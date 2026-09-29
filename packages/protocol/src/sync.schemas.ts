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

/** Validates immutable lowercase UUID-v4 identifiers owned by the sync protocol. */
export const syncIdentifierSchema = z.string().regex(UUID_V4_PATTERN);

/** Distinguishes a server-issued vault identity from other UUID identifiers. */
export const syncVaultIdSchema = syncIdentifierSchema.brand("SyncVaultId");

/** Distinguishes one device installation identity from other UUID identifiers. */
export const syncDeviceIdSchema = syncIdentifierSchema.brand("SyncDeviceId");

/** Distinguishes one immutable revision identity from other UUID identifiers. */
export const syncRevisionSchema = syncIdentifierSchema.brand("SyncRevision");

/** Distinguishes one idempotent operation identity from other UUID identifiers. */
export const syncOperationIdSchema =
  syncIdentifierSchema.brand("SyncOperationId");

/** Distinguishes one immutable inventory scan identity from other UUID identifiers. */
export const syncInventoryIdSchema =
  syncIdentifierSchema.brand("SyncInventoryId");

/** Validates a canonical Markdown NotePath that fits the M7 R2 key bound. */
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
  );

/** Validates a canonical fixed-width decimal feed sequence, including zero checkpoints. */
export const syncSequenceSchema = z
  .string()
  .length(SYNC_SEQUENCE_WIDTH)
  .regex(/^\d+$/)
  .max(SYNC_MAX_SEQUENCE.length)
  .refine((sequence) => sequence <= SYNC_MAX_SEQUENCE);

/** Validates one sequence allocated to an immutable feed event; zero is reserved. */
export const syncEventSequenceSchema = syncSequenceSchema.refine(
  (sequence) => sequence !== "0".repeat(SYNC_SEQUENCE_WIDTH),
);

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

/** Strict checkpoint vector; each lane sequence is a fixed-width decimal string. */
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
  .strict();

/** Validates unpadded base64url syntax for opaque M7 cursors before codec decoding. */
export const syncOpaqueCursorSchema = z
  .string()
  .min(1)
  .regex(BASE64URL_PATTERN);
