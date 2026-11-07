import { EpochSchema } from "@obsidian-ai-bridge/protocol";
import { isBlobGcRunId } from "@worker/infrastructure/sqlite/blob-gc-id";
import { RELATIONAL_SCHEMA_STATEMENTS } from "@worker/infrastructure/sqlite/schema.generated";
import { meta, vaultSchema } from "@worker/infrastructure/sqlite/schema-model";
import { sql } from "drizzle-orm";
import {
	type DrizzleSqliteDODatabase,
	drizzle,
} from "drizzle-orm/durable-sqlite";

/** Persisted schema version; version 9 adds GC marks, run IDs, delete claims, and typed outcome state. */
export const SCHEMA_VERSION = 9;

/** Narrow FTS5 DDL unsupported by the relational model and kept at its engine-specific seam. */
const FTS_SCHEMA = `CREATE VIRTUAL TABLE files_fts USING fts5(
 path UNINDEXED, content, tokenize = 'trigram case_sensitive 0 remove_diacritics 1'
);`;

/** Schema-7 owner registry DDL. These tables are additive and migrate schema 6 in one transaction. */
const OWNER_REGISTRY_SCHEMA = [
	`CREATE TABLE client_generations (client_id TEXT PRIMARY KEY NOT NULL, owner_subject TEXT NOT NULL, generation INTEGER NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER);`,
	`CREATE TABLE client_consents (consent_id TEXT PRIMARY KEY NOT NULL, client_id TEXT NOT NULL, owner_subject TEXT NOT NULL, generation INTEGER NOT NULL, created_at INTEGER NOT NULL);`,
	`CREATE TABLE client_grants (client_id TEXT NOT NULL, grant_id TEXT NOT NULL UNIQUE, owner_subject TEXT NOT NULL, generation INTEGER NOT NULL, consent_id TEXT NOT NULL, created_at INTEGER NOT NULL, cleanup_pending INTEGER NOT NULL, PRIMARY KEY(client_id, grant_id));`,
	`CREATE TABLE owner_csrf_states (state TEXT PRIMARY KEY NOT NULL, owner_subject TEXT NOT NULL, browser_id TEXT NOT NULL, expires_at INTEGER NOT NULL);`,
] as const;

