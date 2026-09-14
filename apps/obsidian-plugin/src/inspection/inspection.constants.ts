import {
  LocalVaultFailureReason,
  type LocalVaultFailureReasonCode,
  MAX_NOTE_SIZE_BYTES,
} from "@obsidian-ai-bridge/core";

/** Stable M2 palette IDs; Obsidian adds the manifest ID prefix during registration. */
export const InspectionCommand = {
  list: { id: "inspect-local-notes", name: "Inspect local Markdown notes" },
  active: { id: "inspect-active-note", name: "Inspect active Markdown note" },
} as const;

/** Local-only lifecycle feedback, not a domain or wire failure code. */
export const INSPECTION_BUSY_MESSAGE = "An inspection is already running.";

/** Saved-file reads never force-save or inspect an editor buffer. */
export const SAVED_FILE_GUIDANCE =
  "Saved vault text only. Save and retry to include unsaved changes.";

/** Exhaustive sanitized messages; raw host exceptions and refused paths never enter notices. */
export const InspectionFailureMessage: Readonly<{
  [Reason in LocalVaultFailureReasonCode]: string;
}> = {
  [LocalVaultFailureReason.noActiveFile]:
    "No active file. Open a saved Markdown note and retry.",
  [LocalVaultFailureReason.unsupportedFile]:
    "Only lowercase .md files can be inspected.",
  [LocalVaultFailureReason.excludedLocation]:
    "This file is in an excluded location.",
  [LocalVaultFailureReason.invalidPath]:
    "This file has an unsupported vault-relative path.",
  [LocalVaultFailureReason.missingFile]:
    "The saved file is missing. Select an existing note and retry.",
  [LocalVaultFailureReason.oversized]: `This note exceeds the ${MAX_NOTE_SIZE_BYTES / (1024 * 1024)} MiB inspection limit.`,
  [LocalVaultFailureReason.changedDuringRead]:
    "The saved file changed during inspection. Save and retry.",
  [LocalVaultFailureReason.unavailable]:
    "Local inspection is unavailable. Please retry.",
};
