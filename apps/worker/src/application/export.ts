import type {
	ExportFailure,
	ExportOperationResult,
} from "@obsidian-ai-bridge/protocol";
import {
	ExportOperationResultSchema,
	MAX_EXPORT_FILE_COUNT,
} from "@obsidian-ai-bridge/protocol";

export { MAX_EXPORT_FILE_COUNT } from "@obsidian-ai-bridge/protocol";

import {
	advanceZip32,
	createZip32Cursor,
	isZip32Complete,
	parseZip32Cursor,
	Zip32LimitFailure,
	type Zip32Member,
	Zip32SourceFailure,
} from "@worker/application/export-zip";

/** Exact encoded archive ceiling from the Worker product envelope. */
export const MAX_EXPORT_ARCHIVE_BYTES = 2_000_000_000;
/** Maximum canonical manifest bytes held while emitting its ZIP member. */
export const MAX_EXPORT_MANIFEST_BYTES = 32 * 1024 * 1024;
/** Fixed R2 multipart part size except the final part. */
export const EXPORT_PART_BYTES = 5 * 1024 * 1024;
/** Maximum encoded archive bytes produced by one native alarm invocation. */
export const EXPORT_STEP_OUTPUT_BYTES = 1 * 1024 * 1024;
/** Maximum source bytes read by one native alarm invocation. */
export const EXPORT_STEP_SOURCE_BYTES = 1 * 1024 * 1024;
/** Maximum immutable source reads issued by one native alarm invocation. */
export const EXPORT_STEP_SOURCE_READS = 16;

/** One captured live path and exact immutable revision used to restore its bytes. */
export interface PackedExportFile {
	/** Zero-based snapshot order and matching ZIP source index. */
	ordinal: number;
	/** Canonical current vault path captured at the snapshot cut. */
	path: string;
	/** Exact immutable revision pinned for the export lifetime. */
	rev: number;
	/** SHA-256 identity captured with the immutable revision. */
	hash: string;
	/** Exact raw payload size in bytes. */
	size: number;
}

/** R2 multipart receipt persisted after an accepted part. */
export interface PackedExportPart {
	/** One-based multipart position required by R2 completion. */
	partNumber: number;
	/** Opaque R2 receipt persisted for exact multipart completion. */
	etag: string;
}

/** Persisted operation and pinned metadata loaded for one alarm batch. */
export interface PackedExportWork extends ExportOperationResult {
	/** Stable SQLite row identity formed from epoch and canonical timestamp. */
	id: string;
	/** Private archive key passed only to the infrastructure adapter. */
	objectKey: string;
	/** Unix timestamp in milliseconds used to order active work. */
	startedAt: number;
	/** Opaque active R2 multipart id, or `null` before upload creation. */
	uploadId: string | null;
	/** Canonical serialized manifest member, bounded before ZIP output. */
	manifest: string;
	/** Ordered exact revision metadata for active source reads. */
	files: readonly PackedExportFile[];
	/** Serialized ZIP continuation cursor protected by SQLite compare-and-set. */
	zipState: string;
	/** Uncommitted archive bytes held below one fixed multipart part. */
	pendingPart: Uint8Array;
	/** Accepted R2 parts in their required one-based order. */
	completedParts: readonly PackedExportPart[];
}

/** Compare-and-set values saved after one bounded archive step. */
export interface PackedExportCheckpoint {
	/** Next serialized ZIP cursor after one bounded step. */
	zipState: string;
	/** Bytes not yet large enough to upload as a complete R2 part. */
	pendingPart: Uint8Array;
	/** Accepted multipart receipts, ordered by their part number. */
	completedParts: readonly PackedExportPart[];
}

