import type {
	ExportFailure,
	ExportOperationResult,
} from "@obsidian-ai-bridge/protocol";
import {
	ExportFailureSchema,
	ExportManifestSchema,
	ExportOperationResultSchema,
} from "@obsidian-ai-bridge/protocol";
import type { BlobContentStore, BlobEvidence } from "@worker/application/blobs";
import type {
	PackedExportFile,
	PackedExportPart,
	PackedExportRepository,
	PackedExportWork,
} from "@worker/application/export";
import {
	EXPORT_PART_BYTES,
	MAX_EXPORT_FILE_COUNT,
	MAX_EXPORT_MANIFEST_BYTES,
	PackedExportLimitFailure,
	PackedExportSourceFailure,
	PackedExportStorageFailure,
} from "@worker/application/export";
import { ZIP32_SOURCE_RANGE_BYTES } from "@worker/application/export-zip";
import { FileOperationDenied } from "@worker/application/files";
import {
	exportPins,
	files,
	meta,
	PACKED_EXPORT_CHUNK_DATA_BYTES,
	PACKED_EXPORT_CHUNK_ROW_OVERHEAD_BYTES,
	packedExportChunks,
	packedExportFiles,
	packedExports,
	revisions,
	SQLITE_BOUND_PARAMETER_LIMIT,
	SQLITE_ROW_BYTE_LIMIT,
	vaultSchema,
} from "@worker/infrastructure/sqlite/schema-model";
import type { Logger } from "drizzle-orm";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
	type DrizzleSqliteDODatabase,
	drizzle,
} from "drizzle-orm/durable-sqlite";

/** Rows in one insert statement stay below SQLite's native parameter limit. */
const SNAPSHOT_FILE_ROW_PARAMETERS = 7;
/** SQL bindings used by each pinned-revision row in one insert statement. */
const SNAPSHOT_PIN_ROW_PARAMETERS = 3;
/** SQL bindings used by each bounded export chunk row in one insert statement. */
const SNAPSHOT_CHUNK_ROW_PARAMETERS = 4;
/** Maximum file rows per insert under SQLite's native parameter ceiling. */
const SNAPSHOT_FILE_INSERT_BATCH = Math.floor(
	SQLITE_BOUND_PARAMETER_LIMIT / SNAPSHOT_FILE_ROW_PARAMETERS,
);
/** Maximum pin rows per insert under SQLite's native parameter ceiling. */
const SNAPSHOT_PIN_INSERT_BATCH = Math.floor(
	SQLITE_BOUND_PARAMETER_LIMIT / SNAPSHOT_PIN_ROW_PARAMETERS,
);
/** Maximum chunk rows per insert under SQLite's native parameter ceiling. */
const SNAPSHOT_CHUNK_INSERT_BATCH = Math.floor(
	SQLITE_BOUND_PARAMETER_LIMIT / SNAPSHOT_CHUNK_ROW_PARAMETERS,
);
/** Native transaction shape for this vault's typed relational tables. */
type PackedExportTransaction = Parameters<
	Parameters<DrizzleSqliteDODatabase<typeof vaultSchema>["transaction"]>[0]
>[0];

/** Captures, pins, resumes, and lists current-file ZIP exports in Durable SQLite. */
export class SqlitePackedExportStore implements PackedExportRepository {
	private readonly db;

	/** Bind the single-vault database and checksum-verified immutable blob reader. */
	constructor(
		private readonly storage: DurableObjectStorage,
		private readonly blobs: BlobContentStore,
		logger?: Logger,
	) {
		this.db = drizzle(storage, { schema: vaultSchema, logger });
	}

