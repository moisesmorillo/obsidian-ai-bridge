import { parseETag } from "@protocol/codecs/etag";
import { FullTextContentSchema } from "@protocol/schemas/content";
import { EpochSchema, ETagSchema } from "@protocol/schemas/etag";
import { PathSchema } from "@protocol/schemas/path";
import { z } from "zod";

/** SHA-256 digest for an empty byte sequence. */
export const EMPTY_PAYLOAD_HASH =
	"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** The vault scopes that gate admission of each operation. */
export const VaultScopeSchema = z.enum([
	"vault:read",
	"vault:write",
	"vault:delete",
]);

/** Client and grant identity with unique scopes in canonical order. */
export const AuthorizationContextSchema = z.object({
	client_id: z
		.string()
		.refine((value) => new TextEncoder().encode(value).byteLength <= 2048),
	grant_id: z
		.string()
		.refine((value) => new TextEncoder().encode(value).byteLength <= 2048),
	scopes: z
		.array(VaultScopeSchema)
		.refine((scopes) => new Set(scopes).size === scopes.length)
		.transform((scopes) => [...scopes].sort()),
});

/** Operation metadata validated before a request body is read. */
export const OperationDescriptorSchema = z
	.object({
		op: z.enum(["read", "put", "delete", "rename", "append", "restore"]),
		epoch: EpochSchema.optional(),
		paths: z.array(PathSchema),
		precondition: z.discriminatedUnion("kind", [
			z.object({ kind: z.literal("none") }),
			z.object({ kind: z.literal("absent") }),
			z.object({ kind: z.literal("match"), etag: ETagSchema }),
		]),
	})
	.superRefine((descriptor, ctx) => {
		const validCount =
			descriptor.op === "read"
				? [0, 1]
				: descriptor.op === "rename"
					? [2]
					: [1];
		if (!validCount.includes(descriptor.paths.length)) {
			ctx.addIssue({ code: "custom", message: "invalid path count" });
		}
		const preconditions: Record<typeof descriptor.op, string[]> = {
			read: ["none"],
			put: ["absent", "match"],
			delete: ["match"],
			rename: ["match"],
			append: ["none"],
			restore: ["match"],
		};
		if (!preconditions[descriptor.op].includes(descriptor.precondition.kind)) {
			ctx.addIssue({
				code: "custom",
				message: "invalid precondition for operation",
			});
		}
		if (
			(descriptor.op === "put" || descriptor.op === "append") &&
			descriptor.epoch === undefined
		) {
			ctx.addIssue({ code: "custom", message: "explicit epoch missing" });
		}
		if (
			descriptor.epoch !== undefined &&
			descriptor.precondition.kind === "match" &&
			parseETag(descriptor.precondition.etag).epoch !== descriptor.epoch
		) {
			ctx.addIssue({ code: "custom", message: "epoch mismatch" });
		}
	});

/** Typed failure kinds for append and blob size limits. */
export const AdmissionSizeFailureKindSchema = z.enum([
	"text_too_large",
	"blob_too_large",
]);

/** Operation metadata with a lowercase SHA-256 payload hash and byte size. */
export const OperationIntentSchema = OperationDescriptorSchema.safeExtend({
	payload_hash: z.string().regex(/^[0-9a-f]{64}$/),
	size: z.number().int().nonnegative().safe(),
})
	.strict()
	.superRefine((intent, ctx) => {
		if (
			(intent.op === "read" || intent.op === "delete") &&
			(intent.size !== 0 || intent.payload_hash !== EMPTY_PAYLOAD_HASH)
		) {
			ctx.addIssue({ code: "custom", message: "payload must be empty" });
		}
		if (intent.op === "append" && intent.size > 1_000_000) {
			ctx.addIssue({
				code: "custom",
				params: {
					admissionFailure: AdmissionSizeFailureKindSchema.enum.text_too_large,
				},
				message: "append input too large",
			});
		}
		if (intent.op === "put" && intent.size > 25_000_000) {
			ctx.addIssue({
				code: "custom",
				params: {
					admissionFailure: AdmissionSizeFailureKindSchema.enum.blob_too_large,
				},
				message: "blob input too large",
			});
		}
		if (intent.size > 26_000_000) {
			ctx.addIssue({ code: "custom", message: "request metadata too large" });
		}
	});

/** PUT or DELETE descriptor with the existing admission refinements retained. */
export const TextMutationDescriptorSchema =
	OperationDescriptorSchema.safeExtend({
		op: z.enum(["put", "delete"]),
	}).strict();

