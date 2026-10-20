import {
	encodeFileFailure,
	encodeFileFailureBodyChunks,
	type FileHttpFailureInput,
} from "@obsidian-ai-bridge/protocol";

/** Maximum bytes requested or queued by the owned response reader. */
const RESPONSE_CHUNK_BYTES = 65_536;

/**
 * Keep mutation capacity through response preparation and owned production, not final client delivery.
 * Completion never rejects. Headers return without waiting for EOF or cancellation cleanup.
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
			return new Response(ownedResponseBody(reader, complete), response);
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
 * Forward one bounded read at a time under downstream demand.
 * EOF or cancellation clears owned references after all started reads and cleanup settle.
 */
function ownedResponseBody(
	reader: ReadableStreamBYOBReader | undefined,
	complete: () => void,
): ReadableStream<Uint8Array> {
	let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
	let stopping = false;
	let cleanup: Promise<void> | undefined;
	/** Join started read and cancellation before releasing the reader and its capacity. */
	function finish(cancel: boolean, reason?: unknown): Promise<void> {
		if (cleanup !== undefined) return cleanup;
		stopping = true;
		const cancellation = cancel ? reader?.cancel(reason) : undefined;
		cleanup = (async () => {
			await Promise.allSettled([pending, cancellation]);
			pending = undefined;
			reader?.releaseLock();
			reader = undefined;
			complete();
		})();
		return cleanup;
	}
	return new ReadableStream<Uint8Array>({
		type: "bytes",
		/** Supply a single bounded chunk. Final enqueue does not complete production. */
		async pull(controller) {
			if (stopping || reader === undefined) return;
			try {
				pending = reader.read(new Uint8Array(RESPONSE_CHUNK_BYTES));
				const item = await pending;
				pending = undefined;
				if (stopping) return;
				if (item.done) {
					await finish(false);
					controller.close();
					if ("byobRequest" in controller) controller.byobRequest?.respond(0);
				} else {
					controller.enqueue(item.value);
				}
			} catch (error) {
				if (stopping) return;
				await finish(true, error);
				controller.error(error);
			}
		},
		/** Observe overlapping reads and producer cancellation, including cleanup failures. */
		cancel(reason) {
			return finish(true, reason);
		},
	});
}

/** Encode a canonical failure without exposing thrown exception details. */
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
			headers: { ...result.headers, "Content-Type": "application/json" },
		},
	);
}
