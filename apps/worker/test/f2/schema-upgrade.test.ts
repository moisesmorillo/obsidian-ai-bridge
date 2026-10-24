import { env, runInDurableObject } from "cloudflare:test";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { describe, expect, it, vi } from "vitest";

/** Fixed valid epoch used only when testing rejection of an unsupported schema version. */
const TEST_EPOCH = "0123456789abcdef0123456789abcdef";

/** Remove only schema-7 additions to form an exact schema-6 upgrade fixture. */
function downgradeToSchema6(storage: DurableObjectStorage): void {
	storage.sql.exec("DROP TABLE owner_csrf_states");
	storage.sql.exec("DROP TABLE client_grants");
	storage.sql.exec("DROP TABLE client_consents");
	storage.sql.exec("DROP TABLE client_generations");
	storage.sql.exec("UPDATE meta SET value = '6' WHERE key = 'schema_version'");
}

describe("schema-6 owner registry upgrade", () => {
	it("preserves vault identity and committed data while adding the owner registry", async () => {
		const stub = env.VAULTS.get(
			env.VAULTS.idFromName(`schema-upgrade-${crypto.randomUUID()}`),
		);
		await runInDurableObject(stub, (_instance, state) => {
			const storage = state.storage;
			const beforeEpoch = storage.sql
				.exec("SELECT value FROM meta WHERE key = 'epoch'")
				.toArray()[0]?.value;
			storage.sql.exec(
				"INSERT INTO clients (id, name, kind, created_at, last_seen_at) VALUES ('old-client', 'Old name', 'agent', 10, 20)",
			);
			storage.sql.exec(
				"INSERT INTO revoked_grants (grant_id, at) VALUES ('old-denial', 30)",
			);
			storage.sql.exec(
				"INSERT INTO files (path, path_key, rev, seq, hash, size, kind, content, blob_hash, renamed_to, deleted, updated_at, origin) VALUES ('note.md', 'note.md', 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 4, 'text', 'body', NULL, NULL, 0, 40, 'old-client')",
			);
			storage.sql.exec(
				"INSERT INTO revisions (path, rev, hash, size, kind, content, blob_hash, deleted, origin, at) VALUES ('note.md', 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 4, 'text', 'body', NULL, 0, 'old-client', 40)",
			);
			storage.sql.exec(
				"INSERT INTO changes (op, path, rev, hash, from_path, from_rev, origin, at) VALUES ('put', 'note.md', 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', NULL, NULL, 'old-client', 40)",
			);
			storage.sql.exec(
				"INSERT INTO receipts (client_id, key, fingerprint, status, body, at) VALUES ('old-client', 'receipt-key', 'fingerprint', 200, '{\"ok\":true}', 50)",
			);
			storage.sql.exec(
				"UPDATE meta SET value = '1' WHERE key IN ('head_seq', 'live_file_count')",
			);
			downgradeToSchema6(storage);
			initializeVaultStorage(
				storage,
				() => {
					throw new Error("upgrade must not replace epoch");
				},
				() => {
					throw new Error("upgrade must not reset creation time");
				},
			);
			expect(
				storage.sql
					.exec("SELECT value FROM meta WHERE key = 'schema_version'")
					.toArray()[0]?.value,
			).toBe("7");
			expect(
				storage.sql
					.exec("SELECT value FROM meta WHERE key = 'epoch'")
					.toArray()[0]?.value,
			).toBe(beforeEpoch);
			expect(
				storage.sql
					.exec("SELECT path, content FROM files WHERE path = 'note.md'")
					.toArray(),
			).toEqual([{ path: "note.md", content: "body" }]);
			expect(
				storage.sql
					.exec("SELECT * FROM revisions WHERE path = 'note.md'")
					.toArray(),
			).toHaveLength(1);
			expect(
				storage.sql
					.exec("SELECT * FROM changes WHERE path = 'note.md'")
					.toArray(),
			).toHaveLength(1);
			expect(
				storage.sql
					.exec("SELECT * FROM receipts WHERE key = 'receipt-key'")
					.toArray(),
			).toHaveLength(1);
			expect(
				storage.sql
					.exec("SELECT * FROM revoked_grants WHERE grant_id = 'old-denial'")
					.toArray(),
			).toHaveLength(1);
			expect(
				storage.sql
					.exec(
						"SELECT key, value FROM meta WHERE key IN ('head_seq', 'live_file_count') ORDER BY key",
					)
					.toArray(),
			).toEqual([
				{ key: "head_seq", value: "1" },
				{ key: "live_file_count", value: "1" },
			]);
			expect(
				storage.sql
					.exec(
						"SELECT key, value FROM meta WHERE key LIKE 'history_%_bytes' ORDER BY key",
					)
					.toArray(),
			).toEqual([
				{ key: "history_changes_bytes", value: "0" },
				{ key: "history_pressure_bytes", value: "0" },
				{ key: "history_receipts_bytes", value: "0" },
				{ key: "history_revisions_bytes", value: "0" },
			]);
			expect(
				storage.sql
					.exec(
						"SELECT name FROM sqlite_master WHERE name = 'client_generations'",
					)
					.toArray(),
			).toHaveLength(1);
		});
	});

	it("rolls back partial registry DDL when schema-6 migration fails", async () => {
		const stub = env.VAULTS.get(
			env.VAULTS.idFromName(`schema-interrupted-${crypto.randomUUID()}`),
		);
		await runInDurableObject(stub, (_instance, state) => {
			const storage = state.storage;
			downgradeToSchema6(storage);
			const execute = storage.sql.exec.bind(storage.sql);
			const failOnGrantTable = vi
				.spyOn(storage.sql, "exec")
				.mockImplementation((statement, ...parameters) => {
					if (statement.includes("CREATE TABLE client_grants"))
						throw new Error("synthetic migration interruption");
					return execute(statement, ...parameters);
				});
			try {
				expect(() =>
					initializeVaultStorage(
						storage,
						() => TEST_EPOCH,
						() => 1,
					),
				).toThrow();
				expect(failOnGrantTable).toHaveBeenCalled();
			} finally {
				failOnGrantTable.mockRestore();
			}
			expect(
				storage.sql
					.exec("SELECT value FROM meta WHERE key = 'schema_version'")
					.toArray()[0]?.value,
			).toBe("6");
			expect(
				storage.sql
					.exec(
						"SELECT name FROM sqlite_master WHERE name IN ('client_generations', 'client_consents', 'client_grants', 'owner_csrf_states')",
					)
					.toArray(),
			).toHaveLength(0);
		});
	});

	it("rejects an unsupported schema without replacing its metadata or data", async () => {
		const stub = env.VAULTS.get(
			env.VAULTS.idFromName(`schema-unsupported-${crypto.randomUUID()}`),
		);
		await runInDurableObject(stub, (_instance, state) => {
			const storage = state.storage;
			storage.sql.exec(
				"INSERT INTO clients (id, name, kind, created_at, last_seen_at) VALUES ('kept', 'Kept', 'agent', 1, NULL)",
			);
			downgradeToSchema6(storage);
			storage.sql.exec(
				"UPDATE meta SET value = '5' WHERE key = 'schema_version'",
			);
			expect(() =>
				initializeVaultStorage(
					storage,
					() => TEST_EPOCH,
					() => 1,
				),
			).toThrow("Unsupported vault schema version");
			expect(
				storage.sql
					.exec("SELECT value FROM meta WHERE key = 'schema_version'")
					.toArray()[0]?.value,
			).toBe("5");
			expect(
				storage.sql.exec("SELECT id FROM clients WHERE id = 'kept'").toArray(),
			).toHaveLength(1);
			expect(
				storage.sql
					.exec(
						"SELECT name FROM sqlite_master WHERE name = 'client_generations'",
					)
					.toArray(),
			).toHaveLength(0);
		});
	});
});
