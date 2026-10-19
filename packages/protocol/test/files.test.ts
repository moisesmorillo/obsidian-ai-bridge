import type { FileHttpFailure, FileHttpFailureInput } from "@protocol/index";
import {
	AdmissionFailureSchema,
	CurrentEpochRequestSchema,
	CurrentEpochResultSchema,
	encodeFileFailure,
	FileFailureSchema,
	FileHttpFailureInputSchema,
	FileHttpFailureSchema,
	MutationReceiptSchema,
	MutationSuccessSchema,
	TextMutationBeginResultSchema,
	TextMutationDescriptorSchema,
	TextMutationIntentSchema,
	TextMutationResultSchema,
	TextPayloadSchema,
	TextReadRequestSchema,
	TextReadResponseSchema,
	TextReadResultSchema,
} from "@protocol/index";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

const epoch = "0000000000000000000000000000000a";
const hash = "0".repeat(64);
const etag = `"${epoch}.1"`;
const validPut = {
	op: "put",
	epoch,
	paths: ["note.md"],
	precondition: { kind: "absent" },
} as const;
const validDelete = {
	op: "delete",
	paths: ["note.md"],
	precondition: { kind: "match", etag },
} as const;
const success = {
	path: "note.md",
	etag,
	seq: 1,
	hash,
	size: 5,
	deleted: false,
};
const tombstoneSuccess = {
	...success,
	hash: "",
	size: 0,
	deleted: true,
};
const validTextPayload = {
	content: "hello",
	payload_hash:
		"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
	size: 5,
};
const readResponse = {
	path: "note.md",
	etag,
	hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
	size: 5,
	kind: "text",
	deleted: false,
	origin: "client",
	updated_at: 1,
	content: "hello",
	offset: 0,
	length: 5,
	truncated: false,
} as const;

/** Shows whether a schema accepts one DTO fixture. */
function accepts(schema: ZodType, value: unknown): boolean {
	return schema.safeParse(value).success;
}

/** Captures a typed encoder result so rejection shells still reach result assertions. */
function encodedFailure(
	failure: FileHttpFailureInput,
): FileHttpFailure | undefined {
	try {
		return encodeFileFailure(failure);
	} catch {
		return undefined;
	}
}

describe("current epoch metadata contract", () => {
	it("accepts the current read, text mutation, and history mutation operations", () => {
		expect(CurrentEpochRequestSchema.parse({ operation: "put" })).toEqual({
			operation: "put",
		});
		for (const operation of ["rename", "append", "restore"] as const) {
			expect(CurrentEpochRequestSchema.parse({ operation })).toEqual({
				operation,
			});
		}
		expect(
			CurrentEpochRequestSchema.safeParse({ operation: "read", extra: true })
				.success,
		).toBe(false);
	});

	it("accepts a canonical epoch or authority failure", () => {
		expect(
			CurrentEpochResultSchema.parse({ ok: true, current_epoch: epoch }),
		).toEqual({ ok: true, current_epoch: epoch });
		expect(
			CurrentEpochResultSchema.parse({
				ok: false,
				failure: { kind: "revoked" },
			}),
		).toEqual({ ok: false, failure: { kind: "revoked" } });
		expect(
			CurrentEpochResultSchema.safeParse({
				ok: true,
				current_epoch: "not-an-epoch",
			}).success,
		).toBe(false);
	});
});

