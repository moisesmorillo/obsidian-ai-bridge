/** Closed successful effects returned by the narrow local reconciliation writer. */
export const LOCAL_RECONCILIATION_WRITE_OUTCOME = {
  created: "created",
  replaced: "replaced",
  adopted: "adopted",
} as const;

/** Closed dispatch modes separating first effects from same-operation recovery. */
export const LOCAL_RECONCILIATION_DISPATCH_MODE = {
  firstDispatch: "first-dispatch",
  sameOperationRecovery: "same-operation-recovery",
} as const;

/** Typed host/precondition refusals that prove the requested content effect did not occur. */
export const LOCAL_RECONCILIATION_REFUSAL = {
  invalidPath: "invalid-path",
  excludedPath: "excluded-path",
  oversized: "oversized",
  contentHashMismatch: "content-hash-mismatch",
  destinationFileExists: "destination-file-exists",
  destinationFolderExists: "destination-folder-exists",
  missingTarget: "missing-target",
  parentFileCollision: "parent-file-collision",
  staleContent: "stale-content",
  preservationCollision: "preservation-collision",
  unsafePreservationRoot: "unsafe-preservation-root",
} as const;

/** Sanitized adapter failures whose certainty is reported separately from their cause. */
export const LOCAL_RECONCILIATION_FAILURE = {
  hostUnavailable: "host-unavailable",
  postconditionMismatch: "postcondition-mismatch",
} as const;

/** Reserved dot-prefixed root for generated conflict-preservation artifacts. */
export const RECONCILIATION_PRESERVATION_ROOT = ".ai-bridge-conflicts";
