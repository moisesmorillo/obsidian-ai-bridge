import {
  type ApplicationRevision,
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  type ContentOperationReceipt,
  type ContentSha256,
  type CreateOperationReceipt,
  CURRENT_NOTE_STATE_KIND,
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createRecoverySnapshotId,
  MAX_NOTE_SIZE_BYTES,
  MUTATION_ACTION,
  type RecoverySnapshotId,
  type TombstoneOperationReceipt,
  type UpdateOperationReceipt,
} from "@obsidian-ai-bridge/core";
import { encodeValidatedStorageObject } from "@worker/infrastructure/storage-object.codec";
import {
  BRIDGE_STORAGE_FORMAT,
  BRIDGE_STORAGE_FORMAT_METADATA_VALUE,
  MAX_LIVE_CURRENT_OBJECT_BYTES,
  MAX_TOMBSTONE_CURRENT_OBJECT_BYTES,
} from "@worker/infrastructure/storage-object.constants";
import {
  STORED_OBJECT_DATA_ERROR_KIND,
  StoredObjectDataError,
} from "@worker/infrastructure/storage-object.errors";
import { sha256Content } from "@worker/storage/storage-crypto";
import { z } from "zod";

/** Decoded untagged Markdown retained for M1 compatibility. */
export interface DecodedLegacyCurrentObject {
  readonly kind: typeof CURRENT_NOTE_STATE_KIND.legacy;
  readonly content: string;
}

/** Decoded validated content-bearing M3 current generation. */
export interface DecodedLiveCurrentObject {
  readonly kind: typeof CURRENT_NOTE_STATE_KIND.live;
  readonly revision: ApplicationRevision;
  readonly receipt: ContentOperationReceipt;
  readonly contentSha256: ContentSha256;
  readonly content: string;
}

/** Decoded validated M3 tombstone generation with no note content. */
export interface DecodedTombstoneCurrentObject {
  readonly kind: typeof CURRENT_NOTE_STATE_KIND.tombstone;
  readonly revision: ApplicationRevision;
  readonly receipt: TombstoneOperationReceipt;
  readonly deletedRevision: ApplicationRevision;
  readonly recoveryId: RecoverySnapshotId;
}

/** Closed current-object representations recognized by private Worker storage. */
export type DecodedCurrentObject =
  | DecodedLegacyCurrentObject
  | DecodedLiveCurrentObject
  | DecodedTombstoneCurrentObject;

/** Validates one canonical application revision read from private storage. */
const applicationRevisionSchema = z.custom<ApplicationRevision>(
  (value) =>
    typeof value === "string" && createApplicationRevision(value) !== undefined,
);
/** Validates the association bound into one persisted mutation receipt. */
const associationIdSchema = z.custom<CreateOperationReceipt["associationId"]>(
  (value) =>
    typeof value === "string" && createMirrorAssociationId(value) !== undefined,
);
/** Validates the idempotency identity retained by a persisted receipt. */
const operationIdSchema = z.custom<CreateOperationReceipt["operationId"]>(
  (value) =>
    typeof value === "string" && createMirrorOperationId(value) !== undefined,
);
/** Validates the recovery identity referenced by a persisted tombstone. */
const recoveryIdSchema = z.custom<RecoverySnapshotId>(
  (value) =>
    typeof value === "string" && createRecoverySnapshotId(value) !== undefined,
);
/** Validates the canonical digest retained with persisted live content. */
const contentSha256Schema = z.custom<ContentSha256>(
  (value) =>
    typeof value === "string" && createContentSha256(value) !== undefined,
);
/** Persisted precondition proving an absence-only creation intent. */
const absentPreconditionSchema = z
  .object({
    kind: z.literal(CONDITIONAL_MUTATION_PRECONDITION_KIND.absent),
  })
  .strict();
/** Persisted precondition binding a mutation to one parent revision. */
const matchingPreconditionSchema = z
  .object({
    kind: z.literal(CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision),
    revision: applicationRevisionSchema,
  })
  .strict();
/** Persisted receipt for one confirmed absence-only creation. */
const createReceiptSchema: z.ZodType<CreateOperationReceipt> = z
  .object({
    action: z.literal(MUTATION_ACTION.create),
    associationId: associationIdSchema,
    operationId: operationIdSchema,
    precondition: absentPreconditionSchema,
    contentSha256: contentSha256Schema,
  })
  .strict();
