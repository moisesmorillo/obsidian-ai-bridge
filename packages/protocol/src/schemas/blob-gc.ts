import { z } from "zod";

/** Canonical count and byte total for objects that current references do not protect. */
export const BlobGcPreviewSchema = z
	.object({
		count: z.number().int().nonnegative().safe(),
		bytes: z.number().int().nonnegative().safe(),
	})
	.strict();

/** Typed retryable rejection when a hash is under garbage-collection authority. */
export const BlobGcFailureSchema = z
	.object({
		kind: z.literal("blob_gc_in_progress"),
		retry_after_seconds: z.number().int().min(1).max(300),
	})
	.strict();

/** Typed retryable failure returned when owner inventory or execution fails. */
export const BlobGcOperationFailureSchema = z
	.object({
		kind: z.literal("blob_gc_unavailable"),
		retry_after_seconds: z.number().int().min(1).max(300),
	})
	.strict();

/** Durable collection phase, visible failure, and exact mark count and byte total. */
export const BlobGcStatusSchema = z
	.object({
		phase: z.enum(["idle", "marking", "deleting"]),
		marked_count: z.number().int().nonnegative().safe(),
		marked_bytes: z.number().int().nonnegative().safe(),
		failure: z.enum(["blob_gc_unavailable"]).nullable(),
	})
	.strict();

/** Validated owner-facing dry-run or durable-mark measurement. */
export type BlobGcPreview = z.infer<typeof BlobGcPreviewSchema>;
/** Validated transient publication refusal during garbage collection. */
export type BlobGcFailure = z.infer<typeof BlobGcFailureSchema>;
/** Validated retry response for owner preview or execution failures. */
export type BlobGcOperationFailure = z.infer<
	typeof BlobGcOperationFailureSchema
>;
/** Validated durable collection phase and mark measurement. */
export type BlobGcStatus = z.infer<typeof BlobGcStatusSchema>;
