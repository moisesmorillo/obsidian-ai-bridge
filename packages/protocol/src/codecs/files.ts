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
	if (failure.kind === "admission_limited") {
		result.headers = {
			"Retry-After": BigInt(failure.retry_after_seconds).toString(10),
		};
	}
	return FileHttpFailureSchema.parse(result);
}
