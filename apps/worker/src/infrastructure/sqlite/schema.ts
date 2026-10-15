import { EpochSchema } from "@obsidian-ai-bridge/protocol";

export const SCHEMA_VERSION = 1;

export const SCHEMA = `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE files (
 path TEXT PRIMARY KEY, path_key TEXT NOT NULL, rev INTEGER NOT NULL, seq INTEGER NOT NULL,
 hash TEXT NOT NULL, size INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('text','blob')),
 content TEXT, blob_hash TEXT, deleted INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
 origin TEXT NOT NULL
);
CREATE UNIQUE INDEX files_live_key ON files(path_key) WHERE deleted = 0;
CREATE INDEX files_key ON files(path_key);
CREATE TABLE revisions (
 path TEXT NOT NULL, rev INTEGER NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL,
 kind TEXT NOT NULL, content TEXT, blob_hash TEXT, deleted INTEGER NOT NULL,
 origin TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (path, rev)
);
CREATE TABLE changes (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL CHECK (op IN ('put','delete','rename')),
 path TEXT NOT NULL, rev INTEGER NOT NULL, hash TEXT NOT NULL, from_path TEXT, from_rev INTEGER,
 origin TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE files_fts USING fts5(
 path UNINDEXED, content, tokenize = 'trigram case_sensitive 0 remove_diacritics 1'
);
CREATE TABLE receipts (
 client_id TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
 status INTEGER NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (client_id, key)
);
CREATE TABLE export_pins (export_id TEXT NOT NULL, path TEXT NOT NULL, rev INTEGER NOT NULL, PRIMARY KEY (export_id, path, rev));
CREATE TABLE clients (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('device','agent','app')),
 created_at INTEGER NOT NULL, last_seen_at INTEGER
);
CREATE TABLE revoked_grants (grant_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE blob_refs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, first_ref_at INTEGER NOT NULL);
CREATE TABLE exports (
 id TEXT PRIMARY KEY, started_at INTEGER, finished_at INTEGER, status TEXT, head_seq INTEGER,
 calls_this_hour INTEGER, hour_started_at INTEGER, commit_sha TEXT, error TEXT
);`;

const APPLICATION_TABLES = [
	"export_pins",
	"revoked_grants",
	"blob_refs",
	"files_fts",
	"receipts",
	"revisions",
	"changes",
	"clients",
	"exports",
	"files",
	"meta",
] as const;

export function generateEpoch(
	fillRandom: (bytes: Uint8Array) => Uint8Array,
): string {
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const bytes = fillRandom(new Uint8Array(16));
		if (bytes.length !== 16)
			throw new Error("Entropy source returned an invalid byte count");
		const epoch = Array.from(bytes, (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		if (EpochSchema.safeParse(epoch).success) return epoch;
	}
	throw new Error("Unable to generate a canonical vault epoch");
}

function isCanonicalSafeInteger(value: string, nonNegative: boolean): boolean {
	const parsed = Number(value);
	return (
		Number.isSafeInteger(parsed) &&
		String(parsed) === value &&
		(!nonNegative || parsed >= 0)
	);
}

export function initializeVaultStorage(
	storage: DurableObjectStorage,
	createEpoch: () => string,
	now: () => number,
): void {
	storage.transactionSync(() => {
		const tableNames = storage.sql
			.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'table'",
			)
			.toArray()
			.map(({ name }) => name);
		const applicationTables = tableNames.filter(
			(name) => !name.startsWith("sqlite_"),
		);
		if (applicationTables.length === 0) {
			storage.sql.exec(SCHEMA);
			const epoch = createEpoch();
			if (!EpochSchema.safeParse(epoch).success)
				throw new Error("Invalid vault epoch");
			const createdAt = now();
			if (!Number.isSafeInteger(createdAt))
				throw new Error("Invalid vault creation time");
			for (const [key, value] of Object.entries({
				schema_version: String(SCHEMA_VERSION),
				epoch,
				head_seq: "0",
				created_at: String(createdAt),
				live_file_count: "0",
			}))
				storage.sql.exec(
					"INSERT INTO meta (key, value) VALUES (?, ?)",
					key,
					value,
				);
			return;
		}

		const metadata = new Map<string, string>(
			storage.sql
				.exec<{ key: string; value: string }>("SELECT key, value FROM meta")
				.toArray()
				.map(({ key, value }) => [key, value] as [string, string]),
		);
		if (metadata.get("schema_version") !== String(SCHEMA_VERSION)) {
			throw new Error("Unsupported vault schema version");
		}
		for (const key of ["epoch", "head_seq", "created_at", "live_file_count"]) {
			if (typeof metadata.get(key) !== "string")
				throw new Error(`Missing vault metadata: ${key}`);
		}
		if (!EpochSchema.safeParse(metadata.get("epoch")).success)
			throw new Error("Invalid vault epoch");
		if (
			!isCanonicalSafeInteger(metadata.get("head_seq") ?? "", true) ||
			!isCanonicalSafeInteger(metadata.get("live_file_count") ?? "", true)
		) {
			throw new Error("Invalid numeric vault metadata");
		}
		if (!isCanonicalSafeInteger(metadata.get("created_at") ?? "", false))
			throw new Error("Invalid vault creation time");
		for (const table of APPLICATION_TABLES) {
			if (!tableNames.includes(table))
				throw new Error(`Missing vault table: ${table}`);
		}
		const indexes = storage.sql
			.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'index'",
			)
			.toArray()
			.map(({ name }) => name);
		for (const index of ["files_live_key", "files_key"]) {
			if (!indexes.includes(index))
				throw new Error(`Missing vault index: ${index}`);
		}
	});
}