/** SQLite authority for a pinned current-file snapshot and its durable checkpoints. */
export interface PackedExportRepository {
	/** Capture manifest metadata and insert all revision pins in one transaction. */
	capture(createdAt: string, now: number): Promise<PackedExportWork>;
	/** Load the oldest queued or uploading export with its pinned file list. */
	nextActive(): Promise<PackedExportWork | null>;
	/** Check for active work without materializing its manifest or source rows. */
	hasActive(): Promise<boolean>;
	/** Read one exact immutable source range and settle its stream before return. */
	readSourceRange(
		exportId: string,
		ordinal: number,
		offset: number,
		length: number,
	): Promise<Uint8Array>;
	/** Save cursor, multipart receipt, and remainder only at the observed cursor. */
	checkpoint(
		exportId: string,
		observedZipState: string,
		checkpoint: PackedExportCheckpoint,
	): Promise<boolean>;
	/** Attach the R2 upload id to a row that does not own one yet. */
	attachUpload(
		exportId: string,
		observedZipState: string,
		uploadId: string,
	): Promise<boolean>;
	/** Publish completion only for the exact completed ZIP cursor and final object size. */
	complete(
		exportId: string,
		observedZipState: string,
		size: number,
	): Promise<boolean>;
	/** Record a typed failure and release pins after source reads settle. */
	fail(
		exportId: string,
		observedZipState: string,
		failure: ExportFailure,
	): Promise<void>;
	/** List completed export states in newest-first order. */
	listCompleted(): Promise<readonly ExportOperationResult[]>;
	/** Return key and exact size only when its export row is complete. */
	getCompletedArchive(
		exportId: string,
	): Promise<{ key: string; size: number } | null>;
}

/** Existing R2 bucket capability for bounded multipart archive writes. */
export interface PackedArchiveStore {
	/** Start one multipart upload for the deterministic snapshot key. */
	create(key: string): Promise<string>;
	/** Upload one known-length part and return its durable R2 receipt. */
	putPart(
		key: string,
		uploadId: string,
		partNumber: number,
		bytes: Uint8Array,
	): Promise<PackedExportPart>;
	/** Complete a multipart upload from the stored receipts in part order. */
	complete(
		key: string,
		uploadId: string,
		parts: readonly PackedExportPart[],
	): Promise<number>;
	/** Find a completed object after a lost completion response. */
	head(key: string): Promise<{ key: string; size: number } | null>;
	/** Abort one known incomplete multipart upload after a typed failure. */
	abort(key: string, uploadId: string): Promise<void>;
	/** Stream one completed archive without copying it into application memory. */
	get(
		key: string,
	): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
}

/** Mark exact encoded archive, member, or manifest bounds as exceeded. */
export class PackedExportLimitFailure extends Error {
	/** Mark an exact encoded archive, member, or manifest bound as exceeded. */
	constructor() {
		super("Packed export exceeds its product limits");
	}
}

/** Mark R2 outcomes that need a later alarm retry instead of a false terminal failure. */
export class PackedExportStorageFailure extends Error {
	/** Preserve a retryable archive-storage boundary without exposing provider details. */
	constructor() {
		super("Packed archive storage is temporarily unavailable");
	}
}

/** Distinguish unavailable pinned source bytes from R2 archive write failures. */
export class PackedExportSourceFailure extends Error {
	/** Mark a missing or invalid immutable revision range as a typed source failure. */
	constructor() {
		super("Packed export source is unavailable");
	}
}

/** Coordinates idempotent snapshot capture and bounded ZIP continuation. */
export class PackedExportService {
	private activeStep: Promise<void> | null = null;

	/** Bind one durable snapshot authority and the existing-bucket archive adapter. */
	constructor(
		private readonly repository: PackedExportRepository,
		private readonly archive: PackedArchiveStore,
	) {}

	/** Start or replay the epoch-and-timestamp export without reading file payload bytes. */
	async start(createdAt: string, now: number): Promise<ExportOperationResult> {
		const work = await this.repository.capture(createdAt, now);
		if (work.status === "queued" || work.status === "uploading") {
			try {
				createZip32Cursor(archiveMembers(work), MAX_EXPORT_ARCHIVE_BYTES);
			} catch (error) {
				const failure = classifyFailure(error);
				await this.failWork(work, work.uploadId, failure);
				return ExportOperationResultSchema.parse({
					epoch: work.epoch,
					created_at: work.created_at,
					status: "failed",
					size: null,
					failure,
				});
			}
		}
		return ExportOperationResultSchema.parse(publicResult(work));
	}

