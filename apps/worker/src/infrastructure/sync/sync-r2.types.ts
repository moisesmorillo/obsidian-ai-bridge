/** Opaque key accepted only after its M7.1 shape and vault prefix are rebuilt exactly. */
export type SyncR2Key = string & { readonly __syncR2Key: unique symbol };

/** One key-scoped observation retaining the exact bytes and generation evidence privately. */
export interface SyncR2Observed {
  /** Canonical M7.1 key whose generation was observed. */
  readonly key: SyncR2Key;
  /** Exact R2 ETag for conditional replacement; never exposed to core. */
  readonly etag: string;
  /** Exact body bytes returned with this generation. */
  readonly bytes: Uint8Array;
  /** R2 server upload time used only to enforce same-key cooldown. */
  readonly uploaded: Date;
}

/** Typed read evidence for one validated sync key. */
export type SyncR2ReadResult =
  | { readonly kind: "absent" }
  | { readonly kind: "observed"; readonly observation: SyncR2Observed }
  | { readonly kind: "unavailable" };

/** Exact typed projection used by later record facades without exposing R2 metadata outside Worker. */
export type SyncRecordRead<T> =
  | { readonly kind: "absent" }
  | {
      readonly kind: "observed";
      readonly observation: SyncRecordObservation<T>;
    }
  | { readonly kind: "unavailable" };

/** A decoded private record tied to the exact R2 generation that supplied it. */
export interface SyncRecordObservation<T> {
  /** Strictly decoded record payload. */
  readonly value: T;
  /** R2 generation evidence retained only inside Worker infrastructure. */
  readonly observed: SyncR2Observed;
}

/** Retry evidence callers must carry across isolates before reattempting a throttled or uncertain write. */
export interface SyncR2RetryContext {
  /** Earliest safe Unix epoch millisecond time reported by the prior write result. */
  readonly retryAfterEpochMs: number;
}

/** Closed certainty outcomes for a single conditional R2 write attempt. */
export type SyncR2WriteResult =
  | { readonly kind: "confirmed" }
  | { readonly kind: "refused" }
  | { readonly kind: "throttled"; readonly retryAfterEpochMs: number }
  | { readonly kind: "effect_unknown"; readonly retryAfterEpochMs?: number };

/** Narrow one-object capability for protocol-major-one conditional persistence. */
export interface SyncR2ObjectStore {
  /** Reads one allowed key and bounds allocation before accepting its body. */
  read(key: SyncR2Key, maxBytes: number): Promise<SyncR2ReadResult>;
  /** Creates the key only if absent, then confirms exact bytes by read-back. */
  create(
    key: SyncR2Key,
    bytes: Uint8Array,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult>;
  /** Replaces only the exact generation retained from a prior read. */
  replace(
    observed: SyncR2Observed,
    bytes: Uint8Array,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult>;
}
