import {
  type ApplicationRevision,
  type ContentSha256,
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createRecoverySnapshotId,
  isNormalizedNotePath,
  MAX_NOTE_SIZE_BYTES,
  type MirrorAssociationId,
  type MirrorOperationId,
  type NotePath,
  RECOVERY_SNAPSHOT_STATE_KIND,
  type RecoverySnapshotId,
} from "@obsidian-ai-bridge/core";
import { encodeValidatedStorageObject } from "@worker/infrastructure/storage-object.codec";
import {
  BRIDGE_STORAGE_FORMAT,
  MAX_RECOVERY_OBJECT_BYTES,
} from "@worker/infrastructure/storage-object.constants";
import {
  STORED_OBJECT_DATA_ERROR_KIND,
  StoredObjectDataError,
} from "@worker/infrastructure/storage-object.errors";
import { sha256Content } from "@worker/storage/storage-crypto";
import { z } from "zod";

/** Fields retained by every private recovery-object generation. */
interface DecodedRecoveryObjectBase {
  readonly id: RecoverySnapshotId;
  readonly associationId: MirrorAssociationId;
  readonly path: NotePath;
  readonly revision: ApplicationRevision;
  readonly sourceRevision: ApplicationRevision;
  readonly contentSha256: ContentSha256;
  readonly operationId: MirrorOperationId;
}

/** Prepared recovery material written create-only before a current tombstone. */
export interface DecodedPreparedRecoveryObject
  extends DecodedRecoveryObjectBase {
  readonly kind: typeof RECOVERY_SNAPSHOT_STATE_KIND.prepared;
  /** Exact recoverable note text retained remotely. */
  readonly content: string;
}

/** Sealed recovery material retaining content and tombstone-derived deadline proof. */
export interface DecodedSealedRecoveryObject extends DecodedRecoveryObjectBase {
  readonly kind: typeof RECOVERY_SNAPSHOT_STATE_KIND.sealed;
  readonly previousRevision: ApplicationRevision;
  readonly tombstoneRevision: ApplicationRevision;
  readonly recoverUntil: string;
  /** Exact recoverable note text retained until a conditional purge. */
  readonly content: string;
}

/** Content-free marker that prevents delayed preparation from recreating purged text. */
export interface DecodedPurgedRecoveryObject extends DecodedRecoveryObjectBase {
  readonly kind: typeof RECOVERY_SNAPSHOT_STATE_KIND.purged;
  readonly previousRevision: ApplicationRevision;
  readonly tombstoneRevision: ApplicationRevision;
  readonly recoverUntil: string;
}

/** Closed private storage representation for recovery lifecycle generations. */
export type DecodedRecoveryObject =
  | DecodedPreparedRecoveryObject
  | DecodedSealedRecoveryObject
  | DecodedPurgedRecoveryObject;

/** Validates one canonical application revision read from recovery storage. */
const applicationRevisionSchema = z.custom<ApplicationRevision>(
  (value) =>
    typeof value === "string" && createApplicationRevision(value) !== undefined,
);
/** Validates the association owning one persisted recovery generation. */
const associationIdSchema = z.custom<MirrorAssociationId>(
  (value) =>
    typeof value === "string" && createMirrorAssociationId(value) !== undefined,
);
/** Validates the deletion operation retained by one recovery generation. */
const operationIdSchema = z.custom<MirrorOperationId>(
  (value) =>
    typeof value === "string" && createMirrorOperationId(value) !== undefined,
);
/** Validates the identity of one persisted recovery lifecycle. */
const recoveryIdSchema = z.custom<RecoverySnapshotId>(
  (value) =>
    typeof value === "string" && createRecoverySnapshotId(value) !== undefined,
);
/** Validates the canonical note path represented by recovery metadata. */
const notePathSchema = z.custom<NotePath>(
  (value) => typeof value === "string" && isNormalizedNotePath(value),
);
/** Validates the canonical digest of retained or formerly retained content. */
const contentSha256Schema = z.custom<ContentSha256>(
  (value) =>
    typeof value === "string" && createContentSha256(value) !== undefined,
);
/** Persisted identity/source fields shared by every recovery lifecycle generation. */
const recoveryBaseShape = {
  format: z.literal(BRIDGE_STORAGE_FORMAT),
  id: recoveryIdSchema,
  associationId: associationIdSchema,
  path: notePathSchema,
  revision: applicationRevisionSchema,
  sourceRevision: applicationRevisionSchema,
  contentSha256: contentSha256Schema,
  operationId: operationIdSchema,
};
/** Prepared persisted snapshot whose identity equals its deletion operation. */
const preparedRecoverySchema: z.ZodType<
  DecodedPreparedRecoveryObject & { format: 2 }
