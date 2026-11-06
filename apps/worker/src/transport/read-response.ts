import type {
	AdmissionCompletion,
	AdmissionFinishResult,
} from "@obsidian-ai-bridge/protocol";
import type { ReadSlotLease } from "@worker/application/read-budget";
import { ReadAborted } from "@worker/application/read-demand";
import {
	ReadBatchFailure,
	settleReadAdmission,
} from "@worker/application/reads";

/** Maximum encoded bytes produced by one response demand. */
const RESPONSE_CHUNK_BYTES = 65_536;

/** Abort a fixed writer even when its consumer already ended the stream. */
async function abortResponseWriter(
	writer: WritableStreamDefaultWriter<Uint8Array>,
	reason: unknown,
): Promise<void> {
	try {
		await writer.abort(reason);
	} catch {
		// A canceled consumer can close the writer before cleanup reaches it.
	}
}

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

/**
 * Transfer one read slot and admission to a byte response.
 * Generic responses stay pull-driven. Positive known lengths use FixedLengthStream at the final
 * Response boundary and hold one bounded chunk until EOF validates the selected length. Zero-byte
 * known lengths use a gated byte stream so response status and Content-Length remain intact until
 * durable settlement succeeds. Settlement uses one fixed deadline. Local capacity releases after
 * started source work and source cancellation settle, independent of durable settlement and consumer
 * drain. The acquisition lease deadline releases local capacity and errors unfinished responses even
 * when source or cancellation work remains unresolved. Unknown work keeps durable admission uncertain.
 * @param knownByteLength - Exact response bytes, or undefined for generic response framing.
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
	let fixedWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
	let fixedWriterShutdown: Promise<void> | undefined;
	let fixedPump: Promise<void> | undefined;
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
	}
	/** Fail the response at its acquisition deadline without joining unknown source work. */
	function expire(): void {
		if (expired) return;
		expired = true;
		stopping = true;
		signalDeadline();
		release();
		const reason = new Error("Read slot hold deadline exceeded");
		deadlineError = reason;
		const controller = controllerRef;
		controllerRef = undefined;
		try {
			controller?.error(reason);
		} catch {
			// The response may already be closed when the deadline fires.
		}
		if (!settlement) void cancelSource(reason).catch(() => {});
		void abortFixedWriter(reason);
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
	/** Join source reads and cancellation before capacity release, then bound durable settlement. */
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
			const outcome = results.some(
				(result) =>
					result.status === "rejected" &&
					!(
						result.reason instanceof ReadBatchFailure ||
						result.reason instanceof ReadAborted
					),
			)
				? "uncertain"
				: completion;
			await settleReadAdmission(() => owner.finish(outcome));
		})();
		return settlement;
	}
	/** Join source cleanup and bounded settlement, with local capacity released after source cleanup. */
	function finish(
		cancel: boolean,
		completion: AdmissionCompletion,
		reason?: unknown,
	): Promise<void> {
		return settleOwner(
			cancel,
			expired ? "uncertain" : completion,
			reason,
		).finally(() => {
			release();
			completeDeadline();
		});
	}
	/** Start one fixed-writer shutdown and retain its promise for release coordination. */
	function abortFixedWriter(reason: unknown): Promise<void> {
		const writer = fixedWriter;
		if (!writer) return Promise.resolve();
		fixedWriterShutdown ??= abortResponseWriter(writer, reason);
		return fixedWriterShutdown;
	}
	/** Abort response production and join durable cleanup, the pump, and writer shutdown. */
	function abort() {
		const reason = signal?.reason;
		const controller = controllerRef;
		if (fixedWriter) {
			const abortReason = reason ?? new Error("Read aborted");
			const writerShutdown = abortFixedWriter(abortReason);
			const durableCleanup = settleOwner(true, "settled", reason);
			void Promise.allSettled([writerShutdown, durableCleanup, fixedPump]);
			return;
		}
		void finish(true, "settled", reason).then(
			() => controller?.error(reason ?? new Error("Read aborted")),
			(error) => controller?.error(error),
		);
	}
	if (knownByteLength !== undefined) {
		if (!Number.isSafeInteger(knownByteLength) || knownByteLength < 0)
			throw new RangeError(
				"Known response length must be a non-negative safe integer",
			);
		if (knownByteLength === 0) {
			const headers = new Headers(init?.headers);
			headers.set("Content-Length", "0");
			const responseInit: ResponseInit = {
				status: init?.status,
				statusText: init?.statusText,
				headers,
			};
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
					if (stopping) return;
					try {
						pending = source.next();
						const item = await Promise.race([
							pending,
							deadlinePromise.then(() => {
								throw deadlineError;
							}),
						]);
						pending = undefined;
						if (stopping || expired) return;
						if (item.done) {
							await finish(false, "settled");
							controller.close();
							if ("byobRequest" in controller)
								controller.byobRequest?.respond(0);
							return;
						}
						if (item.value.byteLength > 0)
							throw new Error("Read response source exceeded its limits");
					} catch (error) {
						pending = undefined;
						try {
							await finish(
								true,
								error instanceof ReadBatchFailure ||
									error instanceof ReadAborted
									? "settled"
									: "uncertain",
								error,
							);
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
			return new Response(zeroLengthStream, responseInit);
		}
		const fixed = new FixedLengthStream(knownByteLength);
		const writer = fixed.writable.getWriter();
		fixedWriter = writer;
		if (expired) void abortFixedWriter(deadlineError);
		/** Hold one bounded chunk until EOF settles the owner before response completion. */
		const pump = async (): Promise<void> => {
			let buffered: Uint8Array | undefined;
			let received = 0;
			while (!stopping) {
				let item: IteratorResult<Uint8Array>;
				try {
					pending = source.next();
					item = await Promise.race([
						pending,
						deadlinePromise.then(() => {
							throw deadlineError;
						}),
					]);
					pending = undefined;
				} catch (error) {
					pending = undefined;
					await abortFixedWriter(error);
					await settleOwner(
						true,
						error instanceof ReadBatchFailure || error instanceof ReadAborted
							? "settled"
							: "uncertain",
						error,
					);
					return;
				}
				if (stopping || expired) return;
				if (item.done) {
					if (received !== knownByteLength) {
						const error = new Error(
							"Response source length did not match its declaration",
						);
						await abortFixedWriter(error);
						await settleOwner(true, "uncertain", error);
						return;
					}
					try {
						await settleOwner(false, "settled");
						if (buffered) await writer.write(buffered);
						await writer.close();
					} catch (error) {
						await abortFixedWriter(error);
						await settleOwner(true, "settled", error);
					}
					return;
				}
				if (
					item.value.byteLength > RESPONSE_CHUNK_BYTES ||
					received + item.value.byteLength > knownByteLength
				) {
					const error = new Error("Read response source exceeded its limits");
					await abortFixedWriter(error);
					await settleOwner(true, "uncertain", error);
					return;
				}
				received += item.value.byteLength;
				if (buffered) {
					try {
						await writer.write(buffered);
					} catch (error) {
						await settleOwner(true, "settled", error);
						return;
					}
				}
				buffered = item.value;
			}
		};
		fixedPump = Promise.resolve()
			.then(pump)
			.catch(async (error: unknown) => {
				await abortFixedWriter(error);
				try {
					await settleOwner(true, "uncertain", error);
				} catch {
					// The response stream carries the producer fault to its consumer.
				}
			})
			.then(async () => {
				let ownerSettlement: Promise<void> | undefined;
				let writerShutdown: Promise<void> | undefined;
				do {
					ownerSettlement = settlement;
					writerShutdown = fixedWriterShutdown;
					await Promise.allSettled([ownerSettlement, writerShutdown]);
				} while (
					ownerSettlement !== settlement ||
					writerShutdown !== fixedWriterShutdown
				);
				release();
				completeDeadline();
			});
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		return new Response(fixed.readable, init);
	}
	const stream = new ReadableStream<Uint8Array>({
		type: "bytes",
		/** Keep the controller only while response production owns its resources. */
		start(controller) {
			controllerRef = controller;
			if (expired) {
				controller.error(deadlineError);
				return;
			}
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
		},
		/** Request one chunk only under downstream demand, without a prefetch queue. */
		async pull(controller) {
			if (stopping) return;
			try {
				pending = source.next();
				const item = await Promise.race([
					pending,
					deadlinePromise.then(() => {
						throw deadlineError;
					}),
				]);
				pending = undefined;
				if (stopping || expired) return;
				if (item.done) {
					await finish(false, "settled");
					controller.close();
					if ("byobRequest" in controller) controller.byobRequest?.respond(0);
				} else {
					if (item.value.byteLength > RESPONSE_CHUNK_BYTES)
						throw new Error("Read response chunk exceeded its limit");
					controller.enqueue(item.value);
				}
			} catch (error) {
				pending = undefined;
				if (stopping) {
					controller.error(error);
					return;
				}
				try {
					await finish(
						true,
						error instanceof ReadBatchFailure || error instanceof ReadAborted
							? "settled"
							: "uncertain",
						error,
					);
				} catch {
					/* The stream reports failure even when durable cleanup also fails. */
				}
				controller.error(error);
			}
		},
		/** Cancellation joins pending work, producer cancellation, and durable cleanup. */
		cancel(reason) {
			return finish(true, "settled", reason);
		},
	});
	return new Response(stream, init);
}

/** Encode JSON with bounded string windows, including isolated UTF-16 surrogates. */
export function* encodeJsonChunks(value: unknown): Generator<Uint8Array> {
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
				yield* encodeJsonChunks(key);
				yield encoder.encode(":");
			}
			yield* encodeJsonChunks(field);
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