	/** Check for queued or uploading work without loading file snapshots. */
	hasPending(): Promise<boolean> {
		return this.repository.hasActive();
	}

	/** Run one output-bounded step and one fixed-size multipart part at most. */
	async runBatch(): Promise<boolean> {
		if (this.activeStep) {
			await this.activeStep;
			return (await this.repository.nextActive()) !== null;
		}
		const operation = this.runOneBatch();
		this.activeStep = operation;
		try {
			await operation;
		} finally {
			this.activeStep = null;
		}
		return (await this.repository.nextActive()) !== null;
	}

	/** List only completed exports so partial output is never available to download. */
	async list(): Promise<readonly ExportOperationResult[]> {
		return (await this.repository.listCompleted()).map((item) =>
			ExportOperationResultSchema.parse(item),
		);
	}

	/** Stream a completed archive only when SQLite and R2 agree on its exact size. */
	async getDownload(
		exportId: string,
	): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null> {
		const expected = await this.repository.getCompletedArchive(exportId);
		if (!expected) return null;
		const object = await this.archive.get(expected.key);
		if (!object) return null;
		if (object.size !== expected.size) {
			await object.body.cancel().catch(() => undefined);
			throw new Error("Packed export download size differs from its record");
		}
		return object;
	}

	/** Advance one durable export by bounded source demand and a cursor CAS. */
	private async runOneBatch(): Promise<void> {
		const work = await this.repository.nextActive();
		if (!work) return;
		let uploadId = work.uploadId;
		try {
			const members = archiveMembers(work);
			const manifestBytes = new TextEncoder().encode(work.manifest);
			if (manifestBytes.byteLength > MAX_EXPORT_MANIFEST_BYTES)
				throw new PackedExportLimitFailure();
			const cursor = work.zipState
				? parseZip32Cursor(work.zipState)
				: createZip32Cursor(members, MAX_EXPORT_ARCHIVE_BYTES);
			if (!uploadId) {
				uploadId = await this.archive.create(work.objectKey);
				if (
					!(await this.repository.attachUpload(
						work.id,
						work.zipState,
						uploadId,
					))
				) {
					await this.archive.abort(work.objectKey, uploadId);
					return;
				}
			}
			if (isZip32Complete(cursor)) {
				if (work.pendingPart.byteLength > 0) {
					if (work.pendingPart.byteLength >= EXPORT_PART_BYTES)
						throw new Error("Packed export remainder exceeds its limit");
					const part = await this.archive.putPart(
						work.objectKey,
						uploadId,
						work.completedParts.length + 1,
						work.pendingPart,
					);
					const saved = await this.repository.checkpoint(
						work.id,
						work.zipState,
						{
							zipState: work.zipState,
							pendingPart: new Uint8Array(),
							completedParts: [...work.completedParts, part],
						},
					);
					if (!saved) return;
					return;
				}
				await this.completeArchive(work, uploadId, cursor.archiveOffset);
				return;
			}

			const step = await advanceZip32(
				members,
				cursor,
				async (memberIndex, offset, length) => {
					if (memberIndex === 0)
						return manifestBytes.slice(offset, offset + length);
					try {
						return await this.repository.readSourceRange(
							work.id,
							memberIndex - 1,
							offset,
							length,
						);
					} catch (error) {
						if (error instanceof PackedExportStorageFailure) throw error;
						throw new PackedExportSourceFailure();
					}
				},
				{
					maxOutputBytes: EXPORT_STEP_OUTPUT_BYTES,
					maxSourceReads: EXPORT_STEP_SOURCE_READS,
					maxSourceBytes: EXPORT_STEP_SOURCE_BYTES,
				},
			);
			if (
				step.bytes.byteLength > EXPORT_STEP_OUTPUT_BYTES ||
				step.sourceBytes > EXPORT_STEP_SOURCE_BYTES ||
				step.sourceReads > EXPORT_STEP_SOURCE_READS
			)
				throw new Error("Packed export step exceeded its source budget");

			const combined = appendBytes(work.pendingPart, step.bytes);
			let pendingPart = combined;
			const completedParts = [...work.completedParts];
			if (
				combined.byteLength >= EXPORT_PART_BYTES ||
				(isZip32Complete(step.cursor) && combined.byteLength > 0)
			) {
				const partSize = Math.min(combined.byteLength, EXPORT_PART_BYTES);
				const part = await this.archive.putPart(
					work.objectKey,
					uploadId,
					completedParts.length + 1,
					combined.slice(0, partSize),
				);
				completedParts.push(part);
				pendingPart = combined.slice(partSize);
			}
			const saved = await this.repository.checkpoint(work.id, work.zipState, {
				zipState: JSON.stringify(step.cursor),
				pendingPart,
				completedParts,
			});
			if (!saved) return;
		} catch (error) {
			if (error instanceof PackedExportStorageFailure) return;
			await this.failWork(work, uploadId, classifyFailure(error));
		}
	}

