import type { BlobGcStatus } from "@obsidian-ai-bridge/protocol";
import type {
	BlobGcObject,
	BlobGcRepository,
} from "@worker/application/blob-gc";
import type { VaultTransaction } from "@worker/infrastructure/sqlite/admission";
import { isBlobGcRunId } from "@worker/infrastructure/sqlite/blob-gc-id";
import {
	blobGc,
	files,
	meta,
	packedExportFiles,
	packedExports,
	revisions,
	vaultSchema,
} from "@worker/infrastructure/sqlite/schema-model";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";

/** Reserve four fixed predicates so each reachability statement stays below 100 bindings. */
const SQLITE_BLOB_GC_BATCH_SIZE = 96;

/** Persists marked blob hashes and derives reachability from authoritative reference owners. */
export class SqliteBlobGcStore implements BlobGcRepository {
	private readonly db;

	/** Bind this GC authority to the vault's native SQLite store. */
	constructor(storage: DurableObjectStorage) {
		this.db = drizzle(storage, { schema: vaultSchema });
	}

	/** Count unreferenced objects in bounded SQL batches without writing marks. */
	async preview(objects: readonly BlobGcObject[]) {
		let count = 0;
		let bytes = 0;
		for (
			let offset = 0;
			offset < objects.length;
			offset += SQLITE_BLOB_GC_BATCH_SIZE
		) {
			const batch = objects.slice(offset, offset + SQLITE_BLOB_GC_BATCH_SIZE);
			const hashes = batch.map(({ hash }) => hash);
			const referenced = this.referencedHashes(hashes);
			for (const object of batch) {
				if (!referenced.has(object.hash)) {
					count += 1;
					bytes += object.size;
				}
			}
		}
		return { count, bytes };
	}

	/** Start a confirmed inventory with a new identity when no earlier run remains active. */
	async start(): Promise<void> {
		this.db.transaction((tx) => {
			if (readMeta(tx, "blob_gc_phase") !== "idle") return;
			writeMeta(tx, "blob_gc_phase", "marking");
			writeMeta(tx, "blob_gc_cursor", "");
			writeMeta(tx, "blob_gc_run_id", crypto.randomUUID());
			writeMeta(tx, "blob_gc_failure", "");
		});
	}

	/** Read the durable run identity, phase, and opaque R2 continuation cursor. */
	async runState(): Promise<{
		runId: string | null;
		phase: BlobGcStatus["phase"];
		cursor: string | null;
	}> {
		return this.db.transaction((tx) => {
			const phase = readMeta(tx, "blob_gc_phase");
			if (phase !== "idle" && phase !== "marking" && phase !== "deleting")
				throw new Error("Invalid blob-GC phase");
			const runId = readMeta(tx, "blob_gc_run_id");
			if (
				(phase === "idle" && runId !== "") ||
				(phase !== "idle" && !isBlobGcRunId(runId))
			)
				throw new Error("Invalid blob-GC run identity");
			const cursor = readMeta(tx, "blob_gc_cursor");
			return {
				runId: phase === "idle" ? null : runId,
				phase,
				cursor: phase === "marking" && cursor !== "" ? cursor : null,
			};
		});
	}

	/** Persist failure only while the failed inventory page still owns the current state. */
	async recordInventoryFailure(
		runId: string,
		cursor: string | null,
	): Promise<void> {
		this.db.transaction((tx) => {
			if (
				readMeta(tx, "blob_gc_phase") !== "marking" ||
				readMeta(tx, "blob_gc_run_id") !== runId ||
				readMeta(tx, "blob_gc_cursor") !== (cursor ?? "")
			)
				return;
			writeMeta(tx, "blob_gc_failure", "blob_gc_unavailable");
		});
	}

