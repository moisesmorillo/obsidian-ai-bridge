import type {
  syncCheckpointSchema,
  syncDeviceIdSchema,
  syncErrorCodeSchema,
  syncEventSequenceSchema,
  syncInventoryIdSchema,
  syncNotePathSchema,
  syncOpaqueCursorSchema,
  syncOperationIdSchema,
  syncRevisionSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
  syncVaultMarkerSchema,
} from "@protocol/sync.schemas";
import type { z } from "zod";

/** Immutable server-issued vault identity used to scope every M7 record. */
export type SyncVaultIdDto = z.infer<typeof syncVaultIdSchema>;

/** Immutable installation identity, distinct from authorization or writer election. */
export type SyncDeviceIdDto = z.infer<typeof syncDeviceIdSchema>;

/** Immutable revision identity assigned to one versioned path state. */
export type SyncRevisionDto = z.infer<typeof syncRevisionSchema>;

/** Immutable operation identity reused only for exact retries of one request. */
export type SyncOperationIdDto = z.infer<typeof syncOperationIdSchema>;

/** Immutable identity for one resumable inventory scan. */
export type SyncInventoryIdDto = z.infer<typeof syncInventoryIdSchema>;

/** Canonical normalized path accepted by M7 versioned storage. */
export type SyncNotePathDto = z.infer<typeof syncNotePathSchema>;

/** Fixed-width decimal sequence that can represent the initial zero checkpoint. */
export type SyncSequenceDto = z.infer<typeof syncSequenceSchema>;

/** Non-zero fixed-width decimal sequence assigned to a feed event. */
export type SyncEventSequenceDto = z.infer<typeof syncEventSequenceSchema>;

/** Closed result error code set for protocol-major-one storage operations. */
export type SyncErrorCodeDto = z.infer<typeof syncErrorCodeSchema>;

/** Strict protocol-major-one marker written at the root of a sync vault namespace. */
export type SyncVaultMarkerDto = z.infer<typeof syncVaultMarkerSchema>;

/** Protocol/vault-bound checkpoint vector for committed feed positions. */
export type SyncCheckpointDto = z.infer<typeof syncCheckpointSchema>;

/** Opaque base64url checkpoint cursor carried between protocol consumers. */
export type SyncOpaqueCursorDto = z.infer<typeof syncOpaqueCursorSchema>;
