import {
	AdmissionFailureSchema,
	RequestAdmissionLeaseSchema,
} from "@protocol/schemas/admission";
import { FullTextContentSchema } from "@protocol/schemas/content";
import { EpochSchema, ETagSchema } from "@protocol/schemas/etag";
import { PathSchema } from "@protocol/schemas/path";
import { VaultIdSchema } from "@protocol/schemas/vault";
import { z } from "zod";

/** Adds closed-object checks without changing canonical admission refinements. */
const [firstAdmissionFailure, ...otherAdmissionFailures] =
	AdmissionFailureSchema.options;

/** Rejects unknown admission fields for file contracts and preserves canonical union refinements. */
const StrictAdmissionFailureSchema = z.intersection(
	AdmissionFailureSchema,
	z.union([
		firstAdmissionFailure.strict(),
		...otherAdmissionFailures.map((variant) => variant.strict()),
	]),
);

/** Canonical failure details returned by file and idempotency policies. */
export const FileFailureSchema = z.union([
	StrictAdmissionFailureSchema,
	z.object({ kind: z.literal("operation_expired") }).strict(),
	z.object({ kind: z.literal("capacity_exceeded") }).strict(),
	z.object({ kind: z.literal("query_too_short") }).strict(),
	z.object({ kind: z.literal("query_too_long") }).strict(),
	z.object({ kind: z.literal("cursor_expired") }).strict(),
	z.object({ kind: z.literal("blob_integrity_mismatch") }).strict(),
	z
		.object({
			kind: z.literal("blob_storage_unavailable"),
			retry_after_seconds: z.number().int().min(1).max(300),
		})
		.strict(),
	z
		.object({
			kind: z.literal("importing"),
			retry_after_seconds: z.number().int().min(1).max(300),
		})
		.strict(),
	z
		.object({ kind: z.literal("vault_retired"), new_vault_id: VaultIdSchema })
		.strict(),
	z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("invalid_path") }).strict(),
		z.object({ kind: z.literal("not_found") }).strict(),
		z
			.object({
				kind: z.literal("path_collision"),
				existing_path: PathSchema,
			})
			.strict(),
		z.object({ kind: z.literal("idempotency_in_progress") }).strict(),
		z.object({ kind: z.literal("revision_pruned") }).strict(),
		z.object({ kind: z.literal("idempotency_mismatch") }).strict(),
		z.object({ kind: z.literal("not_implemented") }).strict(),
		z.object({ kind: z.literal("tombstone") }).strict(),
		z.object({ kind: z.literal("path_occupied") }).strict(),
		z.object({ kind: z.literal("idempotency_key_required") }).strict(),
		z.object({ kind: z.literal("unsupported_append_kind") }).strict(),
	]),
]);

/** Supported operation that can request the current vault epoch without an admission. */
export const CurrentEpochOperationSchema = z.enum([
	"read",
	"put",
	"delete",
	"rename",
	"append",
	"restore",
]);

/** Authorized metadata request for the current epoch and operation scope. */
export const CurrentEpochRequestSchema = z
	.object({ operation: CurrentEpochOperationSchema })
	.strict();

/** Current epoch result or a canonical authority failure. */
export const CurrentEpochResultSchema = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true), current_epoch: EpochSchema }).strict(),
	z.object({ ok: z.literal(false), failure: FileFailureSchema }).strict(),
]);

/** Error codes supported by the canonical HTTP failure encoder. */
const FileHttpErrorSchema = z.enum([
	"invalid_request",
	"query_too_short",
	"query_too_long",
	"invalid_path",
	"revoked",
	"forbidden_scope",
	"not_found",
	"epoch_mismatch",
	"path_collision",
	"operation_expired",
	"capacity_exceeded",
	"idempotency_in_progress",
	"invalid_ticket",
	"revision_pruned",
	"cursor_expired",
	"precondition_failed",
	"text_too_large",
	"blob_too_large",
	"blob_integrity_mismatch",
	"blob_storage_unavailable",
	"idempotency_mismatch",
	"admission_limited",
	"not_implemented",
	"tombstone",
	"path_occupied",
	"idempotency_key_required",
	"unsupported_append_kind",
	"unauthorized",
	"internal_error",
	"importing",
	"vault_retired",
]);

