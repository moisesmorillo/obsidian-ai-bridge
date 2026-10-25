import type {
	McpAppendToNoteInputSchema,
	McpCreateNoteInputSchema,
	McpDeleteNoteInputSchema,
	McpGetHistoryInputSchema,
	McpHistoryResultSchema,
	McpListNotesInputSchema,
	McpListNotesResultSchema,
	McpMutationOutputSchema,
	McpReadNoteInputSchema,
	McpReadNoteResultSchema,
	McpRestoreNoteInputSchema,
	McpSearchNotesInputSchema,
	McpSearchNotesResultSchema,
	McpToolErrorSchema,
	McpUpdateNoteInputSchema,
} from "@protocol/schemas/mcp";
import type { z } from "zod";

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
