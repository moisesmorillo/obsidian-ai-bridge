import { env, runInDurableObject } from "cloudflare:test";
import {
	type AuthorizationContext,
	EMPTY_PAYLOAD_HASH,
} from "@obsidian-ai-bridge/protocol";
import { tryAcquireBodySlot } from "@worker/application/body-budget";
import { tryAcquireReadSlot } from "@worker/application/read-budget";
import { R2BlobStore } from "@worker/infrastructure/r2/blobs";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import { TEXT_FIXTURE_EPOCH } from "@worker/test-fixtures/text-files";
import { createWorker } from "@worker/transport/worker";
import { describe, expect, it } from "vitest";

const clientId = "aggregate-runtime-client";
const host = "aggregate-runtime-budget.invalid";

/** Resolve request identity from test headers while keeping all grant IDs in one client scope. */
async function requestIdentity(
	request: Request,
): Promise<AuthorizationContext> {
	const grantId =
		request.headers.get("X-Test-Grant") ?? "aggregate-runtime-request";
	return {
		client_id: clientId,
		grant_id: grantId,
		scopes: ["vault:read", "vault:write", "vault:delete"],
	};
}

/** Reserve one isolate body slot until the caller releases it. */
function holdBodySlot(): () => void {
	const release = tryAcquireBodySlot();
	if (!release) throw new Error("Expected an available body slot");
	return release;
}

/** Reserve one isolate read slot until the caller releases it. */
function holdReadSlot(): () => void {
	const release = tryAcquireReadSlot();
	if (!release) throw new Error("Expected an available read slot");
	return release;
}

describe("aggregate runtime budgets", () => {
	it("keeps four body and four read slots independent in one isolate", () => {
		const bodyReleases = Array.from({ length: 4 }, holdBodySlot);
		const readReleases = Array.from({ length: 4 }, holdReadSlot);
		try {
			expect(tryAcquireBodySlot()).toBeUndefined();
			expect(tryAcquireReadSlot()).toBeUndefined();
		} finally {
			for (const release of readReleases) release();
			for (const release of bodyReleases) release();
		}
	});

	it("routes request seventeen to the same real DO after sixteen mixed durable grants", async () => {
		const stub = env.VAULTS.get(env.VAULTS.idFromName(host));
		await runInDurableObject(stub, async (_instance, state) => {
			clearTestVault(state.storage);
			initializeVaultStorage(
				state.storage,
				() => TEXT_FIXTURE_EPOCH,
				() => 10_000,
			);
		});
		/** Give each mixed read or write admission its own grant under one durable client ID. */
		const contextFor = (index: number): AuthorizationContext => ({
			client_id: clientId,
			grant_id: `aggregate-runtime-grant-${index}`,
			scopes: [index % 2 === 0 ? "vault:read" : "vault:write"],
		});
		const admissions = await Promise.all(
			Array.from({ length: 16 }, (_, index) =>
				stub.authorize(
					contextFor(index),
					index % 2 === 0
						? {
								op: "read",
								paths: [],
								precondition: { kind: "none" },
								payload_hash: EMPTY_PAYLOAD_HASH,
								size: 0,
							}
						: {
								op: "put",
								epoch: TEXT_FIXTURE_EPOCH,
								paths: [`notes/${index}.md`],
								precondition: { kind: "absent" },
								payload_hash: EMPTY_PAYLOAD_HASH,
								size: 0,
							},
				),
			),
		);
		expect(
			admissions.every((result) => result.ok),
			JSON.stringify(admissions),
		).toBe(true);

		const firstRouter = createWorker(
			requestIdentity,
			() => stub,
			(bindings) => new R2BlobStore(bindings.R2_BUCKET),
		);
		const secondRouter = createWorker(
			requestIdentity,
			() => stub,
			(bindings) => new R2BlobStore(bindings.R2_BUCKET),
		);
		const refused = await firstRouter.fetch(
			new Request(`https://${host}/v1/files/request-seventeen.md`, {
				method: "PUT",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"X-Test-Grant": "aggregate-runtime-seventeenth-grant",
				},
				body: "must not be read",
			}),
			env,
		);
		expect(refused.status).toBe(429);
		expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
		expect(await refused.json()).toMatchObject({ error: "admission_limited" });
		const alsoRefused = await secondRouter.fetch(
			new Request(`https://${host}/v1/files/request-eighteen.md`, {
				method: "PUT",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"X-Test-Grant": "aggregate-runtime-eighteenth-grant",
				},
				body: "must not be read",
			}),
			env,
		);
		expect(alsoRefused.status).toBe(429);
		expect(Number(alsoRefused.headers.get("Retry-After"))).toBeGreaterThan(0);
		expect(await alsoRefused.json()).toMatchObject({
			error: "admission_limited",
		});
		expect(admissions).toHaveLength(16);
	});

	it("derives the maximum inline application-owned input and response values", () => {
		const maximumTextBytes = 1_000_000;
		const simultaneousBodySlots = 4;
		const input = "\0".repeat(maximumTextBytes);
		const responseFragment = JSON.stringify({ content: input });
		const encodedFragmentBytes = new TextEncoder().encode(
			responseFragment,
		).byteLength;
		const ownedUtf16Bytes = input.length * 2;
		const responseFragmentUtf16Bytes = responseFragment.length * 2;
		const derivedBodyOwnedBytes =
			simultaneousBodySlots *
			(maximumTextBytes * 2 +
				ownedUtf16Bytes * 2 +
				responseFragmentUtf16Bytes +
				encodedFragmentBytes);
		expect(ownedUtf16Bytes).toBe(2_000_000);
		expect(responseFragmentUtf16Bytes).toBe(12_000_028);
		expect(encodedFragmentBytes).toBe(6_000_014);
		expect(derivedBodyOwnedBytes).toBe(96_000_168);
	});
});
