import type { OperationDescriptor } from "@obsidian-ai-bridge/protocol";
import { FileOperationDenied } from "@worker/application/files";
import type { VaultTransaction } from "@worker/infrastructure/sqlite/admission";
import {
	blobRefs,
	files,
	meta,
} from "@worker/infrastructure/sqlite/schema-model";
import { eq, sql } from "drizzle-orm";

/** Fixed product limits. Test policies may use smaller values through construction. */
export const SQLITE_CAPACITY_LIMITS = Object.freeze({
	databaseAlertBytes: 1_500_000_000,
	databaseLimitBytes: 2_000_000_000,
	liveFileLimit: 10_000,
	historyPressureLimitBytes: 1_000_000_000,
	blobAlertBytes: 4_000_000_000,
});

/** Named capacity thresholds used by native owners and isolated policy tests. */
export type SqliteCapacityLimits = Readonly<{
	databaseAlertBytes: number;
	databaseLimitBytes: number;
	liveFileLimit: number;
	historyPressureLimitBytes: number;
	blobAlertBytes: number;
}>;

/** Canonical database row fields used by logical history payload accounting. */
type RevisionPayloadRow = Readonly<{
	path: string;
	rev: number;
	hash: string;
	size: number;
	kind: string;
	content: string | null;
	blobHash: string | null;
	deleted: number;
	origin: string;
	at: number;
}>;

/** Canonical immutable feed row fields used by logical payload accounting. */
type ChangePayloadRow = Readonly<{
	seq: number;
	op: string;
	path: string;
	rev: number;
	hash: string;
	fromPath?: string | null;
	fromRev?: number | null;
	origin: string;
	at: number;
}>;

/** Canonical receipt fields used by logical history payload accounting. */
type ReceiptPayloadRow = Readonly<{
	clientId: string;
	key: string;
	fingerprint: string;
	status: number;
	body: string;
	at: number;
}>;

/** Construct the SQLite capacity policy and optional lower test thresholds. */
export class SqliteCapacityPolicy {
	constructor(
		private readonly storage: DurableObjectStorage,
		private readonly limits: SqliteCapacityLimits = SQLITE_CAPACITY_LIMITS,
	) {}

	/** Reject new content before publication when native allocation or live files reached a limit. */
	assertCanPublish(tx: VaultTransaction, operation: OperationDescriptor): void {
		if (operation.op !== "delete") {
			const liveFiles = tx
				.select({ count: sql<number>`count(*)` })
				.from(files)
				.where(eq(files.deleted, 0))
				.all()[0]?.count;
			if ((liveFiles ?? 0) >= this.limits.liveFileLimit)
				throw new FileOperationDenied({ kind: "capacity_exceeded" });
			if (this.storage.sql.databaseSize >= this.limits.databaseLimitBytes)
				throw new FileOperationDenied({ kind: "capacity_exceeded" });
		}
	}

	/** Reject non-delete publication and roll back all writes when native allocation crosses the limit. */
	assertPublishedSize(
		_tx: VaultTransaction,
		operation: OperationDescriptor,
	): void {
		if (
			operation.op !== "delete" &&
			this.storage.sql.databaseSize > this.limits.databaseLimitBytes
		)
			throw new FileOperationDenied({ kind: "capacity_exceeded" });
	}
}

/** Count UTF-8 bytes for a JSON array that carries every complete row column in schema order. */
export function logicalPayloadBytes(
	values: readonly (string | number | null)[],
): number {
	const encoded = JSON.stringify(values);
	if (encoded === undefined)
		throw new Error("Logical row payload is not encodable");
	return new TextEncoder().encode(encoded).byteLength;
}

/** Count the complete revision row in fixed column order, including null payload references. */
export function revisionLogicalPayloadBytes(row: RevisionPayloadRow): number {
	return logicalPayloadBytes([
		row.path,
		row.rev,
		row.hash,
		row.size,
		row.kind,
		row.content,
		row.blobHash,
		row.deleted,
		row.origin,
		row.at,
	]);
}

/** Count the complete receipt row in fixed column order. */
export function receiptLogicalPayloadBytes(row: ReceiptPayloadRow): number {
	return logicalPayloadBytes([
		row.clientId,
		row.key,
		row.fingerprint,
		row.status,
		row.body,
		row.at,
	]);
}

