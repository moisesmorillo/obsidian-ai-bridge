import type { NotePath } from "@core/note-path/note-path.types";

/** Stable server-issued UUID identity that scopes one protocol-major-one vault. */
export type SyncVaultId = string & { readonly __brand: "SyncVaultId" };

/** Stable installation UUID, distinct from authorization and writer election. */
export type SyncDeviceId = string & { readonly __brand: "SyncDeviceId" };

/** Device identity recorded as mutation provenance, never authorization or a lock. */
export type SyncOrigin = SyncDeviceId;

/** Immutable UUID identity for one version of a path in the sync store. */
export type SyncRevision = string & { readonly __brand: "SyncRevision" };

/** UUID idempotency identity bound to one exact sync mutation request. */
export type SyncOperationId = string & { readonly __brand: "SyncOperationId" };

/** UUID identity for one resumable sync inventory scan. */
export type SyncInventoryId = string & { readonly __brand: "SyncInventoryId" };

/** Canonical sync path satisfying NotePath validation and the sync key-size bound. */
export type SyncNotePath = NotePath & {
  readonly __syncBrand: "SyncNotePath";
};

/** Validated 20-digit decimal feed position, including the initial all-zero checkpoint. */
export type SyncSequence = string & { readonly __brand: "SyncSequence" };

/** Non-zero validated event position, assignable wherever a general sequence is accepted. */
export type SyncEventSequence = SyncSequence & {
  readonly __eventBrand: "SyncEventSequence";
};

/** Protocol-major-one feed position vector bound to one vault. */
export type SyncCheckpoint = {
  /** Protocol generation whose cursor semantics this vector follows. */
  readonly protocolMajor: 1;
  /** Vault whose independent feed positions this checkpoint records. */
  readonly vaultId: SyncVaultId;
  /** Highest consumed sequence for each feed lane. */
  readonly laneSequences: readonly SyncSequence[];
  /** Lane selected first by the next bounded feed read. */
  readonly nextLane: number;
};