	/** Capture head, manifest metadata, snapshot rows, and revision pins atomically. */
	async capture(createdAt: string, now: number): Promise<PackedExportWork> {
		if (!Number.isSafeInteger(now) || now < 0)
			throw new Error("Invalid packed export start time");
		return this.db.transaction((tx) => {
			const epoch = readMeta(tx, "epoch");
			const headSeq = readMetaCounter(tx, "head_seq");
			const id = `${epoch}:${createdAt}`;
			const existing = tx
				.select()
				.from(packedExports)
				.where(
					and(
						eq(packedExports.epoch, epoch),
						eq(packedExports.createdAt, createdAt),
					),
				)
				.all()[0];
			if (existing) return loadWork(tx, existing);

			const captured = tx
				.select({
					path: files.path,
					rev: files.rev,
					hash: files.hash,
					size: files.size,
					kind: files.kind,
					deleted: files.deleted,
					fileBlobHash: files.blobHash,
					fileContentPresent: sql<number>`CASE WHEN ${files.content} IS NULL THEN 0 ELSE 1 END`,
					fileContentBytes: sql<number>`length(CAST(${files.content} AS BLOB))`,
					revisionPath: revisions.path,
					revision: revisions.rev,
					revisionHash: revisions.hash,
					revisionSize: revisions.size,
					revisionKind: revisions.kind,
					revisionBlobHash: revisions.blobHash,
					revisionContentPresent: sql<number>`CASE WHEN ${revisions.content} IS NULL THEN 0 ELSE 1 END`,
					revisionContentBytes: sql<number>`length(CAST(${revisions.content} AS BLOB))`,
					revisionDeleted: revisions.deleted,
				})
				.from(files)
				.leftJoin(
					revisions,
					and(eq(revisions.path, files.path), eq(revisions.rev, files.rev)),
				)
				.where(eq(files.deleted, 0))
				.orderBy(asc(files.path))
				.limit(MAX_EXPORT_FILE_COUNT + 1)
				.all();
			if (captured.length > MAX_EXPORT_FILE_COUNT)
				throw new PackedExportSourceFailure();

			const snapshot: PackedExportFile[] = captured.map((row, ordinal) => {
				if (!row.path || row.deleted !== 0)
					throw new PackedExportSourceFailure();
				const hasRevision = row.revisionPath !== null;
				if (
					hasRevision &&
					(row.path !== row.revisionPath ||
						row.rev !== row.revision ||
						row.hash !== row.revisionHash ||
						row.size !== row.revisionSize ||
						row.kind !== row.revisionKind ||
						row.revisionDeleted !== 0)
				)
					throw new PackedExportSourceFailure();
				if (row.kind === "text") {
					if (
						row.fileContentPresent !== 1 ||
						row.fileContentBytes !== row.size ||
						row.fileBlobHash !== null ||
						(hasRevision &&
							(row.revisionContentPresent !== 1 ||
								row.revisionContentBytes !== row.size ||
								row.revisionBlobHash !== null))
					)
						throw new PackedExportSourceFailure();
				} else if (row.kind === "blob") {
					if (
						row.fileContentPresent !== 0 ||
						row.fileBlobHash !== row.hash ||
						(hasRevision &&
							(row.revisionContentPresent !== 0 ||
								row.revisionBlobHash !== row.hash))
					)
						throw new PackedExportSourceFailure();
				} else {
					throw new PackedExportSourceFailure();
				}
				const sourceType: PackedExportFile["sourceType"] =
					row.kind === "text"
						? hasRevision
							? "revision_text"
							: "snapshot_text"
						: hasRevision
							? "revision_blob"
							: "snapshot_blob";
				return {
					ordinal,
					path: row.path,
					rev: row.rev,
					hash: row.hash,
					size: row.size,
					sourceType,
				};
			});
			if (snapshot.length !== readMetaCounter(tx, "live_file_count"))
				throw new PackedExportSourceFailure();

			const manifest = ExportManifestSchema.parse({
				epoch,
				head_seq: headSeq,
				created_at: createdAt,
				files: snapshot.map(({ path, rev, hash, size }) => ({
					path,
					rev,
					hash,
					size,
				})),
			});
			const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
			if (manifestBytes.byteLength > MAX_EXPORT_MANIFEST_BYTES)
				throw new PackedExportLimitFailure();
			const objectKey = `backups/${epoch}/${createdAt}.zip`;
			tx.insert(packedExports)
				.values([
					{
						id,
						epoch,
						createdAt,
						headSeq,
						status: "queued",
						objectKey,
						startedAt: now,
						finishedAt: null,
						size: null,
						uploadId: null,
						zipState: "",
						manifestSize: manifestBytes.byteLength,
						completedParts: "[]",
						error: null,
					},
				])
				.run();
			insertExportChunks(tx, splitExportChunks(id, "manifest", manifestBytes));
			for (
				let offset = 0;
				offset < snapshot.length;
				offset += SNAPSHOT_FILE_INSERT_BATCH
			) {
				const batch = snapshot.slice(
					offset,
					offset + SNAPSHOT_FILE_INSERT_BATCH,
				);
				tx.insert(packedExportFiles)
					.values(
						batch.map((file) => ({
							exportId: id,
							ordinal: file.ordinal,
							path: file.path,
							rev: file.rev,
							hash: file.hash,
							size: file.size,
							sourceType: file.sourceType,
						})),
					)
					.run();
			}
			for (
				let offset = 0;
				offset < snapshot.length;
				offset += SNAPSHOT_PIN_INSERT_BATCH
			) {
				const batch = snapshot.slice(
					offset,
					offset + SNAPSHOT_PIN_INSERT_BATCH,
				);
				tx.insert(exportPins)
					.values(
						batch.map((file) => ({
							exportId: id,
							path: file.path,
							rev: file.rev,
						})),
					)
					.run();
			}
			insertFrozenTextSources(tx, id, snapshot);

			return loadWork(
				tx,
				tx
					.select()
					.from(packedExports)
					.where(eq(packedExports.id, id))
					.all()[0],
			);
		});
	}

