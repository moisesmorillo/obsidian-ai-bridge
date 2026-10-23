import { env, runInDurableObject, SELF } from "cloudflare:test";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import { TEXT_FIXTURE_EPOCH } from "@worker/test-fixtures/text-files";
import { beforeEach, describe, expect, it } from "vitest";

/** Seed 10,000 live rows through native SQL for the HTTP admission boundary test. */
async function seedLiveFileLimit(): Promise<void> {
	const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
	await runInDurableObject(stub, async (_instance, state) => {
		clearTestVault(state.storage);
		initializeVaultStorage(
			state.storage,
			() => TEXT_FIXTURE_EPOCH,
			() => 10_000,
		);
		state.storage.transactionSync(() => {
			for (let index = 0; index < 10_000; index += 1) {
				const path = `seed/${String(index).padStart(5, "0")}.txt`;
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

describe("vault capacity HTTP behavior", () => {
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

	it("shows the product capacity summary and returns 507 while reads and deletes continue", async () => {
		await seedLiveFileLimit();
		const summary = await SELF.fetch("https://worker.invalid/v1/vault");
		expect(summary.status).toBe(200);
		expect(await summary.json()).toMatchObject({
			counts: { live: 10_000, deleted: 0 },
			capacity: {
				database_limit_bytes: 2_000_000_000,
				live_file_limit: 10_000,
				history_pressure_bytes: 0,
				referenced_blob_bytes: 0,
			},
			attention: ["capacity_exceeded"],
		});

		const refused = await SELF.fetch("https://worker.invalid/v1/files/new.md", {
			method: "PUT",
			headers: {
				"If-None-Match": "*",
				"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
			},
			body: "content",
		});
		expect(refused.status).toBe(507);
		expect(await refused.json()).toMatchObject({ error: "capacity_exceeded" });

		const deleted = await SELF.fetch(
			"https://worker.invalid/v1/files/seed/00000.txt",
			{
				method: "DELETE",
				headers: { "If-Match": `"${TEXT_FIXTURE_EPOCH}.1"` },
			},
		);
		expect(deleted.status).toBe(200);
		await deleted.text();
	});
});
