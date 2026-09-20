/** Closed operator authority sources that may admit future M4 operations. */
export const RECONCILIATION_AUTHORITY_SOURCE = {
  reconciliationDecision: "operator-reconciliation-decision",
  adoptionDecision: "operator-adoption-decision",
  tombstoneDecision: "operator-tombstone-decision",
  recoveryRestoreDecision: "operator-recovery-restore-decision",
  historyDecision: "operator-history-decision",
} as const;

/** Closed read-only classifications accepted by the M4 reconciliation design. */
export const RECONCILIATION_CLASSIFICATION = {
  aligned: "aligned",
  localAhead: "local-ahead",
  remoteAhead: "remote-ahead",
  bothChanged: "both-changed",
  remoteTombstoned: "remote-tombstoned",
  localMissing: "local-missing",
  legacyRemote: "legacy-remote",
  unknownLocal: "unknown-local",
  remoteUnavailable: "remote-unavailable",
  unresolvedM3Effect: "unresolved-m3-effect",
  deferredHistory: "deferred-history",
} as const;

/** Explicit retention boundary between transient sampled review data and durable metadata. */
export const RECONCILIATION_REVIEW_RETENTION = {
  ephemeral: "ephemeral",
  durable: "durable",
} as const;

/** Durable review statuses; transient sampled bodies are never represented here. */
export const RECONCILIATION_REVIEW_STATUS = {
  pending: "pending",
  staged: "staged",
  stale: "stale",
  blocked: "blocked",
  completed: "completed",
} as const;

/** Closed future operation actions approved by the M4 specification. */
export const RECONCILIATION_ACTION = {
  keepLocal: "keep-local",
  useRemote: "use-remote",
  keepBoth: "keep-both",
  adoptRevision: "exact-revisioned-adoption",
  acceptTombstone: "accept-tombstone",
  recreateRemote: "recreate-remote",
  restoreRecovery: "restore-recovery",
  forkLegacy: "fork-legacy",
  resolveHistory: "bounded-history-decision",
  defer: "defer",
} as const;

/** Durable M4 operation phases; effects cannot be inferred from phase names alone. */
export const RECONCILIATION_OPERATION_PHASE = {
  admitted: "admitted",
  preserving: "preserving",
  mutatingLocal: "mutating-local",
  mutatingRemote: "mutating-remote",
  evidenceRequired: "evidence-required",
  partial: "partial",
  restoredPendingReview: "restored-pending-review",
  successorReviewRequired: "successor-review-required",
  stale: "stale",
  blocked: "blocked",
  completed: "completed",
} as const;

/** Closed operator choices for a complete evidence-derived deferred-history group. */
export const HISTORY_DECISION_KIND = {
  retainIndependent: "retain-independent",
  deferHistory: "defer-history",
  executeCleanupPlan: "execute-cleanup-plan",
} as const;

/** Closed remote-only cleanup step kind; history never gains a local effect channel. */
export const HISTORY_CLEANUP_STEP_KIND = {
  remoteFormerSourceCleanup: "remote-former-source-cleanup",
} as const;

/** Closed remote-effect evidence kinds for one history cleanup step. */
export const HISTORY_REMOTE_EFFECT_KIND = {
  confirmedExactTombstoneReceipt: "confirmed-exact-tombstone-receipt",
} as const;

/** Durable phase of one ordered history cleanup step. */
export const HISTORY_CLEANUP_STEP_PHASE = {
  pending: "pending",
  preserving: "preserving",
  ready: "ready",
  mutatingRemote: "mutating-remote",
  evidenceRequired: "evidence-required",
  blocked: "blocked",
  completed: "completed",
} as const;

/** Migration and refined-history progress variants in the v4 operation union. */
export const HISTORY_PROGRESS_KIND = {
  refined: "refined",
  legacyV3Unrefined: "legacy-v3-history-unrefined",
} as const;

/** Focused startup-recovery progress retained by an unfenced v3 local effect. */
export const LEGACY_V3_LOCAL_EFFECT_RECOVERY_STATE = {
  pending: "pending",
  evidenceRequired: "evidence-required",
  blocked: "blocked",
} as const;

/** Durable synthetic local-effect observation variants. */
export const LOCAL_EFFECT_OBSERVATION_KIND = {
  notRequired: "not-required",
  notStarted: "not-started",
  prepared: "prepared",
  confirmed: "confirmed",
  recoveredV3: "recovered-v3",
  legacyV3Unfenced: "legacy-v3-unfenced",
} as const;

/** Eligible Vault event kinds retained as bounded successor evidence. */
export const RECONCILIATION_EVENT_KIND = {
  create: "create",
  modify: "modify",
  delete: "delete",
  rename: "rename",
} as const;

/** Closed persistence scope for operation- and step-owned preservation receipts. */
export const RECONCILIATION_PRESERVATION_SCOPE = {
  operation: "operation",
  historyStep: "history-step",
} as const;

/** Sides whose exact bytes may be preserved before a competing mutation. */
export const RECONCILIATION_PRESERVATION_SIDE = {
  local: "local",
  remote: "remote",
} as const;

/** Closed proof states for one content-free preservation receipt. */
export const RECONCILIATION_PRESERVATION_PROOF_STATE = {
  pending: "pending",
  verified: "verified",
  evidenceRequired: "evidence-required",
  blocked: "blocked",
} as const;

/** Relationship of a reserved path to the existing M3 ledger and review target. */
export const RECONCILIATION_PATH_REFERENCE_KIND = {
  tracked: "tracked",
  reviewTarget: "review-target",
  newDestination: "new-destination",
} as const;

/** Content-free local evidence variants retained by a review or operation. */
export const RECONCILIATION_LOCAL_EVIDENCE_KIND = {
  absent: "absent",
  live: "live",
  unknown: "unknown",
} as const;

/** Whether sampled local evidence is exact enough to authorize a reviewed decision. */
export const RECONCILIATION_LOCAL_STABILITY = {
  stable: "stable",
  unknown: "unknown",
} as const;

/** Content-free remote evidence variants retained by a review or operation. */
export const RECONCILIATION_REMOTE_EVIDENCE_KIND = {
  absent: "absent",
  legacy: "legacy",
  live: "live",
  tombstone: "tombstone",
  unavailable: "unavailable",
} as const;

/** Maximum sparse durable reviews retained in one device state. */
export const MAX_RECONCILIATION_REVIEWS = 1_024;

/** Maximum sparse durable operations retained in one device state. */
export const MAX_RECONCILIATION_OPERATIONS = 1_024;

/** Maximum preservation receipts retained across sparse operations. */
export const MAX_RECONCILIATION_PRESERVATION_RECEIPTS = 2_048;