	/** Check for active work without loading manifests or file snapshot rows. */
	async hasActive(): Promise<boolean> {
		return (
			this.db
				.select({ id: packedExports.id })
				.from(packedExports)
				.where(inArray(packedExports.status, ["queued", "uploading"]))
				.limit(1)
				.all()[0] !== undefined
		);
	}

	/** Load the oldest active export and verify stored protocol and checkpoint shapes. */
	async nextActive(): Promise<PackedExportWork | null> {
		return this.db.transaction((tx) => {
			const row = tx
				.select()
				.from(packedExports)
				.where(inArray(packedExports.status, ["queued", "uploading"]))
				.orderBy(asc(packedExports.startedAt), asc(packedExports.id))
				.limit(1)
				.all()[0];
			return row ? loadWork(tx, row) : null;
		});
	}

	/** Read one exact bounded range from the serialized manifest chunks. */
	async readManifestRange(
		exportId: string,
		offset: number,
		length: number,
	): Promise<Uint8Array> {
		const row = this.db
			.select({ manifestSize: packedExports.manifestSize })
			.from(packedExports)
			.where(
				and(
					eq(packedExports.id, exportId),
					inArray(packedExports.status, ["queued", "uploading"]),
				),
			)
			.all()[0];
		if (!row) throw new PackedExportSourceFailure();
		return readExportChunkRange(
			this.storage,
			exportId,
			"manifest",
			0,
			offset,
			length,
			row.manifestSize,
		);
	}

	/** Read one exact pinned or transaction-frozen UTF-8/blob byte range. */
	async readSourceRange(
		exportId: string,
		ordinal: number,
		offset: number,
		length: number,
	): Promise<Uint8Array> {
		validateSourceRange(ordinal, offset, length);
		const row = this.db
			.select({
				path: packedExportFiles.path,
				rev: packedExportFiles.rev,
				hash: packedExportFiles.hash,
				size: packedExportFiles.size,
				sourceType: packedExportFiles.sourceType,
			})
			.from(packedExportFiles)
			.where(
				and(
					eq(packedExportFiles.exportId, exportId),
					eq(packedExportFiles.ordinal, ordinal),
				),
			)
			.all()[0];
		if (!row || offset + length > row.size)
			throw new PackedExportSourceFailure();
		const pin = this.db
			.select({ path: exportPins.path })
			.from(exportPins)
			.where(
				and(
					eq(exportPins.exportId, exportId),
					eq(exportPins.path, row.path),
					eq(exportPins.rev, row.rev),
				),
			)
			.all()[0];
		if (!pin) throw new PackedExportSourceFailure();

		if (row.sourceType === "snapshot_text")
			return readExportChunkRange(
				this.storage,
				exportId,
				"source",
				ordinal,
				offset,
				length,
				row.size,
			);
		if (row.sourceType === "revision_text") {
			const revision = this.db
				.select({
					hash: revisions.hash,
					size: revisions.size,
					kind: revisions.kind,
					blobHash: revisions.blobHash,
					deleted: revisions.deleted,
					contentPresent: sql<number>`CASE WHEN ${revisions.content} IS NULL THEN 0 ELSE 1 END`,
				})
				.from(revisions)
				.where(and(eq(revisions.path, row.path), eq(revisions.rev, row.rev)))
				.all()[0];
			if (
				!revision ||
				revision.hash !== row.hash ||
				revision.size !== row.size ||
				revision.kind !== "text" ||
				revision.deleted !== 0 ||
				revision.blobHash !== null ||
				revision.contentPresent !== 1
			)
				throw new PackedExportSourceFailure();
			const range = this.storage.sql
				.exec<{ bytes: ArrayBuffer | null }>(
					"SELECT substr(CAST(content AS BLOB), ? + 1, ?) AS bytes FROM revisions WHERE path = ? AND rev = ?",
					offset,
					length,
					row.path,
					row.rev,
				)
				.toArray()[0]?.bytes;
			if (!range || range.byteLength !== length)
				throw new PackedExportSourceFailure();
			return new Uint8Array(range);
		}
		if (row.sourceType === "revision_blob") {
			const revision = this.db
				.select({
					hash: revisions.hash,
					size: revisions.size,
					kind: revisions.kind,
					blobHash: revisions.blobHash,
					deleted: revisions.deleted,
					contentPresent: sql<number>`CASE WHEN ${revisions.content} IS NULL THEN 0 ELSE 1 END`,
				})
				.from(revisions)
				.where(and(eq(revisions.path, row.path), eq(revisions.rev, row.rev)))
				.all()[0];
			if (
				!revision ||
				revision.hash !== row.hash ||
				revision.size !== row.size ||
				revision.kind !== "blob" ||
				revision.deleted !== 0 ||
				revision.blobHash !== row.hash ||
				revision.contentPresent !== 0
			)
				throw new PackedExportSourceFailure();
			return this.readBlobRange(row.hash, row.size, offset, length);
		}
		if (row.sourceType === "snapshot_blob")
			return this.readBlobRange(row.hash, row.size, offset, length);
		throw new PackedExportSourceFailure();
	}

