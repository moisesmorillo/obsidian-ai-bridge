import { env, runInDurableObject } from "cloudflare:test";
import {
	isVaultOverload,
	refuseVaultOverload,
	VaultOverloaded,
} from "@worker/application/vault-overload";
import { R2BlobStore } from "@worker/infrastructure/r2/blobs";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import { TEXT_FIXTURE_EPOCH } from "@worker/test-fixtures/text-files";
import { createWorker } from "@worker/transport/worker";
import { beforeEach, describe, expect, it } from "vitest";

/** Host whose Vault Durable Object backs every overload case. */
const HOST = "overload.invalid";

/** Build the error shape that a Durable Object stub throws when its queue is overloaded. */
function overloadedError(): Error {
	return Object.assign(
		new Error("Durable Object is overloaded. Requests queued for too long."),
		{ overloaded: true },
	);
}

/** Vault RPC methods that the production composition exposes to the router. */
const VAULT_METHODS = [
	"getCurrentEpoch",
	"beginMutation",
	"authorize",
	"commitText",
	"authorizeBlob",
	"commitBlob",
	"readBlobMetadata",
	"finishAdmission",
	"readText",
	"beginRenameSource",
	"authorizeRenameSource",
	"commitFileCommand",
	"readHistory",
	"readVault",
	"readHistoryUpper",
	"readBatch",
	"search",
] as const;

/**
 * Route the real router to the real Vault through a plain gateway object, as production composes
 * it, failing the named RPC before it reaches the object. `failure` selects an overloaded platform
 * error or an ordinary unknown error.
 */
function overloadWorker(method: string, failure: "overloaded" | "unknown") {
	const stub = env.VAULTS.get(env.VAULTS.idFromName(HOST));
	const gateway = Object.fromEntries(
		VAULT_METHODS.map((name) => [
			name,
			async (...args: unknown[]) => {
				if (name === method)
					throw failure === "overloaded"
						? overloadedError()
						: new Error("Simulated RPC loss");
				return await Reflect.apply(
					Reflect.get(stub, name) as (...args: unknown[]) => unknown,
					stub,
					args,
				);
			},
		]),
	) as unknown as typeof stub;
	return createWorker(
		async () => ({
			client_id: "overload-client",
			grant_id: "overload-grant",
			scopes: ["vault:read", "vault:write", "vault:delete"],
		}),
		() => gateway,
		() => new R2BlobStore(env.R2_BUCKET),
	);
}

/** ETag of the seeded note, captured before each case. */
let seededEtag = "";

/** Exact bytes and declaration of the blob that blob cases upload. */
const BLOB_BYTES = new Uint8Array([0, 1, 2, 255]);

/** Build a create-only text PUT for a new note. */
function newTextPut(): Request {
	return new Request(`https://${HOST}/v1/files/new.md`, {
		method: "PUT",
		headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
		body: "x".repeat(1_000),
	});
}

/** Build a create-only declared blob PUT with the exact SHA-256 of {@link BLOB_BYTES}. */
async function newBlobPut(): Promise<Request> {
	const digest = Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", BLOB_BYTES)),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
	return new Request(`https://${HOST}/v1/files/new.bin`, {
		method: "PUT",
		headers: {
			"If-None-Match": "*",
			"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
			"X-Content-SHA256": digest,
			"X-Content-Size": String(BLOB_BYTES.byteLength),
		},
		body: BLOB_BYTES,
	});
}

/**
 * REST requests, the RPC whose overload each one must survive, and the durable admission states
 * left afterwards. A refusal after a ticket exists keeps that admission uncertain, never settled,
 * because an overloaded call may still have reached the object. A refusal before any ticket leaves
 * no admission.
 */
const REST_CASES: Array<
	[string, string, () => Request | Promise<Request>, string[]]
> = [
	["PUT before reservation", "beginMutation", newTextPut, []],
	["PUT at authorization", "authorize", newTextPut, ["uncertain"]],
	["PUT at commit", "commitText", newTextPut, ["uncertain"]],
	["blob PUT at commit", "commitBlob", newBlobPut, ["uncertain"]],
	[
		"rename at commit",
		"commitFileCommand",
		() =>
			new Request(`https://${HOST}/v1/files/note.md:rename`, {
				method: "POST",
				headers: {
					"If-Match": seededEtag,
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"Idempotency-Key": "overload-rename-01",
				},
				body: JSON.stringify({ to: "renamed.md" }),
			}),
		["uncertain"],
	],
	[
		"vault read",
		"readVault",
		() => new Request(`https://${HOST}/v1/vault`),
		["uncertain"],
	],
	[
		"feed open",
		"authorize",
		() =>
			new Request(
				`https://${HOST}/v1/changes?epoch=${TEXT_FIXTURE_EPOCH}&since=0`,
			),
		[],
	],
	[
		"feed batch",
		"readBatch",
		() =>
			new Request(
				`https://${HOST}/v1/changes?epoch=${TEXT_FIXTURE_EPOCH}&since=0`,
			),
		["uncertain"],
	],
	[
		"manifest batch",
		"readBatch",
		() => new Request(`https://${HOST}/v1/manifest`),
		["uncertain"],
	],
	[
		"content read",
		"readText",
		() => new Request(`https://${HOST}/v1/files/note.md`),
		["uncertain"],
	],
	[
		"history read",
		"readHistoryUpper",
		() => new Request(`https://${HOST}/v1/history/note.md`),
		["uncertain"],
	],
	[
		"search",
		"search",
		() => new Request(`https://${HOST}/v1/search?q=note`),
		["uncertain"],
	],
];