describe("text mutation contracts", () => {
	it("accepts a PUT descriptor with an absent condition", () => {
		expect(accepts(TextMutationDescriptorSchema, validPut)).toBe(true);
	});

	it("accepts a PUT descriptor with a matching ETag", () => {
		expect(
			accepts(TextMutationDescriptorSchema, {
				...validPut,
				precondition: { kind: "match", etag },
			}),
		).toBe(true);
	});

	it("accepts a DELETE descriptor with a matching ETag", () => {
		expect(accepts(TextMutationDescriptorSchema, validDelete)).toBe(true);
	});

	it("rejects unknown descriptor fields", () => {
		expect(
			accepts(TextMutationDescriptorSchema, { ...validPut, unknown: true }),
		).toBe(false);
	});

	it("rejects operations outside PUT and DELETE", () => {
		expect(
			accepts(TextMutationDescriptorSchema, {
				...validPut,
				op: "append",
			}),
		).toBe(false);
	});

	it("rejects a PUT descriptor without an epoch", () => {
		expect(
			accepts(TextMutationDescriptorSchema, {
				...validPut,
				epoch: undefined,
			}),
		).toBe(false);
	});

	it("rejects a DELETE descriptor without a matching condition", () => {
		expect(
			accepts(TextMutationDescriptorSchema, {
				...validDelete,
				precondition: { kind: "absent" },
			}),
		).toBe(false);
	});

	it("rejects a descriptor with an invalid path count", () => {
		expect(
			accepts(TextMutationDescriptorSchema, {
				...validPut,
				paths: ["note.md", "other.md"],
			}),
		).toBe(false);
	});

	it("rejects a PUT descriptor with an ETag from another epoch", () => {
		expect(
			accepts(TextMutationDescriptorSchema, {
				...validPut,
				epoch: "0000000000000000000000000000000b",
				precondition: { kind: "match", etag },
			}),
		).toBe(false);
	});

	it("accepts PUT intent with payload metadata", () => {
		expect(
			accepts(TextMutationIntentSchema, {
				...validPut,
				payload_hash: hash,
				size: 5,
			}),
		).toBe(true);
	});

	it("accepts DELETE intent with the empty payload digest", () => {
		expect(
			accepts(TextMutationIntentSchema, {
				...validDelete,
				payload_hash:
					"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
				size: 0,
			}),
		).toBe(true);
	});

	it("rejects malformed PUT payload metadata", () => {
		expect(
			accepts(TextMutationIntentSchema, {
				...validPut,
				payload_hash: "bad",
				size: -1,
			}),
		).toBe(false);
	});

	it("rejects non-empty DELETE payload metadata", () => {
		expect(
			accepts(TextMutationIntentSchema, {
				...validDelete,
				payload_hash: hash,
				size: 1,
			}),
		).toBe(false);
	});

	it("rejects a PUT intent above the existing blob limit", () => {
		expect(
			accepts(TextMutationIntentSchema, {
				...validPut,
				payload_hash: hash,
				size: 25_000_001,
			}),
		).toBe(false);
	});

	it("rejects a PUT intent above the existing request limit", () => {
		expect(
			accepts(TextMutationIntentSchema, {
				...validPut,
				payload_hash: hash,
				size: 26_000_001,
			}),
		).toBe(false);
	});

	it("rejects an append intent", () => {
		expect(
			accepts(TextMutationIntentSchema, {
				op: "append",
				epoch,
				paths: ["note.md"],
				precondition: { kind: "none" },
				payload_hash: hash,
				size: 0,
			}),
		).toBe(false);
	});
});

describe("full text payload contract", () => {
	it("accepts valid full UTF-8 text", () => {
		expect(accepts(TextPayloadSchema, validTextPayload)).toBe(true);
	});

	it("rejects lone surrogates in full text", () => {
		expect(
			accepts(TextPayloadSchema, {
				...validTextPayload,
				content: "bad\ud800",
				size: 6,
			}),
		).toBe(false);
	});

	it("rejects full text with an incorrect UTF-8 byte size", () => {
		expect(
			accepts(TextPayloadSchema, {
				...validTextPayload,
				content: "café",
				size: 4,
			}),
		).toBe(false);
	});

	it("rejects full text above the inline byte limit", () => {
		expect(
			accepts(TextPayloadSchema, {
				...validTextPayload,
				content: "a".repeat(1_000_001),
				size: 1_000_001,
			}),
		).toBe(false);
	});
});

