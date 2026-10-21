import type {
	AdmissionCompletion,
	AdmissionFinishResult,
} from "@obsidian-ai-bridge/protocol";
import { ReadBatchFailure } from "@worker/application/reads";

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

/**
 * Transfer one read slot and admission to a demand-driven byte response.
 * Final enqueue does not release ownership. EOF and cancellation join started work and cleanup.
 */
export function ownedReadResponse(
	source: ReadResponseSource,
	owner: ReadResponseOwner,
	releaseSlot: () => void,
	init?: ResponseInit,
	signal?: AbortSignal,
): Response {
	let pending: Promise<IteratorResult<Uint8Array>> | undefined;
	let stopping = false;
	let cleanup: Promise<void> | undefined;
	let controllerRef: ReadableStreamController<Uint8Array> | undefined;
	/** Join producer work and cleanup before durable settlement and local release. */
	function finish(
		cancel: boolean,
		completion: AdmissionCompletion,
		reason?: unknown,
	): Promise<void> {
		if (cleanup) return cleanup;
		stopping = true;
		cleanup = (async () => {
			let cancellation: Promise<void> | undefined;
			try {
				if (cancel) cancellation = Promise.resolve(source.cancel(reason));
			} catch (error) {
				cancellation = Promise.reject(error);
			}
			const results = await Promise.allSettled([pending, cancellation]);
			pending = undefined;
			signal?.removeEventListener("abort", abort);
			try {
				await owner.finish(
					results.some((result) => result.status === "rejected")
						? "uncertain"
						: completion,
				);
			} finally {
				controllerRef = undefined;
				releaseSlot();
			}
		})();
		return cleanup;
	}
	/** Abort response production without freeing capacity over unresolved work. */
	function abort() {
		const controller = controllerRef;
		void finish(true, "settled", signal?.reason).then(
			() => controller?.error(signal?.reason ?? new Error("Read aborted")),
			(error) => controller?.error(error),
		);
	}
	const stream = new ReadableStream<Uint8Array>({
		type: "bytes",
		/** Keep the controller only while response production owns its resources. */
		start(controller) {
			controllerRef = controller;
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
		},
		/** Request one chunk only under downstream demand, without a prefetch queue. */
		async pull(controller) {
			if (stopping) return;
			try {
				pending = source.next();
				const item = await pending;
				pending = undefined;
				if (stopping) return;
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
						error instanceof ReadBatchFailure ? "settled" : "uncertain",
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
			await pending?.catch(() => undefined);
			await chunks.return?.();
		},
	};
}

/** Read immutable bytes through a bounded BYOB reader without a complete application buffer. */
export function blobReadSource(
	body: ReadableStream<Uint8Array>,
): ReadResponseSource {
	const reader = body.getReader({ mode: "byob" });
	let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
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
			pending = reader.read(new Uint8Array(RESPONSE_CHUNK_BYTES));
			const item = await pending;
			if (item.done) {
				release();
				return { done: true, value: undefined };
			}
			return { done: false, value: item.value };
		},
		/** Observe cancellation rejection and pending reads before reader release. */
		async cancel(reason) {
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
