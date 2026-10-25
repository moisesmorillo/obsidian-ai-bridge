import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { EpochSchema } from "@obsidian-ai-bridge/protocol";
import {
	generateEpoch,
	initializeVaultStorage,
	SCHEMA,
	SCHEMA_VERSION,
} from "@worker/infrastructure/sqlite/schema";
import { RELATIONAL_SCHEMA_STATEMENTS } from "@worker/infrastructure/sqlite/schema.generated";
import { clearTestVault } from "@worker/test-fixtures/admission";
import { describe, expect, it } from "vitest";

/** Reads raw bootstrap strings so assertions detect invalid stored values without normalization. */
const metadata = (storage: DurableObjectStorage) =>
	Object.fromEntries(
		storage.sql
			.exec<{ key: string; value: string }>("SELECT key, value FROM meta")
			.toArray()
			.map(({ key, value }) => [key, value]),
	);
/** Lists native tables, including platform metadata and SQLite internals. */
const tableNames = (storage: DurableObjectStorage) =>
	storage.sql
		.exec<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table'",
		)
		.toArray()
		.map(({ name }) => name);
/** Lists application tables without native alarm metadata or SQLite-owned objects. */
const applicationTableNames = (storage: DurableObjectStorage) =>
	tableNames(storage).filter(
		(name) => !name.startsWith("sqlite_") && name !== "_cf_METADATA",
	);
/** Reads the exact catalog DDL, or null when no definition exists. */
const schemaDefinition = (storage: DurableObjectStorage, name: string) =>
	storage.sql
		.exec<{ sql: string | null }>(
			"SELECT sql FROM sqlite_master WHERE name = ?",
			name,
		)
		.toArray()[0]?.sql ?? null;

/** Uses native random bytes and the production epoch validator for fresh test stores. */
const createEpoch = () =>
	generateEpoch((bytes) => {
		bytes.set(crypto.getRandomValues(new Uint8Array(16)));
		return bytes;
	});