	/** Read one exact bounded R2 range after checking the immutable hash and size. */
	private async readBlobRange(
		hash: string,
		size: number,
		offset: number,
		length: number,
	): Promise<Uint8Array> {
		let evidence: BlobEvidence | undefined;
		try {
			evidence = await this.blobs.head(hash);
		} catch {
			throw new PackedExportStorageFailure();
		}
		if (!evidence || evidence.hash !== hash || evidence.size !== size)
			throw new PackedExportSourceFailure();
		try {
			const source = await this.blobs.read(hash, size, {
				start: offset,
				end: offset + length - 1,
			});
			const reader = source.getReader();
			const chunks: Uint8Array[] = [];
			let total = 0;
			try {
				while (total < length) {
					const { done, value } = await reader.read().catch(() => {
						throw new PackedExportStorageFailure();
					});
					if (done || !value || value.byteLength > length - total)
						throw new PackedExportSourceFailure();
					chunks.push(value);
					total += value.byteLength;
				}
			} finally {
				await reader.cancel().catch(() => undefined);
				reader.releaseLock();
			}
			if (total !== length) throw new PackedExportSourceFailure();
			return concatenate(chunks, total);
		} catch (error) {
			if (
				error instanceof PackedExportStorageFailure ||
				(error instanceof FileOperationDenied &&
					error.failure.kind === "blob_storage_unavailable")
			)
				throw new PackedExportStorageFailure();
			throw new PackedExportSourceFailure();
		}
	}

	/** Save the exact next cursor and R2 part receipts if no alarm already advanced it. */
	async checkpoint(
		exportId: string,
		observedZipState: string,
		checkpoint: {
			zipState: string;
			pendingPart: Uint8Array;
			completedParts: readonly PackedExportPart[];
		},
	): Promise<boolean> {
		if (checkpoint.pendingPart.byteLength >= EXPORT_PART_BYTES)
			throw new PackedExportLimitFailure();
		const partsJson = JSON.stringify(checkpoint.completedParts);
		return this.db.transaction((tx) => {
			const changed = tx
				.update(packedExports)
				.set({
					status: "uploading",
					zipState: checkpoint.zipState,
					completedParts: partsJson,
				})
				.where(
					and(
						eq(packedExports.id, exportId),
						eq(packedExports.zipState, observedZipState),
						inArray(packedExports.status, ["queued", "uploading"]),
					),
				)
				.returning({ id: packedExports.id })
				.all();
			if (changed.length !== 1) return false;
			tx.delete(packedExportChunks)
				.where(
					and(
						eq(packedExportChunks.exportId, exportId),
						eq(packedExportChunks.kind, "pending"),
					),
				)
				.run();
			insertExportChunks(
				tx,
				splitExportChunks(exportId, "pending", checkpoint.pendingPart),
			);
			return true;
		});
	}

	/** Persist one R2 multipart id only while the export row has no upload owner. */
	async attachUpload(
		exportId: string,
		observedZipState: string,
		uploadId: string,
	): Promise<boolean> {
		const rows = this.db
			.update(packedExports)
			.set({ uploadId, status: "uploading" })
			.where(
				and(
					eq(packedExports.id, exportId),
					eq(packedExports.zipState, observedZipState),
					eq(packedExports.status, "queued"),
					isNull(packedExports.uploadId),
				),
			)
			.returning({ id: packedExports.id })
			.all();
		return rows.length === 1;
	}

