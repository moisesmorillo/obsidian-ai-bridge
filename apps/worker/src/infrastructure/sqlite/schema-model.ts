import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** Relational §5.2 schema; timestamp fields (`*_at` and `at`) are plain Unix-millisecond integers, not Drizzle timestamp modes. */
export const meta = sqliteTable(
	"meta",
	{
		key: text("key"),
		value: text("value").notNull(),
	},
	(table) => [primaryKey({ columns: [table.key] })],
);

export const files = sqliteTable(
	"files",
	{
		path: text("path"),
		pathKey: text("path_key").notNull(),
		rev: integer("rev").notNull(),
		seq: integer("seq").notNull(),
		hash: text("hash").notNull(),
		size: integer("size").notNull(),
		kind: text("kind").notNull(),
		content: text("content"),
		blobHash: text("blob_hash"),
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

export const revisions = sqliteTable(
	"revisions",
	{
		path: text("path").notNull(),
		rev: integer("rev").notNull(),
		hash: text("hash").notNull(),
		size: integer("size").notNull(),
		kind: text("kind").notNull(),
		content: text("content"),
		blobHash: text("blob_hash"),
		deleted: integer("deleted").notNull(),
		origin: text("origin").notNull(),
		at: integer("at").notNull(),
	},
	(table) => [primaryKey({ columns: [table.path, table.rev] })],
);

export const changes = sqliteTable(
	"changes",
	{
		seq: integer("seq").primaryKey({ autoIncrement: true }).notNull(),
		op: text("op").notNull(),
		path: text("path").notNull(),
		rev: integer("rev").notNull(),
		hash: text("hash").notNull(),
		fromPath: text("from_path"),
		fromRev: integer("from_rev"),
		origin: text("origin").notNull(),
		at: integer("at").notNull(),
	},
	(table) => [
		check("changes_op_check", sql`${table.op} IN ('put', 'delete', 'rename')`),
	],
);

export const receipts = sqliteTable(
	"receipts",
	{
		clientId: text("client_id").notNull(),
		key: text("key").notNull(),
		fingerprint: text("fingerprint").notNull(),
		status: integer("status").notNull(),
		body: text("body").notNull(),
		at: integer("at").notNull(),
	},
	(table) => [primaryKey({ columns: [table.clientId, table.key] })],
);

export const exportPins = sqliteTable(
	"export_pins",
	{
		exportId: text("export_id").notNull(),
		path: text("path").notNull(),
		rev: integer("rev").notNull(),
	},
	(table) => [primaryKey({ columns: [table.exportId, table.path, table.rev] })],
);

export const clients = sqliteTable(
	"clients",
	{
		id: text("id"),
		name: text("name").notNull(),
		kind: text("kind").notNull(),
		createdAt: integer("created_at").notNull(),
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

export const revokedGrants = sqliteTable(
	"revoked_grants",
	{
		grantId: text("grant_id"),
		at: integer("at").notNull(),
	},
	(table) => [primaryKey({ columns: [table.grantId] })],
);

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

export const blobRefs = sqliteTable(
	"blob_refs",
	{
		hash: text("hash"),
		size: integer("size").notNull(),
		firstRefAt: integer("first_ref_at").notNull(),
	},
	(table) => [primaryKey({ columns: [table.hash] })],
);

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
	exports,
	operationAdmissions,
};