/** Persisted receipt for one confirmed update or tombstone recreation. */
const updateReceiptSchema: z.ZodType<UpdateOperationReceipt> = z
  .object({
    action: z.union([
      z.literal(MUTATION_ACTION.update),
      z.literal(MUTATION_ACTION.recreate),
    ]),
    associationId: associationIdSchema,
    operationId: operationIdSchema,
    precondition: matchingPreconditionSchema,
    contentSha256: contentSha256Schema,
  })
  .strict();
/** Persisted receipt for one confirmed recovery-first tombstone. */
const tombstoneReceiptSchema: z.ZodType<TombstoneOperationReceipt> = z
  .object({
    action: z.literal(MUTATION_ACTION.tombstone),
    associationId: associationIdSchema,
    operationId: operationIdSchema,
    precondition: matchingPreconditionSchema,
  })
  .strict();
/** Persisted live envelope, including receipt/hash agreement and fresh-parent invariants. */
const liveObjectSchema: z.ZodType<DecodedLiveCurrentObject & { format: 2 }> = z
  .object({
    format: z.literal(BRIDGE_STORAGE_FORMAT),
    kind: z.literal(CURRENT_NOTE_STATE_KIND.live),
    revision: applicationRevisionSchema,
    receipt: z.union([createReceiptSchema, updateReceiptSchema]),
    contentSha256: contentSha256Schema,
    content: z.string(),
  })
  .strict()
  .superRefine((object, context) => {
    if (object.receipt.contentSha256 !== object.contentSha256) {
      context.addIssue({
        code: "custom",
        message: "Stored live hashes must agree.",
        path: ["contentSha256"],
      });
    }
    if (
      object.receipt.precondition.kind ===
        CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision &&
      object.receipt.precondition.revision === object.revision
    ) {
      context.addIssue({
        code: "custom",
        message: "Stored live revision must be fresh.",
        path: ["revision"],
      });
    }
  });
/** Persisted tombstone envelope binding deletion, recovery, and receipt identities. */
const tombstoneObjectSchema: z.ZodType<
  DecodedTombstoneCurrentObject & { format: 2 }
> = z
  .object({
    format: z.literal(BRIDGE_STORAGE_FORMAT),
    kind: z.literal(CURRENT_NOTE_STATE_KIND.tombstone),
    revision: applicationRevisionSchema,
    receipt: tombstoneReceiptSchema,
    deletedRevision: applicationRevisionSchema,
    recoveryId: recoveryIdSchema,
  })
  .strict()
  .superRefine((object, context) => {
    if (
      object.revision === object.deletedRevision ||
      object.receipt.precondition.revision !== object.deletedRevision ||
      object.recoveryId !== object.receipt.operationId
    ) {
      context.addIssue({
        code: "custom",
        message: "Stored tombstone generation is inconsistent.",
      });
    }
  });
/** Closed set of tagged current-object representations accepted from storage. */
const recognizedCurrentObjectSchema = z.union([
  liveObjectSchema,
  tombstoneObjectSchema,
]);
/** Strict decoder that prevents malformed persisted bytes from becoming text. */
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Decodes an exact current-object body according to its explicit R2 format tag.
 *
 * @param bytes - Actual stored bytes, already bounded by the repository adapter.
 * @param taggedFormat - Value of private `bridgeFormat` custom metadata, if present.
 * @returns Legacy Markdown or one validated recognized M3 generation.
 * @throws {StoredObjectDataError} For unsupported tags, invalid UTF-8/schema, or hash mismatch.
 */