	/** Publish completion and release all source pins in the same transaction. */
	async complete(
		exportId: string,
		observedZipState: string,
		size: number,
	): Promise<boolean> {
		if (!Number.isSafeInteger(size) || size < 1)
			throw new Error("Invalid packed export size");
		return this.db.transaction((tx) => {
			const rows = tx
				.update(packedExports)
				.set({ status: "complete", finishedAt: Date.now(), size, error: null })
				.where(
					and(
						eq(packedExports.id, exportId),
						eq(packedExports.zipState, observedZipState),
						eq(packedExports.status, "uploading"),
					),
				)
				.returning({ id: packedExports.id })
				.all();
			if (rows.length !== 1) return false;
			tx.delete(exportPins).where(eq(exportPins.exportId, exportId)).run();
			tx.delete(packedExportFiles)
				.where(eq(packedExportFiles.exportId, exportId))
				.run();
			tx.delete(packedExportChunks)
				.where(eq(packedExportChunks.exportId, exportId))
				.run();
			return true;
		});
	}

	/** Persist failure and release pins after the caller settles all source work. */
	async fail(
		exportId: string,
		observedZipState: string,
		failure: ExportFailure,
	): Promise<void> {
		const parsedFailure = ExportFailureSchema.parse(failure);
		this.db.transaction((tx) => {
			const rows = tx
				.update(packedExports)
				.set({
					status: "failed",
					finishedAt: Date.now(),
					size: null,
					error: parsedFailure.kind,
				})
				.where(
					and(
						eq(packedExports.id, exportId),
						eq(packedExports.zipState, observedZipState),
						inArray(packedExports.status, ["queued", "uploading"]),
					),
				)
				.returning({ id: packedExports.id })
				.all();
			if (rows.length !== 1) return;
			tx.delete(exportPins).where(eq(exportPins.exportId, exportId)).run();
			tx.delete(packedExportFiles)
				.where(eq(packedExportFiles.exportId, exportId))
				.run();
			tx.delete(packedExportChunks)
				.where(eq(packedExportChunks.exportId, exportId))
				.run();
		});
	}

	/** List every completed archive in newest-first order without exposing object keys. */
	async listCompleted(): Promise<readonly ExportOperationResult[]> {
		return this.db
			.select({
				epoch: packedExports.epoch,
				created_at: packedExports.createdAt,
				status: packedExports.status,
				size: packedExports.size,
				error: packedExports.error,
			})
			.from(packedExports)
			.where(eq(packedExports.status, "complete"))
			.orderBy(asc(packedExports.finishedAt))
			.all()
			.reverse()
			.map(({ epoch, created_at, size }) =>
				ExportOperationResultSchema.parse({
					epoch,
					created_at,
					status: "complete",
					size,
					failure: null,
				}),
			);
	}

	/** Return the R2 key and final size only for one completed export row. */
	async getCompletedArchive(
		exportId: string,
	): Promise<{ key: string; size: number } | null> {
		const row = this.db
			.select({ key: packedExports.objectKey, size: packedExports.size })
			.from(packedExports)
			.where(
				and(
					eq(packedExports.id, exportId),
					eq(packedExports.status, "complete"),
				),
			)
			.all()[0];
		if (
			!row ||
			!Number.isSafeInteger(row.size) ||
			row.size === null ||
			row.size < 1
		)
			return null;
		return { key: row.key, size: row.size };
	}
}

/** One independently bounded SQLite payload row owned by a packed export. */
interface ExportChunkRow {
	exportId: string;
	kind: "manifest" | "pending";
	ordinal: number;
	data: Uint8Array;
}

/** Validate a source index and one ZIP-sized byte range before querying SQLite. */
function validateSourceRange(
	ordinal: number,
	offset: number,
	length: number,
): void {
	if (
		!Number.isSafeInteger(ordinal) ||
		ordinal < 0 ||
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		!Number.isSafeInteger(length) ||
		length < 1 ||
		length > ZIP32_SOURCE_RANGE_BYTES
	)
		throw new PackedExportSourceFailure();
}