/** Fixed safe messages for implemented domain and transport failures. */
export const FILE_HTTP_MESSAGES = Object.freeze({
	invalid_request: "The request is not valid.",
	query_too_short: "The search query is too short.",
	query_too_long: "The search query is too long.",
	invalid_path: "The path is not valid.",
	revoked: "The grant no longer allows access.",
	forbidden_scope: "The grant does not allow this operation.",
	not_found: "The file does not exist.",
	epoch_mismatch: "The vault epoch does not match.",
	path_collision: "Another file uses this path key.",
	operation_expired: "The operation key is outside the accepted time range.",
	capacity_exceeded: "The vault has reached its storage limit.",
	idempotency_in_progress: "An operation with this key is not complete.",
	invalid_ticket: "The operation ticket is not valid.",
	revision_pruned: "This revision is no longer available.",
	cursor_expired: "This read cursor is no longer valid.",
	precondition_failed: "The file state does not match the precondition.",
	text_too_large: "The text is larger than the size limit.",
	blob_too_large: "The blob is larger than the size limit.",
	blob_integrity_mismatch: "The blob does not match its declared identity.",
	blob_storage_unavailable: "Blob storage cannot verify this request now.",
	idempotency_mismatch: "This key belongs to a different operation.",
	admission_limited: "The vault cannot accept another operation now.",
	not_implemented: "The service does not support this operation.",
	tombstone: "The path is deleted.",
	path_occupied: "The destination path is occupied.",
	idempotency_key_required: "The idempotency key is required.",
	unsupported_append_kind: "The file kind does not support append.",
	unauthorized: "Authentication is not valid.",
	internal_error: "The service cannot complete the request.",
	importing: "The vault is still importing.",
	vault_retired: "The vault has moved to a new identity.",
} as const) satisfies Readonly<
	Record<z.infer<typeof FileHttpErrorSchema>, string>
>;

/** Canonical HTTP status codes used by implemented failure responses. */
const FileHttpStatusSchema = z.union([
	z.literal(400),
	z.literal(401),
	z.literal(403),
	z.literal(404),
	z.literal(409),
	z.literal(410),
	z.literal(412),
	z.literal(413),
	z.literal(415),
	z.literal(422),
	z.literal(428),
	z.literal(429),
	z.literal(500),
	z.literal(507),
	z.literal(503),
	z.literal(501),
]);

/** HTTP status assigned to each implemented error code. */
export const FILE_HTTP_STATUSES = Object.freeze({
	invalid_request: 400,
	query_too_short: 400,
	query_too_long: 400,
	invalid_path: 400,
	revoked: 401,
	forbidden_scope: 403,
	not_found: 404,
	epoch_mismatch: 409,
	path_collision: 409,
	operation_expired: 409,
	capacity_exceeded: 507,
	idempotency_in_progress: 409,
	invalid_ticket: 409,
	revision_pruned: 410,
	cursor_expired: 410,
	precondition_failed: 412,
	text_too_large: 413,
	blob_too_large: 413,
	blob_integrity_mismatch: 422,
	blob_storage_unavailable: 503,
	idempotency_mismatch: 422,
	admission_limited: 429,
	not_implemented: 501,
	tombstone: 409,
	path_occupied: 409,
	idempotency_key_required: 428,
	unsupported_append_kind: 415,
	unauthorized: 401,
	internal_error: 500,
	importing: 503,
	vault_retired: 410,
} as const) satisfies Readonly<
	Record<
		z.infer<typeof FileHttpErrorSchema>,
		z.infer<typeof FileHttpStatusSchema>
	>
>;

