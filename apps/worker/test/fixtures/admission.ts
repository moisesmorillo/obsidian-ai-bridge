import { SCHEMA_V1_RELATIONAL_STATEMENTS } from "@worker/test-fixtures/schema-v1";

/** Test-only FTS5 DDL that completes the canonical schema-v1 fixture. It does not define production FTS state. */
const FTS_SCHEMA = `CREATE VIRTUAL TABLE files_fts USING fts5(
 path UNINDEXED, content, tokenize = 'trigram case_sensitive 0 remove_diacritics 1'
);`;

/** Clear only known application objects in a disposable native test vault. */
export function clearTestVault(storage: DurableObjectStorage): void {
	storage.transactionSync(() => {
		storage.sql.exec("DROP TABLE IF EXISTS files_fts");
		for (const statement of [
			"DROP TABLE IF EXISTS operation_admissions",
			"DROP TABLE IF EXISTS export_pins",
			"DROP TABLE IF EXISTS revoked_grants",
			"DROP TABLE IF EXISTS blob_refs",
			"DROP TABLE IF EXISTS exports",
			"DROP TABLE IF EXISTS receipts",
			"DROP TABLE IF EXISTS revisions",
			"DROP TABLE IF EXISTS changes",
			"DROP TABLE IF EXISTS clients",
			"DROP TABLE IF EXISTS files",
			"DROP TABLE IF EXISTS meta",
		])
			storage.sql.exec(statement);
	});
}

/** Seed an exact canonical-v1 vault without calling production initialization. */
export function seedCanonicalV1(storage: DurableObjectStorage): void {
	storage.transactionSync(() => {
		for (const statement of SCHEMA_V1_RELATIONAL_STATEMENTS)
			storage.sql.exec(statement);
		storage.sql.exec(FTS_SCHEMA);
		storage.sql.exec(
			"INSERT INTO meta(key, value) VALUES ('schema_version', '1'), ('epoch', '0123456789abcdef0123456789abcdef'), ('head_seq', '0'), ('created_at', '1'), ('live_file_count', '0')",
		);
		storage.sql.exec(
			"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES ('preserve.md','preserve.md',1,1,'fixture-hash',7,'text','preserve',0,1,'fixture')",
		);
	});
}

/** Return the application catalog and stored state needed to prove read-only rejection. */
export function captureVaultState(storage: DurableObjectStorage) {
	return {
		catalog: storage.sql
			.exec<{ type: string; name: string; sql: string | null }>(
				"SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
			)
			.toArray(),
		metadata: storage.sql
			.exec<{ key: string; value: string }>(
				"SELECT key, value FROM meta ORDER BY key",
			)
			.toArray(),
		files: storage.sql.exec("SELECT * FROM files ORDER BY path").toArray(),
	};
}