/** Return bounded bytes from a manifest or captured-text chunk without selecting its full BLOB. */
function readExportChunkRange(
	storage: DurableObjectStorage,
	exportId: string,
	kind: "manifest" | "source",
	ownerOrdinal: number,
	offset: number,
	length: number,
	totalSize: number,
): Uint8Array {
	validateSourceRange(ownerOrdinal, offset, length);
	if (
		!Number.isSafeInteger(totalSize) ||
		totalSize < 0 ||
		offset + length > totalSize
	)
		throw new PackedExportSourceFailure();
	const result = new Uint8Array(length);
	let copied = 0;
	while (copied < length) {
		const cursor = offset + copied;
		const chunkOrdinal = Math.floor(cursor / PACKED_EXPORT_CHUNK_DATA_BYTES);
		const chunkBase =
			kind === "source" ? 0 : chunkOrdinal * PACKED_EXPORT_CHUNK_DATA_BYTES;
		const rowOrdinal = kind === "source" ? ownerOrdinal : chunkOrdinal;
		const inChunkOffset = cursor - chunkBase;
		const count = Math.min(
			length - copied,
			PACKED_EXPORT_CHUNK_DATA_BYTES - inChunkOffset,
		);
		const expectedChunkBytes =
			kind === "source"
				? totalSize
				: Math.min(PACKED_EXPORT_CHUNK_DATA_BYTES, totalSize - chunkBase);
		const row = storage.sql
			.exec<{ bytes: ArrayBuffer | null; dataBytes: number }>(
				"SELECT substr(data, ? + 1, ?) AS bytes, length(data) AS dataBytes FROM packed_export_chunks WHERE export_id = ? AND kind = ? AND ordinal = ?",
				inChunkOffset,
				count,
				exportId,
				kind,
				rowOrdinal,
			)
			.toArray()[0];
		if (!row || row.dataBytes !== expectedChunkBytes || !row.bytes)
			throw new PackedExportSourceFailure();
		const rangeBytes = new Uint8Array(row.bytes);
		if (rangeBytes.byteLength !== count) throw new PackedExportSourceFailure();
		result.set(rangeBytes, copied);
		copied += count;
	}
	return result;
}

/** Split one encoded member or multipart remainder into row-safe chunks. */
function splitExportChunks(
	exportId: string,
	kind: "manifest" | "pending",
	bytes: Uint8Array,
): ExportChunkRow[] {
	const rows: ExportChunkRow[] = [];
	for (
		let offset = 0, ordinal = 0;
		offset < bytes.byteLength;
		offset += PACKED_EXPORT_CHUNK_DATA_BYTES, ordinal += 1
	) {
		const data = bytes.slice(
			offset,
			Math.min(offset + PACKED_EXPORT_CHUNK_DATA_BYTES, bytes.byteLength),
		);
		assertExportChunkRowSize(exportId, kind, ordinal, data.byteLength);
		rows.push({ exportId, kind, ordinal, data });
	}
	return rows;
}

/** Insert chunk rows in statements that stay under SQLite's bound-parameter limit. */
function insertExportChunks(
	tx: PackedExportTransaction,
	rows: readonly ExportChunkRow[],
): void {
	for (
		let offset = 0;
		offset < rows.length;
		offset += SNAPSHOT_CHUNK_INSERT_BATCH
	) {
		const batch = rows.slice(offset, offset + SNAPSHOT_CHUNK_INSERT_BATCH);
		tx.insert(packedExportChunks)
			.values(
				batch.map(({ exportId, kind, ordinal, data }) => ({
					exportId,
					kind,
					ordinal,
					data: data as typeof packedExportChunks.$inferSelect.data,
				})),
			)
			.run();
	}
}

/** Copy only pruned current text payloads into their immutable export snapshot rows. */
function insertFrozenTextSources(
	tx: PackedExportTransaction,
	exportId: string,
	filesSnapshot: readonly PackedExportFile[],
): void {
	const snapshotText = filesSnapshot.filter(
		(file) => file.sourceType === "snapshot_text",
	);
	const batchSize = Math.floor(SQLITE_BOUND_PARAMETER_LIMIT / 3);
	for (let offset = 0; offset < snapshotText.length; offset += batchSize) {
		const batch = snapshotText.slice(offset, offset + batchSize);
		for (const file of batch)
			assertExportChunkRowSize(exportId, "source", file.ordinal, file.size);
		const inserts = batch.map(
			(file) =>
				sql`SELECT ${exportId}, 'source', ${file.ordinal}, CAST(content AS BLOB) FROM files WHERE path = ${file.path} AND deleted = 0 AND content IS NOT NULL`,
		);
		tx.run(
			sql`INSERT INTO packed_export_chunks (export_id, kind, ordinal, data) ${sql.join(inserts, sql` UNION ALL `)}`,
		);
	}
}