	/** Apply references and advance only when the observed run, phase, and cursor still match. */
	async markAndAdvance(
		runId: string,
		cursor: string | null,
		objects: readonly BlobGcObject[],
		nextCursor: string | null,
	): Promise<boolean> {
		return this.db.transaction((tx) => {
			if (
				readMeta(tx, "blob_gc_phase") !== "marking" ||
				readMeta(tx, "blob_gc_run_id") !== runId ||
				readMeta(tx, "blob_gc_cursor") !== (cursor ?? "")
			)
				return false;
			const markedAt = Date.now();
			let inserted = 0;
			for (
				let offset = 0;
				offset < objects.length;
				offset += SQLITE_BLOB_GC_BATCH_SIZE
			) {
				const batch = objects.slice(offset, offset + SQLITE_BLOB_GC_BATCH_SIZE);
				const hashes = batch.map(({ hash }) => hash);
				const referenced = this.referencedHashes(hashes, tx);
				const alreadyMarked = new Set(
					tx
						.select({ hash: blobGc.hash })
						.from(blobGc)
						.where(inArray(blobGc.hash, hashes))
						.all()
						.map(({ hash }) => hash),
				);
				for (const object of batch) {
					if (referenced.has(object.hash) || alreadyMarked.has(object.hash))
						continue;
					tx.insert(blobGc)
						.values({
							hash: object.hash,
							size: object.size,
							markedAt,
						})
						.run();
					inserted += 1;
				}
			}
			if (inserted > 0) incrementGeneration(tx);
			writeMeta(tx, "blob_gc_cursor", nextCursor ?? "");
			if (nextCursor === null) writeMeta(tx, "blob_gc_phase", "deleting");
			writeMeta(tx, "blob_gc_failure", "");
			return true;
		});
	}

	/** Mark a persisted active claim unknown when a new Durable Object instance starts. */
	markInterruptedDeleteUnknown(): void {
		this.db.transaction((tx) => {
			if (
				readMeta(tx, "blob_gc_delete_owner") !== "" &&
				readMeta(tx, "blob_gc_delete_state") === "active"
			)
				writeMeta(tx, "blob_gc_delete_state", "unknown");
		});
	}

	/** Hold one durable delete claim without a timeout across the full R2 request. */
	async claimDeleteBatch(
		owner: string,
	): Promise<readonly BlobGcObject[] | null> {
		if (!isBlobGcRunId(owner)) throw new Error("Invalid blob-GC delete owner");
		return this.db.transaction((tx) => {
			if (
				readMeta(tx, "blob_gc_phase") !== "deleting" ||
				readMeta(tx, "blob_gc_delete_owner") !== ""
			)
				return null;
			writeMeta(tx, "blob_gc_delete_owner", owner);
			writeMeta(tx, "blob_gc_delete_state", "active");
			return tx
				.select({ hash: blobGc.hash, size: blobGc.size })
				.from(blobGc)
				.orderBy(blobGc.hash)
				.limit(SQLITE_BLOB_GC_BATCH_SIZE)
				.all();
		});
	}

	/** Keep a typed failure and release only the caller's settled delete claim. */
	async recordFailure(owner?: string): Promise<void> {
		this.db.transaction((tx) => {
			if (owner !== undefined) {
				if (readMeta(tx, "blob_gc_delete_owner") !== owner) return;
				writeMeta(tx, "blob_gc_delete_owner", "");
				writeMeta(tx, "blob_gc_delete_state", "");
			}
			writeMeta(tx, "blob_gc_failure", "blob_gc_unavailable");
		});
	}

	/** Clear exact marks and release the delete claim in the same transaction. */
	async clear(objects: readonly BlobGcObject[], owner: string): Promise<void> {
		this.db.transaction((tx) => {
			if (readMeta(tx, "blob_gc_delete_owner") !== owner)
				throw new Error("Blob-GC delete claim changed before settlement");
			let removed = false;
			for (const object of objects) {
				const current = tx
					.select({ hash: blobGc.hash })
					.from(blobGc)
					.where(
						and(eq(blobGc.hash, object.hash), eq(blobGc.size, object.size)),
					)
					.all()[0];
				if (!current) continue;
				tx.delete(blobGc)
					.where(
						and(eq(blobGc.hash, object.hash), eq(blobGc.size, object.size)),
					)
					.run();
				removed = true;
			}
			if (removed) incrementGeneration(tx);
			writeMeta(tx, "blob_gc_delete_owner", "");
			writeMeta(tx, "blob_gc_delete_state", "");
			writeMeta(tx, "blob_gc_failure", "");
		});
	}

	/** Finish only when this delete owner holds the fence and no marks remain. */
	async finish(owner: string): Promise<void> {
		this.db.transaction((tx) => {
			if (
				readMeta(tx, "blob_gc_phase") !== "deleting" ||
				readMeta(tx, "blob_gc_delete_owner") !== owner ||
				tx.select({ hash: blobGc.hash }).from(blobGc).limit(1).all().length > 0
			)
				throw new Error("Blob-GC run cannot finish before delete settlement");
			writeMeta(tx, "blob_gc_phase", "idle");
			writeMeta(tx, "blob_gc_cursor", "");
			writeMeta(tx, "blob_gc_run_id", "");
			writeMeta(tx, "blob_gc_failure", "");
			writeMeta(tx, "blob_gc_delete_owner", "");
			writeMeta(tx, "blob_gc_delete_state", "");
		});
	}

