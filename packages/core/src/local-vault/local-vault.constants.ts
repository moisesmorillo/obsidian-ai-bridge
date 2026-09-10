/** Local-only result discriminants; these are not HTTP or sync protocol values. */
export const LocalInspectionKind = {
  ok: "ok",
  failed: "failed",
} as const;

/**
 * Enumeration skip reasons, evaluated in declaration order so each file counts once.
 * Malformed size metadata is unavailable, not a skip; no skipped paths are exposed.
 */
export const LocalSkipReason = {
  unsupportedFile: "unsupported_file",
  excludedLocation: "excluded_location",
  invalidPath: "invalid_path",
  oversized: "oversized",
} as const;

/** Expected local inspection failures; lifecycle/busy states belong to the plugin. */
export const LocalVaultFailureReason = {
  ...LocalSkipReason,
  noActiveFile: "no_active_file",
  missingFile: "missing_file",
  changedDuringRead: "changed_during_read",
  unavailable: "unavailable",
} as const;
