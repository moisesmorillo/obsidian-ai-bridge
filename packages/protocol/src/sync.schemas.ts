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
import {
  BASE64URL_PATTERN,
  isNormalizedNotePath,
  UUID_V4_PATTERN,
} from "@obsidian-ai-bridge/core";
import {
  MAX_SYNC_NOTE_PATH_BYTES,
  SYNC_ERROR_CODES,
  SYNC_FEED_LANE_COUNT,
  SYNC_MAX_SEQUENCE,
  SYNC_PROTOCOL_MAJOR,
  SYNC_SEQUENCE_WIDTH,
} from "@protocol/sync.constants";
import { z } from "zod";

/** Validates canonical lowercase UUID-v4 strings before role-specific branding. */
export const syncIdentifierSchema = z.string().regex(UUID_V4_PATTERN);

/** Validates a vault UUID, then brands it as the core sync identity at this trust boundary. */
export const syncVaultIdSchema = syncIdentifierSchema.transform(
  (identifier): SyncVaultId => identifier as SyncVaultId,
);

/** Validates a device UUID, then brands it as the core sync identity at this trust boundary. */
export const syncDeviceIdSchema = syncIdentifierSchema.transform(
  (identifier): SyncDeviceId => identifier as SyncDeviceId,
);

/** Validates a revision UUID, then brands it as the core sync identity at this trust boundary. */
export const syncRevisionSchema = syncIdentifierSchema.transform(
  (identifier): SyncRevision => identifier as SyncRevision,
);

/** Validates an operation UUID, then brands it as the core sync identity at this trust boundary. */
export const syncOperationIdSchema = syncIdentifierSchema.transform(
  (identifier): SyncOperationId => identifier as SyncOperationId,
);

/** Validates an inventory UUID, then brands it as the core sync identity at this trust boundary. */
export const syncInventoryIdSchema = syncIdentifierSchema.transform(
  (identifier): SyncInventoryId => identifier as SyncInventoryId,
);

/** Validates the canonical, bounded Markdown path before adding the core sync-path brand. */
export const syncNotePathSchema = z
  .string()
  .refine(
    isNormalizedNotePath,
    "Expected a canonical normalized Markdown NotePath.",
  )
  .refine(
    (path) =>
      new TextEncoder().encode(path).byteLength <= MAX_SYNC_NOTE_PATH_BYTES,
    `A sync NotePath cannot exceed ${MAX_SYNC_NOTE_PATH_BYTES} UTF-8 bytes.`,
  )
  .transform((path): SyncNotePath => path as SyncNotePath);

/** Validates the fixed-width decimal checkpoint domain before core branding. */
export const syncSequenceSchema = z
  .string()
  .length(SYNC_SEQUENCE_WIDTH)
  .regex(/^\d+$/)
  .max(SYNC_MAX_SEQUENCE.length)
  .refine((sequence) => sequence <= SYNC_MAX_SEQUENCE)
  .transform((sequence): SyncSequence => sequence as SyncSequence);

/** Validates a non-zero event position before narrowing the core sequence brand. */
export const syncEventSequenceSchema = syncSequenceSchema
  .refine((sequence) => sequence !== "0".repeat(SYNC_SEQUENCE_WIDTH))
  .transform((sequence): SyncEventSequence => sequence as SyncEventSequence);

/** Closed error code schema for protocol-major-one storage operations. */
export const syncErrorCodeSchema = z.enum(SYNC_ERROR_CODES);

/** Strict create-only marker proving a namespace belongs to one protocol vault. */
export const syncVaultMarkerSchema = z
  .object({
    schemaVersion: z.literal(SYNC_PROTOCOL_MAJOR),
    protocolMajor: z.literal(SYNC_PROTOCOL_MAJOR),
    vaultId: syncVaultIdSchema,
  })
  .strict();

/** Validates a strict protocol/vault checkpoint, returning its core semantic type. */
export const syncCheckpointSchema = z
  .object({
    protocolMajor: z.literal(SYNC_PROTOCOL_MAJOR),
    vaultId: syncVaultIdSchema,
    laneSequences: z.array(syncSequenceSchema).length(SYNC_FEED_LANE_COUNT),
    nextLane: z
      .int()
      .min(0)
      .max(SYNC_FEED_LANE_COUNT - 1),
  })
  .strict()
  .transform((checkpoint): SyncCheckpoint => checkpoint);

/** Validates unpadded base64url syntax for opaque M7 cursors before codec decoding. */
export const syncOpaqueCursorSchema = z
  .string()
  .min(1)
  .regex(BASE64URL_PATTERN);
