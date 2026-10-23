import { env, runInDurableObject, SELF } from "cloudflare:test";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import { TEXT_FIXTURE_EPOCH } from "@worker/test-fixtures/text-files";
import { beforeEach, describe, expect, it } from "vitest";

const vaultUrl = "https://worker.invalid";
const replayPath = "/v1/files/capacity-replay.md";
const replayHeaders = {
	"If-None-Match": "*",
	"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
	"Idempotency-Key": "capacity-replay-0001",
};

/** Seed a live-file count at 10,000 while retaining one committed replay receipt. */
async function fillCapacity(): Promise<void> {
	const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.transactionSync(() => {
			for (let index = 0; index < 9_999; index += 1) {
				const path = `capacity/${String(index).padStart(5, "0")}.txt`;
				state.storage.sql.exec(
					"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 1, 0, ?, 4, 'text', 'seed', 0, 10000, 'seed')",
					path,
					path,
					"a".repeat(64),
				);
			}
			state.storage.sql.exec(
				"UPDATE meta SET value = '10000' WHERE key = 'live_file_count'",
			);
		});
	});
}

describe("runtime limit HTTP recovery at capacity", () => {
	beforeEach(async () => {
		const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
		await runInDurableObject(stub, async (_instance, state) => {
			clearTestVault(state.storage);
			initializeVaultStorage(
				state.storage,
				() => TEXT_FIXTURE_EPOCH,
				() => 10_000,
			);
		});
	});

	it("refuses new content while replay, reads, deletes, and summary attention remain available", async () => {
		const first = await SELF.fetch(`${vaultUrl}${replayPath}`, {
			method: "PUT",
			headers: replayHeaders,
			body: "original content",
		});
		expect(first.status).toBe(201);
		const firstEtag = first.headers.get("ETag");
		await first.text();
		await fillCapacity();

		const refused = await SELF.fetch(
			`${vaultUrl}/v1/files/new-at-capacity.md`,
			{
				method: "PUT",
				headers: {
					"If-None-Match": "*",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
				},
				body: "new content",
			},
		);
		expect(refused.status).toBe(507);
		expect(await refused.json()).toMatchObject({ error: "capacity_exceeded" });

		const replay = await SELF.fetch(`${vaultUrl}${replayPath}`, {
			method: "PUT",
			headers: replayHeaders,
			body: "original content",
		});
		expect(replay.status).toBe(201);
		expect(replay.headers.get("ETag")).toBe(firstEtag);
		await replay.text();

		const content = await SELF.fetch(`${vaultUrl}${replayPath}`);
		expect(content.status).toBe(200);
		expect(await content.json()).toMatchObject({ content: "original content" });

		const read = await SELF.fetch(`${vaultUrl}/v1/vault`);
		expect(read.status).toBe(200);
		expect(await read.json()).toMatchObject({
			counts: { live: 10_000 },
			attention: ["capacity_exceeded"],
		});

		const deleted = await SELF.fetch(
			`${vaultUrl}/v1/files/capacity/00000.txt`,
			{
				method: "DELETE",
				headers: { "If-Match": `"${TEXT_FIXTURE_EPOCH}.1"` },
			},
		);
		expect(deleted.status).toBe(200);
		await deleted.text();
	});
});