/** PUT or DELETE intent with all existing payload and descriptor refinements retained. */
export const TextMutationIntentSchema = OperationIntentSchema.safeExtend({
	op: z.enum(["put", "delete"]),
});

/** Measures normalized envelope JSON in UTF-8 bytes after child schemas parse. */
function withinPreparationLimit(
	envelope: Record<string, unknown>,
	ctx: z.RefinementCtx,
): void {
	if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength > 16_384) {
		ctx.addIssue({ code: "custom", message: "preparation envelope too large" });
	}
}

/** Canonical context-plus-descriptor envelope for reservation checks. */
export const DescriptorPreparationSchema = z
	.object({
		context: AuthorizationContextSchema,
		descriptor: OperationDescriptorSchema,
	})
	.superRefine(withinPreparationLimit);

/** Canonical context-plus-intent envelope for full authorization. */
export const OperationPreparationSchema = z
	.object({
		context: AuthorizationContextSchema,
		intent: OperationIntentSchema,
	})
	.superRefine(withinPreparationLimit);

/** A reservation identifier and its expiry time in Unix milliseconds. */
export const RequestAdmissionLeaseSchema = z.object({
	admission_id: z.string(),
	expires_at: z.number().int().safe(),
});

/** Internal denial codes returned by admission checks. */
export const AdmissionFailureSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.literal("invalid_request") }),
		z.object({ kind: z.literal("revoked") }),
		z.object({ kind: z.literal("forbidden_scope") }),
		z.object({ kind: z.literal("epoch_mismatch"), current_epoch: EpochSchema }),
		z.object({
			kind: z.literal(AdmissionSizeFailureKindSchema.enum.text_too_large),
		}),
		z.object({
			kind: z.literal(AdmissionSizeFailureKindSchema.enum.blob_too_large),
		}),
		z.object({
			kind: z.literal("admission_limited"),
			retry_after_seconds: z.number().int().positive(),
		}),
		z.object({ kind: z.literal("invalid_ticket") }),
		z.object({
			kind: z.literal("precondition_failed"),
			etag: ETagSchema.optional(),
			hash: z
				.string()
				.regex(/^(?:[0-9a-f]{64})?$/)
				.optional(),
			deleted: z.boolean().optional(),
			renamed_to: PathSchema.optional(),
			content: FullTextContentSchema.optional(),
		}),
	])
	.superRefine((failure, ctx) => {
		if (failure.kind !== "precondition_failed") return;
		if (failure.hash === "" && failure.deleted !== true) {
			ctx.addIssue({
				code: "custom",
				message: "empty current hash needs a tombstone",
			});
		}
		const metadata = [
			failure.etag !== undefined,
			failure.hash !== undefined,
			failure.deleted !== undefined,
		];
		if (metadata.some(Boolean) && !metadata.every(Boolean)) {
			ctx.addIssue({
				code: "custom",
				message: "current revision metadata must be complete",
			});
		}
		if (failure.content !== undefined && !metadata.every(Boolean)) {
			ctx.addIssue({
				code: "custom",
				message: "current content needs complete revision metadata",
			});
		}
		if (
			failure.renamed_to !== undefined &&
			(!metadata.every(Boolean) ||
				failure.deleted !== true ||
				failure.hash !== "")
		) {
			ctx.addIssue({
				code: "custom",
				message: "rename destination needs complete tombstone metadata",
			});
		}
	});

/** Result of reserving request capacity before body processing. */
export const RequestAdmissionResultSchema = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true), lease: RequestAdmissionLeaseSchema }),
	z.object({ ok: z.literal(false), failure: AdmissionFailureSchema }),
]);

/** A single-use operation ticket with a 128-bit lowercase hexadecimal ID. */
export const OperationTicketSchema = z.object({
	id: z.string().regex(/^[0-9a-f]{32}$/),
	expires_at: z.number().int().safe(),
});

/** Result of authorizing one complete operation intent. */
export const AdmissionResultSchema = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true), ticket: OperationTicketSchema }),
	z.object({ ok: z.literal(false), failure: AdmissionFailureSchema }),
]);

/** Completion state reported for an admitted operation. */
export const AdmissionCompletionSchema = z.enum(["settled", "uncertain"]);

/** Result of closing an admitted operation ticket. */
export const AdmissionFinishResultSchema = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true) }),
	z.object({ ok: z.literal(false), failure: AdmissionFailureSchema }),
]);
