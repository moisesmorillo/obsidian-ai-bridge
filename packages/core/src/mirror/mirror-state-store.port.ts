import type { MirrorDeviceState } from "@core/mirror/mirror-state.types";

/** Closed failure categories exposed by device-local persistence adapters. */
export const MIRROR_STATE_STORE_FAILURE = {
  unavailable: "unavailable",
  quotaOrStorageError: "quota-or-storage-error",
} as const;

/** Sanitized state-store failure without raw host exceptions. */
export type MirrorStateStoreFailure =
  (typeof MIRROR_STATE_STORE_FAILURE)[keyof typeof MIRROR_STATE_STORE_FAILURE];

/** Result of durably replacing one complete validated device-local snapshot. */
export type MirrorStateSaveResult =
  | { readonly kind: "saved" }
  | { readonly kind: "failed"; readonly reason: MirrorStateStoreFailure };

/**
 * Persistence capability for complete device-local mirror snapshots.
 *
 * Implementations own host serialization. Core callers never perform generic
 * read-modify-write calls against the underlying storage API.
 */
export interface MirrorStateStore {
  /**
   * Replaces the durable snapshot after adapter validation/serialization.
   *
   * @param state - Complete next state, containing metadata but no note body or token.
   * @returns Whether durable replacement completed.
   */
  save(state: MirrorDeviceState): Promise<MirrorStateSaveResult>;
}
