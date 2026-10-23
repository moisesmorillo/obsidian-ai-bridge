import { env, runInDurableObject, SELF } from "cloudflare:test";
import type { AuthorizationContext } from "@obsidian-ai-bridge/protocol";
import { R2BlobStore } from "@worker/infrastructure/r2/blobs";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import { TEXT_FIXTURE_EPOCH } from "@worker/test-fixtures/text-files";
import { createWorker } from "@worker/transport/worker";
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

	it("returns HTTP 412 with the current ETag at capacity and omits write-only content", async () => {
		const host = "worker.invalid";
		const stub = env.VAULTS.get(env.VAULTS.idFromName(host));
		await seedLiveFileLimit();
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE files SET path = 'notes/source.md', path_key = 'notes/source.md', size = 6, content = 'before' WHERE path = 'seed/00000.txt'",
			);
		});
		let checkedBeforeCommit = false;
		let vault: typeof stub;
		vault = new Proxy(stub, {
			/** Control the revision race and capture the state around native commit. */
			get(target, property) {
				const method = Reflect.get(target, property, target);
				if (property === "authorize" && typeof method === "function")
					return async (...args: Parameters<typeof stub.authorize>) => {
						const admission = await Reflect.apply(method, target, args);
						await runInDurableObject(stub, async (_instance, state) => {
							state.storage.sql.exec(
								"UPDATE files SET rev = 2, hash = ?, size = 7, content = 'changed' WHERE path = 'notes/source.md'",
								"b".repeat(64),
							);
						});
						return admission;
					};
				if (property === "commitText" && typeof method === "function")
					return async (...args: Parameters<typeof stub.commitText>) => {
						const before = await runInDurableObject(
							stub,
							async (_instance, state) => ({
								files: state.storage.sql
									.exec("SELECT * FROM files ORDER BY path")
									.toArray(),
								revisions: state.storage.sql
									.exec("SELECT * FROM revisions ORDER BY path, rev")
									.toArray(),
								changes: state.storage.sql
									.exec("SELECT * FROM changes ORDER BY seq")
									.toArray(),
								meta: state.storage.sql
									.exec("SELECT key, value FROM meta ORDER BY key")
									.toArray(),
								admissions: state.storage.sql
									.exec("SELECT * FROM operation_admissions ORDER BY id")
									.toArray(),
								claims: state.storage.sql
									.exec("SELECT * FROM mutation_claims ORDER BY client_id, key")
									.toArray(),
							}),
						);
						const result = await Reflect.apply(method, target, args);
						const after = await runInDurableObject(
							stub,
							async (_instance, state) => ({
								files: state.storage.sql
									.exec("SELECT * FROM files ORDER BY path")
									.toArray(),
								revisions: state.storage.sql
									.exec("SELECT * FROM revisions ORDER BY path, rev")
									.toArray(),
								changes: state.storage.sql
									.exec("SELECT * FROM changes ORDER BY seq")
									.toArray(),
								meta: state.storage.sql
									.exec("SELECT key, value FROM meta ORDER BY key")
									.toArray(),
								admissions: state.storage.sql
									.exec("SELECT * FROM operation_admissions ORDER BY id")
									.toArray(),
								claims: state.storage.sql
									.exec("SELECT * FROM mutation_claims ORDER BY client_id, key")
									.toArray(),
							}),
						);
						expect(after).toEqual(before);
						checkedBeforeCommit = true;
						return result;
					};
				return typeof method === "function"
					? (...args: unknown[]) => Reflect.apply(method, target, args)
					: method;
			},
		});
		/** Provide a write-only principal so refusal bodies cannot include file text. */
		const identity = async (): Promise<AuthorizationContext> => ({
			client_id: "capacity-http-write-only",
			grant_id: "capacity-http-write-only-grant",
			scopes: ["vault:write"],
		});
		const worker = createWorker(
			identity,
			() => vault,
			(bindings) => new R2BlobStore(bindings.R2_BUCKET),
		);
		const response = await worker.fetch(
			new Request(`https://${host}/v1/files/notes/source.md`, {
				method: "PUT",
				headers: {
					"If-Match": `"${TEXT_FIXTURE_EPOCH}.1"`,
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
				},
				body: "replacement",
			}),
			env,
		);
		expect(response.status).toBe(412);
		const body = await response.json();
		expect(body).toMatchObject({
			error: "precondition_failed",
			etag: `"${TEXT_FIXTURE_EPOCH}.2"`,
		});
		expect(body).not.toHaveProperty("content");
		expect(checkedBeforeCommit).toBe(true);
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
