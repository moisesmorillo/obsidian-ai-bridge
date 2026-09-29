import type {
  SyncCheckpoint,
  SyncDeviceId,
  SyncEventSequence,
  SyncInventoryId,
  SyncNotePath,
  SyncOperationId,
  SyncRevision,
  SyncSequence,
  SyncVaultId,
} from "@obsidian-ai-bridge/core";
import type {
  syncErrorCodeSchema,
  syncOpaqueCursorSchema,
  syncVaultMarkerSchema,
} from "@protocol/sync.schemas";
import type { z } from "zod";

/** Immutable server-issued vault identity used to scope every M7 record. */
export type SyncVaultIdDto = SyncVaultId;

/** Immutable installation identity, distinct from authorization or writer election. */
export type SyncDeviceIdDto = SyncDeviceId;

/** Immutable revision identity assigned to one versioned path state. */
export type SyncRevisionDto = SyncRevision;

/** Immutable operation identity reused only for exact retries of one request. */
export type SyncOperationIdDto = SyncOperationId;

/** Immutable identity for one resumable inventory scan. */
export type SyncInventoryIdDto = SyncInventoryId;

/** Canonical normalized path accepted by M7 versioned storage. */
export type SyncNotePathDto = SyncNotePath;

/** Fixed-width decimal sequence that can represent the initial zero checkpoint. */
export type SyncSequenceDto = SyncSequence;

/** Non-zero fixed-width decimal sequence assigned to a feed event. */
export type SyncEventSequenceDto = SyncEventSequence;

/** Closed result error code set for protocol-major-one storage operations. */
export type SyncErrorCodeDto = z.infer<typeof syncErrorCodeSchema>;

/** Strict protocol-major-one marker written at the root of a sync vault namespace. */
export type SyncVaultMarkerDto = z.infer<typeof syncVaultMarkerSchema>;

/** Protocol/vault-bound checkpoint vector for committed feed positions. */
export type SyncCheckpointDto = SyncCheckpoint;

/** Opaque base64url checkpoint cursor carried between protocol consumers. */
export type SyncOpaqueCursorDto = z.infer<typeof syncOpaqueCursorSchema>;