	/** Complete multipart output or recover exact-size completion after a lost reply. */
	private async completeArchive(
		work: PackedExportWork,
		uploadId: string,
		expectedSize: number,
	): Promise<void> {
		const existing = await this.archive.head(work.objectKey);
		if (existing) {
			if (existing.key !== work.objectKey || existing.size !== expectedSize)
				throw new Error("Packed export object conflicts with its checkpoint");
			await this.repository.complete(work.id, work.zipState, expectedSize);
			return;
		}
		const size = await this.archive.complete(
			work.objectKey,
			uploadId,
			work.completedParts,
		);
		if (size !== expectedSize)
			throw new Error("Packed export object size differs from its checkpoint");
		await this.repository.complete(work.id, work.zipState, size);
	}

	/** Record the typed failure after all started reads settle and abort known multipart work. */
	private async failWork(
		work: PackedExportWork,
		uploadId: string | null,
		failure: ExportFailure,
	): Promise<void> {
		if (uploadId) {
			try {
				await this.archive.abort(work.objectKey, uploadId);
			} catch {
				// The failed export stays unavailable if R2 cannot confirm the abort.
			}
		}
		await this.repository.fail(work.id, work.zipState, failure);
	}
}

/** Classify deterministic ZIP limits and missing pinned sources before hiding other faults. */
function classifyFailure(error: unknown): ExportFailure {
	if (
		error instanceof PackedExportSourceFailure ||
		error instanceof Zip32SourceFailure
	)
		return { kind: "export_source_unavailable" };
	if (
		error instanceof PackedExportLimitFailure ||
		error instanceof Zip32LimitFailure
	)
		return { kind: "export_limit_exceeded" };
	return { kind: "export_storage_unavailable" };
}

/** Map captured metadata to ZIP members, with current bytes below `files/`. */
function archiveMembers(work: PackedExportWork): Zip32Member[] {
	const manifestSize = new TextEncoder().encode(work.manifest).byteLength;
	if (manifestSize > MAX_EXPORT_MANIFEST_BYTES)
		throw new PackedExportLimitFailure();
	const members: Zip32Member[] = [
		{ name: "manifest.json", size: manifestSize },
		...work.files.map(({ path, size }) => ({ name: `files/${path}`, size })),
	];
	if (members.length > MAX_EXPORT_FILE_COUNT + 1)
		throw new PackedExportLimitFailure();
	return members;
}

/** Append one bounded ZIP output chunk to the persisted multipart remainder. */
function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
	const bytes = new Uint8Array(left.byteLength + right.byteLength);
	bytes.set(left);
	bytes.set(right, left.byteLength);
	return bytes;
}

/** Return the canonical protocol fields and hide SQLite cursor and key details. */
function publicResult(work: PackedExportWork): ExportOperationResult {
	return {
		epoch: work.epoch,
		created_at: work.created_at,
		status: work.status,
		size: work.size,
		failure: work.failure,
	};
}
