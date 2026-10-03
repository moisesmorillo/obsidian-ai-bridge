import {
  type ContentSha256,
  createContentSha256,
  decodeBase64Url,
  decodeUtf8,
  encodeBase64Url,
} from "@obsidian-ai-bridge/core";
import { decodeSyncPathKey } from "@protocol/sync.codec";
import { MAX_SYNC_INVENTORY_STEP_INDEX } from "@protocol/sync.constants";
import {
  syncDeviceIdSchema,
  syncIdentifierSchema,
  syncInventoryIdSchema,
  syncNotePathSchema,
  syncOperationIdSchema,
  syncRevisionSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type { SyncInventoryClaimId } from "@worker/infrastructure/sync/sync-record.types";
import { z } from "zod";

/** Single source of storage byte and count ceilings for private protocol-v1 records. */
export const SYNC_RECORD_LIMITS = {
  contentBodyBytes: 1_048_576,
  pathBytes: 720,
  headBytes: 2_048,
  manifestBytes: 8_192,
  witnessedManifestBytes: 9_216,
  cursorWitnessBytes: 384,
  cursorJournalBytes: 512,
  cursorBytes: 4_096,
  chunkBytes: 12 * 1_024,
  chunkEnvelopeBytes: 8_192,
  summaryBytes: 1_536,
  inventorySteps: MAX_SYNC_INVENTORY_STEP_INDEX + 1,
  inventoryHeads: 10_000,
  emptyInventoryPages: 10_000,
  inventoryListAttempts: 40_002,
  inventoryHeadGetAttempts: 20_000,
  inventoryUniqueHeadBodyBytes: 20 * 1_048_576,
  inventoryActualHeadBodyBytes: 40 * 1_048_576,
  inventoryEvidenceBytes: 192 * 1_048_576,
  chunkTranscriptBytes: 256,
} as const;

/** Closed set of canonical lowercase hexadecimal SHA-256 digests. */
const sha256Schema = z.custom<ContentSha256>(
  (value) =>
    typeof value === "string" && createContentSha256(value) !== undefined,
);
/** Fixed UTF-8 media type accepted by protocol-major-one Markdown records. */
const markdownMediaTypeSchema = z.literal("text/markdown");
/** Exact strict JSON envelope shared by private persisted protocol-v1 metadata. */
const envelopeShape = {
  schemaVersion: z.literal(1),
  protocolMajor: z.literal(1),
  vaultId: syncVaultIdSchema,
};
/** Explicit previous-generation predicate stored with a published version. */
const parentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("never_seen") }).strict(),
  z
    .object({ kind: z.literal("revision"), revision: syncRevisionSchema })
    .strict(),
]);
/** Exact live/tombstone metadata shared by mutable heads and immutable versions. */
const versionFields = {
  path: syncNotePathSchema,
  revision: syncRevisionSchema,
  contentSha256: sha256Schema,
  byteSize: z.number().int().min(0).max(SYNC_RECORD_LIMITS.contentBodyBytes),
  mediaType: markdownMediaTypeSchema,
  operationId: syncOperationIdSchema,
  origin: syncDeviceIdSchema,
};
/** Strict current-head record with path, revision, request and content provenance. */
export const syncHeadRecordSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...envelopeShape,
        ...versionFields,
        kind: z.literal("live"),
        parent: parentSchema,
      })
      .strict(),
    z
      .object({
        ...envelopeShape,
        ...versionFields,
        kind: z.literal("tombstone"),
        parent: z
          .object({ kind: z.literal("revision"), revision: syncRevisionSchema })
          .strict(),
      })
      .strict(),
  ])
  .superRefine((record, context) => {
    if (
      record.parent.kind === "revision" &&
      record.parent.revision === record.revision
    ) {
      context.addIssue({
        code: "custom",
        message: "A new head revision must differ from its parent revision.",
      });
    }
  });
/** Strict immutable version metadata stored separately from exact raw Markdown bytes. */
export const syncVersionMetadataSchema = syncHeadRecordSchema;
/** Strict operation-bound recovery metadata for a preserved source revision. */
export const syncRecoveryMetadataSchema = z
  .object({
    ...envelopeShape,
    path: syncNotePathSchema,
    operationId: syncOperationIdSchema,
    sourceRevision: syncRevisionSchema,
    contentSha256: sha256Schema,
    byteSize: z.number().int().min(0).max(SYNC_RECORD_LIMITS.contentBodyBytes),
    mediaType: markdownMediaTypeSchema,
    origin: syncDeviceIdSchema,
  })
  .strict();
