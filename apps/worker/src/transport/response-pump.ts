import { waitUntil } from "cloudflare:workers";

/**
 * How one pump run ended.
 * `eof`: the source reported its end and every accepted chunk went to `write`.
 * `source_failed`: `next` rejected or `accept` threw. The error is the source or limit fault.
 * `write_failed`: `write` rejected. On a native writer this is consumer cancellation or writer abort.
 * `stopped`: the caller's stop condition became true before or after a source demand.
 */
export type ResponsePumpEnd =
	| { kind: "eof" }
	| { kind: "source_failed"; error: unknown }
	| { kind: "write_failed"; error: unknown }
	| { kind: "stopped" };

/** Hooks for one sequential response pump. */
export interface ResponsePumpHooks {
	/** Demand at most one bounded chunk. The pump never calls it again before `write` settles. */
	next(): Promise<IteratorResult<Uint8Array>>;
	/** Validate one chunk before the write. A throw ends the pump as `source_failed`. */
	accept?(chunk: Uint8Array): void;
	/** Hand one chunk to the native writer. A rejection ends the pump as `write_failed`. */
	write(chunk: Uint8Array): Promise<void>;
	/** True when the caller has stopped the response, for example at its deadline. */
	stopped(): boolean;
}

/**
 * Move source chunks to a native writer one at a time.
 * A native write resolves only after its consumer reads the chunk, so the next source demand starts
 * after the previous write resolves and only one demand is outstanding. A native write rejects
 * after the consumer cancels, also across the runtime boundary, where a JavaScript stream never gets
 * its cancel callback. The caller owns the writer, source cleanup, and capacity release for each end.
 * The pump never throws: every fault becomes a `ResponsePumpEnd`.
 */
export async function pumpResponseChunks(
	hooks: ResponsePumpHooks,
): Promise<ResponsePumpEnd> {
	while (!hooks.stopped()) {
		let item: IteratorResult<Uint8Array>;
		try {
			item = await hooks.next();
			if (!item.done) hooks.accept?.(item.value);
		} catch (error) {
			return { kind: "source_failed", error };
		}
		if (hooks.stopped()) return { kind: "stopped" };
		if (item.done) return { kind: "eof" };
		try {
			await hooks.write(item.value);
		} catch (error) {
			return { kind: "write_failed", error };
		}
	}
	return { kind: "stopped" };
}

/**
 * Abort a native response writer and ignore a rejected abort. A consumer that already canceled can
 * end the writer before cleanup reaches it. This covers IdentityTransformStream and FixedLengthStream.
 */
export async function abortResponseWriter(
	writer: WritableStreamDefaultWriter<Uint8Array>,
	reason: unknown,
): Promise<void> {
	try {
		await writer.abort(reason);
	} catch {
		// A canceled consumer can close the writer before cleanup reaches it.
	}
}

/**
 * Keep the current invocation alive until response work settles.
 * Workers cancel every task of a request whose client disconnects unless the task is registered with
 * waitUntil. Without it a canceled body never sees its failed write, never cancels its source, and
 * keeps its capacity until a lazy reclaim. The caller resolves `work` when response work completes,
 * or within a bounded grace after its response deadline. Outside a request context (for example a
 * direct unit call) there is nothing to extend, so a registration failure is ignored.
 */
export function keepResponseWorkAlive(work: Promise<void>): void {
	try {
		waitUntil(work);
	} catch {
		// No current invocation exists to extend.
	}
}
