import type {
	FileCommandSchema,
	HistoryEntrySchema,
	HistoryRequestSchema,
	HistoryResultSchema,
	RenameRequestSchema,
	RenameResultSchema,
	RestoreRequestSchema,
} from "@protocol/schemas/history";
import type { z } from "zod";

/** Validated command identity and exact input digest. */
export type FileCommand = z.infer<typeof FileCommandSchema>;
/** One retained content-free revision record. */
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
/** Query for retained history in the current vault epoch. */
export type HistoryRequest = z.infer<typeof HistoryRequestSchema>;
/** Ascending retained revision metadata. */
export type HistoryResult = z.infer<typeof HistoryResultSchema>;
/** Normalized rename destination body. */
export type RenameRequest = z.infer<typeof RenameRequestSchema>;
/** Successful rename receipt. */
export type RenameResult = z.infer<typeof RenameResultSchema>;
/** Selected revision and restore policy. */
export type RestoreRequest = z.infer<typeof RestoreRequestSchema>;
