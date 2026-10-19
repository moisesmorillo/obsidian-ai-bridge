import { EpochSchema } from "@obsidian-ai-bridge/protocol";
import { RELATIONAL_SCHEMA_STATEMENTS } from "@worker/infrastructure/sqlite/schema.generated";
import { meta, vaultSchema } from "@worker/infrastructure/sqlite/schema-model";
import { sql } from "drizzle-orm";
import {
	type DrizzleSqliteDODatabase,
	drizzle,
} from "drizzle-orm/durable-sqlite";

/** Persisted SQLite schema version; incompatible changes require an explicit version boundary. */
export const SCHEMA_VERSION = 3;

/** Narrow FTS5 DDL unsupported by the relational model and kept at its engine-specific seam. */
const FTS_SCHEMA = `CREATE VIRTUAL TABLE files_fts USING fts5(
 path UNINDEXED, content, tokenize = 'trigram case_sensitive 0 remove_diacritics 1'
);`;

/** Frozen §5.2 bootstrap DDL composed from generated relational SQL and the FTS5 statement. */
export const SCHEMA = [...RELATIONAL_SCHEMA_STATEMENTS, FTS_SCHEMA].join("\n");

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

/**
 * Derived from the sole DDL source rather than a second schema map. Assumes controlled,
 * semicolon-delimited statements without embedded semicolons and the supported CREATE TABLE,
 * CREATE INDEX, and CREATE VIRTUAL TABLE headers; it does not parse arbitrary SQL.
 */
const FROZEN_SCHEMA_OBJECTS: FrozenSchemaObject[] = SCHEMA.split(";")
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
 * Creates a fresh canonical schema-version-3 vault or validates an existing version-3 store.
 * Version-1, version-2, and other unsupported stores fail without migration, repair, replacement, or epoch changes.
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
			({ name }) => !name.startsWith("sqlite_"),
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
		rejectUnexpectedCatalogObjects(catalogObjects, tableKinds);
		readAndValidateMetadata(tx);
		validateExpectedObjects(actualObjects);
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
	const epoch = createEpoch();
	if (!EpochSchema.safeParse(epoch).success)
		throw new Error("Invalid vault epoch");
	const createdAt = now();
	if (!Number.isSafeInteger(createdAt))
		throw new Error("Invalid vault creation time");
	tx.insert(meta)
		.values([
			{ key: "schema_version", value: String(SCHEMA_VERSION) },
			{ key: "epoch", value: epoch },
			{ key: "head_seq", value: "0" },
			{ key: "created_at", value: String(createdAt) },
			{ key: "live_file_count", value: "0" },
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
): void {
	const expectedNames = new Set(FROZEN_SCHEMA_OBJECTS.map(({ name }) => name));
	for (const actual of catalogObjects) {
		if (expectedNames.has(actual.name)) continue;
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
function readAndValidateMetadata(tx: VaultTransaction): void {
	const metadata = new Map<string, string>();
	for (const row of tx.select().from(meta).all()) {
		if (typeof row.key !== "string" || typeof row.value !== "string")
			throw new Error("Malformed vault metadata row");
		metadata.set(row.key, row.value);
	}
	if (metadata.get("schema_version") !== String(SCHEMA_VERSION))
		throw new Error("Unsupported vault schema version");
	for (const key of ["epoch", "head_seq", "created_at", "live_file_count"]) {
		if (typeof metadata.get(key) !== "string")
			throw new Error(`Missing vault metadata: ${key}`);
	}
	if (!EpochSchema.safeParse(metadata.get("epoch")).success)
		throw new Error("Invalid vault epoch");
	if (
		!isCanonicalSafeInteger(metadata.get("head_seq") ?? "", true) ||
		!isCanonicalSafeInteger(metadata.get("live_file_count") ?? "", true)
	)
		throw new Error("Invalid numeric vault metadata");
	if (!isCanonicalSafeInteger(metadata.get("created_at") ?? "", false))
		throw new Error("Invalid vault creation time");
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
): void {
	for (const expected of FROZEN_SCHEMA_OBJECTS) {
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
