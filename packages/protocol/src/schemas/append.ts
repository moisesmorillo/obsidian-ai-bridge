import { FullTextContentSchema } from "@protocol/schemas/content";
import { ETagSchema } from "@protocol/schemas/etag";
import { MutationSuccessSchema } from "@protocol/schemas/files";
import { IdempotencyKeySchema } from "@protocol/schemas/idempotency";
import { PathSchema } from "@protocol/schemas/path";
import { z } from "zod";

/** Trimmed, non-empty heading label shared by all heading-append contracts. */
export const AppendHeadingTextSchema = z.string().trim().min(1).max(256);

/** Canonical request for a conditional append inside an existing Markdown heading section. */
export const AppendUnderHeadingRequestSchema = z
	.object({
		path: PathSchema,
		heading: AppendHeadingTextSchema,
		text: FullTextContentSchema,
		etag: ETagSchema,
		idempotency_key: IdempotencyKeySchema,
	})
	.strict();

/** Canonical mutation body returned after a successful heading append. */
export const AppendUnderHeadingResultSchema = MutationSuccessSchema;

/** Canonical HTTP body for the heading and UTF-8 text fields. */
export const AppendUnderHeadingBodySchema =
	AppendUnderHeadingRequestSchema.pick({
		heading: true,
		text: true,
	}).strict();

/** JSON Schema projection consumed by the MCP tool registry. */
export const AppendUnderHeadingToolSchema = z.toJSONSchema(
	AppendUnderHeadingRequestSchema,
);

/** Validated request to append text within one exact heading section. */
export type AppendUnderHeadingRequest = z.infer<
	typeof AppendUnderHeadingRequestSchema
>;
/** Validated result of a successful heading append publication. */
export type AppendUnderHeadingResult = z.infer<
	typeof AppendUnderHeadingResultSchema
>;
