import type {
	PackedArchiveStore,
	PackedExportPart,
	PackedExportRepository,
	PackedExportWork,
} from "@worker/application/export";
import {
	PackedExportService,
	PackedExportStorageFailure,
} from "@worker/application/export";
import { describe, expect, it } from "vitest";

const epoch = "a".repeat(32);
const createdAt = "2026-11-07T03:00:00.000Z";
const payload = new Uint8Array(5 * 1024 * 1024 + 7).fill(9);

/** Build a durable repository double that preserves checkpoint compare-and-set behavior. */
class ExportRepositoryFake implements PackedExportRepository {
	work: PackedExportWork;
	manifestBytes: Uint8Array;
	readBytes = 0;
	readCalls = 0;

	/** Seed one queued export with a stable manifest and immutable payload. */
	constructor() {
		const files = [
			{
				ordinal: 0,
				path: "notes/a.md",
				rev: 3,
				hash: "b".repeat(64),
				size: payload.byteLength,
				sourceType: "revision_blob" as const,
			},
		];
		const file = files[0];
		if (!file) throw new Error("Export fixture lacks its file row");
		const manifest = JSON.stringify({
			epoch,
			head_seq: 9,
			created_at: createdAt,
			files: [
				{ path: file.path, rev: file.rev, hash: file.hash, size: file.size },
			],
		});
		this.manifestBytes = new TextEncoder().encode(manifest);
		this.work = {
			id: "export-id",
			epoch,
			created_at: createdAt,
			status: "queued",
			size: null,
			failure: null,
			objectKey: `backups/${epoch}/${createdAt}.zip`,
			startedAt: 1,
			uploadId: null,
			manifestSize: this.manifestBytes.byteLength,
			files,
			zipState: "",
			pendingPart: new Uint8Array(),
			completedParts: [],
		};
	}

	/** Return the same timestamp-keyed snapshot to model start idempotency. */
	async capture(): Promise<PackedExportWork> {
		return this.work;
	}
	/** Return work only while its durable state remains active. */
	async nextActive(): Promise<PackedExportWork | null> {
		return this.work.status === "complete" || this.work.status === "failed"
			? null
			: this.work;
	}
	/** Check active state without loading source payload bytes. */
	async hasActive(): Promise<boolean> {
		return this.work.status === "queued" || this.work.status === "uploading";
	}
	/** Return one exact bounded manifest slice from the seeded JSON member. */
	async readManifestRange(
		_id: string,
		offset: number,
		length: number,
	): Promise<Uint8Array> {
		return this.manifestBytes.slice(offset, offset + length);
	}
	/** Return one exact bounded range from the captured test revision. */
	async readSourceRange(
		_id: string,
		ordinal: number,
		offset: number,
		length: number,
	): Promise<Uint8Array> {
		expect(ordinal).toBe(0);
		this.readCalls += 1;
		const bytes = payload.slice(offset, offset + length);
		this.readBytes += bytes.byteLength;
		return bytes;
	}
	/** Save progress only when the cursor still matches the caller's observation. */
	async checkpoint(
		_id: string,
		observed: string,
		checkpoint: {
			zipState: string;
			pendingPart: Uint8Array;
			completedParts: readonly PackedExportPart[];
		},
	): Promise<boolean> {
		if (this.work.zipState !== observed) return false;
		this.work = { ...this.work, status: "uploading", ...checkpoint };
		return true;
	}
	/** Attach one multipart id before the writer stores progress. */
	async attachUpload(
		_id: string,
		_observedZipState: string,
		uploadId: string,
	): Promise<boolean> {
		if (this.work.uploadId) return false;
		this.work = { ...this.work, uploadId };
		return true;
	}
	/** Mark the snapshot complete with the exact test archive size. */
	async complete(
		_id: string,
		_observed: string,
		size: number,
	): Promise<boolean> {
		this.work = { ...this.work, status: "complete", size };
		return true;
	}
	/** Keep failure terminal and remove this row from active alarm work. */
	async fail(
		_id: string,
		_observedZipState: string,
		failure: PackedExportWork["failure"],
	): Promise<void> {
		this.work = { ...this.work, status: "failed", size: null, failure };
	}
	/** Return only the completed row used by owner listing tests. */
	async listCompleted() {
		return this.work.status === "complete" ? [this.work] : [];
	}
	/** Return the exact key and size only after completion. */
	async getCompletedArchive(
		_id: string,
	): Promise<{ key: string; size: number } | null> {
		return this.work.status === "complete" && this.work.size !== null
			? { key: this.work.objectKey, size: this.work.size }
			: null;
	}
}

/** Record multipart part sizes and receipts without buffering a whole test archive. */
class ArchiveStoreFake implements PackedArchiveStore {
	readonly partSizes: number[] = [];
	readonly partAttempts: Array<{ number: number; bytes: Uint8Array }> = [];
	private failNextPart = true;
	private readonly sizes = new Map<string, number>();
	private readonly completedObjects = new Map<string, number>();
	private completedSize = 0;
	completeCalls = 0;
	headCalls = 0;

