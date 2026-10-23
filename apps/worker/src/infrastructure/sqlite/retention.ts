import type { VaultTransaction } from "@worker/infrastructure/sqlite/admission";
import {
	changeLogicalPayloadBytes,
	readCounter,
	receiptLogicalPayloadBytes,
	revisionLogicalPayloadBytes,
	SQLITE_CAPACITY_LIMITS,
	subtractLogicalPayload,
} from "@worker/infrastructure/sqlite/capacity";
import {
	changes,
	exportPins,
	meta,
	receipts,
	revisions,
	vaultSchema,
} from "@worker/infrastructure/sqlite/schema-model";
import type { Logger } from "drizzle-orm";
import { and, asc, eq, lt, notExists, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";

/** Milliseconds in one policy day for UTC retention comparisons. */
const DAY_MS = 24 * 60 * 60 * 1000;
/** Composite-key batch size keeps per-identity operations far below SQLite's bind cap. */
const BATCH_SIZE = 49;
/** Feed rows use one sequence binding, so the native batch limit stays at 64 identities. */
const FEED_BATCH_SIZE = 64;
/** Durable category order gives each alarm one bounded type of deletion work. */
const RETENTION_CATEGORIES = [
	"changes",
	"receipts",
	"ordinary_revisions",
	"pressure_revisions",
] as const;
/** Closed meta cursor values used to resume category work after interruption. */
type RetentionCategory = (typeof RETENTION_CATEGORIES)[number];
/** Internal pressure threshold, lowerable only by native tests. */
type RetentionLimits = Readonly<{ historyPressureLimitBytes: number }>;
/** Complete change row selected for feed-boundary and counter updates. */
type ChangeRow = typeof changes.$inferSelect;
/** Complete receipt row selected for exact logical-byte decrements. */
type ReceiptRow = typeof receipts.$inferSelect;
/** Complete revision row selected for exact logical-byte decrements. */
type RevisionRow = typeof revisions.$inferSelect;

/** Applies one bounded retention batch to one vault's SQLite history. */
export class SqliteRetentionStore {
	private readonly db;
	private readonly historyPressureLimitBytes: number;

	/** Bind native vault storage, an internal test threshold, and optional SQL observation. */
	constructor(
		storage: DurableObjectStorage,
		limits: RetentionLimits = {
			historyPressureLimitBytes:
				SQLITE_CAPACITY_LIMITS.historyPressureLimitBytes,
		},
		logger?: Logger,
	) {
		if (
			!Number.isSafeInteger(limits.historyPressureLimitBytes) ||
			limits.historyPressureLimitBytes < 0
		)
			throw new Error("Invalid retention pressure limit");
		this.historyPressureLimitBytes = limits.historyPressureLimitBytes;
		this.db = drizzle(storage, { schema: vaultSchema, logger });
	}

	/** Delete one category batch transactionally and report remaining work and pressure reduction. */
	runBatch(now: number): { more: boolean; historyReduced: boolean } {
		if (!Number.isSafeInteger(now) || now < 0)
			throw new Error("Invalid retention time");
		return this.db.transaction((tx) => {
			validateRetentionMetadata(tx);
			const category = readRetentionCategory(tx);
			for (const candidate of orderedCategories(category)) {
				const deleted = this.deleteCategory(tx, candidate, now);
				if (deleted !== null) {
					const more = hasEligibleRows(
						tx,
						candidate,
						now,
						this.historyPressureLimitBytes,
					);
					const nextCategory = more ? candidate : nextAfter(candidate);
					writeRetentionCategory(tx, nextCategory);
					return {
						more:
							more ||
							orderedCategories(nextCategory).some((next) =>
								hasEligibleRows(tx, next, now, this.historyPressureLimitBytes),
							),
						historyReduced:
							candidate === "pressure_revisions" && deleted.length > 0,
					};
				}
			}
			writeRetentionCategory(tx, "changes");
			return { more: false, historyReduced: false };
		});
	}

	/** Delete the selected rows and update counters and the durable feed boundary atomically. */
	private deleteCategory(
		tx: VaultTransaction,
		category: RetentionCategory,
		now: number,
	): (ChangeRow | ReceiptRow | RevisionRow)[] | null {
		const cutoff30 = now - 30 * DAY_MS;
		if (category === "changes") {
			const selected = tx
				.select()
				.from(changes)
				.where(lt(changes.at, cutoff30))
				.orderBy(asc(changes.seq))
				.limit(FEED_BATCH_SIZE)
				.all();
			if (selected.length === 0) return null;
			let bytes = 0;
			for (const row of selected) {
				tx.delete(changes).where(eq(changes.seq, row.seq)).run();
				bytes += changeLogicalPayloadBytes({
					seq: row.seq,
					op: row.op,
					path: row.path,
					rev: row.rev,
					hash: row.hash,
					fromPath: row.fromPath,
					fromRev: row.fromRev,
					origin: row.origin,
					at: row.at,
				});
			}
			subtractLogicalPayload(tx, "changes", bytes);
			const boundary = Math.max(...selected.map(({ seq }) => seq)) + 1;
			writeMaxCounter(tx, "retention_pruned_feed_seq", boundary);
			return selected;
		}
		if (category === "receipts") {
			const selected = tx
				.select()
				.from(receipts)
				.where(lt(receipts.at, cutoff30))
				.orderBy(asc(receipts.at), asc(receipts.clientId), asc(receipts.key))
				.limit(BATCH_SIZE)
				.all();
			if (selected.length === 0) return null;
			let bytes = 0;
			for (const row of selected) {
				tx.delete(receipts)
					.where(
						and(eq(receipts.clientId, row.clientId), eq(receipts.key, row.key)),
					)
					.run();
				bytes += receiptLogicalPayloadBytes({
					clientId: row.clientId,
					key: row.key,
					fingerprint: row.fingerprint,
					status: row.status,
					body: row.body,
					at: row.at,
				});
			}
			subtractLogicalPayload(tx, "receipts", bytes);
			return selected;
		}
		const pressure = category === "pressure_revisions";
		const ageCutoff = pressure ? now - 7 * DAY_MS : cutoff30;
		const pinned = notExists(
			tx
				.select({ one: sql`1` })
				.from(exportPins)
				.where(
					and(
						eq(exportPins.path, revisions.path),
						eq(exportPins.rev, revisions.rev),
					),
				),
		);
		const olderThanOrdinary = pressure
			? sql`1 = 1`
			: lt(revisions.at, cutoff30);
		const overPressure = pressure
			? sql`CAST((SELECT value FROM meta WHERE key = 'history_pressure_bytes') AS INTEGER) > ${this.historyPressureLimitBytes}`
			: sql`1 = 1`;
		const selected = tx
			.select()
			.from(revisions)
			.where(
				and(
					lt(revisions.at, ageCutoff),
					olderThanOrdinary,
					pinned,
					overPressure,
				),
			)
			.orderBy(asc(revisions.at), asc(revisions.path), asc(revisions.rev))
			.limit(BATCH_SIZE)
			.all();
		if (selected.length === 0) return null;
		const deleted: RevisionRow[] = [];
		for (const row of selected) {
			tx.delete(revisions)
				.where(and(eq(revisions.path, row.path), eq(revisions.rev, row.rev)))
				.run();
			const rowBytes = revisionLogicalPayloadBytes({
				path: row.path,
				rev: row.rev,
				hash: row.hash,
				size: row.size,
				kind: row.kind,
				content: row.content,
				blobHash: row.blobHash,
				deleted: row.deleted,
				origin: row.origin,
				at: row.at,
			});
			deleted.push(row);
			subtractLogicalPayload(tx, "revisions", rowBytes);
			if (
				pressure &&
				readCounter(tx, "history_pressure_bytes") <=
					this.historyPressureLimitBytes
			)
				break;
		}
		if (pressure)
			tx.update(meta)
				.set({ value: "1" })
				.where(eq(meta.key, "history_reduced"))
				.run();
		return deleted;
	}
}

/** Order categories from the durable cursor, then wrap to find work left by interruption. */
function orderedCategories(current: RetentionCategory): RetentionCategory[] {
	const start = RETENTION_CATEGORIES.indexOf(current);
	return RETENTION_CATEGORIES.map(
		(_, offset) =>
			RETENTION_CATEGORIES[(start + offset) % RETENTION_CATEGORIES.length],
	);
}

/** Return the category after the completed category, wrapping to the first category. */
function nextAfter(category: RetentionCategory): RetentionCategory {
	const index = RETENTION_CATEGORIES.indexOf(category);
	return RETENTION_CATEGORIES[(index + 1) % RETENTION_CATEGORIES.length];
}

/** Check whether a category still contains eligible rows without materializing its history. */
function hasEligibleRows(
	tx: VaultTransaction,
	category: RetentionCategory,
	now: number,
	pressureLimit: number,
): boolean {
	const cutoff30 = now - 30 * DAY_MS;
	if (category === "changes")
		return (
			tx
				.select({ seq: changes.seq })
				.from(changes)
				.where(lt(changes.at, cutoff30))
				.limit(1)
				.all().length > 0
		);
	if (category === "receipts")
		return (
			tx
				.select({ key: receipts.key })
				.from(receipts)
				.where(lt(receipts.at, cutoff30))
				.limit(1)
				.all().length > 0
		);
	const pressure = category === "pressure_revisions";
	const conditions = [
		lt(revisions.at, pressure ? now - 7 * DAY_MS : cutoff30),
		notExists(
			tx
				.select({ one: sql`1` })
				.from(exportPins)
				.where(
					and(
						eq(exportPins.path, revisions.path),
						eq(exportPins.rev, revisions.rev),
					),
				),
		),
	];
	if (pressure)
		conditions.push(
			sql`CAST((SELECT value FROM meta WHERE key = 'history_pressure_bytes') AS INTEGER) > ${pressureLimit}`,
		);
	return (
		tx
			.select({ path: revisions.path })
			.from(revisions)
			.where(and(...conditions))
			.limit(1)
			.all().length > 0
	);
}

/** Validate counters and feed state before any destructive retention effect. */
function validateRetentionMetadata(tx: VaultTransaction): void {
	const revisionsBytes = readCounter(tx, "history_revisions_bytes");
	const receiptsBytes = readCounter(tx, "history_receipts_bytes");
	const changesBytes = readCounter(tx, "history_changes_bytes");
	const totalBytes = readCounter(tx, "history_pressure_bytes");
	const historyReduced = readCounter(tx, "history_reduced");
	readCounter(tx, "retention_pruned_feed_seq");
	if (
		revisionsBytes + receiptsBytes + changesBytes !== totalBytes ||
		!Number.isSafeInteger(totalBytes) ||
		(historyReduced !== 0 && historyReduced !== 1)
	)
		throw new Error("Invalid logical history metadata");
}

/** Validate persisted category progress and fail closed on malformed native metadata. */
function readRetentionCategory(tx: VaultTransaction): RetentionCategory {
	const value = tx
		.select({ value: meta.value })
		.from(meta)
		.where(eq(meta.key, "retention_category"))
		.all()[0]?.value;
	if (value === undefined || !isRetentionCategory(value))
		throw new Error("Invalid retention category progress");
	return value;
}

/** Check the closed persisted category spelling without accepting unknown future values. */
function isRetentionCategory(value: string): value is RetentionCategory {
	return RETENTION_CATEGORIES.some((category) => category === value);
}

/** Persist the next category cursor inside the same transaction as its deletions. */
function writeRetentionCategory(
	tx: VaultTransaction,
	category: RetentionCategory,
): void {
	tx.update(meta)
		.set({ value: category })
		.where(eq(meta.key, "retention_category"))
		.run();
}

/** Raise the persisted feed boundary without allowing repeated alarms to lower it. */
function writeMaxCounter(
	tx: VaultTransaction,
	key: string,
	next: number,
): void {
	if (!Number.isSafeInteger(next) || next < 0)
		throw new Error("Invalid pruned feed boundary");
	const current = readCounter(tx, key);
	const boundary = Math.max(current, next);
	if (!Number.isSafeInteger(boundary))
		throw new Error("Unsafe pruned feed boundary");
	tx.update(meta)
		.set({ value: String(boundary) })
		.where(eq(meta.key, key))
		.run();
}
