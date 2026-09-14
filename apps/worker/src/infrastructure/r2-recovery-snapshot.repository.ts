import {
  createRecoverySnapshotId,
  MAX_MIRROR_PAGE_SIZE,
  MAX_NOTE_SIZE_BYTES,
  MUTATION_EFFECT_CERTAINTY,
  type MutationEffectResult,
  type ObservedPreparedRecoveryGeneration,
  type ObservedPurgedRecoveryGeneration,
  type ObservedSealedRecoveryGeneration,
  type PreparedRecoveryGenerationCandidate,
  type PurgedRecoveryGenerationCandidate,
  RECOVERY_SNAPSHOT_STATE_KIND,
  type RecoveryGenerationObservation,
  type RecoveryGenerationObservationPage,
  type RecoveryGenerationReplacement,
  type RecoverySnapshotId,
  type RecoverySnapshotRepository,
  type RecoverySnapshotState,
  type SealedRecoveryGenerationCandidate,
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
import { sha256Content } from "@worker/storage/storage-crypto";

interface ObservedRecoveryObject {
  readonly decoded: DecodedRecoveryObject;
  readonly storageEtag: string;
  readonly uploaded: Date;
}

/**
 * R2 adapter for create-only recovery preparation and exact lifecycle CAS.
 *
 * Application policy supplies revisions, retention decisions, and transition
 * candidates. This adapter owns only codecs, private keys, and R2 predicates.
 */
export class R2RecoverySnapshotRepository
  implements RecoverySnapshotRepository
{
  /** @param bucket - Delete-free R2 capability admitting only conditional puts. */
  constructor(private readonly bucket: R2ConditionalBucketPort) {}

  /**
   * Reads exact validated recovery data with an opaque generation-bound CAS capability.
   *
   * @param id - Deletion-operation-derived recovery identity.
   * @returns Validated recovery observation, or `null` only for exact absence.
   * @throws {StoredObjectDataError} For malformed, unsupported, or oversized data.
   */
  async read(
    id: RecoverySnapshotId,
  ): Promise<RecoveryGenerationObservation | null> {
    const observed = await this.readObserved(id);
    if (observed === null) return null;
    return this.toObservation(observed.decoded, observed.storageEtag);
  }

  /**
   * Writes one application-assembled prepared generation with create-only semantics.
   *
   * @param candidate - Exact prepared recovery envelope.
   * @returns Exact prepared observation on confirmation or conservative certainty.
   */
  async create(
    candidate: PreparedRecoveryGenerationCandidate,
  ): Promise<MutationEffectResult<ObservedPreparedRecoveryGeneration>> {
    try {
      if (
        candidate.id !== candidate.operationId ||
        new TextEncoder().encode(candidate.content).byteLength >
          MAX_NOTE_SIZE_BYTES ||
        (await sha256Content(candidate.content)) !== candidate.contentSha256
      ) {
        return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
      }
      const onlyIf = new Headers();
      onlyIf.set(R2_IF_NONE_MATCH_HEADER, R2_ABSENCE_WILDCARD);
      return await this.conditionalPut(
        candidate.id,
        encodePreparedRecoveryObject(candidate),
        onlyIf,
        (storageEtag) => ({
          kind: RECOVERY_SNAPSHOT_STATE_KIND.prepared,
          state: this.toState(candidate),
          content: candidate.content,
          replacement: this.replacement(candidate.id, storageEtag),
        }),
      );
    } catch {
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }
  }

  /**
   * Lists one bounded page and fails closed on malformed recovery identities or data.
   *
   * @param cursor - Opaque R2 continuation cursor.
   * @returns Metadata-only recovery states and optional continuation.
   */
  async list(cursor?: string): Promise<RecoveryGenerationObservationPage> {
    const page = await this.bucket.list({
      prefix: RECOVERY_OBJECT_PREFIX,
      ...(cursor === undefined ? {} : { cursor }),
      limit: MAX_MIRROR_PAGE_SIZE,
    });
    const states: RecoverySnapshotState[] = [];
    for (const object of page.objects) {
      if (!object.key.startsWith(RECOVERY_OBJECT_PREFIX)) {
        throw new StoredObjectDataError(
          STORED_OBJECT_DATA_ERROR_KIND.malformed,
        );
      }
      const id = createRecoverySnapshotId(
        object.key.slice(RECOVERY_OBJECT_PREFIX.length),
      );
      if (id === undefined) {
        throw new StoredObjectDataError(
          STORED_OBJECT_DATA_ERROR_KIND.malformed,
        );
      }
      const observed = await this.read(id);
      if (observed !== null) states.push(observed.state);
    }
    return { states, nextCursor: page.truncated ? page.cursor : null };
  }

  /**
   * Creates a recovery CAS capability bound permanently to one observed R2 ETag.
   *
   * @param id - Recovery identity bound to the private key.
   * @param storageEtag - Private validator from the exact observed generation.
   * @returns Seal/purge capability that cannot refresh its predicate.
   */
  private replacement(
    id: RecoverySnapshotId,
    storageEtag: string,
  ): RecoveryGenerationReplacement {
    const onlyIf = { etagMatches: storageEtag };
    return {
      seal: (candidate) => this.writeSealed(id, candidate, onlyIf),
      purge: (candidate) => this.writePurged(id, candidate, onlyIf),
    };
  }

  /**
   * Encodes and CAS-writes one sealed recovery generation.
   *
   * @param id - Recovery identity bound to the observed key.
   * @param candidate - Application-approved sealed envelope.
   * @param onlyIf - Exact observed-generation predicate.
   * @returns Exact sealed observation or conservative effect certainty.
   */
  private async writeSealed(
    id: RecoverySnapshotId,
    candidate: SealedRecoveryGenerationCandidate,
    onlyIf: { readonly etagMatches: string },
  ): Promise<MutationEffectResult<ObservedSealedRecoveryGeneration>> {
    try {
      if (
        candidate.id !== id ||
        new TextEncoder().encode(candidate.content).byteLength >
          MAX_NOTE_SIZE_BYTES ||
        (await sha256Content(candidate.content)) !== candidate.contentSha256
      ) {
        return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
      }
      return await this.conditionalPut(
        id,
        encodeSealedRecoveryObject(candidate),
        onlyIf,
        (storageEtag) => ({
          kind: RECOVERY_SNAPSHOT_STATE_KIND.sealed,
          state: this.toState(candidate),
          content: candidate.content,
          operationId: candidate.operationId,
          previousRevision: candidate.previousRevision,
          tombstoneRevision: candidate.tombstoneRevision,
          replacement: this.replacement(id, storageEtag),
        }),
      );
    } catch {
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }
  }

  /**
   * Encodes and CAS-writes one content-free purged recovery marker.
   *
   * @param id - Recovery identity bound to the observed key.
   * @param candidate - Application-approved purged marker.
   * @param onlyIf - Exact observed-generation predicate.
   * @returns Exact purged observation or conservative effect certainty.
   */
  private async writePurged(
    id: RecoverySnapshotId,
    candidate: PurgedRecoveryGenerationCandidate,
    onlyIf: { readonly etagMatches: string },
  ): Promise<MutationEffectResult<ObservedPurgedRecoveryGeneration>> {
    try {
      if (candidate.id !== id) {
        return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
      }
      return await this.conditionalPut(
        id,
        encodePurgedRecoveryObject(candidate),
        onlyIf,
        (storageEtag) => ({
          kind: RECOVERY_SNAPSHOT_STATE_KIND.purged,
          state: this.toState(candidate),
          operationId: candidate.operationId,
          previousRevision: candidate.previousRevision,
          tombstoneRevision: candidate.tombstoneRevision,
          replacement: this.replacement(id, storageEtag),
        }),
      );
    } catch {
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }
  }

  /**
   * Reads one exact recovery generation and retains only private storage metadata.
   *
   * @param id - Recovery identity used to derive the exact private key.
   * @returns Validated envelope plus private CAS metadata, or exact absence.
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
   * Dispatches one conditional write and preserves uncertainty after any binding throw.
   *
   * @param id - Recovery identity for the private key.
   * @param encoded - Exact encoded recovery envelope.
   * @param onlyIf - Atomic absence or observed-generation predicate.
   * @param observation - Converts exact successful PUT metadata to an observation.
   * @returns Conservative certainty and exact observation on confirmation.
   */
  private async conditionalPut<Observed>(
    id: RecoverySnapshotId,
    encoded: string,
    onlyIf: Headers | { readonly etagMatches: string },
    observation: (storageEtag: string) => Observed,
  ): Promise<MutationEffectResult<Observed>> {
    if (
      new TextEncoder().encode(encoded).byteLength > MAX_RECOVERY_OBJECT_BYTES
    ) {
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }

    try {
      const key = this.objectKey(id);
      const stored: R2ConditionalObjectMetadata | null = await this.bucket.put(
        key,
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
      if (!isExactR2Generation(stored, key)) {
        return { kind: MUTATION_EFFECT_CERTAINTY.unknown };
      }
      return {
        kind: MUTATION_EFFECT_CERTAINTY.confirmed,
        confirmed: observation(stored.etag),
      };
    } catch {
      return { kind: MUTATION_EFFECT_CERTAINTY.unknown };
    }
  }

  /**
   * Converts a decoded generation into an application observation.
   *
   * @param decoded - Strictly validated private recovery envelope.
   * @param storageEtag - Validator for exactly that stored generation.
   * @returns Recovery data with a generation-bound CAS capability.
   */
  private toObservation(
    decoded: DecodedRecoveryObject,
    storageEtag: string,
  ): RecoveryGenerationObservation {
    const replacement = this.replacement(decoded.id, storageEtag);
    switch (decoded.kind) {
      case RECOVERY_SNAPSHOT_STATE_KIND.prepared:
        return {
          kind: RECOVERY_SNAPSHOT_STATE_KIND.prepared,
          state: this.toState(decoded),
          content: decoded.content,
          replacement,
        };
      case RECOVERY_SNAPSHOT_STATE_KIND.sealed:
        return {
          kind: RECOVERY_SNAPSHOT_STATE_KIND.sealed,
          state: this.toState(decoded),
          content: decoded.content,
          operationId: decoded.operationId,
          previousRevision: decoded.previousRevision,
          tombstoneRevision: decoded.tombstoneRevision,
          replacement,
        };
      case RECOVERY_SNAPSHOT_STATE_KIND.purged:
        return {
          kind: RECOVERY_SNAPSHOT_STATE_KIND.purged,
          state: this.toState(decoded),
          operationId: decoded.operationId,
          previousRevision: decoded.previousRevision,
          tombstoneRevision: decoded.tombstoneRevision,
          replacement,
        };
    }
  }

  /** Removes storage-only transition evidence and plaintext from recovery metadata. */
  private toState(
    decoded:
      | Extract<DecodedRecoveryObject, { readonly kind: "prepared" }>
      | PreparedRecoveryGenerationCandidate,
  ): Extract<RecoverySnapshotState, { readonly kind: "prepared" }>;
  private toState(
    decoded:
      | Extract<DecodedRecoveryObject, { readonly kind: "sealed" }>
      | SealedRecoveryGenerationCandidate,
  ): Extract<RecoverySnapshotState, { readonly kind: "sealed" }>;
  private toState(
    decoded:
      | Extract<DecodedRecoveryObject, { readonly kind: "purged" }>
      | PurgedRecoveryGenerationCandidate,
  ): Extract<RecoverySnapshotState, { readonly kind: "purged" }>;
  private toState(
    decoded:
      | DecodedRecoveryObject
      | PreparedRecoveryGenerationCandidate
      | SealedRecoveryGenerationCandidate
      | PurgedRecoveryGenerationCandidate,
  ): RecoverySnapshotState {
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
   * @param id - Validated deletion-operation-derived identity.
   * @returns Exact private R2 recovery key.
   */
  private objectKey(id: RecoverySnapshotId): string {
    return `${RECOVERY_OBJECT_PREFIX}${id}`;
  }
}
