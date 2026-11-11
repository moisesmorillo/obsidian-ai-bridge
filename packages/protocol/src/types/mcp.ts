import type {
	McpAppendToNoteInputSchema,
	McpCreateBaseInputSchema,
	McpCreateNoteInputSchema,
	McpDeleteBaseInputSchema,
	McpDeleteNoteInputSchema,
	McpGetHistoryInputSchema,
	McpHistoryResultSchema,
	McpListBasesInputSchema,
	McpListBasesResultSchema,
	McpListNotesInputSchema,
	McpListNotesResultSchema,
	McpMutationOutputSchema,
	McpReadBaseInputSchema,
	McpReadBaseResultSchema,
	McpReadNoteInputSchema,
	McpReadNoteResultSchema,
	McpRestoreNoteInputSchema,
	McpSearchNotesInputSchema,
	McpSearchNotesResultSchema,
	McpToolErrorSchema,
	McpUpdateBaseInputSchema,
	McpUpdateNoteInputSchema,
	McpValidateBaseInputSchema,
	McpValidateBaseResultSchema,
} from "@protocol/schemas/mcp";
import type { z } from "zod";

/** Validated Base list filter using the existing note-list bounds. */
export type McpListBasesInput = z.infer<typeof McpListBasesInputSchema>;
/** Epoch-bearing live Base metadata returned by list_bases. */
export type McpListBasesResult = z.infer<typeof McpListBasesResultSchema>;
/** Epoch-bearing raw Base text or an ETag-only mismatch response. */
export type McpReadBaseResult = z.infer<typeof McpReadBaseResultSchema>;
/** Validated Base path and optional revision-pinned fragment selection. */
export type McpReadBaseInput = z.infer<typeof McpReadBaseInputSchema>;
/** Validated create-only Base request with explicit vault epoch. */
export type McpCreateBaseInput = z.infer<typeof McpCreateBaseInputSchema>;
/** Validated exact-revision Base replacement request. */
export type McpUpdateBaseInput = z.infer<typeof McpUpdateBaseInputSchema>;
/** Validated exact-revision Base tombstone request. */
export type McpDeleteBaseInput = z.infer<typeof McpDeleteBaseInputSchema>;
/** Validated structural-only Base content request. */
export type McpValidateBaseInput = z.infer<typeof McpValidateBaseInputSchema>;
/** Epoch-bearing structural validation result without parsed content. */
export type McpValidateBaseResult = z.infer<typeof McpValidateBaseResultSchema>;

/** Validated create-only request with explicit vault epoch. */
export type McpCreateNoteInput = z.infer<typeof McpCreateNoteInputSchema>;
/** Validated exact-revision replacement request. */
export type McpUpdateNoteInput = z.infer<typeof McpUpdateNoteInputSchema>;
/** Validated append request with a required client-scoped receipt key. */
export type McpAppendToNoteInput = z.infer<typeof McpAppendToNoteInputSchema>;
/** Validated exact-revision delete request. */
export type McpDeleteNoteInput = z.infer<typeof McpDeleteNoteInputSchema>;
/** Validated restore request with exact source and current ETags. */
export type McpRestoreNoteInput = z.infer<typeof McpRestoreNoteInputSchema>;
/** Bounded epoch-bearing mutation receipt. */
export type McpMutationOutput = z.infer<typeof McpMutationOutputSchema>;

/** Validated optional list prefix and large-note selection for MCP discovery. */
export type McpListNotesInput = z.infer<typeof McpListNotesInputSchema>;
/** Epoch-bearing live note metadata returned by MCP list_notes. */
export type McpListNotesResult = z.infer<typeof McpListNotesResultSchema>;
/** Validated path, ETag, and bounded UTF-16 fragment selection for read_note. */
export type McpReadNoteInput = z.infer<typeof McpReadNoteInputSchema>;
/** Epoch-bearing current note content or an ETag-only mismatch response. */
export type McpReadNoteResult = z.infer<typeof McpReadNoteResultSchema>;
/** Validated literal query and bounded result limit for search_notes. */
export type McpSearchNotesInput = z.infer<typeof McpSearchNotesInputSchema>;
/** Epoch-bearing bounded search hits and index coverage counts. */
export type McpSearchNotesResult = z.infer<typeof McpSearchNotesResultSchema>;
/** Validated note path for retained history lookup. */
export type McpGetHistoryInput = z.infer<typeof McpGetHistoryInputSchema>;
/** Epoch-bearing retained revision list from get_history. */
export type McpHistoryResult = z.infer<typeof McpHistoryResultSchema>;
/** Bounded epoch-bearing application error returned only after authorized work. */
export type McpToolError = z.infer<typeof McpToolErrorSchema>;
