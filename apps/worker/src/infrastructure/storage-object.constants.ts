import { MAX_NOTE_SIZE_BYTES } from "@obsidian-ai-bridge/core";

/** Application storage format recognized for M3 current and recovery objects. */
export const BRIDGE_STORAGE_FORMAT = 2 as const;

/** R2 custom-metadata key that distinguishes envelopes from legacy Markdown bytes. */
export const BRIDGE_STORAGE_FORMAT_METADATA_KEY = "bridgeFormat";

/** Canonical custom-metadata value for the recognized M3 storage format. */
export const BRIDGE_STORAGE_FORMAT_METADATA_VALUE = String(
  BRIDGE_STORAGE_FORMAT,
);

/** Conditional header used by R2 for create-only object writes. */
export const R2_IF_NONE_MATCH_HEADER = "If-None-Match";

/** R2 conditional value requiring exact key absence. */
export const R2_ABSENCE_WILDCARD = "*";

/** JSON media type attached to private M3 storage envelopes. */
export const BRIDGE_STORAGE_CONTENT_TYPE = "application/json; charset=utf-8";

/** Maximum encoded bytes accepted for a live current-generation envelope. */
export const MAX_LIVE_CURRENT_OBJECT_BYTES = 6 * MAX_NOTE_SIZE_BYTES + 4096;

/** Maximum encoded bytes accepted for a current tombstone envelope. */
export const MAX_TOMBSTONE_CURRENT_OBJECT_BYTES = 4096;

/** Maximum encoded bytes accepted for a recoverable snapshot envelope. */
export const MAX_RECOVERY_OBJECT_BYTES = 6 * MAX_NOTE_SIZE_BYTES + 8192;

/** Private namespace for recovery objects keyed by deletion operation identity. */
export const RECOVERY_OBJECT_PREFIX = "recovery/";
