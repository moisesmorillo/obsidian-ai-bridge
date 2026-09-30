/** Persisted byte ceilings shared by publication validation and R2 object access. */
export const SYNC_PUBLICATION_LIMITS = {
  /** Maximum exact Markdown content retained in a mutation journal. */
  payloadBytes: 1_048_576,
  /** Maximum canonical journal JSON bytes, including its exact retained request. */
  journalBytes: 8 * 1_048_576,
  /** Maximum bounded JSON bytes for lane heads and immutable feed events. */
  metadataBytes: 2_048,
  /** Maximum exact prior JSON bytes retained as a mutation precondition. */
  preconditionBytes: 2_048,
  /** Maximum UTF-8 bytes retained for an opaque original R2 ETag. */
  etagBytes: 1_024,
} as const;
