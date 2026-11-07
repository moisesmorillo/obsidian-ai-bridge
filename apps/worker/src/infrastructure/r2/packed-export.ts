import type {
	PackedArchiveStore,
	PackedExportPart,
} from "@worker/application/export";
import {
	EXPORT_PART_BYTES,
	PackedExportStorageFailure,
} from "@worker/application/export";

/** R2 adapter for durable ZIP multipart output in the dedicated backup bucket. */
export class R2PackedArchiveStore implements PackedArchiveStore {
	/** Bind the dedicated archive bucket without creating a new Cloudflare resource. */
	constructor(private readonly bucket: R2Bucket) {}

	/** Start one multipart upload and return its opaque resume id. */
	async create(key: string): Promise<string> {
		try {
			const upload = await this.bucket.createMultipartUpload(key);
			return upload.uploadId;
		} catch {
			throw storageFailure();
		}
	}

	/** Upload one bounded byte array through a fixed-length stream. */
	async putPart(
		key: string,
		uploadId: string,
		partNumber: number,
		bytes: Uint8Array,
	): Promise<PackedExportPart> {
		if (
			!Number.isSafeInteger(partNumber) ||
			partNumber < 1 ||
			partNumber > 10_000 ||
			bytes.byteLength < 1 ||
			bytes.byteLength > EXPORT_PART_BYTES
		)
			throw storageFailure();
		const upload = this.bucket.resumeMultipartUpload(key, uploadId);
		const fixed = new FixedLengthStream(bytes.byteLength);
		const writer = fixed.writable.getWriter();
		let uploadResult: ReturnType<typeof upload.uploadPart> | undefined;
		try {
			uploadResult = upload.uploadPart(partNumber, fixed.readable);
			await writer.write(bytes);
			await writer.close();
			const part = await uploadResult;
			if (part.partNumber !== partNumber || !part.etag) throw storageFailure();
			return { partNumber: part.partNumber, etag: part.etag };
		} catch {
			await writer.abort().catch(() => undefined);
			if (uploadResult) await Promise.allSettled([uploadResult]);
			throw storageFailure();
		} finally {
			writer.releaseLock();
		}
	}

	/** Complete the exact ordered part list and return the committed archive size. */
	async complete(
		key: string,
		uploadId: string,
		parts: readonly PackedExportPart[],
	): Promise<number> {
		if (parts.length === 0) throw storageFailure();
		for (const [index, part] of parts.entries())
			if (part.partNumber !== index + 1 || !part.etag) throw storageFailure();
		try {
			const result = await this.bucket
				.resumeMultipartUpload(key, uploadId)
				.complete(parts.map(({ partNumber, etag }) => ({ partNumber, etag })));
			if (
				result.key !== key ||
				!Number.isSafeInteger(result.size) ||
				result.size < 1
			)
				throw storageFailure();
			return result.size;
		} catch {
			throw storageFailure();
		}
	}

	/** Read exact key and size evidence for interrupted completion recovery. */
	async head(key: string): Promise<{ key: string; size: number } | null> {
		try {
			const result = await this.bucket.head(key);
			return result && result.key === key
				? { key: result.key, size: result.size }
				: null;
		} catch {
			throw storageFailure();
		}
	}

	/** Abort one known incomplete multipart upload without exposing R2 details. */
	async abort(key: string, uploadId: string): Promise<void> {
		try {
			await this.bucket.resumeMultipartUpload(key, uploadId).abort();
		} catch {
			throw storageFailure();
		}
	}

	/** Return a completed R2 body as a stream with its stored byte count. */
	async get(
		key: string,
	): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null> {
		try {
			const object = await this.bucket.get(key);
			if (!object) return null;
			return { body: object.body, size: object.size };
		} catch {
			throw storageFailure();
		}
	}
}

/** Hide R2-specific causes behind one typed application failure boundary. */
function storageFailure(): PackedExportStorageFailure {
	return new PackedExportStorageFailure();
}
