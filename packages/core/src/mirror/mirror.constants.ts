/** Unanchored canonical UUID-v4 source shared by identity and ETag patterns. */
const UUID_V4_PATTERN_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

/** Canonical lowercase UUID-v4 syntax for all M3 opaque identities. */
export const UUID_V4_PATTERN = new RegExp(`^${UUID_V4_PATTERN_SOURCE}$`);

/** Canonical lowercase hexadecimal representation of a SHA-256 content digest. */
export const CONTENT_SHA_256_PATTERN = /^[0-9a-f]{64}$/;

/** Prefix inside the strong application ETag for an M3 current generation. */
export const APPLICATION_ETAG_PREFIX = "m3-";

/** Canonical strong application ETag syntax exposed by the M3 HTTP protocol. */
export const APPLICATION_ETAG_PATTERN = new RegExp(
  `^"${APPLICATION_ETAG_PREFIX}${UUID_V4_PATTERN_SOURCE}"$`,
);

/** Closed M3 mutations against a current note generation. */
export const MUTATION_ACTION = {
  create: "create",
  update: "update",
  recreate: "recreate",
  tombstone: "tombstone",
} as const;

/** Ordered mutation actions accepted by protocol schemas. */
export const MUTATION_ACTIONS = [
  MUTATION_ACTION.create,
  MUTATION_ACTION.update,
  MUTATION_ACTION.recreate,
  MUTATION_ACTION.tombstone,
] as const;

/** Closed conditional requirements that prevent replace-any mutations. */
export const CONDITIONAL_MUTATION_PRECONDITION_KIND = {
  absent: "absent",
  matchingRevision: "matching-revision",
} as const;

/** Closed current-note observations; unknown storage formats are not current generations. */
export const CURRENT_NOTE_STATE_KIND = {
  absent: "absent",
  legacy: "legacy",
  live: "live",
  tombstone: "tombstone",
} as const;

/** Closed recovery lifecycle states for a snapshot or retained purged marker. */
export const RECOVERY_SNAPSHOT_STATE_KIND = {
  prepared: "prepared",
  sealed: "sealed",
  purged: "purged",
} as const;

/** Closed certainty states for a mutation after an attempted client dispatch. */
export const MUTATION_EFFECT_CERTAINTY = {
  notDispatched: "not-dispatched",
  definitelyRefused: "definitely-refused",
  confirmed: "confirmed",
  unknown: "unknown",
} as const;

/** Closed stages that locate certainty within the recoverable tombstone workflow. */
export const TOMBSTONE_WORKFLOW_STAGE_KIND = {
  current: "current",
  recoveryPreparation: "recovery-preparation",
  tombstone: "tombstone",
  complete: "complete",
} as const;

/** Closed current-content retrieval outcomes preserving one observed generation. */
export const CURRENT_CONTENT_RESULT_KIND = {
  absent: "absent",
  legacy: "legacy",
  live: "live",
  tombstone: "tombstone",
} as const;

/** Closed recovery-content retrieval outcomes for application callers. */
export const RECOVERY_CONTENT_RESULT_KIND = {
  missing: "missing",
  recoverable: "recoverable",
  expired: "expired",
  purged: "purged",
} as const;

/** Closed semantic outcomes for explicit recovery maintenance transport mapping. */
export const RECOVERY_MAINTENANCE_RESULT_KIND = {
  missing: "missing",
  preconditionFailed: "precondition-failed",
  conflict: "conflict",
  notDispatched: MUTATION_EFFECT_CERTAINTY.notDispatched,
  confirmed: MUTATION_EFFECT_CERTAINTY.confirmed,
  unknown: MUTATION_EFFECT_CERTAINTY.unknown,
} as const;

/** Exact 30-day recovery window measured from a confirmed tombstone upload. */
export const RECOVERY_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;

/** Maximum opaque cursor length accepted by the M3 API. */
export const MAX_MIRROR_CURSOR_LENGTH = 4096;

/** Maximum current-note or recovery metadata entries returned in one M3 page. */
export const MAX_MIRROR_PAGE_SIZE = 50;

/** Maximum persisted mutation attempts for one original M3 intent. */
export const MAX_MUTATION_ATTEMPTS = 3;

/** Maximum persisted state-evidence requests for one original M3 intent. */
export const MAX_MUTATION_EVIDENCE_ATTEMPTS = 3;