/** Strict body fields emitted by the canonical HTTP failure encoder. */
const FileHttpFailureBodySchema = z
	.object({
		error: FileHttpErrorSchema,
		message: z.string(),
		current_epoch: EpochSchema.optional(),
		etag: ETagSchema.optional(),
		hash: z
			.string()
			.regex(/^(?:[0-9a-f]{64})?$/)
			.optional(),
		deleted: z.boolean().optional(),
		content: FullTextContentSchema.optional(),
		existing_path: PathSchema.optional(),
		renamed_to: PathSchema.optional(),
		new_vault_id: VaultIdSchema.optional(),
	})
	.strict()
	.superRefine((body, ctx) => {
		if (body.message !== FILE_HTTP_MESSAGES[body.error]) {
			ctx.addIssue({
				code: "custom",
				message: "failure message is not canonical",
			});
		}
		if (body.error === "epoch_mismatch" && body.current_epoch === undefined) {
			ctx.addIssue({ code: "custom", message: "current epoch is missing" });
		}
		if (body.error !== "epoch_mismatch" && body.current_epoch !== undefined) {
			ctx.addIssue({
				code: "custom",
				message: "current epoch is not valid here",
			});
		}
		if (body.error === "path_collision" && body.existing_path === undefined) {
			ctx.addIssue({ code: "custom", message: "existing path is missing" });
		}
		if (body.error !== "path_collision" && body.existing_path !== undefined) {
			ctx.addIssue({
				code: "custom",
				message: "existing path is not valid here",
			});
		}
		if (body.error === "vault_retired" && body.new_vault_id === undefined) {
			ctx.addIssue({
				code: "custom",
				message: "new vault identity is missing",
			});
		}
		if (body.error !== "vault_retired" && body.new_vault_id !== undefined) {
			ctx.addIssue({
				code: "custom",
				message: "new vault identity is not valid here",
			});
		}
		const preconditionDetails = [
			body.etag !== undefined,
			body.hash !== undefined,
			body.deleted !== undefined,
		];
		if (
			body.error === "precondition_failed" &&
			preconditionDetails.some(Boolean) &&
			!preconditionDetails.every(Boolean)
		) {
			ctx.addIssue({
				code: "custom",
				message: "precondition details are incomplete",
			});
		}
		if (
			body.error !== "precondition_failed" &&
			preconditionDetails.some(Boolean)
		) {
			ctx.addIssue({
				code: "custom",
				message: "precondition details are not valid here",
			});
		}
		if (body.error !== "precondition_failed" && body.content !== undefined) {
			ctx.addIssue({ code: "custom", message: "content is not valid here" });
		}
		if (
			body.error === "precondition_failed" &&
			body.hash === "" &&
			body.deleted !== true
		) {
			ctx.addIssue({
				code: "custom",
				message: "empty hash needs tombstone metadata",
			});
		}
		if (
			body.renamed_to !== undefined &&
			(body.error !== "precondition_failed" ||
				!preconditionDetails.every(Boolean) ||
				body.deleted !== true ||
				body.hash !== "")
		) {
			ctx.addIssue({
				code: "custom",
				message: "rename destination needs complete tombstone details",
			});
		}
		if (body.content !== undefined && !preconditionDetails.every(Boolean)) {
			ctx.addIssue({
				code: "custom",
				message: "content needs complete revision details",
			});
		}
	});

/** Strict status and body result from failure encoding. */
export const FileHttpFailureSchema = z
	.object({
		status: FileHttpStatusSchema,
		body: FileHttpFailureBodySchema,
		headers: z
			.object({
				"Retry-After": z.string().regex(/^[1-9][0-9]*$/),
			})
			.strict()
			.optional(),
	})
	.strict()
	.superRefine((result, ctx) => {
		if (result.status !== FILE_HTTP_STATUSES[result.body.error]) {
			ctx.addIssue({
				code: "custom",
				message: "failure status does not match error",
			});
		}
		const retryAfter = result.headers?.["Retry-After"];
		const hasRetryAfter = retryAfter !== undefined;
		if (
			(result.body.error === "admission_limited" ||
				result.body.error === "blob_storage_unavailable" ||
				result.body.error === "importing") &&
			!hasRetryAfter
		) {
			ctx.addIssue({
				code: "custom",
				message: "retryable failure needs Retry-After",
			});
		}
		if (
			(result.body.error === "blob_storage_unavailable" ||
				result.body.error === "importing") &&
			retryAfter !== undefined &&
			!/^(?:[1-9]|[1-9][0-9]|[12][0-9]{2}|300)$/.test(retryAfter)
		) {
			ctx.addIssue({
				code: "custom",
				message: "blob storage retry delay must be between 1 and 300 seconds",
			});
		}
		if (
			result.body.error !== "admission_limited" &&
			result.body.error !== "blob_storage_unavailable" &&
			result.body.error !== "importing" &&
			hasRetryAfter
		) {
			ctx.addIssue({
				code: "custom",
				message: "Retry-After is not valid for this failure",
			});
		}
	});

