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
	MAX_EXPORT_FILE_COUNT,
	PackedExportSourceFailure,
	PackedExportStorageFailure,
} from "@worker/application/export";
import { ZIP32_SOURCE_RANGE_BYTES } from "@worker/application/export-zip";
import { FileOperationDenied } from "@worker/application/files";
import {
	exportPins,
	files,
	meta,
	packedExportFiles,
	packedExports,
	revisions,
	vaultSchema,
} from "@worker/infrastructure/sqlite/schema-model";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
	type DrizzleSqliteDODatabase,
	drizzle,
} from "drizzle-orm/durable-sqlite";

/** Rows in one insert statement stay below SQLite's native parameter limit. */
const SNAPSHOT_INSERT_BATCH = 100;
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
	) {
		this.db = drizzle(storage, { schema: vaultSchema });
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
					deleted: files.deleted,
					revisionPath: revisions.path,
					revision: revisions.rev,
					revisionHash: revisions.hash,
					revisionSize: revisions.size,
					revisionDeleted: revisions.deleted,
				})
				.from(files)
				.innerJoin(
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
				if (
					!row.path ||
					row.path !== row.revisionPath ||
					row.rev !== row.revision ||
					row.hash !== row.revisionHash ||
					row.size !== row.revisionSize ||
					row.deleted !== 0 ||
					row.revisionDeleted !== 0
				)
					throw new PackedExportSourceFailure();
				return {
					ordinal,
					path: row.path,
					rev: row.rev,
					hash: row.hash,
					size: row.size,
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
						pendingPart:
							new Uint8Array() as typeof packedExports.$inferSelect.pendingPart,
						completedParts: "[]",
						manifest: JSON.stringify(manifest),
						error: null,
					},
				])
				.run();
			for (
				let offset = 0;
				offset < snapshot.length;
				offset += SNAPSHOT_INSERT_BATCH
			) {
				const batch = snapshot.slice(offset, offset + SNAPSHOT_INSERT_BATCH);
				tx.insert(packedExportFiles)
					.values(
						batch.map((file) => ({
							exportId: id,
							ordinal: file.ordinal,
							path: file.path,
							rev: file.rev,
							hash: file.hash,
							size: file.size,
						})),
					)
					.run();
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

	/** Read one pinned UTF-8 or blob byte range without materializing the whole revision. */
	async readSourceRange(
		exportId: string,
		ordinal: number,
		offset: number,
		length: number,
	): Promise<Uint8Array> {
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
		const row = this.db
			.select({
				path: packedExportFiles.path,
				rev: packedExportFiles.rev,
				hash: packedExportFiles.hash,
				size: packedExportFiles.size,
				revisionHash: revisions.hash,
				revisionSize: revisions.size,
				kind: revisions.kind,
				content: revisions.content,
				blobHash: revisions.blobHash,
				deleted: revisions.deleted,
			})
			.from(packedExportFiles)
			.innerJoin(
				revisions,
				and(
					eq(revisions.path, packedExportFiles.path),
					eq(revisions.rev, packedExportFiles.rev),
				),
			)
			.where(
				and(
					eq(packedExportFiles.exportId, exportId),
					eq(packedExportFiles.ordinal, ordinal),
				),
			)
			.all()[0];
		if (
			!row ||
			row.hash !== row.revisionHash ||
			row.size !== row.revisionSize ||
			row.deleted !== 0 ||
			offset + length > row.size
		)
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

		if (row.kind === "text") {
			if (row.content === null || row.blobHash !== null)
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
		if (row.kind !== "blob" || row.blobHash !== row.hash)
			throw new PackedExportSourceFailure();
		let evidence: BlobEvidence | undefined;
		try {
			evidence = await this.blobs.head(row.hash);
		} catch {
			throw new PackedExportStorageFailure();
		}
		if (!evidence || evidence.hash !== row.hash || evidence.size !== row.size)
			throw new PackedExportSourceFailure();
		try {
			const source = await this.blobs.read(row.hash, row.size, {
				start: offset,
				end: offset + length - 1,
			});
			const reader = source.getReader();
			const chunks: Uint8Array[] = [];
			let total = 0;
			try {
				while (total < length) {
					let item: ReadableStreamReadResult<Uint8Array>;
					try {
						item = await reader.read();
					} catch {
						throw new PackedExportStorageFailure();
					}
					const { done, value } = item;
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
		const partsJson = JSON.stringify(checkpoint.completedParts);
		const changed = this.db
			.update(packedExports)
			.set({
				status: "uploading",
				zipState: checkpoint.zipState,
				pendingPart:
					checkpoint.pendingPart as typeof packedExports.$inferSelect.pendingPart,
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
		return changed.length === 1;
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

/** Load and validate one persisted export row with its immutable file snapshot. */
function loadWork(
	tx: PackedExportTransaction,
	row: typeof packedExports.$inferSelect | undefined,
): PackedExportWork {
	if (!row) throw new Error("Packed export row disappeared");
	const manifest = ExportManifestSchema.parse(JSON.parse(row.manifest));
	if (
		manifest.epoch !== row.epoch ||
		manifest.created_at !== row.createdAt ||
		manifest.head_seq !== row.headSeq
	)
		throw new Error("Packed export manifest identity differs from its row");
	const filesSnapshot = tx
		.select()
		.from(packedExportFiles)
		.where(eq(packedExportFiles.exportId, row.id))
		.orderBy(asc(packedExportFiles.ordinal))
		.all()
		.map(({ exportId: _exportId, ...file }) => file);
	if (
		(row.status === "queued" || row.status === "uploading") &&
		(filesSnapshot.length !== manifest.files.length ||
			filesSnapshot.some(
				(file, index) =>
					file.ordinal !== index ||
					file.path !== manifest.files[index]?.path ||
					file.rev !== manifest.files[index]?.rev ||
					file.hash !== manifest.files[index]?.hash ||
					file.size !== manifest.files[index]?.size,
			))
	)
		throw new Error("Packed export snapshot differs from its manifest");
	if (
		row.status !== "queued" &&
		row.status !== "uploading" &&
		filesSnapshot.length !== 0
	)
		throw new Error("Terminal packed export retains source pins");
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
		manifest: row.manifest,
		files: filesSnapshot,
		zipState: row.zipState,
		pendingPart: Uint8Array.from(row.pendingPart),
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
