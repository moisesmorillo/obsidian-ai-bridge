import {
	FILE_HTTP_MESSAGES,
	FILE_HTTP_STATUSES,
	FileHttpFailureSchema,
} from "@protocol/schemas/files";
import type {
	FileHttpFailure,
	FileHttpFailureInput,
} from "@protocol/types/files";

/** Encodes only canonical failure details with fixed safe messages and status codes. */
export function encodeFileFailure(
	failure: FileHttpFailureInput,
): FileHttpFailure {
	const body: Record<string, unknown> = {
		error: failure.kind,
		message: FILE_HTTP_MESSAGES[failure.kind],
	};

	switch (failure.kind) {
		case "epoch_mismatch":
			body.current_epoch = failure.current_epoch;
			break;
		case "path_collision":
			body.existing_path = failure.existing_path;
			break;
		case "precondition_failed":
			if (failure.etag !== undefined) body.etag = failure.etag;
			if (failure.hash !== undefined) body.hash = failure.hash;
			if (failure.deleted !== undefined) body.deleted = failure.deleted;
			if (failure.content !== undefined) body.content = failure.content;
			break;
		default:
			break;
	}

	const result: Record<string, unknown> = {
		status: FILE_HTTP_STATUSES[failure.kind],
		body,
	};
	if (
		failure.kind === "admission_limited" ||
		failure.kind === "blob_storage_unavailable"
	) {
		result.headers = {
			"Retry-After": BigInt(failure.retry_after_seconds).toString(10),
		};
	}
	return FileHttpFailureSchema.parse(result);
}

/**
 * Serialize an already canonical flat failure body without a complete escaped JSON allocation.
 * String windows contain at most 8,192 UTF-16 units. Each UTF-8 chunk stays below 65,536 bytes.
 */
export function* encodeFileFailureBodyChunks(
	body: FileHttpFailure["body"],
): Iterable<Uint8Array> {
	const encoder = new TextEncoder();
	yield encoder.encode("{");
	let separator = "";
	// Read one field at a time. Object.entries would retain all field values until generator completion.
	for (const key of Object.keys(body)) {
		const value = body[key as keyof typeof body];
		if (value === undefined) continue;
		yield encoder.encode(`${separator}${JSON.stringify(key)}:`);
		separator = ",";
		if (typeof value !== "string") {
			yield encoder.encode(JSON.stringify(value));
			continue;
		}
		yield encoder.encode('"');
		for (let start = 0; start < value.length; ) {
			let end = Math.min(start + 8192, value.length);
			// Keep valid surrogate pairs together. JSON.stringify escapes isolated halves exactly.
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
	}
	yield encoder.encode("}");
}