/** Include encoded keys, scalar fields, and conservative SQLite record overhead in row bounds. */
function assertExportChunkRowSize(
	exportId: string,
	kind: string,
	ordinal: number,
	dataBytes: number,
): void {
	const encoder = new TextEncoder();
	const rowBytes =
		encoder.encode(exportId).byteLength +
		encoder.encode(kind).byteLength +
		encoder.encode(String(ordinal)).byteLength +
		dataBytes +
		PACKED_EXPORT_CHUNK_ROW_OVERHEAD_BYTES;
	if (
		!Number.isSafeInteger(dataBytes) ||
		dataBytes < 0 ||
		dataBytes > PACKED_EXPORT_CHUNK_DATA_BYTES ||
		rowBytes > SQLITE_ROW_BYTE_LIMIT
	)
		throw new PackedExportLimitFailure();
}

/** Validate contiguous manifest or pending chunks and their estimated complete row sizes. */
function validateChunkLengths(
	exportId: string,
	kind: "manifest" | "pending",
	rows: readonly { ordinal: number; dataBytes: number }[],
	totalBytes: number,
): void {
	const expectedCount = Math.ceil(totalBytes / PACKED_EXPORT_CHUNK_DATA_BYTES);
	if (
		!Number.isSafeInteger(totalBytes) ||
		totalBytes < 0 ||
		rows.length !== expectedCount
	)
		throw new Error(`Invalid packed export ${kind} chunk count`);
	for (const [index, row] of rows.entries()) {
		const expectedBytes = Math.min(
			PACKED_EXPORT_CHUNK_DATA_BYTES,
			totalBytes - index * PACKED_EXPORT_CHUNK_DATA_BYTES,
		);
		if (row.ordinal !== index || row.dataBytes !== expectedBytes)
			throw new Error(`Invalid packed export ${kind} chunk sequence`);
		assertExportChunkRowSize(exportId, kind, row.ordinal, row.dataBytes);
	}
}

/** Verify that each frozen-text source chunk matches its captured file row. */
function validateFrozenSourceChunks(
	tx: PackedExportTransaction,
	exportId: string,
	filesSnapshot: readonly PackedExportFile[],
): void {
	const actual = tx
		.select({
			ordinal: packedExportChunks.ordinal,
			dataBytes: sql<number>`length(${packedExportChunks.data})`,
		})
		.from(packedExportChunks)
		.where(
			and(
				eq(packedExportChunks.exportId, exportId),
				eq(packedExportChunks.kind, "source"),
			),
		)
		.orderBy(asc(packedExportChunks.ordinal))
		.all();
	const expected = filesSnapshot
		.filter((file) => file.sourceType === "snapshot_text")
		.map(({ ordinal, size }) => ({ ordinal, dataBytes: size }));
	if (actual.length !== expected.length)
		throw new Error(
			"Packed export frozen text sources differ from its snapshot",
		);
	for (const [index, row] of actual.entries()) {
		const file = expected[index];
		if (
			!file ||
			row.ordinal !== file.ordinal ||
			row.dataBytes !== file.dataBytes
		)
			throw new Error(
				"Packed export frozen text source size differs from its snapshot",
			);
		assertExportChunkRowSize(exportId, "source", row.ordinal, row.dataBytes);
	}
}

/** Parse one persisted source choice without accepting a future storage spelling. */
function parseSourceType(value: string): PackedExportFile["sourceType"] {
	if (
		value === "revision_text" ||
		value === "revision_blob" ||
		value === "snapshot_text" ||
		value === "snapshot_blob"
	)
		return value;
	throw new Error("Invalid packed export source type");
}

