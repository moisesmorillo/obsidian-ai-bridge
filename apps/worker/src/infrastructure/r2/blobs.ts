import type {
	BlobDeclaration,
	ByteRangeSelection,
} from "@obsidian-ai-bridge/protocol";
import type { BlobContentStore, BlobEvidence } from "@worker/application/blobs";
import { FileOperationDenied } from "@worker/application/files";

/** Maximum raw blob bytes under the publication contract. */
const MAX_BLOB_SIZE = 25_000_000;
/** Maximum application-owned buffer for one native BYOB read, in bytes. */
const MAX_READ_SIZE = 65_536;
/** The Workers runtime exposes its native streaming digest on crypto, not globalThis. */
const workerCrypto = crypto as Crypto & { DigestStream: typeof DigestStream };

/** R2-backed immutable blob capability used by Vault publication. */
export class R2BlobStore implements BlobContentStore {
	/** Bind one R2 bucket as the immutable blob namespace. */
	constructor(private readonly bucket: R2Bucket) {}

	/** Stream checksum-attested immutable content without an application response buffer. */
	async read(
		hash: string,
		size: number,
		range?: ByteRangeSelection,
	): Promise<ReadableStream<Uint8Array>> {
		try {
			const object = await this.bucket.get(
				`blobs/${hash}`,
				range === undefined
					? undefined
					: {
							range: {
								offset: range.start,
								length: range.end - range.start + 1,
							},
						},
			);
			const evidence = objectEvidence(object, `blobs/${hash}`);
			if (
				!object ||
				!evidence ||
				evidence.hash !== hash ||
				evidence.size !== size
			) {
				await object?.body.cancel();
				throw storageUnavailable();
			}
			return object.body;
		} catch {
			throw storageUnavailable();
		}
	}

	/** Return actual R2 checksum evidence, not the caller's claimed digest. */
	async head(hash: string): Promise<BlobEvidence | undefined> {
		if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
		return objectEvidence(
			await this.bucket.head(`blobs/${hash}`),
			`blobs/${hash}`,
		);
	}

