import { FileOperationDenied } from "@worker/application/files";

/** Read bounded inline bytes without retaining borrowed chunks or their backing buffers. */
export async function readInlineBody(
	request: Request,
	limit = 1_000_000,
): Promise<Uint8Array> {
	if (request.signal.aborted)
		throw new FileOperationDenied({ kind: "invalid_request" });
	if (request.body === null) return new Uint8Array();
	let byob: ReadableStreamBYOBReader | undefined;
	let ordinary: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		byob = request.body.getReader({ mode: "byob" });
	} catch {
		ordinary = request.body.getReader();
	}
	const reader = byob ?? ordinary;
	if (reader === undefined)
		throw new FileOperationDenied({ kind: "invalid_request" });
	const bytes = new Uint8Array(limit);
	let size = 0;
	let cancellation: Promise<void> | undefined;
	/** Stop pending input demand after caller cancellation. */
	const cancel = () => {
		cancellation ??= reader.cancel("Request aborted");
		void cancellation.catch(() => undefined);
	};
	request.signal.addEventListener("abort", cancel, { once: true });
	try {
		while (true) {
			if (request.signal.aborted)
				throw new FileOperationDenied({ kind: "invalid_request" });
			const item =
				byob === undefined
					? await ordinary?.read()
					: await byob.read(new Uint8Array(Math.min(65_536, limit - size + 1)));
			if (request.signal.aborted || item === undefined)
				throw new FileOperationDenied({ kind: "invalid_request" });
			if (item.done) break;
			const chunk = item.value;
			if (size + chunk.byteLength > limit)
				throw new FileOperationDenied({ kind: "text_too_large" });
			// Reject an oversized borrowed backing buffer instead of retaining a small view of it.
			if (chunk.buffer.byteLength > limit)
				throw new FileOperationDenied({ kind: "invalid_request" });
			bytes.set(chunk, size);
			size += chunk.byteLength;
		}
	} catch (error) {
		cancellation ??= reader.cancel(error);
		await cancellation.catch(() => undefined);
		throw error;
	} finally {
		request.signal.removeEventListener("abort", cancel);
		// Preserve body failure precedence, but retain ownership until source cleanup settles.
		await cancellation?.catch(() => undefined);
		reader.releaseLock();
	}
	return bytes.subarray(0, size);
}