/** Relational DDL introduced only by schema 8. */
const PACKED_EXPORT_SCHEMA = RELATIONAL_SCHEMA_STATEMENTS.filter((statement) =>
	/^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+[`"]?packed_export/.test(
		statement,
	),
);

/** Relational DDL introduced by schema 9 for durable blob-GC marks. */
const BLOB_GC_SCHEMA = RELATIONAL_SCHEMA_STATEMENTS.filter((statement) =>
	/^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+[`"]?blob_gc/.test(statement),
);

/** Schema-7 DDL excludes the later packed-export and blob-GC objects. */
const RELATIONAL_SCHEMA_7 = RELATIONAL_SCHEMA_STATEMENTS.filter(
	(statement) =>
		!PACKED_EXPORT_SCHEMA.includes(statement) &&
		!BLOB_GC_SCHEMA.includes(statement),
);

/** Frozen schema-7 bootstrap DDL, including F2 owner tables. */
const SCHEMA_7 = [
	...RELATIONAL_SCHEMA_7,
	FTS_SCHEMA,
	...OWNER_REGISTRY_SCHEMA,
].join("\n");

/** Exact schema-8 catalog before the additive blob-GC table. */
const SCHEMA_8 = [
	...RELATIONAL_SCHEMA_7,
	...PACKED_EXPORT_SCHEMA,
	FTS_SCHEMA,
	...OWNER_REGISTRY_SCHEMA,
].join("\n");

/** Frozen schema-6 DDL used only to validate an exact supported upgrade source. */
const SCHEMA_6 = [...RELATIONAL_SCHEMA_7, FTS_SCHEMA].join("\n");

/** Current bootstrap DDL includes every versioned relational migration and owner table. */
export const SCHEMA = [
	...RELATIONAL_SCHEMA_STATEMENTS,
	FTS_SCHEMA,
	...OWNER_REGISTRY_SCHEMA,
].join("\n");

/** Platform catalog table used to persist native Durable Object alarm state. */
const ALARM_METADATA_TABLE = "_cf_METADATA";

/** SQLite catalog kinds used by this module's private frozen-DDL compatibility check. */
type SchemaObjectKind = "table" | "index";

/** Native synchronous transaction argument for this module's Drizzle schema. */
type VaultTransaction = Parameters<
	Parameters<DrizzleSqliteDODatabase<typeof vaultSchema>["transaction"]>[0]
>[0];

/** One private `sqlite_master` row used to inspect catalog objects. */
type CatalogObject = { type: string; name: string; sql: string | null };

/** Associates one statement from {@link SCHEMA} with its catalog name, kind, and SQL. */
interface FrozenSchemaObject {
	name: string;
	kind: SchemaObjectKind;
	sql: string;
}

/**
 * Trims outer whitespace, removes a terminal semicolon, and collapses whitespace,
 * including inside quoted literals.
 * This is sufficient only for the current frozen DDL (including tokenizer argument separators);
 * it is not a general SQL-equivalence normalizer.
 */
function normalizeSchemaSql(sql: string): string {
	return sql.trim().replace(/;\s*$/, "").replace(/\s+/g, " ");
}

/** Generates a canonical 128-bit epoch, resampling at most eight invalid entropy samples.
 * @param fillRandom - Fills and returns a 16-byte buffer; other lengths fail, while invalid epochs retry.
 * @returns A lowercase 32-character epoch accepted by the published `EpochSchema`.
 * @throws When the entropy source returns an invalid-length buffer or all eight samples are invalid.
 */
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

/**
 * Accepts only the canonical decimal spelling of a safe integer; counters pass true to
 * require nonnegative values, while creation timestamps pass false to retain signed values.
 */
function isCanonicalSafeInteger(value: string, nonNegative: boolean): boolean {
	const parsed = Number(value);
	return (
		Number.isSafeInteger(parsed) &&
		String(parsed) === value &&
		(!nonNegative || parsed >= 0)
	);
}

/**
 * Creates a fresh schema-9 vault, upgrades exact schema-6 through schema-8 stores, or validates schema 9.
 * Older and unsupported stores fail without repair, replacement, or epoch changes.
 * All DDL and initial metadata writes run synchronously in one Durable SQLite transaction.
 * @param storage - The native storage belonging to this vault Durable Object.
 * @param createEpoch - Called only during fresh initialization; an invalid result aborts the transaction.
 * @param now - Called only during fresh initialization; returns the creation timestamp in milliseconds.
 * @throws If storage is partial, unknown, incompatible, unsupported, or its bootstrap inputs are invalid.
 */
export function initializeVaultStorage(
	storage: DurableObjectStorage,
	createEpoch: () => string,
	now: () => number,
): void {
	storage.sql.exec("PRAGMA foreign_keys = ON");
	const foreignKeys = storage.sql
		.exec<{ foreign_keys: number }>("PRAGMA foreign_keys")
		.toArray()[0]?.foreign_keys;
	if (foreignKeys !== 1)
		throw new Error("SQLite foreign-key enforcement is unavailable");

	const db = drizzle(storage, { schema: vaultSchema });
	db.transaction((tx) => {
		const catalogObjects = tx.all<CatalogObject>(
			"SELECT type, name, sql FROM sqlite_master",
		);
		const applicationObjects = catalogObjects.filter(
			({ name }) =>
				!name.startsWith("sqlite_") && name !== ALARM_METADATA_TABLE,
		);
		if (applicationObjects.length === 0) {
			createFreshVault(tx, createEpoch, now);
			return;
		}

		const actualObjects = new Map(
			catalogObjects.map((object) => [object.name, object]),
		);
		const tableKinds = new Map(
			tx
				.all<{ name: string; type: string }>("PRAGMA table_list")
				.map(({ name, type }) => [name, type]),
		);
		rejectUnexpectedCatalogObjects(catalogObjects, tableKinds, SCHEMA);
		if (!actualObjects.has("meta"))
			throw new Error("Missing vault metadata table");
		const version = readSchemaVersion(tx);
		if (version === "6") {
			rejectUnexpectedCatalogObjects(catalogObjects, tableKinds, SCHEMA_6);
			readAndValidateMetadata(tx, "6");
			validateExpectedObjects(actualObjects, SCHEMA_6);
			upgradeSchema6(tx);
			validateCurrentSchema(tx, SCHEMA_7, "7");
			upgradeSchema7(tx);
			validateCurrentSchema(tx, SCHEMA_8, "8");
			upgradeSchema8(tx);
			validateCurrentSchema(tx, SCHEMA, String(SCHEMA_VERSION));
			return;
		}
		if (version === "7") {
			rejectUnexpectedCatalogObjects(catalogObjects, tableKinds, SCHEMA_7);
			readAndValidateMetadata(tx, "7");
			validateExpectedObjects(actualObjects, SCHEMA_7);
			upgradeSchema7(tx);
			validateCurrentSchema(tx, SCHEMA_8, "8");
			upgradeSchema8(tx);
			validateCurrentSchema(tx, SCHEMA, String(SCHEMA_VERSION));
			return;
		}
		if (version === "8") {
			rejectUnexpectedCatalogObjects(catalogObjects, tableKinds, SCHEMA_8);
			readAndValidateMetadata(tx, "8");
			validateExpectedObjects(actualObjects, SCHEMA_8);
			upgradeSchema8(tx);
			validateCurrentSchema(tx, SCHEMA, String(SCHEMA_VERSION));
			return;
		}
		rejectUnexpectedCatalogObjects(catalogObjects, tableKinds, SCHEMA);
		readAndValidateMetadata(tx, String(SCHEMA_VERSION));
		validateExpectedObjects(actualObjects, SCHEMA);
	});
}

/**
 * Create the schema and canonical metadata in the caller's active transaction.
 * The caller owns commit and rollback.
 *
 * @param tx - Active transaction for all schema and metadata writes.
 * @param createEpoch - Runs after schema DDL. Its result must pass epoch validation.
 * @param now - Runs after epoch validation. Its result must be a safe integer timestamp.
 *
 * @throws If SQL or a factory fails, or a factory result is invalid.
 */
function createFreshVault(
	tx: VaultTransaction,
	createEpoch: () => string,
	now: () => number,
): void {
	for (const statement of RELATIONAL_SCHEMA_STATEMENTS)
		tx.run(sql.raw(statement));
	tx.run(sql.raw(FTS_SCHEMA));
	for (const statement of OWNER_REGISTRY_SCHEMA) tx.run(sql.raw(statement));
	const epoch = createEpoch();
	if (!EpochSchema.safeParse(epoch).success)
		throw new Error("Invalid vault epoch");
	const createdAt = now();
	if (!Number.isSafeInteger(createdAt))
		throw new Error("Invalid vault creation time");
	tx.insert(meta)
		.values([
			{ key: "schema_version", value: String(SCHEMA_VERSION) },
			{ key: "blob_gc_generation", value: "0" },
			{ key: "blob_gc_run_id", value: "" },
			{ key: "blob_gc_phase", value: "idle" },
			{ key: "blob_gc_cursor", value: "" },
			{ key: "blob_gc_delete_owner", value: "" },
			{ key: "blob_gc_delete_state", value: "" },
			{ key: "blob_gc_failure", value: "" },
			{ key: "epoch", value: epoch },
			{ key: "head_seq", value: "0" },
			{ key: "created_at", value: String(createdAt) },
			{ key: "live_file_count", value: "0" },
			{ key: "history_revisions_bytes", value: "0" },
			{ key: "history_receipts_bytes", value: "0" },
			{ key: "history_changes_bytes", value: "0" },
			{ key: "history_pressure_bytes", value: "0" },
			{ key: "history_reduced", value: "0" },
			{ key: "retention_category", value: "changes" },
			{ key: "retention_pruned_feed_seq", value: "0" },
		])
		.run();
}

/**
 * Reject unexpected catalog rows while allowing reserved names and native shadow tables.
 * Reserved objects can have non-null DDL. Shadow exceptions need native PRAGMA classification.
 *
 * @param catalogObjects - Complete rows from the initial `sqlite_master` query.
 * @param tableKinds - Complete name-to-kind map from `PRAGMA table_list`.
 *
 * @throws If a row is not expected, reserved, or classified as a shadow table.
 */
function rejectUnexpectedCatalogObjects(
	catalogObjects: CatalogObject[],
	tableKinds: Map<string, string>,
	schema = SCHEMA,
): void {
	const expectedNames = new Set(schemaObjects(schema).map(({ name }) => name));
	for (const actual of catalogObjects) {
		if (expectedNames.has(actual.name)) continue;
		if (actual.type === "table" && actual.name === ALARM_METADATA_TABLE)
			continue;
		if (actual.name.startsWith("sqlite_")) continue;
		if (actual.type === "table" && tableKinds.get(actual.name) === "shadow")
			continue;
		throw new Error(`Unexpected vault ${actual.type}: ${actual.name}`);
	}
}

/**
 * Read canonical ORM metadata rows and validate version, identity, counters, and time.
 * This helper only reads metadata. It never writes or replaces vault identity.
 *
 * @param tx - Active transaction used to select rows from the canonical metadata table.
 *
 * @throws If metadata lacks a field, uses an unsupported version, or contains malformed or invalid values.
 */
function readSchemaVersion(tx: VaultTransaction): string {
	const row = tx
		.select()
		.from(meta)
		.all()
		.find(({ key }) => key === "schema_version");
	if (!row || typeof row.value !== "string")
		throw new Error("Missing vault schema version");
	return row.value;
}

/** Upgrade one exact schema-6 store without changing its epoch or existing rows. */
function upgradeSchema6(tx: VaultTransaction): void {
	for (const statement of OWNER_REGISTRY_SCHEMA) tx.run(sql.raw(statement));
	tx.run(sql`UPDATE meta SET value = '7' WHERE key = 'schema_version'`);
}

/** Upgrade one exact schema-7 store with packed-export tables and no identity changes. */
function upgradeSchema7(tx: VaultTransaction): void {
	for (const statement of PACKED_EXPORT_SCHEMA) tx.run(sql.raw(statement));
	tx.run(sql`UPDATE meta SET value = '8' WHERE key = 'schema_version'`);
}

/** Add blob-GC marks and their generation fence to one exact schema-8 vault. */
function upgradeSchema8(tx: VaultTransaction): void {
	for (const statement of BLOB_GC_SCHEMA) tx.run(sql.raw(statement));
	tx.insert(meta)
		.values([
			{ key: "blob_gc_generation", value: "0" },
			{ key: "blob_gc_run_id", value: "" },
			{ key: "blob_gc_phase", value: "idle" },
			{ key: "blob_gc_cursor", value: "" },
			{ key: "blob_gc_delete_owner", value: "" },
			{ key: "blob_gc_delete_state", value: "" },
			{ key: "blob_gc_failure", value: "" },
		])
		.run();
	tx.run(sql`UPDATE meta SET value = '9' WHERE key = 'schema_version'`);
}

/** Validate catalog objects and metadata after one atomic version upgrade. */
function validateCurrentSchema(
	tx: VaultTransaction,
	schema: string,
	version: string,
): void {
	readAndValidateMetadata(tx, version);
	const actualObjects = new Map(
		tx
			.all<CatalogObject>("SELECT type, name, sql FROM sqlite_master")
			.map((object) => [object.name, object]),
	);
	validateExpectedObjects(actualObjects, schema);
}

/** Parse controlled frozen DDL to compare exact catalog names, kinds, and definitions. */
function schemaObjects(schema: string): FrozenSchemaObject[] {
	return schema
		.split(";")
		.map((statement) => statement.trim())
		.filter(Boolean)
		.map((sql) => {
			const header =
				/^CREATE\s+(?:UNIQUE\s+|VIRTUAL\s+)?(TABLE|INDEX)\s+[`"]?([A-Za-z_][A-Za-z_0-9]*)\b[`"]?/i.exec(
					sql,
				);
			const [, kind, name] = header ?? [];
			if (!kind || !name)
				throw new Error("Invalid frozen vault schema statement");
			return {
				name,
				kind: kind.toLowerCase() as SchemaObjectKind,
				sql: normalizeSchemaSql(sql),
			};
		});
}

/** Validate identity, schema version, counters, and history consistency without repairing metadata. */
function readAndValidateMetadata(tx: VaultTransaction, version: string): void {
	const metadata = new Map<string, string>();
	for (const row of tx.select().from(meta).all()) {
		if (typeof row.key !== "string" || typeof row.value !== "string")
			throw new Error("Malformed vault metadata row");
		metadata.set(row.key, row.value);
	}
	if (metadata.get("schema_version") !== version)
		throw new Error("Unsupported vault schema version");
	for (const key of [
		"epoch",
		"head_seq",
		"created_at",
		"live_file_count",
		"history_revisions_bytes",
		"history_receipts_bytes",
		"history_changes_bytes",
		"history_pressure_bytes",
		"history_reduced",
		"retention_category",
		"retention_pruned_feed_seq",
	]) {
		if (typeof metadata.get(key) !== "string")
			throw new Error(`Missing vault metadata: ${key}`);
	}
	if (!EpochSchema.safeParse(metadata.get("epoch")).success)
		throw new Error("Invalid vault epoch");
	if (
		!isCanonicalSafeInteger(metadata.get("head_seq") ?? "", true) ||
		!isCanonicalSafeInteger(metadata.get("live_file_count") ?? "", true) ||
		!isCanonicalSafeInteger(
			metadata.get("history_revisions_bytes") ?? "",
			true,
		) ||
		!isCanonicalSafeInteger(
			metadata.get("history_receipts_bytes") ?? "",
			true,
		) ||
		!isCanonicalSafeInteger(
			metadata.get("history_changes_bytes") ?? "",
			true,
		) ||
		!isCanonicalSafeInteger(
			metadata.get("history_pressure_bytes") ?? "",
			true,
		) ||
		!isCanonicalSafeInteger(metadata.get("history_reduced") ?? "", true) ||
		!isCanonicalSafeInteger(
			metadata.get("retention_pruned_feed_seq") ?? "",
			true,
		)
	)
		throw new Error("Invalid numeric vault metadata");
	const revisionBytes = Number(metadata.get("history_revisions_bytes"));
	const receiptBytes = Number(metadata.get("history_receipts_bytes"));
	const changeBytes = Number(metadata.get("history_changes_bytes"));
	const historyBytes = Number(metadata.get("history_pressure_bytes"));
	const historyReduced = Number(metadata.get("history_reduced"));
	const headSequence = Number(metadata.get("head_seq"));
	const prunedFeedSequence = Number(metadata.get("retention_pruned_feed_seq"));
	const retentionCategory = metadata.get("retention_category");
	if (
		revisionBytes + receiptBytes + changeBytes !== historyBytes ||
		!Number.isSafeInteger(historyBytes) ||
		(historyReduced !== 0 && historyReduced !== 1) ||
		!Number.isSafeInteger(headSequence + 1) ||
		prunedFeedSequence > headSequence + 1 ||
		![
			"changes",
			"receipts",
			"ordinary_revisions",
			"pressure_revisions",
		].includes(retentionCategory ?? "")
	)
		throw new Error("Invalid logical history metadata");
	if (!isCanonicalSafeInteger(metadata.get("created_at") ?? "", false))
		throw new Error("Invalid vault creation time");
	if (version === String(SCHEMA_VERSION)) validateBlobGcMetadata(metadata);
}

/** Validate GC phase, cursor, and delete ownership/outcome without repairing persisted state. */
function validateBlobGcMetadata(metadata: ReadonlyMap<string, string>): void {
	const generation = metadata.get("blob_gc_generation");
	const phase = metadata.get("blob_gc_phase");
	const cursor = metadata.get("blob_gc_cursor");
	const runId = metadata.get("blob_gc_run_id");
	const deleteOwner = metadata.get("blob_gc_delete_owner");
	const deleteState = metadata.get("blob_gc_delete_state");
	const failure = metadata.get("blob_gc_failure");
	if (
		!isCanonicalSafeInteger(generation ?? "", true) ||
		(phase !== "idle" && phase !== "marking" && phase !== "deleting") ||
		(phase === "idle" ? runId !== "" : !isBlobGcRunId(runId ?? "")) ||
		cursor === undefined ||
		new TextEncoder().encode(cursor).byteLength > 16_000 ||
		(deleteOwner === ""
			? deleteState !== ""
			: phase !== "deleting" ||
				deleteOwner === undefined ||
				!isBlobGcRunId(deleteOwner) ||
				(deleteState !== "active" && deleteState !== "unknown")) ||
		(failure !== "" && failure !== "blob_gc_unavailable") ||
		(phase !== "marking" && cursor !== "")
	)
		throw new Error("Invalid blob-GC metadata");
}

/**
 * Find expected catalog objects and compare their kinds and controlled-DDL definitions.
 * Normalization handles whitespace and a terminal semicolon. This helper does not write catalog state.
 *
 * @param actualObjects - Catalog rows indexed by object name.
 *
 * @throws If an object is missing or its kind or normalized definition differs.
 */
function validateExpectedObjects(
	actualObjects: Map<string, CatalogObject>,
	schema = SCHEMA,
): void {
	for (const expected of schemaObjects(schema)) {
		const actual = actualObjects.get(expected.name);
		if (!actual)
			throw new Error(`Missing vault ${expected.kind}: ${expected.name}`);
		if (
			actual.type !== expected.kind ||
			actual.sql === null ||
			normalizeSchemaSql(actual.sql) !== expected.sql
		)
			throw new Error(`Incompatible vault ${expected.kind}: ${expected.name}`);
	}
}