export async function decodeCurrentObject(
  bytes: Uint8Array,
  taggedFormat: string | undefined,
): Promise<DecodedCurrentObject> {
  if (
    taggedFormat !== undefined &&
    taggedFormat !== BRIDGE_STORAGE_FORMAT_METADATA_VALUE
  ) {
    throw new StoredObjectDataError(
      STORED_OBJECT_DATA_ERROR_KIND.unsupportedFormat,
    );
  }

  const text = decodeStoredUtf8(bytes);
  if (taggedFormat === undefined) {
    if (bytes.byteLength > MAX_NOTE_SIZE_BYTES) {
      throw new StoredObjectDataError(STORED_OBJECT_DATA_ERROR_KIND.tooLarge);
    }
    return { kind: CURRENT_NOTE_STATE_KIND.legacy, content: text };
  }

  const parsed = parseRecognizedCurrentObject(text);
  if (parsed.kind === CURRENT_NOTE_STATE_KIND.tombstone) {
    if (bytes.byteLength > MAX_TOMBSTONE_CURRENT_OBJECT_BYTES) {
      throw new StoredObjectDataError(STORED_OBJECT_DATA_ERROR_KIND.tooLarge);
    }
    return omitFormat(parsed);
  }
  if (bytes.byteLength > MAX_LIVE_CURRENT_OBJECT_BYTES) {
    throw new StoredObjectDataError(STORED_OBJECT_DATA_ERROR_KIND.tooLarge);
  }
  if (
    new TextEncoder().encode(parsed.content).byteLength > MAX_NOTE_SIZE_BYTES
  ) {
    throw new StoredObjectDataError(STORED_OBJECT_DATA_ERROR_KIND.tooLarge);
  }
  if ((await sha256Content(parsed.content)) !== parsed.contentSha256) {
    throw new StoredObjectDataError(
      STORED_OBJECT_DATA_ERROR_KIND.contentHashMismatch,
    );
  }

  return omitFormat(parsed);
}

/**
 * Serializes one type-safe live current generation in canonical private format 2.
 *
 * @param object - Exact live generation and Markdown content to persist.
 * @returns JSON bytes represented as text for R2 PUT.
 * @throws {Error} When the candidate violates the strict live-object schema.
 */
export function encodeLiveCurrentObject(
  object: DecodedLiveCurrentObject,
): string {
  return encodeValidatedStorageObject(liveObjectSchema, {
    format: BRIDGE_STORAGE_FORMAT,
    kind: object.kind,
    revision: object.revision,
    receipt: object.receipt,
    contentSha256: object.contentSha256,
    content: object.content,
  });
}

/**
 * Serializes one type-safe content-free current tombstone in private format 2.
 *
 * @param object - Exact tombstone generation to persist.
 * @returns JSON bytes represented as text for R2 PUT.
 * @throws {Error} When the candidate violates the strict tombstone schema.
 */
export function encodeTombstoneCurrentObject(
  object: DecodedTombstoneCurrentObject,
): string {
  return encodeValidatedStorageObject(tombstoneObjectSchema, {
    format: BRIDGE_STORAGE_FORMAT,
    kind: object.kind,
    revision: object.revision,
    receipt: object.receipt,
    deletedRevision: object.deletedRevision,
    recoveryId: object.recoveryId,
  });
}

/**
 * Decodes persisted bytes as strict UTF-8 without leaking malformed content.
 *
 * @param bytes - Exact persisted bytes.
 * @returns Decoded text when every byte is valid UTF-8.
 */
function decodeStoredUtf8(bytes: Uint8Array): string {
  try {
    return strictUtf8Decoder.decode(bytes);
  } catch {
    throw new StoredObjectDataError(STORED_OBJECT_DATA_ERROR_KIND.malformed);
  }
}

/**
 * Parses and strictly validates one tagged current-object JSON envelope.
 *
 * @param text - Strictly decoded JSON text.
 * @returns A validated storage envelope retaining its format discriminator.
 */
function parseRecognizedCurrentObject(
  text: string,
): (DecodedLiveCurrentObject | DecodedTombstoneCurrentObject) & { format: 2 } {
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    throw new StoredObjectDataError(STORED_OBJECT_DATA_ERROR_KIND.malformed);
  }

  const result = recognizedCurrentObjectSchema.safeParse(candidate);
  if (!result.success) {
    throw new StoredObjectDataError(STORED_OBJECT_DATA_ERROR_KIND.malformed);
  }
  return result.data;
}

/**
 * Removes the storage-only format discriminator after strict validation.
 *
 * @param object - Validated current-object envelope.
 * @returns The private decoded generation used by the R2 adapter.
 */
function omitFormat(
  object: (DecodedLiveCurrentObject | DecodedTombstoneCurrentObject) & {
    format: 2;
  },
): DecodedLiveCurrentObject | DecodedTombstoneCurrentObject {
  if (object.kind === CURRENT_NOTE_STATE_KIND.live) {
    return {
      kind: object.kind,
      revision: object.revision,
      receipt: object.receipt,
      contentSha256: object.contentSha256,
      content: object.content,
    };
  }

  return {
    kind: object.kind,
    revision: object.revision,
    receipt: object.receipt,
    deletedRevision: object.deletedRevision,
    recoveryId: object.recoveryId,
  };
}