/** Explicit empty or claimed active inventory slot persisted without object deletion. */
export const syncInventorySlotSchema = z.discriminatedUnion("state", [
  z.object({ ...envelopeShape, state: z.literal("empty") }).strict(),
  z
    .object({
      ...envelopeShape,
      state: z.literal("active"),
      inventoryId: syncInventoryIdSchema,
    })
    .strict(),
]);
/** Shared bounded scan fields; strict versioned variants retain independent authority. */
const inventoryManifestShape = {
  ...envelopeShape,
  inventoryId: syncInventoryIdSchema,
  phase: z.enum(["starting", "scanning", "complete", "failed"]),
  startVector: z.array(syncSequenceSchema).length(64),
  cursor: z.string().nullable(),
  lastKey: z.string().nullable(),
  emptyPageCount: z
    .number()
    .int()
    .min(0)
    .max(SYNC_RECORD_LIMITS.emptyInventoryPages),
  nextStep: z.number().int().min(0).max(SYNC_RECORD_LIMITS.inventorySteps),
  listPageCount: z.number().int().min(0).max(SYNC_RECORD_LIMITS.inventorySteps),
  headCount: z.number().int().min(0).max(SYNC_RECORD_LIMITS.inventoryHeads),
  listAttemptCount: z
    .number()
    .int()
    .min(0)
    .max(SYNC_RECORD_LIMITS.inventoryListAttempts),
  headGetAttemptCount: z
    .number()
    .int()
    .min(0)
    .max(SYNC_RECORD_LIMITS.inventoryHeadGetAttempts),
  uniqueHeadBodyBytes: z
    .number()
    .int()
    .min(0)
    .max(SYNC_RECORD_LIMITS.inventoryUniqueHeadBodyBytes),
  actualHeadBodyBytes: z
    .number()
    .int()
    .min(0)
    .max(SYNC_RECORD_LIMITS.inventoryActualHeadBodyBytes),
  evidenceBytes: z
    .number()
    .int()
    .min(0)
    .max(SYNC_RECORD_LIMITS.inventoryEvidenceBytes),
  chunkCount: z.number().int().min(0).max(SYNC_RECORD_LIMITS.inventorySteps),
  chunkHash: sha256Schema.nullable(),
  reservedAttempt: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  expiresAtEpochMs: z.number().int().nonnegative(),
};
/** Strict historical-v1 or witnessed-v2 scan state with bounded opaque R2 cursor. */
export const syncInventoryManifestSchema = z
  .discriminatedUnion("schemaVersion", [
    z.object(inventoryManifestShape).strict(),
    z
      .object({
        ...inventoryManifestShape,
        schemaVersion: z.literal(2),
        cursorWitnessMode: z.literal(1),
      })
      .strict(),
  ])
  .superRefine((manifest, context) => {
    if (
      manifest.chunkCount !== manifest.nextStep ||
      manifest.listPageCount !== manifest.chunkCount
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Manifest step, chunk, and page counters must describe the same contiguous prefix.",
      });
    }
    if ((manifest.chunkCount === 0) !== (manifest.chunkHash === null)) {
      context.addIssue({
        code: "custom",
        message: "Only an empty chunk chain may have a null root hash.",
      });
    }
    if (manifest.cursor !== null && !isBoundedEncodedCursor(manifest.cursor)) {
      context.addIssue({
        code: "custom",
        message: "Inventory cursor is invalid or exceeds its byte limit.",
      });
    }
  });
/** Validates a random UUID before branding it as one private witness attempt generation. */
const inventoryClaimIdSchema = syncIdentifierSchema.transform(
  (identifier): SyncInventoryClaimId => identifier as SyncInventoryClaimId,
);
/** Exact key-linked immutable cursor witness fields shared with its attempt journal. */
const inventoryCursorEvidenceShape = {
  ...envelopeShape,
  inventoryId: syncInventoryIdSchema,
  step: z
    .number()
    .int()
    .min(0)
    .max(SYNC_RECORD_LIMITS.inventorySteps - 1),
  chunkHash: sha256Schema,
  cursorDigest: sha256Schema,
};
/** Immutable digest-indexed record proving one truncated cursor's producing chunk. */
export const syncInventoryCursorWitnessSchema = z
  .object(inventoryCursorEvidenceShape)
  .strict();
