import type {
	AdmissionCompletion,
	AdmissionFinishResult,
} from "@vaultwire/protocol";
import type { ReadSlotLease } from "@worker/application/read-budget";
import { ReadAborted } from "@worker/application/read-demand";
import {
	READ_SETTLEMENT_DEADLINE_MS,
	ReadBatchFailure,
	settleReadAdmission,
} from "@worker/application/reads";
import {
	abortResponseWriter,
	keepResponseWorkAlive,
	pumpResponseChunks,
} from "@worker/transport/response-pump";

/** Maximum encoded bytes produced by one response demand. */
const RESPONSE_CHUNK_BYTES = 65_536;

/** One response producer with explicit cancellation of started work. */
export interface ReadResponseSource {
	/** Demand at most one bounded encoded chunk. */
	next(): Promise<IteratorResult<Uint8Array>>;
	/** Stop future demand and join producer cleanup. */
	cancel(reason?: unknown): Promise<void>;
}

/** Durable read owner. Unknown outcomes keep the original admission deadline. */
export interface ReadResponseOwner {
	/** Finish once after all started response work settles. */
	finish(completion: AdmissionCompletion): Promise<AdmissionFinishResult>;
}

/** Classify a source fault: known batch failures and read aborts settle, other faults stay uncertain. */
function sourceFaultCompletion(error: unknown): AdmissionCompletion {
	return error instanceof ReadBatchFailure || error instanceof ReadAborted
		? "settled"
		: "uncertain";
}

/**
 * Transfer one read slot and admission to a byte response.
 * The body is the readable side of a native stream that one pump drives (see
 * {@link pumpResponseChunks}). Generic framing uses IdentityTransformStream, and a positive known
 * length uses FixedLengthStream. A zero-byte known length uses a gated byte stream, so status and
 * Content-Length stay intact until durable settlement succeeds.
 * A rejected write is consumer cancellation: the pump cancels the source, settles the owner as
 * settled, and completes the lease once. A cancel during pending source work shows at the next write.
 *
 * Demand bound: a generic body runs at most one chunk ahead of its consumer. A known length holds one
 * buffered chunk plus one unread write, because it keeps the last chunk until EOF validates the
 * length. A generic body settles the owner at producer EOF, completes the lease, and then closes.
 * A known length settles the owner at EOF, writes its buffered chunk, closes, and then completes.
 *
 * Settlement uses one fixed deadline. Local capacity releases after started source work and source
 * cancellation settle, independent of durable settlement and consumer drain. The lease deadline
 * releases local capacity and aborts the writer, so the consumer gets an error and never a clean
 * close. Unknown work keeps durable admission uncertain.
 * Byte reservations release when the lease completes. After consumer cancellation that is after
 * source cancellation and bounded durable settlement. After expiry it also waits for the writer abort.
 * @param knownByteLength - Exact response bytes, or undefined for generic response framing.
 * @throws RangeError when knownByteLength is not a non-negative safe integer. The caller keeps its slot.
 */
