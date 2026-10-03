/** Maximum actual GET and PUT calls admitted by one M7 mutation invocation. */
export const SYNC_R2_INVOCATION_CALL_LIMIT = 64;

/** Largest nonnegative Unix epoch millisecond accepted by JavaScript Date for R2 upload metadata. */
export const SYNC_R2_MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;

/** Minimum same-key R2 write interval in milliseconds. */
export const SYNC_R2_WRITE_COOLDOWN_MS = 1_100;
