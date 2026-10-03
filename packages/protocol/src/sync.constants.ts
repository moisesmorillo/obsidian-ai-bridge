/** Stable storage namespace for protocol-major-one sync records. */
export const SYNC_NAMESPACE_PREFIX = "sync/v1/vaults";

/** Protocol major persisted in sync-store records and cursors. */
export const SYNC_PROTOCOL_MAJOR = 1 as const;

/** Fixed number of independently sequenced change-feed lanes. */
export const SYNC_FEED_LANE_COUNT = 64;

/** Maximum UTF-8 bytes permitted in a path encoded into an R2 object key. */
export const MAX_SYNC_NOTE_PATH_BYTES = 720;

/** Largest zero-based inventory chunk and cursor-claim step admitted for one bounded scan. */
export const MAX_SYNC_INVENTORY_STEP_INDEX = 20_000;

/** Maximum actual R2 internal-service calls permitted in one inventory invocation. */
export const MAX_INVENTORY_SUBREQUESTS_PER_INVOCATION = 400;

/** Maximum decimal digits in one feed sequence, represented without number rounding. */
export const SYNC_SEQUENCE_WIDTH = 20;

/** Largest sequence representable by the fixed-width protocol sequence. */
export const SYNC_MAX_SEQUENCE = "99999999999999999999";

/** Stable protocol error codes returned by M7 storage operations. */
export const SYNC_ERROR_CODE = {
  invalidInput: "invalid_input",
  unsupportedProtocolVersion: "unsupported_protocol_version",
  vaultNotFound: "vault_not_found",
  staleRevision: "stale_revision",
  operationIdReused: "operation_id_reused",
  mutationNotAdmitted: "mutation_not_admitted",
  cursorExpired: "cursor_expired",
  invalidCursor: "invalid_cursor",
  inventoryIncomplete: "inventory_incomplete",
  inventoryLimitExceeded: "inventory_limit_exceeded",
  inventoryExpired: "inventory_expired",
  inventoryIdReused: "inventory_id_reused",
  sequenceExhausted: "sequence_exhausted",
  storageThrottled: "storage_throttled",
  operationPending: "operation_pending",
  effectUnknown: "effect_unknown",
  storageUnavailable: "storage_unavailable",
} as const;

/** Ordered closed set of protocol-major-one storage error codes. */
export const SYNC_ERROR_CODES = [
  SYNC_ERROR_CODE.invalidInput,
  SYNC_ERROR_CODE.unsupportedProtocolVersion,
  SYNC_ERROR_CODE.vaultNotFound,
  SYNC_ERROR_CODE.staleRevision,
  SYNC_ERROR_CODE.operationIdReused,
  SYNC_ERROR_CODE.mutationNotAdmitted,
  SYNC_ERROR_CODE.cursorExpired,
  SYNC_ERROR_CODE.invalidCursor,
  SYNC_ERROR_CODE.inventoryIncomplete,
  SYNC_ERROR_CODE.inventoryLimitExceeded,
  SYNC_ERROR_CODE.inventoryExpired,
  SYNC_ERROR_CODE.inventoryIdReused,
  SYNC_ERROR_CODE.sequenceExhausted,
  SYNC_ERROR_CODE.storageThrottled,
  SYNC_ERROR_CODE.operationPending,
  SYNC_ERROR_CODE.effectUnknown,
  SYNC_ERROR_CODE.storageUnavailable,
] as const;

/** Canonical component filenames and subdirectories under each vault namespace. */
export const SYNC_OBJECT_SEGMENT = {
  vault: "vault.json",
  heads: "heads",
  versions: "versions",
  content: "content",
  recovery: "recovery",
  operations: "operations",
  feed: "feed",
  events: "events",
  head: "head.json",
  inventories: "inventories",
  active: "active.json",
  scans: "scans",
  manifest: "manifest.json",
  chunks: "chunks",
  claims: "claims",
  cursors: "cursors",
} as const;