> = z
  .object({
    ...recoveryBaseShape,
    kind: z.literal(RECOVERY_SNAPSHOT_STATE_KIND.prepared),
    content: z.string(),
  })
  .strict()
  .superRefine((object, context) => {
    if (
      object.id !== object.operationId ||
      object.revision === object.sourceRevision
    ) {
      context.addIssue({
        code: "custom",
        message: "Prepared recovery identity or revision is inconsistent.",
      });
    }
  });
/** Persisted proof fields shared by sealed content and purged markers. */
const transitionedRecoveryShape = {
  ...recoveryBaseShape,
  previousRevision: applicationRevisionSchema,
  tombstoneRevision: applicationRevisionSchema,
  recoverUntil: z.iso.datetime({ offset: true }),
};
/** Sealed persisted snapshot with immutable tombstone-derived recovery deadline. */
const sealedRecoverySchema: z.ZodType<
  DecodedSealedRecoveryObject & { format: 2 }
> = z
  .object({
    ...transitionedRecoveryShape,
    kind: z.literal(RECOVERY_SNAPSHOT_STATE_KIND.sealed),
    content: z.string(),
  })
  .strict()
  .superRefine(validateTransitionedRecovery);
/** Content-free persisted marker retaining the completed recovery transition proof. */
const purgedRecoverySchema: z.ZodType<
  DecodedPurgedRecoveryObject & { format: 2 }
> = z
  .object({
    ...transitionedRecoveryShape,
    kind: z.literal(RECOVERY_SNAPSHOT_STATE_KIND.purged),
  })
  .strict()
  .superRefine(validateTransitionedRecovery);
/** Closed set of recovery object representations accepted from private storage. */
const recoveryObjectSchema = z.union([
  preparedRecoverySchema,
  sealedRecoverySchema,
  purgedRecoverySchema,
]);
/** Strict decoder that prevents malformed recovery bytes from becoming text. */
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Decodes and strictly validates one tagged recovery object.
 *
 * @param bytes - Actual persisted recovery-envelope bytes.
 * @returns A prepared/sealed content snapshot or content-free purged marker.
 * @throws {StoredObjectDataError} For invalid UTF-8/schema, bounds, or content digest.
 */
