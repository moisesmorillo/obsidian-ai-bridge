/** Closed durable lifecycle states for one device-local mirror writer. */
export const MIRROR_DEVICE_LIFECYCLE_KIND = {
  disabled: "disabled",
  active: "active",
  paused: "paused",
  handoffDraining: "handoff-draining",
  handoffDrained: "handoff-drained",
  handoffStaged: "handoff-staged",
} as const;

/** Closed last-acknowledged remote states retained per eligible path. */
export const MIRROR_ACKNOWLEDGEMENT_KIND = {
  unassociated: "unassociated",
  live: "live",
  tombstone: "tombstone",
} as const;

/** Closed coalesced local evidence states retained without note bodies. */
export const MIRROR_DESIRED_STATE_KIND = {
  none: "none",
  dirtyPresent: "dirty-present",
  runtimeDelete: "runtime-delete",
  renameDeferred: "rename-deferred",
} as const;

/** Closed handoff alignment states; only `matched` may contribute to activation. */
export const HANDOFF_ALIGNMENT_KIND = {
  pending: "pending",
  matched: "matched",
  mismatch: "mismatch",
} as const;

/** Durable unresolved-mutation workflow phases retained across restart. */
export const MIRROR_MUTATION_PHASE = {
  intentPersisted: "intent-persisted",
  dispatched: "dispatched",
  evidenceRequired: "evidence-required",
  recoveryPreparation: "recovery-preparation",
  tombstoneCommit: "tombstone-commit",
} as const;

/** Sanitized global reasons that deny mutation admission. */
export const MIRROR_GLOBAL_BLOCK_REASON = {
  configurationUnavailable: "configuration-unavailable",
  stateUnavailable: "state-unavailable",
  persistenceFailed: "persistence-failed",
  designationMismatch: "designation-mismatch",
  missingSecret: "missing-secret",
  handoffMismatch: "handoff-mismatch",
} as const;

/** Sanitized path-local reasons retained without raw failures or note text. */
export const MIRROR_PATH_BLOCK_REASON = {
  diverged: "diverged",
  retryExhausted: "retry-exhausted",
  unresolvedEffect: "unresolved-effect",
  renameDeferred: "rename-deferred",
  handoffMismatch: "handoff-mismatch",
} as const;

/** Durable reasons for pausing one explicitly bound writer. */
export const MIRROR_PAUSE_REASON = {
  manual: "manual",
  persistenceFailure: "persistence-failure",
} as const;

/** Closed deferred rename phases modeled before runtime orchestration exists. */
export const MIRROR_RENAME_PHASE = {
  destinationRequired: "destination-required",
  sourceCleanupRequired: "source-cleanup-required",
} as const;

/** Version of the core-owned durable device state contract. */
export const MIRROR_DEVICE_STATE_VERSION = 1;

/** Practical upper bound on tracked paths in one device-local ledger. */
export const MAX_MIRROR_TRACKED_PATHS = 50_000;
