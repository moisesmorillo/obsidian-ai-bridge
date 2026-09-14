import {
  MAX_NOTE_SIZE_BYTES,
  MUTATION_EFFECT_CERTAINTY,
  type MutationEffectResult,
  RECOVERY_SNAPSHOT_STATE_KIND,
  type RecoveryMutationResult,
  type RecoveryPreparationRequest,
  type RecoveryPurgeRequest,
  type RecoverySealRequest,
  type RecoverySnapshotId,
  type RecoverySnapshotRepository,
  type RecoverySnapshotState,
} from "@obsidian-ai-bridge/core";
import type {
  R2ConditionalBucketPort,
  R2ConditionalObjectMetadata,
} from "@worker/infrastructure/r2.types";
import { isExactR2Generation } from "@worker/infrastructure/r2-conditional-object";
import {
  type DecodedRecoveryObject,
  decodeRecoveryObject,
  encodePreparedRecoveryObject,
  encodePurgedRecoveryObject,
  encodeSealedRecoveryObject,
} from "@worker/infrastructure/recovery-object.codec";
import {
  BRIDGE_STORAGE_CONTENT_TYPE,
  BRIDGE_STORAGE_FORMAT_METADATA_KEY,
  BRIDGE_STORAGE_FORMAT_METADATA_VALUE,
  MAX_RECOVERY_OBJECT_BYTES,
  R2_ABSENCE_WILDCARD,
  R2_IF_NONE_MATCH_HEADER,
  RECOVERY_OBJECT_PREFIX,
} from "@worker/infrastructure/storage-object.constants";
import {
  STORED_OBJECT_DATA_ERROR_KIND,
  StoredObjectDataError,
} from "@worker/infrastructure/storage-object.errors";
import {
  generateApplicationRevision,
  sha256Content,
} from "@worker/storage/storage-crypto";

/** Private metadata returned by the exact successful recovery-object PUT. */
export interface StoredRecoveryGeneration {
  /** Validated application recovery state derived from bytes written by this PUT. */
  readonly state: RecoverySnapshotState;
  /** Opaque R2 validator retained only for storage-level evidence. */
  readonly storageEtag: string;
  /** R2-assigned upload time for this exact successful generation. */
  readonly uploaded: Date;
}

/** Closed recovery mutation result retaining private successful-PUT evidence. */
export type StoredRecoveryMutationResult =
  MutationEffectResult<StoredRecoveryGeneration>;

interface ObservedRecoveryObject {
  readonly decoded: DecodedRecoveryObject;
  readonly storageEtag: string;
  readonly uploaded: Date;
}

/**
 * R2 adapter for create-only recovery preparation and exact lifecycle CAS.
 *
 * Purge replaces a sealed generation with a marker and never uses native delete.
 * Retention eligibility is deliberately owned by later application orchestration.
 */
