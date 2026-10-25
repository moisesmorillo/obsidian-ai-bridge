import { env, runInDurableObject } from "cloudflare:test";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { describe, expect, it, vi } from "vitest";

/** Fixed valid epoch used only when testing rejection of an unsupported schema version. */
const TEST_EPOCH = "0123456789abcdef0123456789abcdef";

/** Capture catalog definitions so rejected upgrades cannot repair changed or missing objects. */
function schemaCatalogState(storage: DurableObjectStorage) {
	return storage.sql
		.exec(
			"SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != '_cf_METADATA' ORDER BY type, name",
		)
		.toArray();
}

/** Snapshot vault metadata and committed rows to prove a rejected upgrade makes no repairs. */
function preservedStoreState(storage: DurableObjectStorage) {
	return {
		metadata: storage.sql
			.exec("SELECT key, value FROM meta ORDER BY key")
			.toArray(),
		clients: storage.sql.exec("SELECT * FROM clients ORDER BY id").toArray(),
		revokedGrants: storage.sql
			.exec("SELECT * FROM revoked_grants ORDER BY grant_id")
			.toArray(),
		files: storage.sql.exec("SELECT * FROM files ORDER BY path").toArray(),
		revisions: storage.sql
			.exec("SELECT * FROM revisions ORDER BY path, rev")
			.toArray(),
		changes: storage.sql.exec("SELECT * FROM changes ORDER BY seq").toArray(),
		receipts: storage.sql
			.exec("SELECT * FROM receipts ORDER BY client_id, key")
			.toArray(),
	};
}

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
			storage.sql.exec("UPDATE meta SET value = '3' WHERE key = 'head_seq'");
			storage.sql.exec(
				"UPDATE meta SET value = '1' WHERE key = 'live_file_count'",
			);
			storage.sql.exec(
				"UPDATE meta SET value = '111' WHERE key = 'history_revisions_bytes'",
			);
			storage.sql.exec(
				"UPDATE meta SET value = '222' WHERE key = 'history_receipts_bytes'",
			);
			storage.sql.exec(
				"UPDATE meta SET value = '333' WHERE key = 'history_changes_bytes'",
			);
			storage.sql.exec(
				"UPDATE meta SET value = '666' WHERE key = 'history_pressure_bytes'",
			);
			storage.sql.exec(
				"UPDATE meta SET value = '1' WHERE key = 'history_reduced'",
			);
			storage.sql.exec(
				"UPDATE meta SET value = 'pressure_revisions' WHERE key = 'retention_category'",
			);
			storage.sql.exec(
				"UPDATE meta SET value = '2' WHERE key = 'retention_pruned_feed_seq'",
			);
			downgradeToSchema6(storage);
			const before = preservedStoreState(storage);
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
			expect(preservedStoreState(storage)).toEqual({
				...before,
				metadata: before.metadata.map((row) =>
					row.key === "schema_version" ? { ...row, value: "7" } : row,
				),
			});
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
				{ key: "head_seq", value: "3" },
				{ key: "live_file_count", value: "1" },
			]);
			expect(
				storage.sql
					.exec(
						"SELECT key, value FROM meta WHERE key LIKE 'history_%_bytes' ORDER BY key",
					)
					.toArray(),
			).toEqual([
				{ key: "history_changes_bytes", value: "333" },
				{ key: "history_pressure_bytes", value: "666" },
				{ key: "history_receipts_bytes", value: "222" },
				{ key: "history_revisions_bytes", value: "111" },
			]);
			expect(
				storage.sql
					.exec(
						"SELECT name FROM sqlite_master WHERE name = 'client_generations'",
					)
					.toArray(),
			).toHaveLength(1);
			expect(
				storage.sql
					.exec(
						"SELECT key, value FROM meta WHERE key IN ('history_reduced', 'retention_category', 'retention_pruned_feed_seq') ORDER BY key",
					)
					.toArray(),
			).toEqual([
				{ key: "history_reduced", value: "1" },
				{ key: "retention_category", value: "pressure_revisions" },
				{ key: "retention_pruned_feed_seq", value: "2" },
			]);
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

	it.each([
		[
			"changed expected index",
			"DROP INDEX files_key; CREATE INDEX files_key ON files(path_key DESC)",
			"Incompatible vault index: files_key",
		],
		[
			"missing expected index",
			"DROP INDEX files_key",
			"Missing vault index: files_key",
		],
	])(
		"rejects schema-6 storage with a %s without repair",
		async (_case, ddl, expectedError) => {
			const stub = env.VAULTS.get(
				env.VAULTS.idFromName(`schema-catalog-${crypto.randomUUID()}`),
			);
			await runInDurableObject(stub, (_instance, state) => {
				const storage = state.storage;
				storage.sql.exec(
					"INSERT INTO clients (id, name, kind, created_at, last_seen_at) VALUES ('kept', 'Kept', 'agent', 1, NULL)",
				);
				storage.sql.exec(
					"INSERT INTO files (path, path_key, rev, seq, hash, size, kind, content, blob_hash, renamed_to, deleted, updated_at, origin) VALUES ('kept.md', 'kept.md', 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 4, 'text', 'data', NULL, NULL, 0, 2, 'test')",
				);
				storage.sql.exec(ddl);
				downgradeToSchema6(storage);
				const before = preservedStoreState(storage);
				const catalogBefore = schemaCatalogState(storage);
				expect(() =>
					initializeVaultStorage(
						storage,
						() => TEST_EPOCH,
						() => 3,
					),
				).toThrow(expectedError);
				expect(preservedStoreState(storage)).toEqual(before);
				expect(schemaCatalogState(storage)).toEqual(catalogBefore);
			});
		},
	);

	it.each([
		[
			"invalid numeric metadata",
			"UPDATE meta SET value = '00' WHERE key = 'head_seq'",
			"Invalid numeric vault metadata",
		],
		[
			"missing retention metadata",
			"DELETE FROM meta WHERE key = 'retention_category'",
			"Missing vault metadata: retention_category",
		],
	])(
		"rejects schema-6 storage with %s without repair",
		async (_case, corrupt, expectedError) => {
			const stub = env.VAULTS.get(
				env.VAULTS.idFromName(`schema-metadata-${crypto.randomUUID()}`),
			);
			await runInDurableObject(stub, (_instance, state) => {
				const storage = state.storage;
				storage.sql.exec(
					"INSERT INTO clients (id, name, kind, created_at, last_seen_at) VALUES ('kept', 'Kept', 'agent', 1, NULL)",
				);
				storage.sql.exec(
					"INSERT INTO files (path, path_key, rev, seq, hash, size, kind, content, blob_hash, renamed_to, deleted, updated_at, origin) VALUES ('kept.md', 'kept.md', 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 4, 'text', 'data', NULL, NULL, 0, 2, 'test')",
				);
				storage.sql.exec(corrupt);
				downgradeToSchema6(storage);
				const before = preservedStoreState(storage);
				expect(() =>
					initializeVaultStorage(
						storage,
						() => TEST_EPOCH,
						() => 3,
					),
				).toThrow(expectedError);
				expect(preservedStoreState(storage)).toEqual(before);
				expect(
					storage.sql
						.exec("SELECT value FROM meta WHERE key = 'schema_version'")
						.toArray()[0]?.value,
				).toBe("6");
				expect(
					storage.sql
						.exec("SELECT value FROM meta WHERE key = 'epoch'")
						.toArray()[0]?.value,
				).toBe(before.metadata.find((row) => row.key === "epoch")?.value);
			});
		},
	);
});
