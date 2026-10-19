import type {
	CurrentEpochOperationSchema,
	CurrentEpochRequestSchema,
	CurrentEpochResultSchema,
	FileFailureSchema,
	FileHttpFailureInputSchema,
	FileHttpFailureSchema,
	MutationReceiptSchema,
	MutationSuccessSchema,
	TextMutationBeginResultSchema,
	TextMutationResultSchema,
	TextReadRequestSchema,
	TextReadResponseSchema,
	TextReadResultSchema,
} from "@protocol/schemas/files";
import type { z } from "zod";

/** Operation supported by the read-only current epoch capability. */
export type CurrentEpochOperation = z.infer<typeof CurrentEpochOperationSchema>;
/** Validated current epoch request with the intended policy scope. */
export type CurrentEpochRequest = z.infer<typeof CurrentEpochRequestSchema>;
/** Current authoritative epoch or a canonical policy failure. */
export type CurrentEpochResult = z.infer<typeof CurrentEpochResultSchema>;

/** Canonical failure returned by file and idempotency policies. */
export type FileFailure = z.infer<typeof FileFailureSchema>;
/** Strict HTTP failure result with a status, safe body, and optional headers. */
export type FileHttpFailure = z.infer<typeof FileHttpFailureSchema>;
/** Domain or transport failure accepted by the HTTP failure encoder. */
export type FileHttpFailureInput = z.infer<typeof FileHttpFailureInputSchema>;
/** Compact successful mutation body stored in an idempotency receipt. */
export type MutationSuccess = z.infer<typeof MutationSuccessSchema>;
/** Original successful HTTP response retained for idempotent replay. */
export type MutationReceipt = z.infer<typeof MutationReceiptSchema>;
/** Outcome returned by starting a text mutation. */
export type TextMutationBeginResult = z.infer<
	typeof TextMutationBeginResultSchema
>;
/** Outcome returned by committing a text mutation. */
export type TextMutationResult = z.infer<typeof TextMutationResultSchema>;
/** Path, revision, and optional UTF-16 range selector for a text read. */
export type TextReadRequest = z.infer<typeof TextReadRequestSchema>;
/** Authorized current or historical inline text response. */
export type TextReadResponse = z.infer<typeof TextReadResponseSchema>;
/** Outcome returned by an authorized text read. */
export type TextReadResult = z.infer<typeof TextReadResultSchema>;