	/**
	 * Verify EOF, count, digest, and stored checksum without replacing an object.
	 * Own source demand and all started work until settlement, also after abort.
	 * A conditional refusal stops the unused sink but never proves incoming bytes.
	 * @throws FileOperationDenied - Canonical integrity, size, or retryable storage failure.
	 */
	async putVerified(
		declaration: BlobDeclaration,
		body: ReadableStream<Uint8Array>,
		signal: AbortSignal,
	): Promise<BlobEvidence> {
		if (declaration.size > MAX_BLOB_SIZE)
			throw new FileOperationDenied({ kind: "blob_too_large" });
		if (
			!Number.isSafeInteger(declaration.size) ||
			declaration.size < 0 ||
			!/^[0-9a-f]{64}$/.test(declaration.payload_hash)
		)
			throw storageUnavailable();

		const tasks = new StreamTasks();
		let reader: ReadableStreamBYOBReader | undefined;
		const digest = new workerCrypto.DigestStream("SHA-256");
		const digestResult = tasks.observe(digest.digest);
		const digestWriter = digest.getWriter();
		tasks.observe(digestWriter.closed);
		let fixed: FixedLengthStream | undefined;
		let sink: WritableStreamDefaultWriter<Uint8Array> | undefined;
		let sinkStopped = false;
		let closing = false;
		let failure: unknown;
		let stopped = false;
		let putResult: Promise<R2Object | null> | undefined;
		let verified: BlobEvidence | undefined;

		/** Stop a refused or failed sink independently of incoming verification. */
		const stopSink = (reason: unknown): void => {
			if (sinkStopped) return;
			sinkStopped = true;
			if (fixed && !fixed.readable.locked) {
				tasks.observe(fixed.readable.cancel(reason));
			}
			if (sink) tasks.observe(sink.abort(reason));
		};
		/** Stop owned stream demand. Storage remains charged until its result settles. */
		const stop = (reason: unknown): void => {
			if (stopped) return;
			stopped = true;
			failure = reason;
			if (reader) tasks.observe(reader.cancel());
			else if (!body.locked) tasks.observe(body.cancel(reason));
			tasks.observe(digestWriter.abort(reason));
			stopSink(reason);
		};
		/** Abort cannot release ownership of a pending storage result. */
		const onAbort = (): void => stop(storageUnavailable());
		/** Preserve measured failures and reject cancellation after every native wait. */
		const check = (): void => {
			if (failure) throw failure;
			if (signal.aborted) throw storageUnavailable();
		};

		/** A conditional refusal can reject any pending sink write or close without invalidating incoming bytes. */
		const awaitSink = async (operation: Promise<void>): Promise<void> => {
			try {
				await tasks.observe(operation);
			} catch (error) {
				if (!sinkStopped) throw error;
			}
			check();
		};

		signal.addEventListener("abort", onAbort, { once: true });
		try {
			reader = body.getReader({ mode: "byob" });
			tasks.observe(reader.closed);
			check();
			const key = `blobs/${declaration.payload_hash}`;
			const existing = await tasks.observe(this.bucket.head(key));
			check();
			/** Start at most one create-only PUT. Zero-byte streams start only after verification. */
			const startStorage = (): void => {
				fixed = new FixedLengthStream(declaration.size);
				sink = fixed.writable.getWriter();
				tasks.observe(sink.closed);
				putResult = tasks.observe(
					this.bucket
						.put(key, fixed.readable, {
							sha256: Uint8Array.from(
								declaration.payload_hash.match(/.{2}/g) ?? [],
								(byte) => Number.parseInt(byte, 16),
							),
							onlyIf: { etagDoesNotMatch: "*" },
						})
						.then(
							(result) => {
								if (result === null) stopSink(storageUnavailable());
								else if (!closing) stop(storageUnavailable());
								return result;
							},
							(error) => {
								stop(storageUnavailable());
								throw error;
							},
						),
				);
			};
			if (!existing && declaration.size > 0) startStorage();

			let count = 0;
			let tail: Uint8Array | undefined;
			while (true) {
				check();
				const { value, done } = await tasks.observe(
					reader.read(
						new Uint8Array(
							Math.min(MAX_READ_SIZE, Math.max(1, declaration.size - count)),
						),
					),
				);
				check();
				if (done) break;
				count += value.byteLength;
				if (count > MAX_BLOB_SIZE)
					throw new FileOperationDenied({ kind: "blob_too_large" });
				if (count > declaration.size)
					throw new FileOperationDenied({ kind: "blob_integrity_mismatch" });
				await tasks.observe(digestWriter.write(value));
				check();
				// Native fixed-length readers can report EOF as soon as their byte count arrives.
				// Retain the final bounded chunk until incoming EOF and digest checks pass.
				if (count === declaration.size) tail = value;
				else if (sink && !sinkStopped) await awaitSink(sink.write(value));
			}
			if (count !== declaration.size)
				throw new FileOperationDenied({ kind: "blob_integrity_mismatch" });
			await tasks.observe(digestWriter.close());
			const actual = hex(await digestResult);
			check();
			if (actual !== declaration.payload_hash)
				throw new FileOperationDenied({ kind: "blob_integrity_mismatch" });
			closing = true;
			if (!existing && !putResult) startStorage();
			if (tail && sink && !sinkStopped) await awaitSink(sink.write(tail));
			if (sink && !sinkStopped) await awaitSink(sink.close());
			const stored = existing ?? (putResult ? await putResult : null);
			check();
			// A null result says nothing about consumed bytes or stored integrity.
			const evidence = objectEvidence(
				stored ?? (await tasks.observe(this.bucket.head(key))),
				key,
			);
			check();
			if (!evidence || evidence.hash !== actual || evidence.size !== count)
				throw storageUnavailable();
			verified = evidence;
		} catch (error) {
			stop(error);
			if (
				error instanceof FileOperationDenied &&
				(error.failure.kind === "blob_integrity_mismatch" ||
					error.failure.kind === "blob_too_large")
			)
				throw error;
			throw storageUnavailable();
		} finally {
			await tasks.settle();
			signal.removeEventListener("abort", onAbort);
			// Observe cancellation work added between the first drain and listener removal.
			await tasks.settle();
			reader?.releaseLock();
			digestWriter.releaseLock();
			sink?.releaseLock();
		}
		check();
		if (!verified) throw storageUnavailable();
		return verified;
	}
}

/** Hide storage details and preserve uncertainty with the canonical one-second retry delay. */
function storageUnavailable(): FileOperationDenied {
	return new FileOperationDenied({
		kind: "blob_storage_unavailable",
		retry_after_seconds: 1,
	});
}

/** Observe only active work. Settled per-chunk promises never accumulate. */
class StreamTasks {
	private readonly pending = new Set<Promise<unknown>>();

	/** Observe rejection immediately while retaining the original outcome for its caller. */
	observe<T>(promise: Promise<T>): Promise<T> {
		this.pending.add(promise);
		void promise.then(
			() => this.pending.delete(promise),
			() => this.pending.delete(promise),
		);
		return promise;
	}

	/** Wait for started work, including cancellation work created during settlement. */
	async settle(): Promise<void> {
		while (this.pending.size) await Promise.allSettled([...this.pending]);
	}
}

/** Read size and native SHA-256 evidence only for the exact requested R2 key. */
function objectEvidence(
	object: R2Object | null,
	key: string,
): BlobEvidence | undefined {
	const checksum = object?.checksums.sha256;
	if (!object || object.key !== key || !checksum || checksum.byteLength !== 32)
		return undefined;
	return { hash: hex(checksum), size: object.size };
}

/** Encode native digest bytes as lowercase hexadecimal without text decoding. */
function hex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