describe("mutation and read DTOs", () => {
	it("accepts a live mutation success", () => {
		expect(accepts(MutationSuccessSchema, success)).toBe(true);
	});

	it("accepts a tombstone mutation success", () => {
		expect(accepts(MutationSuccessSchema, tombstoneSuccess)).toBe(true);
	});

	it("accepts a live mutation receipt", () => {
		expect(accepts(MutationReceiptSchema, { status: 201, body: success })).toBe(
			true,
		);
	});

	it("accepts a tombstone mutation receipt", () => {
		expect(
			accepts(MutationReceiptSchema, { status: 200, body: tombstoneSuccess }),
		).toBe(true);
	});

	it("accepts a successful mutation commit result", () => {
		expect(
			accepts(TextMutationResultSchema, {
				ok: true,
				response: { status: 201, body: success },
			}),
		).toBe(true);
	});

	it("accepts a successful mutation start result", () => {
		expect(
			accepts(TextMutationBeginResultSchema, {
				ok: true,
				lease: { admission_id: "a", expires_at: 10 },
			}),
		).toBe(true);
	});

	it("accepts a failed mutation commit result", () => {
		expect(
			accepts(TextMutationResultSchema, {
				ok: false,
				failure: { kind: "not_found" },
			}),
		).toBe(true);
	});

	it("accepts a failed mutation start result", () => {
		expect(
			accepts(TextMutationBeginResultSchema, {
				ok: false,
				failure: { kind: "not_found" },
			}),
		).toBe(true);
	});

	it("rejects a tombstone with a non-empty hash", () => {
		expect(
			accepts(MutationSuccessSchema, { ...tombstoneSuccess, hash, size: 0 }),
		).toBe(false);
	});

	it("rejects a tombstone with nonzero size", () => {
		expect(
			accepts(MutationSuccessSchema, {
				...tombstoneSuccess,
				hash: "",
				size: 2,
			}),
		).toBe(false);
	});

	it("rejects a mutation success with a bare revision field", () => {
		expect(accepts(MutationSuccessSchema, { ...success, rev: 1 })).toBe(false);
	});

	it("rejects a live mutation with tombstone size", () => {
		expect(
			accepts(MutationSuccessSchema, { ...success, deleted: true, size: 4 }),
		).toBe(false);
	});

	it("rejects unsupported receipt status", () => {
		expect(accepts(MutationReceiptSchema, { status: 202, body: success })).toBe(
			false,
		);
	});

	it("rejects conflicting mutation start result fields", () => {
		expect(
			accepts(TextMutationBeginResultSchema, {
				ok: false,
				lease: { admission_id: "a", expires_at: 10 },
			}),
		).toBe(false);
	});

	it("accepts a current read request without a historical selector", () => {
		expect(accepts(TextReadRequestSchema, { path: "note.md" })).toBe(true);
	});

	it("needs an epoch for a historical read selector", () => {
		expect(accepts(TextReadRequestSchema, { path: "note.md", rev: 1 })).toBe(
			false,
		);
	});

	it("accepts a historical read request with its epoch", () => {
		expect(
			accepts(TextReadRequestSchema, { path: "note.md", epoch, rev: 1 }),
		).toBe(true);
	});

	it("rejects malformed read ranges and unknown fields", () => {
		expect(
			accepts(TextReadRequestSchema, { path: "note.md", offset: -1 }),
		).toBe(false);
		expect(
			accepts(TextReadRequestSchema, { path: "note.md", selector: "other" }),
		).toBe(false);
	});

	it.each([
		["first UTF-16 half", "😀".slice(0, 1), 0, true],
		["second UTF-16 half", "😀".slice(1, 2), 1, false],
	] as const)(
		"retains the %s range through JSON serialization",
		(_label, content, offset, truncated) => {
			const fragment = {
				...readResponse,
				hash: "f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9",
				size: 4,
				content,
				offset,
				length: 1,
				truncated,
			};
			const roundTrip = JSON.parse(JSON.stringify(fragment));
			expect(roundTrip.content).toBe(content);
			expect(accepts(TextReadResponseSchema, roundTrip)).toBe(true);
		},
	);

	it("accepts a successful text read result", () => {
		expect(
			accepts(TextReadResultSchema, { ok: true, body: readResponse }),
		).toBe(true);
	});

	it("accepts a failed text read result", () => {
		expect(
			accepts(TextReadResultSchema, {
				ok: false,
				failure: { kind: "not_found" },
			}),
		).toBe(true);
	});

	it("accepts canonical tombstone read metadata", () => {
		expect(
			accepts(TextReadResponseSchema, {
				...readResponse,
				hash: "",
				size: 0,
				deleted: true,
				content: null,
			}),
		).toBe(true);
	});

	it("rejects a live read with null content", () => {
		expect(
			accepts(TextReadResponseSchema, {
				...readResponse,
				deleted: false,
				content: null,
			}),
		).toBe(false);
	});

	it("rejects a tombstone read with live content", () => {
		expect(
			accepts(TextReadResponseSchema, { ...readResponse, deleted: true }),
		).toBe(false);
	});

	it("rejects a tombstone read with non-empty hash or size", () => {
		expect(
			accepts(TextReadResponseSchema, {
				...readResponse,
				deleted: true,
				content: null,
				hash,
				size: 5,
			}),
		).toBe(false);
	});
});