	/** Report phase, delete state, failure, and durable mark totals. */
	async status(): Promise<BlobGcStatus> {
		return this.db.transaction((tx) => {
			const row = tx
				.select({
					count: sql<number>`count(*)`,
					bytes: sql<number>`coalesce(sum(${blobGc.size}), 0)`,
				})
				.from(blobGc)
				.all()[0];
			const phase = readMeta(tx, "blob_gc_phase");
			if (phase !== "idle" && phase !== "marking" && phase !== "deleting")
				throw new Error("Invalid blob-GC phase");
			const failure = readMeta(tx, "blob_gc_failure");
			if (failure !== "" && failure !== "blob_gc_unavailable")
				throw new Error("Invalid blob-GC failure");
			const deleteOwner = readMeta(tx, "blob_gc_delete_owner");
			const deleteState = readMeta(tx, "blob_gc_delete_state");
			if (
				(deleteOwner === "" && deleteState !== "") ||
				(deleteOwner !== "" &&
					deleteState !== "active" &&
					deleteState !== "unknown")
			)
				throw new Error("Invalid blob-GC delete state");
			return {
				phase,
				marked_count: row?.count ?? 0,
				marked_bytes: row?.bytes ?? 0,
				delete_state:
					deleteOwner === ""
						? "idle"
						: deleteState === "active"
							? "active"
							: "unknown",
				failure: failure === "" ? null : failure,
			};
		});
	}

	/** Select candidate hashes referenced by current files, retained revisions, or active exports. */
	private referencedHashes(
		hashes: readonly string[],
		tx: VaultTransaction | typeof this.db = this.db,
	): Set<string> {
		if (hashes.length === 0) return new Set();
		const values = new Set<string>();
		for (const row of tx
			.selectDistinct({ hash: files.blobHash })
			.from(files)
			.where(and(eq(files.deleted, 0), inArray(files.blobHash, hashes)))
			.all())
			if (row.hash) values.add(row.hash);
		for (const row of tx
			.selectDistinct({ hash: revisions.blobHash })
			.from(revisions)
			.where(inArray(revisions.blobHash, hashes))
			.all())
			if (row.hash) values.add(row.hash);
		for (const row of tx
			.selectDistinct({ hash: packedExportFiles.hash })
			.from(packedExportFiles)
			.innerJoin(
				packedExports,
				eq(packedExports.id, packedExportFiles.exportId),
			)
			.where(
				and(
					inArray(packedExportFiles.hash, hashes),
					or(
						eq(packedExports.status, "queued"),
						eq(packedExports.status, "uploading"),
					),
					or(
						eq(packedExportFiles.sourceType, "revision_blob"),
						eq(packedExportFiles.sourceType, "snapshot_blob"),
					),
				),
			)
			.all())
			values.add(row.hash);
		return values;
	}
}

/** Read one present blob-GC metadata value from the active transaction. */
function readMeta(tx: VaultTransaction, key: string): string {
	const value = tx
		.select({ value: meta.value })
		.from(meta)
		.where(eq(meta.key, key))
		.all()[0]?.value;
	if (value === undefined) throw new Error(`Missing blob-GC metadata: ${key}`);
	return value;
}

/** Write one blob-GC control value in the caller's atomic transaction. */
function writeMeta(tx: VaultTransaction, key: string, value: string): void {
	tx.update(meta).set({ value }).where(eq(meta.key, key)).run();
}

/** Parse a canonical, nonnegative publication-fence generation from metadata. */
function parseGeneration(value: string | undefined): number {
	const generation = Number(value);
	if (
		value === undefined ||
		!Number.isSafeInteger(generation) ||
		generation < 0 ||
		String(generation) !== value
	)
		throw new Error("Invalid blob-GC publication generation");
	return generation;
}

/** Advance the durable publication fence in the same transaction as mark changes. */
function incrementGeneration(tx: VaultTransaction): void {
	const row = tx
		.select({ value: meta.value })
		.from(meta)
		.where(eq(meta.key, "blob_gc_generation"))
		.all()[0];
	const current = parseGeneration(row?.value);
	if (!Number.isSafeInteger(current + 1))
		throw new Error("Blob-GC generation limit reached");
	tx.update(meta)
		.set({ value: String(current + 1) })
		.where(eq(meta.key, "blob_gc_generation"))
		.run();
}