/** Count the complete change row in fixed column order, preserving null rename fields. */
export function changeLogicalPayloadBytes(row: ChangePayloadRow): number {
	return logicalPayloadBytes([
		row.seq,
		row.op,
		row.path,
		row.rev,
		row.hash,
		row.fromPath ?? null,
		row.fromRev ?? null,
		row.origin,
		row.at,
	]);
}

/** Add one publication row to its category and total metadata counters in the same transaction. */
export function addLogicalPayload(
	tx: VaultTransaction,
	category: "revisions" | "receipts" | "changes",
	bytes: number,
): void {
	if (!Number.isSafeInteger(bytes) || bytes < 0)
		throw new Error("Invalid logical payload byte count");
	const key = `history_${category}_bytes`;
	const current = readCounter(tx, key);
	const total = readCounter(tx, "history_pressure_bytes");
	if (
		!Number.isSafeInteger(current + bytes) ||
		!Number.isSafeInteger(total + bytes)
	)
		throw new Error("Unsafe logical payload byte count");
	tx.update(meta)
		.set({ value: String(current + bytes) })
		.where(eq(meta.key, key))
		.run();
	tx.update(meta)
		.set({ value: String(total + bytes) })
		.where(eq(meta.key, "history_pressure_bytes"))
		.run();
}

/** Read all summary capacity observations from a transaction and native allocation source. */
export function readCapacitySummary(
	tx: VaultTransaction,
	storage: DurableObjectStorage,
): {
	capacity: {
		database_bytes: number;
		database_limit_bytes: number;
		live_file_limit: number;
		history_pressure_bytes: number;
		referenced_blob_bytes: number;
	};
	attention: string[];
} {
	const databaseBytes = storage.sql.databaseSize;
	const historyBytes = readCounter(tx, "history_pressure_bytes");
	const referencedBlobBytes =
		tx
			.select({ bytes: sql<number>`coalesce(sum(${blobRefs.size}), 0)` })
			.from(blobRefs)
			.all()[0]?.bytes ?? 0;
	const liveFiles =
		tx
			.select({ count: sql<number>`count(*)` })
			.from(files)
			.where(eq(files.deleted, 0))
			.all()[0]?.count ?? 0;
	const attention = capacityAttention(
		databaseBytes,
		liveFiles,
		readCounter(tx, "history_reduced") === 1,
		referencedBlobBytes,
	);
	return {
		capacity: {
			database_bytes: databaseBytes,
			database_limit_bytes: SQLITE_CAPACITY_LIMITS.databaseLimitBytes,
			live_file_limit: SQLITE_CAPACITY_LIMITS.liveFileLimit,
			history_pressure_bytes: historyBytes,
			referenced_blob_bytes: referencedBlobBytes,
		},
		attention,
	};
}

/** Return stable attention codes at exact physical, live-file, and referenced-blob thresholds. */
export function capacityAttention(
	databaseBytes: number,
	liveFiles: number,
	historyReduced: boolean,
	referencedBlobBytes: number,
): string[] {
	const attention: string[] = [];
	if (databaseBytes >= SQLITE_CAPACITY_LIMITS.databaseAlertBytes)
		attention.push("storage_high");
	if (
		databaseBytes >= SQLITE_CAPACITY_LIMITS.databaseLimitBytes ||
		liveFiles >= SQLITE_CAPACITY_LIMITS.liveFileLimit
	)
		attention.push("capacity_exceeded");
	if (historyReduced) attention.push("history_reduced");
	if (referencedBlobBytes >= SQLITE_CAPACITY_LIMITS.blobAlertBytes)
		attention.push("blob_storage_high");
	return attention;
}

/** Read one canonical nonnegative counter from the transaction. */
function readCounter(tx: VaultTransaction, key: string): number {
	const value = tx
		.select({ value: meta.value })
		.from(meta)
		.where(eq(meta.key, key))
		.all()[0]?.value;
	if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value))
		throw new Error(`Invalid vault counter: ${key}`);
	const counter = Number(value);
	if (!Number.isSafeInteger(counter))
		throw new Error(`Unsafe vault counter: ${key}`);
	return counter;
}