export function ownedReadResponse(
	source: ReadResponseSource,
	owner: ReadResponseOwner,
	releaseSlot: (() => void) | ReadSlotLease,
	init?: ResponseInit,
	signal?: AbortSignal,
	knownByteLength?: number,
	deadlineLease?: ReadSlotLease,
): Response {
	if (
		knownByteLength !== undefined &&
		(!Number.isSafeInteger(knownByteLength) || knownByteLength < 0)
	)
		throw new RangeError(
			"Known response length must be a non-negative safe integer",
		);
	let pending: Promise<IteratorResult<Uint8Array>> | undefined;
	let stopping = false;
	let settlement: Promise<void> | undefined;
	let cancellation: Promise<void> | undefined;
	let slotReleased = false;
	let expired = false;
	let deadlineError: Error | undefined;
	let signalDeadline!: () => void;
	const deadlinePromise = new Promise<void>((resolve) => {
		signalDeadline = resolve;
	});
	let controllerRef: ReadableStreamController<Uint8Array> | undefined;
	let responseWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
	let writerShutdown: Promise<void> | undefined;
	let responsePump: Promise<void> | undefined;
	let signalWorkSettled!: () => void;
	const workSettled = new Promise<void>((resolve) => {
		signalWorkSettled = resolve;
	});
	keepResponseWorkAlive(workSettled);
	/** Release local capacity after started source work and cancellation settle. */
	function release(): void {
		if (slotReleased) return;
		slotReleased = true;
		signal?.removeEventListener("abort", abort);
		releaseSlot();
	}
	/** Stop observing the acquisition deadline only after response work completes. */
	function completeDeadline(): void {
		if (lease) lease.complete();
		controllerRef = undefined;
		signalWorkSettled();
	}
	/**
	 * Stop holding the invocation once expired work settles, or after the bounded settlement grace
	 * when source or cancellation work never settles. Lazy reclaim still owns the byte reservation.
	 */
	function releaseKeepAliveAfter(work: Promise<void>): void {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const grace = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, READ_SETTLEMENT_DEADLINE_MS);
		});
		void Promise.race([work.catch(() => {}), grace]).then(() => {
			clearTimeout(timer);
			signalWorkSettled();
		});
	}
	/** Fail the response at its acquisition deadline without joining unknown source work. */
	function expire(): void {
		if (expired) return;
		expired = true;
		stopping = true;
		signalDeadline();
		lease?.();
		const reason = new Error("Read slot hold deadline exceeded");
		deadlineError = reason;
		const controller = controllerRef;
		controllerRef = undefined;
		try {
			controller?.error(reason);
		} catch {
			// The zero-byte response may already be closed when the deadline fires.
		}
		releaseKeepAliveAfter(finish(true, "uncertain", reason));
		void abortWriter(reason);
	}
	const lease =
		deadlineLease ?? ("onExpire" in releaseSlot ? releaseSlot : undefined);
	if (lease) lease.onExpire(expire);
	/** Start source cancellation once and observe synchronous throws as promise rejection. */
	function cancelSource(reason?: unknown): Promise<void> {
		if (cancellation) return cancellation;
		try {
			cancellation = Promise.resolve(source.cancel(reason));
		} catch (error) {
			cancellation = Promise.reject(error);
		}
		return cancellation;
	}
	/**
	 * Join source reads and cancellation before capacity release, then bound durable settlement.
	 * After expiry every outcome is uncertain.
	 */
	function settleOwner(
		cancel: boolean,
		completion: AdmissionCompletion,
		reason?: unknown,
	): Promise<void> {
		if (settlement) return settlement;
		stopping = true;
		settlement = (async () => {
			const cleanup = cancel ? cancelSource(reason) : undefined;
			const results = await Promise.allSettled([pending, cleanup]);
			pending = undefined;
			release();
			const outcome =
				expired ||
				results.some(
					(result) =>
						result.status === "rejected" &&
						sourceFaultCompletion(result.reason) === "uncertain",
				)
					? "uncertain"
					: completion;
			await settleReadAdmission(() => owner.finish(outcome));
		})();
		return settlement;
	}
	/**
	 * Join source cleanup and bounded settlement for the zero-byte stream, then complete the lease.
	 * A writer-backed body leaves lease completion to its pump, after writer shutdown.
	 */
	function finish(
		cancel: boolean,
		completion: AdmissionCompletion,
		reason?: unknown,
	): Promise<void> {
		return settleOwner(cancel, completion, reason).finally(() => {
			release();
			if (!responseWriter) completeDeadline();
		});
	}
	/** Start one writer shutdown and retain its promise for release coordination. */
	function abortWriter(reason: unknown): Promise<void> {
		const writer = responseWriter;
		if (!writer) return Promise.resolve();
		writerShutdown ??= abortResponseWriter(writer, reason);
		return writerShutdown;
	}
	/** Abort response production and join durable cleanup, the pump, and writer shutdown. */
	function abort() {
		const reason = signal?.reason;
		if (!responseWriter) {
			const controller = controllerRef;
			void finish(true, "settled", reason).then(
				() => controller?.error(reason ?? new Error("Read aborted")),
				(error) => controller?.error(error),
			);
			return;
		}
		const shutdown = abortWriter(reason ?? new Error("Read aborted"));
		const durableCleanup = settleOwner(true, "settled", reason);
		void Promise.allSettled([shutdown, durableCleanup, responsePump]);
	}
	if (knownByteLength === 0) return zeroByteResponse();
	const generic = knownByteLength === undefined;
	const framing = generic
		? new IdentityTransformStream()
		: new FixedLengthStream(knownByteLength);
	const writer = framing.writable.getWriter();
	responseWriter = writer;
	/**
	 * Run the shared pump with the read deadline and framing limits, then settle the owner for its
	 * end. A known length holds the last chunk until EOF validates the length and settles the owner.
	 */
	const pump = async (): Promise<void> => {
		let buffered: Uint8Array | undefined;
		let received = 0;
		const end = await pumpResponseChunks({
			next: async () => {
				pending = source.next();
				try {
					return await Promise.race([
						pending,
						deadlinePromise.then(() => {
							throw deadlineError;
						}),
					]);
				} finally {
					pending = undefined;
				}
			},
			accept: (chunk) => {
				if (
					chunk.byteLength > RESPONSE_CHUNK_BYTES ||
					(!generic && received + chunk.byteLength > knownByteLength)
				)
					throw new Error("Read response source exceeded its limits");
				received += chunk.byteLength;
			},
			write: async (chunk) => {
				const ready = generic ? chunk : buffered;
				if (!generic) buffered = chunk;
				if (ready) await writer.write(ready);
			},
			stopped: () => Boolean(lease?.expired) || stopping || expired,
		});
		switch (end.kind) {
			case "stopped":
				return;
			case "source_failed":
				await abortWriter(end.error);
				await settleOwner(true, sourceFaultCompletion(end.error), end.error);
				return;
			case "write_failed":
				// A rejected write means the consumer canceled or the writer was aborted.
				await settleOwner(true, "settled", end.error);
				return;
			case "eof":
				break;
		}
		if (!generic && received !== knownByteLength) {
			const error = new Error(
				"Response source length did not match its declaration",
			);
			await abortWriter(error);
			await settleOwner(true, "uncertain", error);
			return;
		}
		try {
			await settleOwner(false, "settled");
			if (lease?.expired || expired) return;
			// Every generic write resolved after its consumer read, so no response bytes remain held.
			// Complete the lease before the clean close, as the consumer sees EOF.
			if (generic) completeDeadline();
			if (buffered) await writer.write(buffered);
			await writer.close();
		} catch (error) {
			await abortWriter(error);
			await settleOwner(true, "settled", error);
		}
	};
	if (expired) void abortWriter(deadlineError);
	responsePump = Promise.resolve()
		.then(pump)
		.catch(async (error: unknown) => {
			await abortWriter(error);
			try {
				await settleOwner(true, "uncertain", error);
			} catch {
				// The response stream carries the producer fault to its consumer.
			}
		})
		.then(async () => {
			let ownerSettlement: Promise<void> | undefined;
			let shutdown: Promise<void> | undefined;
			do {
				ownerSettlement = settlement;
				shutdown = writerShutdown;
				await Promise.allSettled([ownerSettlement, shutdown]);
			} while (ownerSettlement !== settlement || shutdown !== writerShutdown);
			release();
			completeDeadline();
		});
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	return new Response(framing.readable, init);

	/**
	 * Build the zero-byte response as a gated byte stream. FixedLengthStream(0) ends its body without
	 * waiting for a write, so it could not hold EOF until durable settlement or error at the deadline.
	 * This stream has no data to write, so a consumer cancel across the runtime boundary leaves it to
	 * the lease deadline and reclaim.
	 */
	function zeroByteResponse(): Response {
		const headers = new Headers(init?.headers);
		headers.set("Content-Length", "0");
		const zeroLengthStream = new ReadableStream<Uint8Array>({
			type: "bytes",
			/** Retain the controller for request abort errors before source completion. */
			start(controller) {
				controllerRef = controller;
				if (expired) {
					controller.error(deadlineError);
					return;
				}
				signal?.addEventListener("abort", abort, { once: true });
				if (signal?.aborted) abort();
			},
			/** Wait for EOF and durable success before closing the zero-byte response. */
			async pull(controller) {
				if (lease?.expired || stopping) return;
				try {
					pending = source.next();
					const item = await Promise.race([
						pending,
						deadlinePromise.then(() => {
							throw deadlineError;
						}),
					]);
					pending = undefined;
					if (lease?.expired || stopping || expired) return;
					if (item.done) {
						await finish(false, "settled");
						controller.close();
						if ("byobRequest" in controller) controller.byobRequest?.respond(0);
						return;
					}
					if (item.value.byteLength > 0)
						throw new Error("Read response source exceeded its limits");
				} catch (error) {
					pending = undefined;
					try {
						await finish(true, sourceFaultCompletion(error), error);
					} catch {
						/* The response stream reports the source or settlement fault. */
					}
					controller.error(error);
				}
			},
			/** Join source cancellation before the response can finish. */
			cancel(reason) {
				return finish(true, "settled", reason);
			},
		});
		return new Response(zeroLengthStream, {
			status: init?.status,
			statusText: init?.statusText,
			headers,
		});
	}
}