/** Domain and transport failures accepted by the canonical HTTP encoder. */
export const FileHttpFailureInputSchema = z.union([
	FileFailureSchema,
	z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("unauthorized") }).strict(),
		z.object({ kind: z.literal("internal_error") }).strict(),
	]),
]);

/** Successful mutation receipt returned to an authorized caller. */
export const MutationSuccessSchema = z
	.object({
		path: PathSchema,
		etag: ETagSchema,
		seq: z.number().int().positive().safe(),
		hash: z.string().regex(/^(?:[0-9a-f]{64})?$/),
		size: z.number().int().nonnegative().safe(),
		deleted: z.boolean(),
	})
	.strict()
	.superRefine((success, ctx) => {
		if (success.deleted && (success.hash !== "" || success.size !== 0)) {
			ctx.addIssue({
				code: "custom",
				message: "tombstone metadata must be empty",
			});
		}
		if (!success.deleted && success.hash.length !== 64) {
			ctx.addIssue({ code: "custom", message: "live file needs a hash" });
		}
	});

/** Compact immutable response stored for an idempotent mutation. */
export const MutationReceiptSchema = z
	.object({
		status: z.union([z.literal(200), z.literal(201)]),
		body: MutationSuccessSchema,
	})
	.strict();

/** Result of committing a mutation and its compact receipt. */
export const TextMutationResultSchema = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true), response: MutationReceiptSchema }).strict(),
	z.object({ ok: z.literal(false), failure: FileFailureSchema }).strict(),
]);

/** Result of reserving a mutation before body processing. */
export const TextMutationBeginResultSchema = z.discriminatedUnion("ok", [
	z
		.object({ ok: z.literal(true), lease: RequestAdmissionLeaseSchema })
		.strict(),
	z.object({ ok: z.literal(false), failure: FileFailureSchema }).strict(),
]);

/** Request for a current or historical inline text revision. */
export const TextReadRequestSchema = z
	.object({
		path: PathSchema,
		epoch: EpochSchema.optional(),
		rev: z.number().int().positive().safe().optional(),
		offset: z.number().int().nonnegative().safe().optional(),
		length: z.number().int().nonnegative().safe().optional(),
	})
	.strict()
	.superRefine((request, ctx) => {
		if (request.rev !== undefined && request.epoch === undefined) {
			ctx.addIssue({
				code: "custom",
				message: "historical revision needs epoch",
			});
		}
	});

/** Inline text response, including nullable tombstones and UTF-16 range fragments. */
export const TextReadResponseSchema = z
	.object({
		path: PathSchema,
		etag: ETagSchema,
		hash: z.string().regex(/^(?:[0-9a-f]{64})?$/),
		size: z.number().int().nonnegative().safe(),
		kind: z.literal("text"),
		deleted: z.boolean(),
		origin: z.string(),
		updated_at: z.number().int().safe(),
		content: z.string().nullable(),
		offset: z.number().int().nonnegative().safe(),
		length: z.number().int().nonnegative().safe(),
		truncated: z.boolean(),
	})
	.strict()
	.superRefine((response, ctx) => {
		if (response.deleted) {
			if (
				response.content !== null ||
				response.hash !== "" ||
				response.size !== 0
			) {
				ctx.addIssue({
					code: "custom",
					message: "tombstone read metadata must be empty",
				});
			}
			return;
		}
		if (response.content === null || response.hash.length !== 64) {
			ctx.addIssue({
				code: "custom",
				message: "live read needs content and a hash",
			});
			return;
		}
		if (
			response.size > 1_000_000 ||
			response.length !== response.content.length
		) {
			ctx.addIssue({ code: "custom", message: "live read bounds are invalid" });
		}
		const fullContent =
			response.offset === 0 &&
			response.length === response.content.length &&
			!response.truncated;
		if (!fullContent) return;
		const parsed = FullTextContentSchema.safeParse(response.content);
		if (
			!parsed.success ||
			new TextEncoder().encode(response.content).byteLength !== response.size
		) {
			ctx.addIssue({
				code: "custom",
				message: "full read content is not exact UTF-8",
			});
		}
	});

/** Result of reading an authorized inline text revision. */
export const TextReadResultSchema = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true), body: TextReadResponseSchema }).strict(),
	z.object({ ok: z.literal(false), failure: FileFailureSchema }).strict(),
]);