/** Load and validate one persisted export row with bounded manifest and remainder chunks. */
function loadWork(
	tx: PackedExportTransaction,
	row: typeof packedExports.$inferSelect | undefined,
): PackedExportWork {
	if (!row) throw new Error("Packed export row disappeared");
	const active = row.status === "queued" || row.status === "uploading";
	const filesSnapshot = tx
		.select()
		.from(packedExportFiles)
		.where(eq(packedExportFiles.exportId, row.id))
		.orderBy(asc(packedExportFiles.ordinal))
		.all()
		.map(({ exportId: _exportId, ...file }) => ({
			...file,
			sourceType: parseSourceType(file.sourceType),
		}));
	const manifestChunks = tx
		.select({
			ordinal: packedExportChunks.ordinal,
			dataBytes: sql<number>`length(${packedExportChunks.data})`,
		})
		.from(packedExportChunks)
		.where(
			and(
				eq(packedExportChunks.exportId, row.id),
				eq(packedExportChunks.kind, "manifest"),
			),
		)
		.orderBy(asc(packedExportChunks.ordinal))
		.all();
	const pendingChunks = tx
		.select({
			ordinal: packedExportChunks.ordinal,
			data: packedExportChunks.data,
		})
		.from(packedExportChunks)
		.where(
			and(
				eq(packedExportChunks.exportId, row.id),
				eq(packedExportChunks.kind, "pending"),
			),
		)
		.orderBy(asc(packedExportChunks.ordinal))
		.all();
	const allChunkKinds = tx
		.select({ kind: packedExportChunks.kind })
		.from(packedExportChunks)
		.where(eq(packedExportChunks.exportId, row.id))
		.all();
	let pendingPart: Uint8Array = new Uint8Array();
	if (active) {
		validateChunkLengths(row.id, "manifest", manifestChunks, row.manifestSize);
		const pendingRows = pendingChunks.map(({ ordinal, data }) => ({
			ordinal,
			dataBytes: data.byteLength,
		}));
		const pendingSize = pendingRows.reduce(
			(total, item) => total + item.dataBytes,
			0,
		);
		validateChunkLengths(row.id, "pending", pendingRows, pendingSize);
		if (pendingSize >= EXPORT_PART_BYTES)
			throw new Error("Packed export remainder exceeds its multipart bound");
		pendingPart = concatenate(
			pendingChunks.map(({ data }) => Uint8Array.from(data)),
			pendingSize,
		);
		if (
			filesSnapshot.length > MAX_EXPORT_FILE_COUNT ||
			filesSnapshot.some((file, index) => file.ordinal !== index)
		)
			throw new Error("Packed export snapshot ordinals are invalid");
		validateFrozenSourceChunks(tx, row.id, filesSnapshot);
	} else if (
		filesSnapshot.length !== 0 ||
		manifestChunks.length !== 0 ||
		pendingChunks.length !== 0 ||
		allChunkKinds.length !== 0
	) {
		throw new Error("Terminal packed export retains source data");
	}
	const parts = parseParts(row.completedParts);
	const failure = row.error
		? ExportFailureSchema.parse({ kind: row.error })
		: null;
	const operation = ExportOperationResultSchema.parse({
		epoch: row.epoch,
		created_at: row.createdAt,
		status: row.status,
		size: row.size,
		failure,
	});
	return {
		...operation,
		id: row.id,
		objectKey: row.objectKey,
		startedAt: row.startedAt,
		uploadId: row.uploadId,
		manifestSize: row.manifestSize,
		files: filesSnapshot,
		zipState: row.zipState,
		pendingPart,
		completedParts: parts,
	};
}

/** Parse exact R2 multipart receipts from persisted JSON without accepting unknown fields. */
function parseParts(value: string): PackedExportPart[] {
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed))
		throw new Error("Invalid packed export part list");
	const parts: PackedExportPart[] = [];
	for (const [index, part] of parsed.entries()) {
		if (
			typeof part !== "object" ||
			part === null ||
			!("partNumber" in part) ||
			!("etag" in part) ||
			part.partNumber !== index + 1 ||
			typeof part.etag !== "string" ||
			part.etag.length === 0 ||
			Object.keys(part).length !== 2
		)
			throw new Error("Invalid packed export part receipt");
		parts.push({ partNumber: part.partNumber, etag: part.etag });
	}
	return parts;
}

/** Read a required string from SQLite vault metadata. */
function readMeta(tx: PackedExportTransaction, key: string): string {
	const row = tx.select().from(meta).where(eq(meta.key, key)).all()[0];
	if (!row || typeof row.value !== "string")
		throw new Error(`Missing vault metadata: ${key}`);
	return row.value;
}

/** Read one canonical nonnegative integer counter from SQLite metadata. */
function readMetaCounter(tx: PackedExportTransaction, key: string): number {
	const value = Number(readMeta(tx, key));
	if (!Number.isSafeInteger(value) || value < 0)
		throw new Error(`Invalid vault metadata counter: ${key}`);
	return value;
}

/** Concatenate one bounded R2 range response after exact byte-count checks. */
function concatenate(chunks: Uint8Array[], size: number): Uint8Array {
	const result = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}