/**
 * Target size, in bytes, of one coalesced JSON response chunk. Every enqueued chunk crosses the
 * response stream and the runtime output pipe separately, so emitting each JSON token on its own
 * (about 4 bytes per chunk for a feed page) made a 1,000-entry page cost tens of thousands of stream
 * turns. Measured locally on 2026-11-10: 54,017 chunks and about 800 ms for a 219 KB feed page.
 */
export const JSON_CHUNK_TARGET_BYTES = 16_384;

/**
 * Join small encoded parts into chunks of at most {@link JSON_CHUNK_TARGET_BYTES}, flushing at the
 * end of the given parts. A part that does not fit flushes the buffer first; a part at or above the
 * target passes through alone. Encoded JSON parts stay below 49,153 bytes, so no chunk exceeds the
 * 65,536-byte response chunk limit. The buffer is the only retained state and is copied on flush.
 */
export function* coalesceChunks(
	parts: Iterable<Uint8Array>,
): Generator<Uint8Array> {
	const buffer = new Uint8Array(JSON_CHUNK_TARGET_BYTES);
	let used = 0;
	for (const part of parts) {
		if (used > 0 && part.byteLength > buffer.byteLength - used) {
			yield buffer.slice(0, used);
			used = 0;
		}
		if (part.byteLength >= buffer.byteLength) {
			yield part;
			continue;
		}
		buffer.set(part, used);
		used += part.byteLength;
	}
	if (used > 0) yield buffer.slice(0, used);
}