export async function decodeRecoveryObject(
  bytes: Uint8Array,
): Promise<DecodedRecoveryObject> {
  if (bytes.byteLength > MAX_RECOVERY_OBJECT_BYTES) {
    throw new StoredObjectDataError(STORED_OBJECT_DATA_ERROR_KIND.tooLarge);
  }

  const parsed = parseRecoveryObject(decodeStoredUtf8(bytes));
  if (parsed.kind === RECOVERY_SNAPSHOT_STATE_KIND.purged) {
    return omitFormat(parsed);
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
 * Serializes prepared recovery content in strict private format 2.
 *
 * @param object - Validated prepared generation with exact source text.
 * @returns JSON text for a create-only R2 PUT.
 * @throws {Error} When the candidate violates the strict prepared schema.
 */
export function encodePreparedRecoveryObject(
  object: DecodedPreparedRecoveryObject,
): string {
  return encodeValidatedStorageObject(preparedRecoverySchema, {
    format: BRIDGE_STORAGE_FORMAT,
    kind: object.kind,
    id: object.id,
    associationId: object.associationId,
    path: object.path,
    revision: object.revision,
    sourceRevision: object.sourceRevision,
    contentSha256: object.contentSha256,
    operationId: object.operationId,
    content: object.content,
  });
}

/**
 * Serializes sealed recovery content and immutable tombstone proof.
 *
 * @param object - Validated sealed generation retaining recoverable text.
 * @returns JSON text for an exact R2 CAS.
 * @throws {Error} When the candidate violates the strict sealed schema.
 */
export function encodeSealedRecoveryObject(
  object: DecodedSealedRecoveryObject,
): string {
  return encodeValidatedStorageObject(sealedRecoverySchema, {
    format: BRIDGE_STORAGE_FORMAT,
    kind: object.kind,
    id: object.id,
    associationId: object.associationId,
    path: object.path,
    revision: object.revision,
    sourceRevision: object.sourceRevision,
    contentSha256: object.contentSha256,
    operationId: object.operationId,
    previousRevision: object.previousRevision,
    tombstoneRevision: object.tombstoneRevision,
    recoverUntil: object.recoverUntil,
    content: object.content,
  });
}

/**
 * Serializes a purged marker whose type cannot represent note plaintext.
 *
 * @param object - Validated content-free purged generation.
 * @returns JSON text for an exact R2 CAS.
 * @throws {Error} When the candidate violates the strict purged schema.
 */
export function encodePurgedRecoveryObject(
  object: DecodedPurgedRecoveryObject,
): string {
  return encodeValidatedStorageObject(purgedRecoverySchema, {
    format: BRIDGE_STORAGE_FORMAT,
    kind: object.kind,
    id: object.id,
    associationId: object.associationId,
    path: object.path,
    revision: object.revision,
    sourceRevision: object.sourceRevision,
    contentSha256: object.contentSha256,
    operationId: object.operationId,
    previousRevision: object.previousRevision,
    tombstoneRevision: object.tombstoneRevision,
    recoverUntil: object.recoverUntil,
  });
}

/**
 * Validates freshness invariants shared by sealed and purged transitions.
 *
 * @param object - Candidate transitioned recovery generation.
 * @param context - Zod refinement context receiving invariant failures.
 * @returns Nothing; failures are added to the supplied context.
 */
function validateTransitionedRecovery(
  object: (DecodedSealedRecoveryObject | DecodedPurgedRecoveryObject) & {
    format: 2;
  },
  context: z.RefinementCtx,
): void {
  if (
    object.revision === object.sourceRevision ||
    object.revision === object.previousRevision ||
    object.revision === object.tombstoneRevision ||
    object.tombstoneRevision === object.sourceRevision
  ) {
    context.addIssue({
      code: "custom",
      message: "Recovery transition revision must be fresh.",
    });
  }
}

/**
 * Decodes strict UTF-8 without including recovery bytes in failures.
 *
 * @param bytes - Exact persisted recovery bytes.
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
 * Parses one recovery JSON envelope with exact closed fields.
 *
 * @param text - Strictly decoded recovery JSON text.
 * @returns A validated recovery envelope retaining its format discriminator.
 */
function parseRecoveryObject(
  text: string,
): DecodedRecoveryObject & { format: 2 } {
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    throw new StoredObjectDataError(STORED_OBJECT_DATA_ERROR_KIND.malformed);
  }

  const result = recoveryObjectSchema.safeParse(candidate);
  if (!result.success) {
    throw new StoredObjectDataError(STORED_OBJECT_DATA_ERROR_KIND.malformed);
  }
  return result.data;
}

/**
 * Removes the storage-only format discriminator after strict validation.
 *
 * @param object - Validated recovery storage envelope.
 * @returns The private decoded recovery generation used by the R2 adapter.
 */
function omitFormat(
  object: DecodedRecoveryObject & { format: 2 },
): DecodedRecoveryObject {
  const base = {
    id: object.id,
    associationId: object.associationId,
    path: object.path,
    revision: object.revision,
    sourceRevision: object.sourceRevision,
    contentSha256: object.contentSha256,
    operationId: object.operationId,
  };
  switch (object.kind) {
    case RECOVERY_SNAPSHOT_STATE_KIND.prepared:
      return { ...base, kind: object.kind, content: object.content };
    case RECOVERY_SNAPSHOT_STATE_KIND.sealed:
      return {
        ...base,
        kind: object.kind,
        previousRevision: object.previousRevision,
        tombstoneRevision: object.tombstoneRevision,
        recoverUntil: object.recoverUntil,
        content: object.content,
      };
    case RECOVERY_SNAPSHOT_STATE_KIND.purged:
      return {
        ...base,
        kind: object.kind,
        previousRevision: object.previousRevision,
        tombstoneRevision: object.tombstoneRevision,
        recoverUntil: object.recoverUntil,
      };
  }
}