/** Return the durable admission states that remain for the overload test client. */
async function admissionStates(): Promise<string[]> {
	const stub = env.VAULTS.get(env.VAULTS.idFromName(HOST));
	return runInDurableObject(stub, (_instance, state) =>
		state.storage.sql
			.exec(
				"SELECT state FROM operation_admissions WHERE client_id = 'overload-client' ORDER BY state",
			)
			.toArray()
			.map((row) => String(row.state)),
	);
}

/** Send one MCP tool call through the real router. */
function toolCall(name: string, args: Record<string, unknown>): Request {
	const body = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name, arguments: args },
	});
	return new Request(`https://${HOST}/mcp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"content-length": String(body.length),
		},
		body,
	});
}

describe("Durable Object overload refusal", () => {
	beforeEach(async () => {
		const stub = env.VAULTS.get(env.VAULTS.idFromName(HOST));
		await runInDurableObject(stub, (_instance, state) => {
			clearTestVault(state.storage);
			initializeVaultStorage(
				state.storage,
				() => TEXT_FIXTURE_EPOCH,
				() => Date.now(),
			);
		});
		const seeded = await overloadWorker("none", "unknown").fetch(
			new Request(`https://${HOST}/v1/files/note.md`, {
				method: "PUT",
				headers: { "If-None-Match": "*", "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
				body: "note body",
			}),
			env,
		);
		await seeded.text();
		expect(seeded.status).toBe(201);
		seededEtag = seeded.headers.get("ETag") ?? "";
	});

	it.each(REST_CASES)(
		"returns a retryable 429 for an overloaded %s",
		async (_label, method, request, states) => {
			const response = await overloadWorker(method, "overloaded").fetch(
				await request(),
				env,
			);
			const body = await response.json();
			expect(response.status).toBe(429);
			expect(body).toMatchObject({ error: "admission_limited" });
			expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
			expect(await admissionStates()).toEqual(states);
		},
	);

	it("keeps an ordinary unknown RPC failure as an internal error", async () => {
		const response = await overloadWorker("commitText", "unknown").fetch(
			newTextPut(),
			env,
		);
		await response.text();
		expect(response.status).toBe(500);
	});

	it.each([
		["read_note", "readText", () => ({ path: "note.md" }), ["uncertain"]],
		[
			"create_note",
			"beginMutation",
			() => ({
				path: "Agents/new.md",
				content: "x",
				epoch: TEXT_FIXTURE_EPOCH,
			}),
			[],
		],
		[
			"create_note",
			"commitText",
			() => ({
				path: "Agents/new.md",
				content: "x",
				epoch: TEXT_FIXTURE_EPOCH,
			}),
			["uncertain"],
		],
		[
			"update_note",
			"commitText",
			() => ({ path: "note.md", content: "changed", etag: seededEtag }),
			["uncertain"],
		],
		["list_notes", "readBatch", () => ({}), ["uncertain"]],
		["search_notes", "search", () => ({ query: "note" }), ["uncertain"]],
		[
			"get_history",
			"readHistoryUpper",
			() => ({ path: "note.md" }),
			["uncertain"],
		],
	] as Array<[string, string, () => Record<string, unknown>, string[]]>)(
		"returns the retryable admission_limited MCP tool error when %s meets an overloaded %s",
		async (tool, method, args, states) => {
			const response = await overloadWorker(method, "overloaded").fetch(
				toolCall(tool, args()),
				env,
			);
			const message = (await response.json()) as {
				result?: { isError?: boolean; structuredContent?: { code?: string } };
				error?: unknown;
			};
			expect(message.error).toBeUndefined();
			expect(message.result?.isError).toBe(true);
			expect(message.result?.structuredContent?.code).toBe("admission_limited");
			expect(await admissionStates()).toEqual(states);
		},
	);

	it("returns a retryable MCP 429 when the request epoch check meets an overloaded Vault", async () => {
		const response = await overloadWorker(
			"getCurrentEpoch",
			"overloaded",
		).fetch(
			toolCall("create_note", {
				path: "Agents/new.md",
				content: "x",
				epoch: TEXT_FIXTURE_EPOCH,
			}),
			env,
		);
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("5");
		expect(await response.json()).toEqual({ error: "admission_limited" });
	});

	it("maps only overloaded rejections and keeps other results and errors", async () => {
		const unknown = new Error("other");
		const gateway = refuseVaultOverload({
			label: "plain",
			/** Reject with the platform overload marker. */
			async overloaded(): Promise<number> {
				throw overloadedError();
			},
			/** Reject with an ordinary error. */
			async failed(): Promise<number> {
				throw unknown;
			},
			/** Resolve with the receiver's own label to prove the receiver binding. */
			async ok(this: { label: string }): Promise<string> {
				return this.label;
			},
		});
		expect(gateway.label).toBe("plain");
		await expect(gateway.ok()).resolves.toBe("plain");
		await expect(gateway.failed()).rejects.toBe(unknown);
		const refused = await gateway.overloaded().catch((error) => error);
		expect(refused).toBeInstanceOf(VaultOverloaded);
		expect(refused.failure).toEqual({
			kind: "admission_limited",
			retry_after_seconds: 5,
		});
		expect(isVaultOverload({ overloaded: "true" })).toBe(false);
		expect(isVaultOverload(null)).toBe(false);
	});
});
