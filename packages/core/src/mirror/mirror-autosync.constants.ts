/** Quiet time after the latest positive saved-file observation before a path is ready. */
export const MIRROR_COALESCING_QUIET_PERIOD_MILLISECONDS = 750;

/** Maximum time a continuously changing path may wait before another saved read. */
export const MIRROR_MAX_COALESCING_WAIT_MILLISECONDS = 5_000;

/** Maximum number of path, inventory, or evidence jobs owned by one synchronizer. */
export const MAX_ACTIVE_MIRROR_JOBS = 2;

/** Delay before the second mutation attempt for one durable intent. */
export const MIRROR_MUTATION_RETRY_DELAY_MILLISECONDS = 2_000;

/** Delay before the third mutation attempt for one durable intent. */
export const MIRROR_FINAL_MUTATION_RETRY_DELAY_MILLISECONDS = 10_000;

/** Maximum remote inventory pages in one explicitly requested read-only pass. */
export const MAX_REMOTE_INVENTORY_PAGES = 1_000;

/** Closed runtime phases for core synchronization admission and reporting. */
export const MIRROR_SYNCHRONIZER_PHASE = {
  observing: "observing",
  bootstrapping: "bootstrapping",
  inactive: "inactive",
} as const;

/** Closed reasons why local bootstrap work was not durably admitted. */
export const MIRROR_BOOTSTRAP_INCOMPLETE_REASON = {
  pathCapacityExceeded: "path-capacity-exceeded",
  staleTransition: "stale-transition",
  invalidTransition: "invalid-transition",
  persistenceFailed: "persistence-failed",
} as const;

/** Closed reasons why a bounded remote inventory is incomplete. */
export const MIRROR_INVENTORY_INCOMPLETE_REASON = {
  remoteFailure: "remote-failure",
  repeatedCursor: "repeated-cursor",
  pageBudgetExhausted: "page-budget-exhausted",
} as const;
