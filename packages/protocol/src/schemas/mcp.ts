import { EpochSchema, ETagSchema } from "@protocol/schemas/etag";
import { PathSchema } from "@protocol/schemas/path";
import { HistoryPageEntrySchema } from "@protocol/schemas/reads";
import {
	SearchHitSchema,
	SearchLimitSchema,
	SearchQuerySchema,
} from "@protocol/schemas/search";
import { z } from "zod";

/** Validate an optional path prefix without accepting tool-supplied identity. */
export const McpListNotesInputSchema = z
	.object({
		prefix: z.string().max(1024).optional(),
		include_large: z.boolean().optional(),
	})
	.strict();

/** Validate one path and an optional revision-pinned UTF-16 fragment. */
export const McpReadNoteInputSchema = z
	.object({
		path: PathSchema,
		etag: ETagSchema.optional(),
		offset: z.number().int().nonnegative().max(1_000_000).optional(),
		length: z.number().int().positive().max(1_000_000).optional(),
	})
	.strict();

/** Validate a literal search request with the canonical query and result limits. */
export const McpSearchNotesInputSchema = z
	.object({ query: SearchQuerySchema, limit: SearchLimitSchema.optional() })
	.strict();

/** Validate a history request for one canonical vault path. */
export const McpGetHistoryInputSchema = z.object({ path: PathSchema }).strict();

/** JSON Schema form consumed by the MCP SDK without duplicating input policy. */
export const McpListNotesToolSchema = z.toJSONSchema(McpListNotesInputSchema);
/** JSON Schema form consumed by the MCP SDK without duplicating input policy. */
export const McpReadNoteToolSchema = z.toJSONSchema(McpReadNoteInputSchema);
/** JSON Schema form consumed by the MCP SDK without duplicating input policy. */
export const McpSearchNotesToolSchema = z.toJSONSchema(
	McpSearchNotesInputSchema,
);
/** JSON Schema form consumed by the MCP SDK without duplicating input policy. */
export const McpGetHistoryToolSchema = z.toJSONSchema(McpGetHistoryInputSchema);

/** Structured list result with an explicit bound and current epoch. */
export const McpListNotesResultSchema = z
	.object({
		epoch: EpochSchema,
		entries: z
			.array(
				z
					.object({
						path: PathSchema,
						etag: ETagSchema,
						size: z.number().int().nonnegative().safe(),
						updated_at: z.number().int().safe(),
						large: z.boolean(),
					})
					.strict(),
			)
			.max(256),
	})
	.strict();

/** Structured note result without a second text copy of note content. */
export const McpReadNoteResultSchema = z
	.object({
		epoch: EpochSchema,
		path: PathSchema,
		etag: ETagSchema,
		content: z.string().optional(),
		truncated: z.boolean(),
	})
	.strict();

/** Structured bounded search result with authoritative coverage counts. */
export const McpSearchNotesResultSchema = z
	.object({
		epoch: EpochSchema,
		results: z.array(SearchHitSchema).max(50),
		indexed_files: z.number().int().nonnegative().safe(),
		unindexed_large_files: z.number().int().nonnegative().safe(),
	})
	.strict();

/** Structured bounded history result with its authoritative epoch. */
export const McpHistoryResultSchema = z
	.object({
		epoch: EpochSchema,
		entries: z.array(HistoryPageEntrySchema).max(256),
	})
	.strict();

/** JSON Schema form of the bounded list result for MCP output validation. */
export const McpListNotesOutputSchema = z.toJSONSchema(
	McpListNotesResultSchema,
);
/** JSON Schema form of the bounded note result for MCP output validation. */
export const McpReadNoteOutputSchema = z.toJSONSchema(McpReadNoteResultSchema);
/** JSON Schema form of the bounded search result for MCP output validation. */
export const McpSearchNotesOutputSchema = z.toJSONSchema(
	McpSearchNotesResultSchema,
);
/** JSON Schema form of the bounded history result for MCP output validation. */
export const McpHistoryOutputSchema = z.toJSONSchema(McpHistoryResultSchema);

/** MCP tool error envelope with a canonical failure kind and current epoch. */
export const McpToolErrorSchema = z
	.object({
		epoch: EpochSchema,
		code: z.string().min(1).max(64),
		message: z.string().min(1).max(512),
	})
	.strict();
