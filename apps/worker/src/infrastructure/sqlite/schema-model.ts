/**
 * Defines the frozen relational storage format from specification section 5.2.
 * Timestamp fields use Unix milliseconds. Size fields count bytes, not characters.
 *
 * Text primary keys retain physical SQLite nullability. Application writers must supply canonical non-null identities.
 * @packageDocumentation
 */
import { sql } from "drizzle-orm";
import {
	blob,
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** Native SQL statement ceilings applied to export snapshot writes. */
export const SQLITE_BOUND_PARAMETER_LIMIT = 100;
/** Logical per-row limit accepted by the Worker SQLite capacity contract. */
export const SQLITE_ROW_BYTE_LIMIT = 2_000_000;
/** Payload limit for one export checkpoint or manifest chunk. */
export const PACKED_EXPORT_CHUNK_DATA_BYTES = 1_000_000;
/** Conservative fixed bytes reserved for chunk-row identifiers and SQLite record encoding. */
export const PACKED_EXPORT_CHUNK_ROW_OVERHEAD_BYTES = 256;

/** Stores bootstrap identity and counters as canonical strings. Existing-store validation owns their meaning and rejects malformed values without repair. */
export const meta = sqliteTable(
	"meta",
	{
		key: text("key"),
		value: text("value").notNull(),
	},
	(table) => [primaryKey({ columns: [table.key] })],
);

/** Defines current rows, including tombstones. Live rows have unique lowercase NFC keys. Application writes must preserve exact revision conditions. */
export const files = sqliteTable(
	"files",
	{
		path: text("path"),
		/** Unicode lowercase of the NFC path. Only non-deleted rows reserve this key. */
		pathKey: text("path_key").notNull(),
		/** Per-path revision that continues across delete and recreate operations. */
		rev: integer("rev").notNull(),
		/** Sequence of the vault-global change that produced this current row. */
		seq: integer("seq").notNull(),
		/** SHA-256 content hash, or an empty string for a tombstone. */
		hash: text("hash").notNull(),
		size: integer("size").notNull(),
		kind: text("kind").notNull(),
		/** Inline text payload. Application writes use the blob reference instead for blob rows. */
		content: text("content"),
		/** Content-addressed reference for blob rows. The reference alone does not prove external-byte integrity. */
		blobHash: text("blob_hash"),
		/** Immediate destination retained on rename tombstones for stale-write diagnostics. */
		renamedTo: text("renamed_to"),
		deleted: integer("deleted").notNull().default(0),
		updatedAt: integer("updated_at").notNull(),
		origin: text("origin").notNull(),
	},
	(table) => [
		check("files_kind_check", sql`${table.kind} IN ('text', 'blob')`),
		uniqueIndex("files_live_key")
			.on(table.pathKey)
			.where(sql`${table.deleted} = 0`),
		index("files_key").on(table.pathKey),
		primaryKey({ columns: [table.path] }),
	],
);

/** Stores retained path revisions under a composite identity. Retention must preserve export-pinned revisions. Bootstrap creates structure but does not prune history. */
export const revisions = sqliteTable(
	"revisions",
	{
		path: text("path").notNull(),
		rev: integer("rev").notNull(),
		hash: text("hash").notNull(),
		size: integer("size").notNull(),
		kind: text("kind").notNull(),
		/** Historical inline payload. Null does not authorize replacement with newer content. */
		content: text("content"),
		/** Historical content reference. Readers must use this revision, not a current-row substitute. */
		blobHash: text("blob_hash"),
		deleted: integer("deleted").notNull(),
		origin: text("origin").notNull(),
		at: integer("at").notNull(),
	},
	(table) => [primaryKey({ columns: [table.path, table.rev] })],
);

/** Stores the vault-global feed sequence. Rename fields describe the source tombstone, not a second pending operation. */
export const changes = sqliteTable(
	"changes",
	{
		seq: integer("seq").primaryKey({ autoIncrement: true }).notNull(),
		op: text("op").notNull(),
		path: text("path").notNull(),
		rev: integer("rev").notNull(),
		hash: text("hash").notNull(),
		fromPath: text("from_path"),
		/** Source tombstone revision for a rename. Other operations have no source revision. */
		fromRev: integer("from_rev"),
		origin: text("origin").notNull(),
		at: integer("at").notNull(),
	},
	(table) => [
		check("changes_op_check", sql`${table.op} IN ('put', 'delete', 'rename')`),
	],
);

/** Stores idempotency evidence under a client-scoped key. Application commits must publish the receipt with the corresponding authoritative mutation. */
export const receipts = sqliteTable(
	"receipts",
	{
		clientId: text("client_id").notNull(),
		key: text("key").notNull(),
		/** Hash of operation identity, precondition, and payload identity, not a content hash alone. */
		fingerprint: text("fingerprint").notNull(),
		status: integer("status").notNull(),
		body: text("body").notNull(),
		at: integer("at").notNull(),
	},
	(table) => [primaryKey({ columns: [table.clientId, table.key] })],
);

/** Identifies revisions protected by an export. Retention must consult these rows before removing history. Bootstrap does not run exports or retention. */
export const exportPins = sqliteTable(
	"export_pins",
	{
		exportId: text("export_id").notNull(),
		path: text("path").notNull(),
		rev: integer("rev").notNull(),
	},
	(table) => [primaryKey({ columns: [table.exportId, table.path, table.rev] })],
);

/** Stores client identities independently of transport tokens. Client kinds use the frozen persisted spelling. */
export const clients = sqliteTable(
	"clients",
	{
		id: text("id"),
		name: text("name").notNull(),
		kind: text("kind").notNull(),
		createdAt: integer("created_at").notNull(),
		/** Nullable observation time. Absence is not evidence that a client is inactive. */
		lastSeenAt: integer("last_seen_at"),
	},
	(table) => [
		check(
			"clients_kind_check",
			sql`${table.kind} IN ('device', 'agent', 'app')`,
		),
		primaryKey({ columns: [table.id] }),
	],
);

/** Stores grant revocation evidence for authoritative authorization checks. The timestamp uses Unix milliseconds, not token expiry units. */
export const revokedGrants = sqliteTable(
	"revoked_grants",
	{
		grantId: text("grant_id"),
		at: integer("at").notNull(),
	},
	(table) => [primaryKey({ columns: [table.grantId] })],
);

/** Persist admission ownership across reserved, active, and uncertain states. Deadlines use original Unix milliseconds. Expired rows still count until bounded cleanup removes them. */
export const operationAdmissions = sqliteTable(
	"operation_admissions",
	{
		id: text("id").primaryKey().notNull(),
		clientId: text("client_id").notNull(),
		grantId: text("grant_id").notNull(),
		epoch: text("epoch").notNull(),
		fingerprint: text("fingerprint").notNull(),
		admittedAt: integer("admitted_at").notNull(),
		expiresAt: integer("expires_at").notNull(),
		state: text("state").notNull(),
	},
	(table) => [
		check(
			"operation_admissions_state_check",
			sql`${table.state} IN ('reserved', 'active', 'uncertain')`,
		),
		index("operation_admissions_client_expiry").on(
			table.clientId,
			table.expiresAt,
		),
		index("operation_admissions_expiry").on(table.expiresAt),
	],
);

/** Links each client-scoped idempotency key to its exact retained admission owner. Admission deletion cascades claim removal. */
export const mutationClaims = sqliteTable(
	"mutation_claims",
	{
		clientId: text("client_id").notNull(),
		key: text("key").notNull(),
		admissionId: text("admission_id")
			.notNull()
			.references(() => operationAdmissions.id, { onDelete: "cascade" }),
	},
	(table) => [
		primaryKey({ columns: [table.clientId, table.key] }),
		uniqueIndex("mutation_claims_admission").on(table.admissionId),
	],
);

/** Stores referenced content hashes and byte sizes. These rows describe references, not proof that external bytes exist or match their hash. */
export const blobRefs = sqliteTable(
	"blob_refs",
	{
		hash: text("hash"),
		size: integer("size").notNull(),
		firstRefAt: integer("first_ref_at").notNull(),
	},
	(table) => [primaryKey({ columns: [table.hash] })],
);

/** Holds hashes fenced from publication until their exact R2 delete succeeds. */
export const blobGc = sqliteTable(
	"blob_gc",
	{
		hash: text("hash").notNull(),
		size: integer("size").notNull(),
		markedAt: integer("marked_at").notNull(),
	},
	(table) => [primaryKey({ columns: [table.hash] })],
);

/** Reserves the frozen export bookkeeping fields. Nullable fields do not prove completion or success. Bootstrap does not interpret export progress. */
export const exports = sqliteTable(
	"exports",
	{
		id: text("id"),
		startedAt: integer("started_at"),
		finishedAt: integer("finished_at"),
		status: text("status"),
		headSeq: integer("head_seq"),
		callsThisHour: integer("calls_this_hour"),
		hourStartedAt: integer("hour_started_at"),
		commitSha: text("commit_sha"),
		error: text("error"),
	},
	(table) => [primaryKey({ columns: [table.id] })],
);

/** Persists one resumable packed export and its ZIP32/multipart checkpoint. The partial part is under 5 MiB. */
export const packedExports = sqliteTable(
	"packed_exports",
	{
		id: text("id").notNull(),
		epoch: text("epoch").notNull(),
		createdAt: text("created_at").notNull(),
		headSeq: integer("head_seq").notNull(),
		status: text("status").notNull(),
		objectKey: text("object_key").notNull(),
		startedAt: integer("started_at").notNull(),
		finishedAt: integer("finished_at"),
		size: integer("size"),
		uploadId: text("upload_id"),
		zipState: text("zip_state").notNull(),
		manifestSize: integer("manifest_size").notNull(),
		completedParts: text("completed_parts").notNull(),
		error: text("error"),
	},
	(table) => [
		check(
			"packed_exports_status_check",
			sql`${table.status} IN ('queued', 'uploading', 'complete', 'failed')`,
		),
		uniqueIndex("packed_exports_identity").on(table.epoch, table.createdAt),
		primaryKey({ columns: [table.id] }),
	],
);

/** Captures current-file metadata under one export identity while export_pins preserve exact revisions. */
export const packedExportFiles = sqliteTable(
	"packed_export_files",
	{
		exportId: text("export_id").notNull(),
		ordinal: integer("ordinal").notNull(),
		path: text("path").notNull(),
		rev: integer("rev").notNull(),
		hash: text("hash").notNull(),
		size: integer("size").notNull(),
		sourceType: text("source_type").notNull(),
	},
	(table) => [
		check(
			"packed_export_files_source_type_check",
			sql`${table.sourceType} IN ('revision_text', 'revision_blob', 'snapshot_text', 'snapshot_blob')`,
		),
		primaryKey({ columns: [table.exportId, table.ordinal] }),
		uniqueIndex("packed_export_files_path").on(table.exportId, table.path),
	],
);

/** Stores bounded manifest, pending multipart, and frozen fallback-source bytes. */
export const packedExportChunks = sqliteTable(
	"packed_export_chunks",
	{
		exportId: text("export_id").notNull(),
		kind: text("kind").notNull(),
		ordinal: integer("ordinal").notNull(),
		data: blob("data", { mode: "buffer" }).notNull(),
	},
	(table) => [
		check(
			"packed_export_chunks_kind_check",
			sql`${table.kind} IN ('manifest', 'pending', 'source')`,
		),
		check(
			"packed_export_chunks_data_size_check",
			sql.raw(`length(data) <= ${PACKED_EXPORT_CHUNK_DATA_BYTES}`),
		),
		primaryKey({ columns: [table.exportId, table.kind, table.ordinal] }),
	],
);

/** Gives the synchronous Drizzle adapter its canonical relational models. Engine-specific FTS remains outside this model collection. */
export const vaultSchema = {
	meta,
	files,
	revisions,
	changes,
	receipts,
	exportPins,
	clients,
	revokedGrants,
	blobRefs,
	blobGc,
	exports,
	operationAdmissions,
	mutationClaims,
	packedExports,
	packedExportFiles,
	packedExportChunks,
};