export class R2RecoverySnapshotRepository
  implements RecoverySnapshotRepository
{
  /** @param bucket - Delete-free R2 capability admitting only conditional puts. */
  constructor(private readonly bucket: R2ConditionalBucketPort) {}

  /**
   * Reads validated metadata for one recovery identity.
   *
   * @param id - Deletion-operation-derived recovery identity.
   * @returns Metadata state, or `null` only when the exact key is absent.
   * @throws {StoredObjectDataError} When persisted recovery data is malformed or unsupported.
   */
  async read(id: RecoverySnapshotId): Promise<RecoverySnapshotState | null> {
    const observed = await this.readObserved(id);
    return observed === null ? null : this.toState(observed.decoded);
  }

  /**
   * Creates recovery material only when its exact key is absent.
   *
   * @param request - Exact source-generation snapshot and content.
   * @returns Core effect certainty with metadata state on confirmation.
   */
  async prepare(
    request: RecoveryPreparationRequest,
  ): Promise<RecoveryMutationResult> {
    return this.toApplicationResult(await this.prepareStored(request));
  }

  /**
   * Replaces only the supplied prepared recovery generation with sealed content.
   *
   * @param request - Exact prepared revision and tombstone-derived evidence.
   * @returns Core effect certainty with sealed metadata on confirmation.
   */
  async seal(request: RecoverySealRequest): Promise<RecoveryMutationResult> {
    return this.toApplicationResult(await this.sealStored(request));
  }

  /**
   * Replaces only the supplied sealed generation with a content-free marker.
   *
   * @param request - Exact sealed revision selected by application retention policy.
   * @returns Core effect certainty with purged metadata on confirmation.
   */
  async purge(request: RecoveryPurgeRequest): Promise<RecoveryMutationResult> {
    return this.toApplicationResult(await this.purgeStored(request));
  }

  /**
   * Prepares recovery content while retaining metadata from the actual successful PUT.
   *
   * @param request - Exact source-generation snapshot and content.
   * @returns Conservative effect certainty and direct stored metadata on confirmation.
   */
  async prepareStored(
    request: RecoveryPreparationRequest,
  ): Promise<StoredRecoveryMutationResult> {
    try {
      if (
        request.id !== request.operationId ||
        new TextEncoder().encode(request.content).byteLength >
          MAX_NOTE_SIZE_BYTES ||
        (await sha256Content(request.content)) !== request.contentSha256
      ) {
        return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
      }

      const decoded = {
        kind: RECOVERY_SNAPSHOT_STATE_KIND.prepared,
        id: request.id,
        associationId: request.associationId,
        path: request.path,
        revision: generateApplicationRevision(),
        sourceRevision: request.sourceRevision,
        contentSha256: request.contentSha256,
        operationId: request.operationId,
        content: request.content,
      } as const;
      const onlyIf = new Headers();
      onlyIf.set(R2_IF_NONE_MATCH_HEADER, R2_ABSENCE_WILDCARD);
      return await this.conditionalPut(
        request.id,
        encodePreparedRecoveryObject(decoded),
        onlyIf,
        this.toState(decoded),
      );
    } catch (error) {
      if (error instanceof StoredObjectDataError) throw error;
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }
  }

  /**
   * Conditionally seals prepared content while retaining direct successful-PUT metadata.
   *
   * @param request - Exact prepared revision and proven tombstone deadline evidence.
   * @returns Conservative effect certainty and direct stored metadata on confirmation.
   */
  async sealStored(
    request: RecoverySealRequest,
  ): Promise<StoredRecoveryMutationResult> {
    try {
      const observed = await this.readObserved(request.id);
      if (
        observed === null ||
        observed.decoded.kind !== RECOVERY_SNAPSHOT_STATE_KIND.prepared ||
        observed.decoded.revision !== request.expectedRevision ||
        observed.decoded.associationId !== request.associationId
      ) {
        return { kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused };
      }

      const decoded = {
        ...observed.decoded,
        kind: RECOVERY_SNAPSHOT_STATE_KIND.sealed,
        revision: generateApplicationRevision(),
        operationId: request.operationId,
        previousRevision: observed.decoded.revision,
        tombstoneRevision: request.tombstoneRevision,
        recoverUntil: request.recoverUntil,
      } as const;
      return await this.conditionalPut(
        request.id,
        encodeSealedRecoveryObject(decoded),
        { etagMatches: observed.storageEtag },
        this.toState(decoded),
      );
    } catch (error) {
      if (error instanceof StoredObjectDataError) throw error;
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }
  }

  /**
   * Conditionally purges sealed content without implementing retention-time policy.
   *
   * @param request - Exact sealed revision already approved by application policy.
   * @returns Conservative effect certainty and direct marker metadata on confirmation.
   */
  async purgeStored(
    request: RecoveryPurgeRequest,
  ): Promise<StoredRecoveryMutationResult> {
    try {
      const observed = await this.readObserved(request.id);
      if (
        observed === null ||
        observed.decoded.kind !== RECOVERY_SNAPSHOT_STATE_KIND.sealed ||
        observed.decoded.revision !== request.expectedRevision ||
        observed.decoded.associationId !== request.associationId
      ) {
        return { kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused };
      }

      const decoded = {
        kind: RECOVERY_SNAPSHOT_STATE_KIND.purged,
        id: observed.decoded.id,
        associationId: observed.decoded.associationId,
        path: observed.decoded.path,
        revision: generateApplicationRevision(),
        sourceRevision: observed.decoded.sourceRevision,
        contentSha256: observed.decoded.contentSha256,
        operationId: request.operationId,
        previousRevision: observed.decoded.revision,
        tombstoneRevision: observed.decoded.tombstoneRevision,
        recoverUntil: observed.decoded.recoverUntil,
      } as const;
      return await this.conditionalPut(
        request.id,
        encodePurgedRecoveryObject(decoded),
        { etagMatches: observed.storageEtag },
        this.toState(decoded),
      );
    } catch (error) {
      if (error instanceof StoredObjectDataError) throw error;
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }
  }

  /**
   * Reads one exact recovery generation and retains only private CAS evidence.
   *
   * @param id - Recovery identity used to derive the exact private key.
   * @returns Absence or decoded storage generation plus R2 validator/timestamp.
   */
  private async readObserved(
    id: RecoverySnapshotId,
  ): Promise<ObservedRecoveryObject | null> {
    const key = this.objectKey(id);
    const object = await this.bucket.get(key);
    if (object === null) return null;
    if (!isExactR2Generation(object, key)) {
      throw new StoredObjectDataError(STORED_OBJECT_DATA_ERROR_KIND.malformed);
    }
    const taggedFormat =
      object.customMetadata?.[BRIDGE_STORAGE_FORMAT_METADATA_KEY];
    if (taggedFormat === undefined) {
      throw new StoredObjectDataError(STORED_OBJECT_DATA_ERROR_KIND.malformed);
    }
    if (taggedFormat !== BRIDGE_STORAGE_FORMAT_METADATA_VALUE) {
      throw new StoredObjectDataError(
        STORED_OBJECT_DATA_ERROR_KIND.unsupportedFormat,
      );
    }
    if (object.size > MAX_RECOVERY_OBJECT_BYTES) {
      throw new StoredObjectDataError(STORED_OBJECT_DATA_ERROR_KIND.tooLarge);
    }

    const decoded = await decodeRecoveryObject(
      new Uint8Array(await object.arrayBuffer()),
    );
    if (decoded.id !== id) {
      throw new StoredObjectDataError(STORED_OBJECT_DATA_ERROR_KIND.malformed);
    }

    return {
      decoded,
      storageEtag: object.etag,
      uploaded: object.uploaded,
    };
  }

  /**
   * Dispatches one recovery PUT and preserves uncertainty after any binding throw.
   *
   * @param id - Recovery identity used to derive the exact private key.
   * @param encoded - Exact candidate recovery envelope represented as text.
   * @param onlyIf - Atomic absence or observed-R2-ETag predicate.
   * @param state - Core metadata belonging only to this candidate generation.
   * @returns Conservative effect certainty and direct metadata on confirmation.
   */
  private async conditionalPut(
    id: RecoverySnapshotId,
    encoded: string,
    onlyIf: Headers | { readonly etagMatches: string },
    state: RecoverySnapshotState,
  ): Promise<StoredRecoveryMutationResult> {
    if (
      new TextEncoder().encode(encoded).byteLength > MAX_RECOVERY_OBJECT_BYTES
    ) {
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }

    try {
      const stored: R2ConditionalObjectMetadata | null = await this.bucket.put(
        this.objectKey(id),
        encoded,
        {
          onlyIf,
          customMetadata: {
            [BRIDGE_STORAGE_FORMAT_METADATA_KEY]:
              BRIDGE_STORAGE_FORMAT_METADATA_VALUE,
          },
          httpMetadata: { contentType: BRIDGE_STORAGE_CONTENT_TYPE },
        },
      );
      if (stored === null) {
        return { kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused };
      }
      if (!isExactR2Generation(stored, this.objectKey(id))) {
        return { kind: MUTATION_EFFECT_CERTAINTY.unknown };
      }

      return {
        kind: MUTATION_EFFECT_CERTAINTY.confirmed,
        confirmed: {
          state,
          storageEtag: stored.etag,
          uploaded: stored.uploaded,
        },
      };
    } catch {
      return { kind: MUTATION_EFFECT_CERTAINTY.unknown };
    }
  }

  /**
   * Removes private successful-generation metadata at the core repository boundary.
   *
   * @param result - Internal result retaining R2 generation evidence.
   * @returns Slice 1 recovery effect result without infrastructure metadata.
   */
  private toApplicationResult(
    result: StoredRecoveryMutationResult,
  ): RecoveryMutationResult {
    if (result.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      return result;
    }

    return {
      kind: MUTATION_EFFECT_CERTAINTY.confirmed,
      confirmed: result.confirmed.state,
    };
  }

  /**
   * Converts a private storage object to core metadata state without note content.
   *
   * @param decoded - Validated private recovery generation.
   * @returns Corresponding content-free core recovery state.
   */
  private toState(decoded: DecodedRecoveryObject): RecoverySnapshotState {
    const state = {
      id: decoded.id,
      associationId: decoded.associationId,
      path: decoded.path,
      revision: decoded.revision,
      sourceRevision: decoded.sourceRevision,
      contentSha256: decoded.contentSha256,
    };
    switch (decoded.kind) {
      case RECOVERY_SNAPSHOT_STATE_KIND.prepared:
        return { ...state, kind: decoded.kind };
      case RECOVERY_SNAPSHOT_STATE_KIND.sealed:
      case RECOVERY_SNAPSHOT_STATE_KIND.purged:
        return {
          ...state,
          kind: decoded.kind,
          recoverUntil: decoded.recoverUntil,
        };
    }
  }

  /**
   * Builds the adapter-private recovery key from its validated identity.
   *
   * @param id - Validated recovery snapshot identity.
   * @returns Exact private R2 recovery key.
   */
  private objectKey(id: RecoverySnapshotId): string {
    return `${RECOVERY_OBJECT_PREFIX}${id}`;
  }
}
