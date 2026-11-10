import {
	encodeFileFailure,
	encodeFileFailureBodyChunks,
	type FileHttpFailureInput,
} from "@vaultwire/protocol";
import { BODY_RESPONSE_DEADLINE_MS } from "@worker/application/body-budget";
import { jsonReadHeaders } from "@worker/transport/json-read-headers";
import {
	abortResponseWriter,
	keepResponseWorkAlive,
	pumpResponseChunks,
} from "@worker/transport/response-pump";

/** Maximum bytes requested from the inner body in one read. */
const RESPONSE_CHUNK_BYTES = 65_536;
/**
 * Bound, in milliseconds, on the invocation keep-alive after the response deadline when inner
 * cancellation never settles. Body slot reclaim still owns the capacity after this bound.
 */
const MUTATION_RESPONSE_SETTLEMENT_GRACE_MS = 5_000;

/**
 * Keep mutation capacity through response preparation and owned production, not final client delivery.
 * Completion never rejects. Headers return without waiting for EOF or cancellation cleanup.
 * The returned body is the readable side of an IdentityTransformStream that a pump fills from the
 * inner body, so a client cancel across the runtime boundary reaches the pump as a failed write.
 */
export async function withMutationResponse(
	execute: (responseProduction: Promise<void>) => Promise<Response>,
): Promise<Response> {
	/** Resolve the response lifetime without a failure or payload value. */
	let complete = () => {};
	const production = new Promise<void>((resolve) => {
		complete = resolve;
	});
	try {
		const response = await execute(production);
		if (response.body === null) {
			complete();
			return response;
		}
		const reader = response.body.getReader({ mode: "byob" });
		try {
			return new Response(pumpedResponseBody(reader, complete), response);
		} catch (error) {
			await reader.cancel(error).catch(() => undefined);
			reader.releaseLock();
			throw error;
		}
	} catch (error) {
		complete();
		throw error;
	}
}

/**
 * Forward the inner body through the shared response pump, one read of at most 65,536 bytes at a
 * time, written only after the previous write was read.
 * Producer EOF completes production before the clean close. A rejected write is consumer
 * cancellation: the pump cancels the inner reader once, joins its pending read, releases the lock,
 * and completes production once. An inner read failure does the same and then errors the body.
 * At BODY_RESPONSE_DEADLINE_MS the pump aborts the writer, so a client that stopped reading gets an
 * error, and cancels the inner reader. If that cleanup never settles, body slot reclaim releases the
 * capacity later and the keep-alive ends after a bounded grace.
 */
function pumpedResponseBody(
	inner: ReadableStreamBYOBReader,
	complete: () => void,
): ReadableStream<Uint8Array> {
	let reader: ReadableStreamBYOBReader | undefined = inner;
	let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
	let stopping = false;
	let cleanup: Promise<void> | undefined;
	const framing = new IdentityTransformStream();
	const writer = framing.writable.getWriter();
	let signalWorkSettled!: () => void;
	const workSettled = new Promise<void>((resolve) => {
		signalWorkSettled = resolve;
	});
	keepResponseWorkAlive(workSettled);
	const deadline = setTimeout(expire, BODY_RESPONSE_DEADLINE_MS);
	/** Join the started read and inner cancellation, release the reader, and complete production once. */
	function finish(cancel: boolean, reason?: unknown): Promise<void> {
		if (cleanup !== undefined) return cleanup;
		stopping = true;
		clearTimeout(deadline);
		let cancellation: Promise<void> | undefined;
		try {
			cancellation = cancel ? reader?.cancel(reason) : undefined;
		} catch (error) {
			cancellation = Promise.reject(error);
		}
		cleanup = (async () => {
			await Promise.allSettled([pending, cancellation]);
			pending = undefined;
			reader?.releaseLock();
			reader = undefined;
			complete();
			signalWorkSettled();
		})();
		return cleanup;
	}
	/** Error the body at the response deadline and bound the keep-alive when cleanup stalls. */
	function expire(): void {
		if (stopping) return;
		const reason = new Error("Mutation response deadline exceeded");
		void abortResponseWriter(writer, reason);
		const work = finish(true, reason);
		let grace: ReturnType<typeof setTimeout> | undefined;
		void Promise.race([
			work,
			new Promise<void>((resolve) => {
				grace = setTimeout(resolve, MUTATION_RESPONSE_SETTLEMENT_GRACE_MS);
			}),
		]).then(() => {
			clearTimeout(grace);
			signalWorkSettled();
		});
	}
	/** Pump the inner body and end production for each pump outcome. */
	const pump = async (): Promise<void> => {
		const end = await pumpResponseChunks({
			next: async () => {
				const current = reader;
				if (current === undefined) return { done: true, value: undefined };
				pending = current.read(new Uint8Array(RESPONSE_CHUNK_BYTES));
				try {
					const item = await pending;
					return item.done
						? { done: true, value: undefined }
						: { done: false, value: item.value };
				} finally {
					pending = undefined;
				}
			},
			write: (chunk) => writer.write(chunk),
			stopped: () => stopping,
		});
		switch (end.kind) {
			case "stopped":
				return;
			case "write_failed":
				// The consumer canceled, or the deadline aborted the writer.
				await finish(true, end.error);
				return;
			case "source_failed":
				await finish(true, end.error);
				await abortResponseWriter(writer, end.error);
				return;
			case "eof":
				await finish(false);
				try {
					await writer.close();
				} catch {
					// A consumer that canceled after the last read already ended the body.
				}
		}
	};
	void pump().catch(async (error: unknown) => {
		await finish(true, error);
		await abortResponseWriter(writer, error);
	});
	return framing.readable;
}

/**
 * Encode a canonical failure without exposing thrown exception details.
 * File read and mutation failures send `Cache-Control: no-transform` like JSON read responses.
 */
export function fileFailureResponse(failure: FileHttpFailureInput): Response {
	const result = encodeFileFailure(failure);
	let chunks: Iterator<Uint8Array> | undefined = encodeFileFailureBodyChunks(
		result.body,
	)[Symbol.iterator]();
	return new Response(
		new ReadableStream<Uint8Array>({
			type: "bytes",
			/** Produce one canonical chunk only when downstream requests bytes. */
			pull(controller) {
				const item = chunks?.next();
				if (item === undefined || item.done) {
					chunks = undefined;
					controller.close();
					if ("byobRequest" in controller) controller.byobRequest?.respond(0);
				} else controller.enqueue(item.value);
			},
			/** Clear the generator and its content reference before cancellation completes. */
			cancel() {
				chunks?.return?.();
				chunks = undefined;
			},
		}),
		{
			status: result.status,
			headers: jsonReadHeaders({
				...result.headers,
				"Content-Type": "application/json",
			}),
		},
	);
}