describe("canonical failure DTO", () => {
	it.each([
		{ kind: "invalid_request" },
		{ kind: "admission_limited", retry_after_seconds: 4 },
	])("preserves admission failure acceptance for %s", (failure) => {
		expect(accepts(FileFailureSchema, failure)).toBe(true);
	});

	it("preserves operation-expired failure acceptance", () => {
		expect(accepts(FileFailureSchema, { kind: "operation_expired" })).toBe(
			true,
		);
	});

	it("keeps existing admission parsing behavior outside file contracts", () => {
		expect(
			AdmissionFailureSchema.parse({
				kind: "invalid_request",
				secret: "stripped",
			}),
		).toEqual({ kind: "invalid_request" });
	});

	it("rejects unknown fields on a simple admission failure", () => {
		expect(
			accepts(FileFailureSchema, {
				kind: "invalid_request",
				secret: "hidden",
			}),
		).toBe(false);
	});

	it("rejects unknown fields on an admission failure with details", () => {
		expect(
			accepts(FileFailureSchema, {
				kind: "admission_limited",
				retry_after_seconds: 4,
				secret: "hidden",
			}),
		).toBe(false);
	});

	it("rejects unknown fields on precondition failure details", () => {
		expect(
			accepts(FileFailureSchema, {
				kind: "precondition_failed",
				etag,
				hash,
				deleted: false,
				secret: "hidden",
			}),
		).toBe(false);
	});

	it("rejects unknown simple admission fields in mutation results", () => {
		expect(
			accepts(TextMutationResultSchema, {
				ok: false,
				failure: { kind: "invalid_request", secret: "hidden" },
			}),
		).toBe(false);
	});

	it("rejects unknown admission detail fields in start results", () => {
		expect(
			accepts(TextMutationBeginResultSchema, {
				ok: false,
				failure: {
					kind: "admission_limited",
					retry_after_seconds: 4,
					secret: "hidden",
				},
			}),
		).toBe(false);
	});

	it("rejects unknown precondition details in read results", () => {
		expect(
			accepts(TextReadResultSchema, {
				ok: false,
				failure: {
					kind: "precondition_failed",
					etag,
					hash,
					deleted: false,
					secret: "hidden",
				},
			}),
		).toBe(false);
	});

	it("rejects unknown fields in HTTP failure inputs", () => {
		expect(
			accepts(FileHttpFailureInputSchema, {
				kind: "invalid_request",
				secret: "hidden",
			}),
		).toBe(false);
	});

	it("preserves the existing path in parsed collision evidence", () => {
		expect(
			FileFailureSchema.safeParse({
				kind: "path_collision",
				existing_path: "archive/notes.md",
			}),
		).toMatchObject({
			success: true,
			data: { kind: "path_collision", existing_path: "archive/notes.md" },
		});
	});

	it("rejects a path collision without its existing path", () => {
		expect(accepts(FileFailureSchema, { kind: "path_collision" })).toBe(false);
	});

	it("accepts precondition metadata without full content", () => {
		expect(
			accepts(FileFailureSchema, {
				kind: "precondition_failed",
				etag,
				hash,
				deleted: false,
			}),
		).toBe(true);
	});

	it("preserves full content in parsed precondition failure", () => {
		expect(
			FileFailureSchema.safeParse({
				kind: "precondition_failed",
				etag,
				hash,
				deleted: false,
				content: "current",
			}),
		).toMatchObject({
			success: true,
			data: { kind: "precondition_failed", content: "current" },
		});
	});

	it("rejects precondition metadata with missing fields", () => {
		expect(
			accepts(FileFailureSchema, { kind: "precondition_failed", etag, hash }),
		).toBe(false);
	});

	it("rejects an empty current hash for a live precondition", () => {
		expect(
			accepts(FileFailureSchema, {
				kind: "precondition_failed",
				etag,
				hash: "",
				deleted: false,
			}),
		).toBe(false);
	});

	it("rejects precondition content without revision identity", () => {
		expect(
			accepts(FileFailureSchema, {
				kind: "precondition_failed",
				content: "current without identity",
			}),
		).toBe(false);
	});

	it("accepts the canonical strict HTTP failure result", () => {
		expect(
			accepts(FileHttpFailureSchema, {
				status: 400,
				body: {
					error: "invalid_request",
					message: "The request is not valid.",
				},
			}),
		).toBe(true);
	});

	it("rejects a foreign detail field", () => {
		expect(
			accepts(FileHttpFailureSchema, {
				status: 400,
				body: {
					error: "invalid_request",
					message: "The request is not valid.",
					secret: "hidden",
				},
			}),
		).toBe(false);
	});

	it("rejects an error paired with the wrong status", () => {
		expect(
			accepts(FileHttpFailureSchema, {
				status: 400,
				body: { error: "not_found", message: "The file does not exist." },
			}),
		).toBe(false);
	});

	it("rejects the wrong fixed message", () => {
		expect(
			accepts(FileHttpFailureSchema, {
				status: 404,
				body: { error: "not_found", message: "The request is not valid." },
			}),
		).toBe(false);
	});

	it("rejects an unknown header", () => {
		expect(
			accepts(FileHttpFailureSchema, {
				status: 404,
				body: { error: "not_found", message: "The file does not exist." },
				headers: { "X-Secret": "hidden" },
			}),
		).toBe(false);
	});

	it("needs Retry-After for an admission limit", () => {
		expect(
			accepts(FileHttpFailureSchema, {
				status: 429,
				body: {
					error: "admission_limited",
					message: "The vault cannot accept another operation now.",
				},
			}),
		).toBe(false);
	});

	it("rejects Retry-After for a non-limited failure", () => {
		expect(
			accepts(FileHttpFailureSchema, {
				status: 404,
				body: { error: "not_found", message: "The file does not exist." },
				headers: { "Retry-After": "7" },
			}),
		).toBe(false);
	});
});

