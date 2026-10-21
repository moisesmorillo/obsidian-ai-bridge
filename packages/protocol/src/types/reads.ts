import type {
	ChangeEntrySchema,
	ChangesPageSchema,
	HistoryPageEntrySchema,
	HistoryPageSchema,
	HistoryUpperResponseSchema,
	ManifestEntrySchema,
	ManifestPageSchema,
	MetadataBatchRequestSchema,
	MetadataBatchResponseSchema,
	MetadataBatchResultSchema,
	ReadCursorContextSchema,
	ReadCursorSchema,
	ReadFailureResponseSchema,
	ReadQuerySchema,
	VaultReadResponseSchema,
	VaultReadResultSchema,
} from "@protocol/schemas/reads";
import type { z } from "zod";

/** Canonical read failure wrapper returned across Durable Object RPC. */
export type ReadFailureResponse = z.infer<typeof ReadFailureResponseSchema>;
/** Native vault summary response with structured policy failure details. */
export type VaultReadResponse = z.infer<typeof VaultReadResponseSchema>;
/** Native metadata batch response with structured policy failure details. */
export type MetadataBatchResponse = z.infer<typeof MetadataBatchResponseSchema>;
/** Captured history upper revision response with structured policy failures. */
export type HistoryUpperResponse = z.infer<typeof HistoryUpperResponseSchema>;
/** Current vault summary with live and tombstone counts and published limits. */
export type VaultReadResult = z.infer<typeof VaultReadResultSchema>;
/** Current manifest row identified by its epoch-bound ETag. */
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;
/** One bounded page from a captured manifest traversal. */
export type ManifestPage = z.infer<typeof ManifestPageSchema>;
/** Immutable entry in the changes feed, including rename source identity. */
export type ChangeEntry = z.infer<typeof ChangeEntrySchema>;
/** Bounded page of immutable changes at one captured head. */
export type ChangesPage = z.infer<typeof ChangesPageSchema>;
/** Retained history row whose identity is an ETag, not a bare revision. */
export type HistoryPageEntry = z.infer<typeof HistoryPageEntrySchema>;
/** Bounded page of retained history for one path. */
export type HistoryPage = z.infer<typeof HistoryPageSchema>;
/** Versioned continuation identity for a bounded collection traversal. */
export type ReadCursor = z.infer<typeof ReadCursorSchema>;
/** Expected collection and epoch binding for a decoded cursor. */
export type ReadCursorContext = z.infer<typeof ReadCursorContextSchema>;
/** Internal bounded keyset request for metadata-only batches. */
export type MetadataBatchRequest = z.infer<typeof MetadataBatchRequestSchema>;
/** Internal metadata batch with one permitted lookahead row. */
export type MetadataBatchResult = z.infer<typeof MetadataBatchResultSchema>;
/** Strict scalar query values accepted by bounded read endpoints. */
export type ReadQuery = z.infer<typeof ReadQuerySchema>;