/** Encode JSON into coalesced chunks of bounded token parts; see {@link encodeJsonParts}. */
export function encodeJsonChunks(value: unknown): Generator<Uint8Array> {
	return coalesceChunks(encodeJsonParts(value));
}

/** Encode JSON with bounded string windows, including isolated UTF-16 surrogates. */
export function* encodeJsonParts(value: unknown): Generator<Uint8Array> {
	const encoder = new TextEncoder();
	if (typeof value === "string") {
		yield encoder.encode('"');
		for (let start = 0; start < value.length; ) {
			let end = Math.min(start + 8192, value.length);
			const last = value.charCodeAt(end - 1);
			const next = value.charCodeAt(end);
			if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
				end--;
			yield encoder.encode(
				JSON.stringify(value.slice(start, end)).slice(1, -1),
			);
			start = end;
		}
		yield encoder.encode('"');
	} else if (value !== null && typeof value === "object") {
		const array = Array.isArray(value);
		yield encoder.encode(array ? "[" : "{");
		let separator = "";
		for (const key of Object.keys(value)) {
			const field = (value as Record<string, unknown>)[key];
			if (field === undefined) continue;
			if (separator) yield encoder.encode(separator);
			separator = ",";
			if (!array) {
				yield* encodeJsonParts(key);
				yield encoder.encode(":");
			}
			yield* encodeJsonParts(field);
		}
		yield encoder.encode(array ? "]" : "}");
	} else {
		yield encoder.encode(JSON.stringify(value));
	}
}

/** Adapt a JSON producer and join its active demand before generator cancellation. */
export function jsonReadSource(
	chunks: AsyncIterator<Uint8Array> | Iterator<Uint8Array>,
	cancel: () => Promise<void> = async () => {},
): ReadResponseSource {
	let pending: Promise<IteratorResult<Uint8Array>> | undefined;
	return {
		/** Retain started generator work so cancellation can join it. */
		next() {
			pending = Promise.resolve(chunks.next());
			return pending;
		},
		/** Cancel native work first, then clear generator-held rows and strings. */
		async cancel() {
			await cancel();
			const active = pending;
			if (active) {
				try {
					await active;
				} catch {
					// Generator cleanup still runs after a failed producer read.
				}
			}
			await chunks.return?.();
		},
	};
}

/** Read immutable bytes through a bounded BYOB reader until the stream confirms EOF. */
export function blobReadSource(
	body: ReadableStream<Uint8Array>,
): ReadResponseSource {
	const reader = body.getReader({ mode: "byob" });
	let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
	let ended = false;
	let released = false;
	/** Release the reader once after EOF or joined cancellation. */
	function release() {
		if (!released) {
			released = true;
			reader.releaseLock();
		}
	}
	return {
		/** Demand at most 65,536 bytes from the storage producer. */
		async next() {
			if (ended) return { done: true, value: undefined };
			pending = reader.read(new Uint8Array(RESPONSE_CHUNK_BYTES));
			const item = await pending;
			if (item.done) {
				ended = true;
				release();
				return { done: true, value: undefined };
			}
			return { done: false, value: item.value };
		},
		/** Observe cancellation rejection and pending reads before reader release. */
		async cancel(reason) {
			if (released) return;
			const results = await Promise.allSettled([
				reader.cancel(reason),
				pending,
			]);
			release();
			const failure = results.find((result) => result.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
		},
	};
}