describe("file failure HTTP mapping", () => {
	it.each([
		[
			{ kind: "invalid_request" },
			400,
			"invalid_request",
			"The request is not valid.",
		],
		[{ kind: "invalid_path" }, 400, "invalid_path", "The path is not valid."],
		[{ kind: "revoked" }, 401, "revoked", "The grant no longer allows access."],
		[
			{ kind: "forbidden_scope" },
			403,
			"forbidden_scope",
			"The grant does not allow this operation.",
		],
		[{ kind: "not_found" }, 404, "not_found", "The file does not exist."],
		[
			{ kind: "epoch_mismatch", current_epoch: epoch },
			409,
			"epoch_mismatch",
			"The vault epoch does not match.",
		],
		[
			{ kind: "path_collision", existing_path: "archive/notes.md" },
			409,
			"path_collision",
			"Another file uses this path key.",
		],
		[
			{ kind: "operation_expired" },
			409,
			"operation_expired",
			"The operation key is outside the accepted time range.",
		],
		[
			{ kind: "idempotency_in_progress" },
			409,
			"idempotency_in_progress",
			"An operation with this key is not complete.",
		],
		[
			{ kind: "invalid_ticket" },
			409,
			"invalid_ticket",
			"The operation ticket is not valid.",
		],
		[
			{ kind: "revision_pruned" },
			410,
			"revision_pruned",
			"This revision is no longer available.",
		],
		[
			{ kind: "precondition_failed", etag, hash, deleted: false },
			412,
			"precondition_failed",
			"The file state does not match the precondition.",
		],
		[
			{ kind: "text_too_large" },
			413,
			"text_too_large",
			"The text is larger than the size limit.",
		],
		[
			{ kind: "blob_too_large" },
			413,
			"blob_too_large",
			"The blob is larger than the size limit.",
		],
		[
			{ kind: "idempotency_mismatch" },
			422,
			"idempotency_mismatch",
			"This key belongs to a different operation.",
		],
		[
			{ kind: "admission_limited", retry_after_seconds: 7 },
			429,
			"admission_limited",
			"The vault cannot accept another operation now.",
		],
		[
			{ kind: "not_implemented" },
			501,
			"not_implemented",
			"The service does not support this operation.",
		],
		[{ kind: "tombstone" }, 409, "tombstone", "The path is deleted."],
		[
			{ kind: "path_occupied" },
			409,
			"path_occupied",
			"The destination path is occupied.",
		],
		[
			{ kind: "idempotency_key_required" },
			428,
			"idempotency_key_required",
			"The idempotency key is required.",
		],
		[
			{ kind: "unsupported_append_kind" },
			415,
			"unsupported_append_kind",
			"The file kind does not support append.",
		],
		[
			{ kind: "unauthorized" },
			401,
			"unauthorized",
			"Authentication is not valid.",
		],
		[
			{ kind: "internal_error" },
			500,
			"internal_error",
			"The service cannot complete the request.",
		],
	] as const)("maps %s", (failure, status, error, message) => {
		const encoded = encodedFailure(failure);
		expect(encoded).toMatchObject({ status, body: { error, message } });
	});

	it("projects only the current epoch detail", () => {
		expect(
			encodedFailure({ kind: "epoch_mismatch", current_epoch: epoch }),
		).toEqual({
			status: 409,
			body: {
				error: "epoch_mismatch",
				message: "The vault epoch does not match.",
				current_epoch: epoch,
			},
		});
	});

	it("projects only the existing path detail", () => {
		expect(
			encodedFailure({
				kind: "path_collision",
				existing_path: "archive/notes.md",
			}),
		).toEqual({
			status: 409,
			body: {
				error: "path_collision",
				message: "Another file uses this path key.",
				existing_path: "archive/notes.md",
			},
		});
	});

	it("projects precondition metadata without full content", () => {
		expect(
			encodedFailure({
				kind: "precondition_failed",
				etag,
				hash,
				deleted: false,
			}),
		).toEqual({
			status: 412,
			body: {
				error: "precondition_failed",
				message: "The file state does not match the precondition.",
				etag,
				hash,
				deleted: false,
			},
		});
	});

	it("projects authorized precondition content", () => {
		expect(
			encodedFailure({
				kind: "precondition_failed",
				etag,
				hash,
				deleted: false,
				content: "safe current",
			}),
		).toEqual({
			status: 412,
			body: {
				error: "precondition_failed",
				message: "The file state does not match the precondition.",
				etag,
				hash,
				deleted: false,
				content: "safe current",
			},
		});
	});

	it("uses Retry-After only for admission limits and preserves the delay", () => {
		expect(
			encodedFailure({ kind: "admission_limited", retry_after_seconds: 7 }),
		).toEqual({
			status: 429,
			body: {
				error: "admission_limited",
				message: "The vault cannot accept another operation now.",
			},
			headers: { "Retry-After": "7" },
		});
		expect(encodedFailure({ kind: "not_found" })).toEqual({
			status: 404,
			body: { error: "not_found", message: "The file does not exist." },
		});
	});

	it("does not project unknown failure data into a response", () => {
		const failure = { kind: "not_found", secret: "hidden" } as const;
		expect(encodedFailure(failure)).toEqual({
			status: 404,
			body: { error: "not_found", message: "The file does not exist." },
		});
	});
});