describe("Vault SQLite persistence", () => {
	it("uses generated relational DDL and keeps engine-specific FTS DDL separate", () => {
		const relationalDdl = RELATIONAL_SCHEMA_STATEMENTS.join("\n");
		expect(SCHEMA.startsWith(relationalDdl)).toBe(true);
		const ftsDdl = SCHEMA.slice(relationalDdl.length).trim();
		expect(ftsDdl).toMatch(/^CREATE VIRTUAL TABLE files_fts USING fts5\(/);
		expect(ftsDdl).toContain(
			"tokenize = 'trigram case_sensitive 0 remove_diacritics 1'",
		);
		expect(RELATIONAL_SCHEMA_STATEMENTS).toHaveLength(17);
	});

	it("initializes the frozen schema and canonical metadata", async () => {
		expect(env.VAULTS).toBeDefined();
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, (_instance, state) => {
			const tables = tableNames(state.storage);
			expect(tables).toEqual(
				expect.arrayContaining([
					"meta",
					"files",
					"revisions",
					"changes",
					"files_fts",
					"receipts",
					"export_pins",
					"clients",
					"revoked_grants",
					"blob_refs",
					"exports",
					"operation_admissions",
					"client_generations",
					"client_consents",
					"client_grants",
					"owner_csrf_states",
				]),
			);
			const indexes = state.storage.sql
				.exec<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE type = 'index'",
				)
				.toArray()
				.map(({ name }) => name);
			expect(indexes).toEqual(
				expect.arrayContaining(["files_live_key", "files_key"]),
			);
			const data = metadata(state.storage);
			expect(data.schema_version).toBe(String(SCHEMA_VERSION));
			expect(schemaDefinition(state.storage, "files")).toContain(
				"`renamed_to` text",
			);
			expect(EpochSchema.safeParse(data.epoch).success).toBe(true);
			expect(data.head_seq).toBe("0");
			expect(data.live_file_count).toBe("0");
			expect(data.history_revisions_bytes).toBe("0");
			expect(data.history_receipts_bytes).toBe("0");
			expect(data.history_changes_bytes).toBe("0");
			expect(data.history_pressure_bytes).toBe("0");
			expect(data.history_reduced).toBe("0");
			expect(data.retention_category).toBe("changes");
			expect(data.retention_pruned_feed_seq).toBe("0");
			expect(Number.isSafeInteger(Number(data.created_at))).toBe(true);
			expect(new TextEncoder().encode(SCHEMA).byteLength).toBeLessThanOrEqual(
				8192,
			);
		});
	});

	it("preserves identity and data after eviction", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		let beforeEpoch = "";
		let beforeCreated = "";
		await runInDurableObject(stub, (_instance, state) => {
			const before = metadata(state.storage);
			beforeEpoch = before.epoch ?? "";
			beforeCreated = before.created_at ?? "";
			state.storage.sql.exec(
				"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,deleted,updated_at,origin) VALUES ('fixture.md','fixture.md',1,1,'hash',0,'text',1,10,'test')",
			);
			state.storage.sql.exec(
				"INSERT INTO revisions(path,rev,hash,size,kind,deleted,origin,at) VALUES ('fixture.md',1,'hash',0,'text',1,'test',10)",
			);
		});
		await evictDurableObject(stub);
		await runInDurableObject(stub, (_instance, state) => {
			const after = metadata(state.storage);
			expect(after.epoch).toBe(beforeEpoch);
			expect(after.created_at).toBe(beforeCreated);
			expect(
				state.storage.sql
					.exec("SELECT path FROM files WHERE path = 'fixture.md'")
					.toArray(),
			).toHaveLength(1);
			expect(
				state.storage.sql
					.exec("SELECT path FROM revisions WHERE path = 'fixture.md'")
					.toArray(),
			).toHaveLength(1);
		});
	});

	it("isolates distinct Vault ids", async () => {
		const first = env.VAULTS.get(env.VAULTS.newUniqueId());
		const second = env.VAULTS.get(env.VAULTS.newUniqueId());
		let firstEpoch = "";
		await runInDurableObject(first, (_instance, state) => {
			firstEpoch = metadata(state.storage).epoch ?? "";
			state.storage.sql.exec(
				"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,deleted,updated_at,origin) VALUES ('private.md','private.md',1,1,'hash',0,'text',0,10,'test')",
			);
		});
		await runInDurableObject(second, (_instance, state) => {
			expect(metadata(state.storage).epoch).not.toBe(firstEpoch);
			expect(
				state.storage.sql
					.exec("SELECT path FROM files WHERE path = 'private.md'")
					.toArray(),
			).toHaveLength(0);
		});
	});

	it("rolls back failed bootstrap", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, (_instance, state) => {
			clearTestVault(state.storage);
			const remainingTables = tableNames(state.storage);
			expect(applicationTableNames(state.storage)).toHaveLength(0);
			expect(() =>
				initializeVaultStorage(
					state.storage,
					() => {
						throw new Error("injected failure");
					},
					() => 1,
				),
			).toThrow("injected failure");
			expect(applicationTableNames(state.storage)).toHaveLength(0);
			expect([...tableNames(state.storage)].sort()).toEqual(
				[...remainingTables].sort(),
			);
			initializeVaultStorage(state.storage, createEpoch, () => 1);
			expect(tableNames(state.storage)).toEqual(
				expect.arrayContaining(["meta", "files", "files_fts"]),
			);
		});
	});

	it("rejects version-5 storage without migration or identity replacement", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec(
				"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,deleted,updated_at,origin) VALUES ('legacy.md','legacy.md',1,1,'hash',0,'text',0,10,'test')",
			);
			state.storage.sql.exec(
				"UPDATE meta SET value = '5' WHERE key = 'schema_version'",
			);
			const before = metadata(state.storage);
			const identity = before.epoch;
			expect(() =>
				initializeVaultStorage(state.storage, createEpoch, () => 20),
			).toThrow(/Unsupported vault schema version/);
			expect(metadata(state.storage)).toEqual(before);
			expect(metadata(state.storage).epoch).toBe(identity);
			expect(
				state.storage.sql
					.exec("SELECT path FROM files WHERE path = 'legacy.md'")
					.toArray(),
			).toHaveLength(1);
		});
	});

	it("rejects version-4 storage without migration or retention-state backfill", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec(
				"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,deleted,updated_at,origin) VALUES ('legacy.md','legacy.md',1,1,'hash',0,'text',0,10,'test')",
			);
			state.storage.sql.exec(
				"UPDATE meta SET value = '4' WHERE key = 'schema_version'",
			);
			state.storage.sql.exec(
				"DELETE FROM meta WHERE key LIKE 'history_%_bytes' OR key = 'history_reduced'",
			);
			const before = metadata(state.storage);
			expect(() =>
				initializeVaultStorage(state.storage, createEpoch, () => 20),
			).toThrow(/Unsupported vault schema version/);
			expect(metadata(state.storage)).toEqual(before);
			expect(
				state.storage.sql
					.exec("SELECT path FROM files WHERE path = 'legacy.md'")
					.toArray(),
			).toHaveLength(1);
		});
	});

	it("rejects corrupt or unsupported schema without changing data", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, (_instance, state) => {
			const before = metadata(state.storage);
			state.storage.sql.exec(
				"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,deleted,updated_at,origin) VALUES ('keep.md','keep.md',1,1,'hash',0,'text',0,10,'test')",
			);
			state.storage.sql.exec(
				"UPDATE meta SET value = '99' WHERE key = 'schema_version'",
			);
			let replacementRequested = false;
			expect(() =>
				initializeVaultStorage(
					state.storage,
					() => {
						replacementRequested = true;
						return createEpoch();
					},
					() => 2,
				),
			).toThrow();
			expect(replacementRequested).toBe(false);
			expect(tableNames(state.storage)).not.toContain("__drizzle_migrations");
			expect(
				state.storage.sql
					.exec("SELECT path FROM files WHERE path = 'keep.md'")
					.toArray(),
			).toHaveLength(1);
			expect(metadata(state.storage).epoch).toBe(before.epoch);
			state.storage.sql.exec(
				"UPDATE meta SET value = ? WHERE key = 'schema_version'",
				String(SCHEMA_VERSION),
			);
			state.storage.sql.exec("DROP INDEX files_key");
			expect(() =>
				initializeVaultStorage(state.storage, createEpoch, () => 2),
			).toThrow(/Missing vault index/);
			expect(
				state.storage.sql
					.exec("SELECT path FROM files WHERE path = 'keep.md'")
					.toArray(),
			).toHaveLength(1);
			expect(metadata(state.storage).epoch).toBe(before.epoch);
		});
	});

	it("rejects noncanonical or unsafe numeric metadata without replacing identity or rows", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, (_instance, state) => {
			const original = metadata(state.storage);
			state.storage.sql.exec(
				"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,deleted,updated_at,origin) VALUES ('preserve.md','preserve.md',1,1,'hash',0,'text',0,10,'test')",
			);
			const corruptions = [
				["head_seq", "9007199254740992"],
				["head_seq", "00"],
				["live_file_count", "9007199254740992"],
				["history_pressure_bytes", "1"],
				["history_reduced", "2"],
				["retention_pruned_feed_seq", "00"],
				["retention_category", "unknown"],
				["created_at", "1e3"],
				["created_at", "001"],
			] as const;
			for (const [key, value] of corruptions) {
				state.storage.sql.exec(
					"UPDATE meta SET value = ? WHERE key = ?",
					value,
					key,
				);
				let replacementRequested = false;
				expect(() =>
					initializeVaultStorage(
						state.storage,
						() => {
							replacementRequested = true;
							return createEpoch();
						},
						() => 2,
					),
				).toThrow();
				expect(replacementRequested).toBe(false);
				expect(metadata(state.storage)[key]).toBe(value);
				expect(metadata(state.storage).epoch).toBe(original.epoch);
				expect(
					state.storage.sql
						.exec("SELECT path FROM files WHERE path = 'preserve.md'")
						.toArray(),
				).toHaveLength(1);
				state.storage.sql.exec(
					"UPDATE meta SET value = ? WHERE key = ?",
					original[key],
					key,
				);
			}
		});
	});

	it.each([
		[
			"table",
			"CREATE TABLE unexpected_fixture (value TEXT NOT NULL)",
			"INSERT INTO unexpected_fixture(value) VALUES ('preserve')",
			"SELECT value FROM unexpected_fixture",
			"Unexpected vault table: unexpected_fixture",
		],
		[
			"files_fts_ lookalike table",
			"CREATE TABLE files_fts_fixture (value TEXT NOT NULL)",
			"INSERT INTO files_fts_fixture(value) VALUES ('preserve')",
			"SELECT value FROM files_fts_fixture",
			"Unexpected vault table: files_fts_fixture",
		],
		[
			"index",
			"CREATE INDEX unexpected_fixture_idx ON files(path)",
			null,
			null,
			"Unexpected vault index: unexpected_fixture_idx",
		],
		[
			"trigger",
			"CREATE TRIGGER unexpected_fixture_trigger AFTER INSERT ON files BEGIN SELECT 1; END",
			null,
			null,
			"Unexpected vault trigger: unexpected_fixture_trigger",
		],
		[
			"view",
			"CREATE VIEW unexpected_fixture_view AS SELECT path FROM files",
			null,
			null,
			"Unexpected vault view: unexpected_fixture_view",
		],
	])(
		"rejects an unexpected application %s without changing the vault",
		async (_kind, createSql, insertSql, selectSql, expectedError) => {
			const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
			await runInDurableObject(stub, (_instance, state) => {
				state.storage.sql.exec(
					"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,deleted,updated_at,origin) VALUES ('preserve.md','preserve.md',1,1,'hash',0,'text',0,10,'test')",
				);
				state.storage.sql.exec(createSql);
				if (insertSql) state.storage.sql.exec(insertSql);
				const beforeMetadata = metadata(state.storage);
				const beforeObject = state.storage.sql
					.exec<{ type: string; name: string; sql: string | null }>(
						"SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'unexpected_fixture%' OR name = 'files_fts_fixture'",
					)
					.toArray();
				let replacementRequested = false;
				let creationTimeRequested = false;
				expect(() =>
					initializeVaultStorage(
						state.storage,
						() => {
							replacementRequested = true;
							return createEpoch();
						},
						() => {
							creationTimeRequested = true;
							return 2;
						},
					),
				).toThrow(expectedError);
				expect(replacementRequested).toBe(false);
				expect(creationTimeRequested).toBe(false);
				expect(metadata(state.storage)).toEqual(beforeMetadata);
				expect(
					state.storage.sql
						.exec("SELECT path FROM files WHERE path = 'preserve.md'")
						.toArray(),
				).toHaveLength(1);
				expect(
					state.storage.sql
						.exec(
							"SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'unexpected_fixture%' OR name = 'files_fts_fixture'",
						)
						.toArray(),
				).toEqual(beforeObject);
				if (selectSql)
					expect(state.storage.sql.exec(selectSql).toArray()).toEqual([
						{ value: "preserve" },
					]);
			});
		},
	);

	it("fails closed on a view-only database without creating schema", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, (_instance, state) => {
			clearTestVault(state.storage);
			state.storage.sql.exec(
				"CREATE VIEW unknown_fixture_view AS SELECT 1 AS value",
			);
			const before = state.storage.sql
				.exec<{ type: string; name: string; sql: string | null }>(
					"SELECT type, name, sql FROM sqlite_master",
				)
				.toArray();
			expect(before).toContainEqual(
				expect.objectContaining({
					type: "view",
					name: "unknown_fixture_view",
				}),
			);
			expect(applicationTableNames(state.storage)).toEqual([]);
			let epochRequested = false;
			let creationTimeRequested = false;
			expect(() =>
				initializeVaultStorage(
					state.storage,
					() => {
						epochRequested = true;
						return createEpoch();
					},
					() => {
						creationTimeRequested = true;
						return 1;
					},
				),
			).toThrow("Unexpected vault view: unknown_fixture_view");
			expect(epochRequested).toBe(false);
			expect(creationTimeRequested).toBe(false);
			expect(
				state.storage.sql
					.exec<{ type: string; name: string; sql: string | null }>(
						"SELECT type, name, sql FROM sqlite_master",
					)
					.toArray(),
			).toEqual(before);
		});
	});

	it("fails closed on an unknown-only database without deleting it", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, (_instance, state) => {
			clearTestVault(state.storage);
			state.storage.sql.exec(
				"CREATE TABLE unknown_fixture (value TEXT NOT NULL)",
			);
			state.storage.sql.exec(
				"INSERT INTO unknown_fixture(value) VALUES ('preserve')",
			);
			let requestedEpoch = false;
			expect(() =>
				initializeVaultStorage(
					state.storage,
					() => {
						requestedEpoch = true;
						return createEpoch();
					},
					() => 1,
				),
			).toThrow();
			expect(requestedEpoch).toBe(false);
			expect(
				state.storage.sql
					.exec<{ value: string }>("SELECT value FROM unknown_fixture")
					.toArray(),
			).toEqual([{ value: "preserve" }]);
		});
	});

	it("rejects a same-named live index with an incompatible predicate without repairing it", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec(
				"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,deleted,updated_at,origin) VALUES ('preserve-index.md','preserve-index.md',1,1,'hash',0,'text',0,10,'test')",
			);
			state.storage.sql.exec("DROP INDEX files_live_key");
			state.storage.sql.exec(
				"CREATE UNIQUE INDEX files_live_key ON files(path_key) WHERE deleted = 1",
			);
			const beforeSchema = schemaDefinition(state.storage, "files_live_key");
			const beforeMetadata = metadata(state.storage);
			let replacementRequested = false;
			expect(() =>
				initializeVaultStorage(
					state.storage,
					() => {
						replacementRequested = true;
						return createEpoch();
					},
					() => 2,
				),
			).toThrow();
			expect(replacementRequested).toBe(false);
			expect(schemaDefinition(state.storage, "files_live_key")).toBe(
				beforeSchema,
			);
			expect(metadata(state.storage)).toEqual(beforeMetadata);
			expect(
				state.storage.sql
					.exec("SELECT path FROM files WHERE path = 'preserve-index.md'")
					.toArray(),
			).toHaveLength(1);
		});
	});

	it("rejects incompatible same-named table columns without repairing or losing rows", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec(
				"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,deleted,updated_at,origin) VALUES ('preserve-column.md','preserve-column.md',1,1,'hash',0,'text',0,10,'test')",
			);
			state.storage.sql.exec(
				"ALTER TABLE files RENAME COLUMN path_key TO path_lookup_key",
			);
			const beforeSchema = schemaDefinition(state.storage, "files");
			const beforeMetadata = metadata(state.storage);
			let replacementRequested = false;
			expect(() =>
				initializeVaultStorage(
					state.storage,
					() => {
						replacementRequested = true;
						return createEpoch();
					},
					() => 2,
				),
			).toThrow();
			expect(replacementRequested).toBe(false);
			expect(schemaDefinition(state.storage, "files")).toBe(beforeSchema);
			expect(metadata(state.storage)).toEqual(beforeMetadata);
			expect(
				state.storage.sql
					.exec("SELECT path FROM files WHERE path = 'preserve-column.md'")
					.toArray(),
			).toHaveLength(1);
		});
	});

	it("rejects a same-named FTS table with the wrong tokenizer without repairing it", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("DROP TABLE files_fts");
			state.storage.sql.exec(
				"CREATE VIRTUAL TABLE files_fts USING fts5(path UNINDEXED, content, tokenize = 'trigram')",
			);
			state.storage.sql.exec(
				"INSERT INTO files_fts(path, content) VALUES ('wrong-tokenizer.md', 'fixture content')",
			);
			const beforeSchema = schemaDefinition(state.storage, "files_fts");
			const beforeMetadata = metadata(state.storage);
			let replacementRequested = false;
			expect(() =>
				initializeVaultStorage(
					state.storage,
					() => {
						replacementRequested = true;
						return createEpoch();
					},
					() => 2,
				),
			).toThrow();
			expect(replacementRequested).toBe(false);
			expect(schemaDefinition(state.storage, "files_fts")).toBe(beforeSchema);
			expect(metadata(state.storage)).toEqual(beforeMetadata);
			expect(
				state.storage.sql
					.exec("SELECT path FROM files_fts WHERE path = 'wrong-tokenizer.md'")
					.toArray(),
			).toHaveLength(1);
		});
	});

	it("resamples numeric-only epochs and fails closed on exhausted entropy", () => {
		let samples = 0;
		const epoch = generateEpoch((bytes) => {
			samples += 1;
			bytes.fill(samples === 1 ? 0 : 0xab);
			return bytes;
		});
		expect(samples).toBe(2);
		expect(EpochSchema.safeParse(epoch).success).toBe(true);
		let attempts = 0;
		expect(() =>
			generateEpoch((bytes) => {
				attempts += 1;
				bytes.fill(1);
				return bytes;
			}),
		).toThrow();
		expect(attempts).toBe(8);
	});

	it.each([0, 15, 17, 32])(
		"rejects a %i-byte entropy result without retry",
		(length) => {
			let calls = 0;
			expect(() =>
				generateEpoch(() => {
					calls += 1;
					return new Uint8Array(length);
				}),
			).toThrow("Entropy source returned an invalid byte count");
			expect(calls).toBe(1);
		},
	);

	it.each([
		{
			name: "numeric-only epoch",
			epoch: "1".repeat(32),
			time: 1,
			error: "Invalid vault epoch",
		},
		{ name: "short epoch", epoch: "a", time: 1, error: "Invalid vault epoch" },
		{
			name: "NaN timestamp",
			epoch: "a".repeat(32),
			time: Number.NaN,
			error: "Invalid vault creation time",
		},
		{
			name: "infinite timestamp",
			epoch: "a".repeat(32),
			time: Number.POSITIVE_INFINITY,
			error: "Invalid vault creation time",
		},
		{
			name: "unsafe timestamp",
			epoch: "a".repeat(32),
			time: Number.MAX_SAFE_INTEGER + 1,
			error: "Invalid vault creation time",
		},
		{
			name: "fractional timestamp",
			epoch: "a".repeat(32),
			time: 1.5,
			error: "Invalid vault creation time",
		},
	])("rolls back bootstrap after a $name", async ({ epoch, time, error }) => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, (_instance, state) => {
			clearTestVault(state.storage);
			expect(() =>
				initializeVaultStorage(
					state.storage,
					() => epoch,
					() => time,
				),
			).toThrow(error);
			expect(
				state.storage.sql
					.exec<{ name: string }>("SELECT name FROM sqlite_master")
					.toArray()
					.filter(
						({ name }) =>
							!name.startsWith("sqlite_") && name !== "_cf_METADATA",
					),
			).toEqual([]);
			initializeVaultStorage(state.storage, createEpoch, () => -1);
			expect(metadata(state.storage).created_at).toBe("-1");
		});
	});

	it("validates existing storage without calling bootstrap factories", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, (_instance, state) => {
			const before = metadata(state.storage);
			expect(() =>
				initializeVaultStorage(
					state.storage,
					() => {
						throw new Error("Existing storage called the epoch factory");
					},
					() => {
						throw new Error("Existing storage called the time factory");
					},
				),
			).not.toThrow();
			expect(metadata(state.storage)).toEqual(before);
		});
	});

	it("supports exact trigram diacritics and inline row size", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec(
				"INSERT INTO files_fts(path,content) VALUES ('accent.md','café literal AND punctuation!')",
			);
			expect(
				state.storage.sql
					.exec("SELECT path FROM files_fts WHERE files_fts MATCH 'cafe'")
					.toArray(),
			).toHaveLength(1);
			expect(
				state.storage.sql
					.exec("SELECT path FROM files_fts WHERE files_fts MATCH '\"AND\"'")
					.toArray(),
			).toHaveLength(1);
			expect(
				state.storage.sql
					.exec(
						"SELECT path FROM files_fts WHERE files_fts MATCH ?",
						'"punctuation!"',
					)
					.toArray(),
			).toHaveLength(1);
			const content = "x".repeat(1_000_000);
			state.storage.sql.exec(
				"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES ('large.md','large.md',1,1,'hash',?, 'text', ?,0,10,'test')",
				new TextEncoder().encode(content).byteLength,
				content,
			);
			expect(
				state.storage.sql
					.exec<{ content: string }>(
						"SELECT content FROM files WHERE path = 'large.md'",
					)
					.toArray()[0]?.content,
			).toBe(content);
			expect(() =>
				state.storage.transactionSync(() => {
					state.storage.sql.exec(
						"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,deleted,updated_at,origin) VALUES ('rolled.md','rolled.md',1,1,'hash',0,'text',0,10,'test')",
					);
					throw new Error("rollback");
				}),
			).toThrow("rollback");
			expect(
				state.storage.sql
					.exec("SELECT path FROM files WHERE path = 'rolled.md'")
					.toArray(),
			).toHaveLength(0);
		});
	});
});
