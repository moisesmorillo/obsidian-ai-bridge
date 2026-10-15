import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { EpochSchema } from "@obsidian-ai-bridge/protocol";
import {
	generateEpoch,
	initializeVaultStorage,
	SCHEMA,
} from "@worker/infrastructure/sqlite/schema";
import { describe, expect, it } from "vitest";

const metadata = (storage: DurableObjectStorage) =>
	Object.fromEntries(
		storage.sql
			.exec<{ key: string; value: string }>("SELECT key, value FROM meta")
			.toArray()
			.map(({ key, value }) => [key, value]),
	);
const tableNames = (storage: DurableObjectStorage) =>
	storage.sql
		.exec<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table'",
		)
		.toArray()
		.map(({ name }) => name);
const schemaDefinition = (storage: DurableObjectStorage, name: string) =>
	storage.sql
		.exec<{ sql: string | null }>(
			"SELECT sql FROM sqlite_master WHERE name = ?",
			name,
		)
		.toArray()[0]?.sql ?? null;

const createEpoch = () =>
	generateEpoch((bytes) => {
		bytes.set(crypto.getRandomValues(new Uint8Array(16)));
		return bytes;
	});

describe("Vault SQLite persistence", () => {
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
			expect(data.schema_version).toBe("1");
			expect(EpochSchema.safeParse(data.epoch).success).toBe(true);
			expect(data.head_seq).toBe("0");
			expect(data.live_file_count).toBe("0");
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
			state.storage.sql.exec("DROP TABLE IF EXISTS export_pins");
			state.storage.sql.exec("DROP TABLE IF EXISTS revoked_grants");
			state.storage.sql.exec("DROP TABLE IF EXISTS blob_refs");
			state.storage.sql.exec("DROP TABLE IF EXISTS files_fts");
			state.storage.sql.exec("DROP TABLE IF EXISTS receipts");
			state.storage.sql.exec("DROP TABLE IF EXISTS revisions");
			state.storage.sql.exec("DROP TABLE IF EXISTS changes");
			state.storage.sql.exec("DROP TABLE IF EXISTS clients");
			state.storage.sql.exec("DROP TABLE IF EXISTS exports");
			state.storage.sql.exec("DROP TABLE IF EXISTS files");
			state.storage.sql.exec("DROP TABLE IF EXISTS meta");
			const remainingTables = tableNames(state.storage);
			expect(
				remainingTables.filter((name) => !name.startsWith("sqlite_")),
			).toHaveLength(0);
			expect(() =>
				initializeVaultStorage(
					state.storage,
					() => {
						throw new Error("injected failure");
					},
					() => 1,
				),
			).toThrow("injected failure");
			expect(
				tableNames(state.storage).filter((name) => !name.startsWith("sqlite_")),
			).toHaveLength(0);
			expect([...tableNames(state.storage)].sort()).toEqual(
				[...remainingTables].sort(),
			);
			initializeVaultStorage(state.storage, createEpoch, () => 1);
			expect(tableNames(state.storage)).toEqual(
				expect.arrayContaining(["meta", "files", "files_fts"]),
			);
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
				"UPDATE meta SET value = '2' WHERE key = 'schema_version'",
			);
			expect(() =>
				initializeVaultStorage(state.storage, createEpoch, () => 2),
			).toThrow();
			expect(
				state.storage.sql
					.exec("SELECT path FROM files WHERE path = 'keep.md'")
					.toArray(),
			).toHaveLength(1);
			expect(metadata(state.storage).epoch).toBe(before.epoch);
			state.storage.sql.exec(
				"UPDATE meta SET value = '1' WHERE key = 'schema_version'",
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

	it("fails closed on an unknown-only database without deleting it", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("DROP TABLE IF EXISTS export_pins");
			state.storage.sql.exec("DROP TABLE IF EXISTS revoked_grants");
			state.storage.sql.exec("DROP TABLE IF EXISTS blob_refs");
			state.storage.sql.exec("DROP TABLE IF EXISTS files_fts");
			state.storage.sql.exec("DROP TABLE IF EXISTS receipts");
			state.storage.sql.exec("DROP TABLE IF EXISTS revisions");
			state.storage.sql.exec("DROP TABLE IF EXISTS changes");
			state.storage.sql.exec("DROP TABLE IF EXISTS clients");
			state.storage.sql.exec("DROP TABLE IF EXISTS exports");
			state.storage.sql.exec("DROP TABLE IF EXISTS files");
			state.storage.sql.exec("DROP TABLE IF EXISTS meta");
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