	/** Configure one completed multipart request to lose its reply after object creation. */
	constructor(private readonly loseFirstCompletionReply = false) {}
	/** Start one deterministic upload in the fake bucket. */
	async create(): Promise<string> {
		return "upload-id";
	}
	/** Record every attempt and fail once to prove same-part retry behavior. */
	async putPart(
		_key: string,
		_uploadId: string,
		partNumber: number,
		bytes: Uint8Array,
	): Promise<PackedExportPart> {
		this.partAttempts.push({ number: partNumber, bytes: bytes.slice() });
		if (this.failNextPart) {
			this.failNextPart = false;
			throw new PackedExportStorageFailure();
		}
		const etag = `part-${partNumber}`;
		this.partSizes.push(bytes.byteLength);
		this.sizes.set(etag, bytes.byteLength);
		return { partNumber, etag };
	}
	/** Sum accepted part bytes as the completed fake R2 object size. */
	async complete(
		key: string,
		_uploadId: string,
		parts: readonly PackedExportPart[],
	): Promise<number> {
		this.completeCalls += 1;
		this.completedSize = parts.reduce(
			(total, part) => total + (this.sizes.get(part.etag) ?? 0),
			0,
		);
		this.completedObjects.set(key, this.completedSize);
		if (this.loseFirstCompletionReply && this.completeCalls === 1)
			throw new PackedExportStorageFailure();
		return this.completedSize;
	}
	/** Return exact completed-object evidence to exercise lost-response recovery. */
	async head(key: string): Promise<{ key: string; size: number } | null> {
		this.headCalls += 1;
		const size = this.completedObjects.get(key);
		return size === undefined ? null : { key, size };
	}
	/** Accept abort requests because this fixture stores no native uploads. */
	async abort(): Promise<void> {}
	/** Return a test stream whose bytes match the completed object size. */
	async get(): Promise<{ body: ReadableStream<Uint8Array>; size: number }> {
		const bytes = new Uint8Array(this.completedSize);
		return {
			body: new ReadableStream({
				/** Emit the bounded fake object as one test-only stream chunk. */
				start(controller) {
					controller.enqueue(bytes);
					controller.close();
				},
			}),
			size: bytes.byteLength,
		};
	}
}

describe("resumable packed export service", () => {
	it("returns a typed failure before output when exact archive size exceeds the limit", async () => {
		const repository = new ExportRepositoryFake();
		const oversizedSize = 2_000_000_001;
		const original = repository.work.files[0];
		if (!original) throw new Error("Export fixture lacks its file row");
		repository.work = {
			...repository.work,
			files: [{ ...original, size: oversizedSize }],
		};
		const result = await new PackedExportService(
			repository,
			new ArchiveStoreFake(),
		).start(createdAt, 2);
		expect(result.status).toBe("failed");
		expect(result.failure).toEqual({ kind: "export_limit_exceeded" });
		expect(repository.work.failure).toEqual({
			kind: "export_limit_exceeded",
		});
	});

	it("keeps one invocation within source budgets and completes fixed-size multipart ZIP output", async () => {
		const repository = new ExportRepositoryFake();
		const archive = new ArchiveStoreFake();
		const service = new PackedExportService(repository, archive);
		expect((await service.start(createdAt, 2)).status).toBe("queued");
		let batches = 0;
		let priorBytes = 0;
		let priorReads = 0;
		while (true) {
			const more = await new PackedExportService(
				repository,
				archive,
			).runBatch();
			batches += 1;
			expect(repository.readBytes - priorBytes).toBeLessThanOrEqual(
				1 * 1024 * 1024,
			);
			expect(repository.readCalls - priorReads).toBeLessThanOrEqual(16);
			priorBytes = repository.readBytes;
			priorReads = repository.readCalls;
			if (!more) break;
			if (batches > 32)
				throw new Error("Export did not finish in bounded batches");
		}
		expect(repository.work.failure).toBeNull();
		expect(repository.work.status).toBe("complete");
		expect(archive.partAttempts[0]?.number).toBe(1);
		expect(archive.partAttempts[1]?.number).toBe(1);
		expect(archive.partAttempts[1]?.bytes).toEqual(
			archive.partAttempts[0]?.bytes,
		);
		expect(archive.partSizes[0]).toBe(5 * 1024 * 1024);
		expect(archive.partSizes.at(-1)).toBeGreaterThan(0);
		expect(archive.partSizes.at(-1)).toBeLessThanOrEqual(5 * 1024 * 1024);
		const download = await service.getDownload("export-id");
		expect(download?.size).toBe(repository.work.size);
		const reader = download?.body.getReader();
		if (!reader) throw new Error("Completed export has no download stream");
		const chunk = await reader.read();
		expect(chunk.value?.byteLength).toBe(download?.size);
		expect((await reader.read()).done).toBe(true);
		reader.releaseLock();
	}, 60_000);

	it("recovers an R2 completion after the first completion reply is lost", async () => {
		const repository = new ExportRepositoryFake();
		const archive = new ArchiveStoreFake(true);
		const service = new PackedExportService(repository, archive);
		expect((await service.start(createdAt, 2)).status).toBe("queued");
		let more = true;
		let batches = 0;
		while (more) {
			more = await service.runBatch();
			batches += 1;
			if (batches > 32)
				throw new Error("Lost-completion recovery did not finish");
		}
		expect(repository.work.status).toBe("complete");
		expect(repository.work.size).toBeGreaterThan(5 * 1024 * 1024);
		expect(archive.completeCalls).toBe(1);
		expect(archive.headCalls).toBe(2);
	});
});