/** Closed persisted state for one per-step exact-CAS witness dispatch journal. */
export const syncInventoryCursorJournalSchema = z.discriminatedUnion("state", [
  z
    .object({
      ...inventoryCursorEvidenceShape,
      state: z.literal("attempting"),
      claimId: inventoryClaimIdSchema,
    })
    .strict(),
  z
    .object({
      ...inventoryCursorEvidenceShape,
      state: z.literal("retry_wait"),
      claimId: inventoryClaimIdSchema,
      retryAfterEpochMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
]);
/** Validated compact head evidence carried by one inventory chunk. */
const headSummarySchema = z
  .object({
    pathKey: z
      .string()
      .refine((pathKey) => decodeSyncPathKey(pathKey) !== undefined),
    revision: syncRevisionSchema,
    kind: z.enum(["live", "tombstone"]),
  })
  .strict()
  .superRefine((summary, context) => {
    if (
      new TextEncoder().encode(JSON.stringify(summary)).byteLength >
      SYNC_RECORD_LIMITS.summaryBytes
    ) {
      context.addIssue({
        code: "custom",
        message: "Head summary exceeds its serialized byte limit.",
      });
    }
  });
/** One strict durable page replay record with exact output-cursor encoding. */
export const syncInventoryChunkSchema = z
  .object({
    ...envelopeShape,
    inventoryId: syncInventoryIdSchema,
    step: z
      .number()
      .int()
      .min(0)
      .max(SYNC_RECORD_LIMITS.inventorySteps - 1),
    previousChunkHash: sha256Schema.nullable(),
    inputCursorDigest: sha256Schema,
    outputCursorDigest: sha256Schema,
    outputCursor: z.string().nullable(),
    truncated: z.boolean(),
    transcript: z.string(),
    headSummary: headSummarySchema.nullable(),
  })
  .strict()
  .superRefine((chunk, context) => {
    if (chunk.truncated !== (chunk.outputCursor !== null)) {
      context.addIssue({
        code: "custom",
        message:
          "Truncated pages require a cursor; terminal pages require null.",
      });
    }
    if (
      new TextEncoder().encode(chunk.transcript).byteLength >
      SYNC_RECORD_LIMITS.chunkTranscriptBytes
    ) {
      context.addIssue({
        code: "custom",
        message: "Page transcript exceeds its serialized byte limit.",
      });
    }
    if (!isCanonicalTranscript(chunk.transcript)) {
      context.addIssue({
        code: "custom",
        message: "Page transcript must be compact canonical JSON.",
      });
    }
    if ((chunk.step === 0) !== (chunk.previousChunkHash === null)) {
      context.addIssue({
        code: "custom",
        message: "Only the initial chunk may omit a previous chunk hash.",
      });
    }
    if (
      chunk.outputCursor !== null &&
      !isBoundedEncodedCursor(chunk.outputCursor)
    ) {
      context.addIssue({
        code: "custom",
        message: "Chunk output cursor is invalid or exceeds its byte limit.",
      });
    }
    const envelope = {
      schemaVersion: chunk.schemaVersion,
      protocolMajor: chunk.protocolMajor,
      vaultId: chunk.vaultId,
      inventoryId: chunk.inventoryId,
      step: chunk.step,
      previousChunkHash: chunk.previousChunkHash,
      inputCursorDigest: chunk.inputCursorDigest,
      outputCursorDigest: chunk.outputCursorDigest,
      outputCursor: chunk.outputCursor,
      truncated: chunk.truncated,
    };
    if (
      new TextEncoder().encode(JSON.stringify(envelope)).byteLength >
      SYNC_RECORD_LIMITS.chunkEnvelopeBytes
    ) {
      context.addIssue({
        code: "custom",
        message: "Chunk metadata envelope exceeds its serialized byte limit.",
      });
    }
  });

/** Confirms a transcript uses compact JSON spelling without discarded duplicate fields.
 *
 * @param transcript - Serialized private R2 listing-page evidence.
 * @returns Whether compact JSON round-trips byte-for-byte.
 */
function isCanonicalTranscript(transcript: string): boolean {
  try {
    return JSON.stringify(JSON.parse(transcript)) === transcript;
  } catch {
    return false;
  }
}

/** Confirms canonical unpadded base64url and caps the decoded opaque cursor bytes.
 *
 * @param cursor - Encoded cursor from private persisted inventory state.
 * @returns Whether it decodes canonically within the raw cursor byte ceiling.
 */
function isBoundedEncodedCursor(cursor: string): boolean {
  const bytes = decodeBase64Url(cursor);
  return (
    bytes !== undefined &&
    bytes.byteLength <= SYNC_RECORD_LIMITS.cursorBytes &&
    decodeUtf8(bytes) !== undefined &&
    encodeBase64Url(bytes) === cursor
  );
}
