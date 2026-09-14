import {
  type ConditionalCurrentNoteRepository,
  type ConditionalMutationRequest,
  type ConditionalMutationResult,
  type ContentOperationReceipt,
  CURRENT_NOTE_STATE_KIND,
  type CurrentNoteState,
  MAX_NOTE_SIZE_BYTES,
  MUTATION_ACTION,
  MUTATION_EFFECT_CERTAINTY,
  type MutationAcknowledgement,
  type MutationEffectResult,
  type NotePath,
  type TombstoneOperationReceipt,
} from "@obsidian-ai-bridge/core";
import {
  type DecodedCurrentObject,
  decodeCurrentObject,
  encodeLiveCurrentObject,
  encodeTombstoneCurrentObject,
} from "@worker/infrastructure/current-object.codec";
import { VAULT_OBJECT_PREFIX } from "@worker/infrastructure/r2.constants";
import type {
  R2ConditionalBucketPort,
  R2ConditionalObjectMetadata,
} from "@worker/infrastructure/r2.types";
import { isExactR2Generation } from "@worker/infrastructure/r2-conditional-object";
import {
  BRIDGE_STORAGE_CONTENT_TYPE,
  BRIDGE_STORAGE_FORMAT_METADATA_KEY,
  BRIDGE_STORAGE_FORMAT_METADATA_VALUE,
  MAX_LIVE_CURRENT_OBJECT_BYTES,
  MAX_TOMBSTONE_CURRENT_OBJECT_BYTES,
  R2_ABSENCE_WILDCARD,
  R2_IF_NONE_MATCH_HEADER,
} from "@worker/infrastructure/storage-object.constants";
import {
  STORED_OBJECT_DATA_ERROR_KIND,
  StoredObjectDataError,
} from "@worker/infrastructure/storage-object.errors";
import {
  generateApplicationRevision,
  sha256Content,
} from "@worker/storage/storage-crypto";

/** Private evidence returned directly by the successful conditional R2 PUT. */
export interface StoredCurrentGeneration {
  /** Application acknowledgment derived from bytes sent in this PUT. */
  readonly acknowledgement: MutationAcknowledgement;
  /** Opaque validator for the actual stored generation, never an application revision. */
  readonly storageEtag: string;
  /** R2-assigned timestamp belonging to the actual stored generation. */
  readonly uploaded: Date;
}

/** Closed conditional result retaining private successful-generation metadata. */
export type StoredCurrentMutationResult =
  MutationEffectResult<StoredCurrentGeneration>;

interface ObservedCurrentObject {
  readonly decoded: DecodedCurrentObject;
  readonly storageEtag: string;
  readonly uploaded: Date;
}

/**
 * R2 adapter for private M3 current-object codecs and atomic conditional writes.
 *
 * Application revisions are validated from envelopes. They are never used as R2
 * validators; matching mutations CAS only the ETag from the exact observed object.
 */
export class R2ConditionalCurrentNoteRepository
  implements ConditionalCurrentNoteRepository
{
  /** @param bucket - Delete-free R2 capability admitting only conditional puts. */
  constructor(private readonly bucket: R2ConditionalBucketPort) {}

  /**
   * Classifies one exact private current-object key without leaking content or R2 metadata.
   *
   * @param path - Validated application note path.
   * @returns Explicit absent, legacy, live, or tombstone application state.
   * @throws {StoredObjectDataError} When tagged persisted data is malformed or unsupported.
   */
  async readCurrent(path: NotePath): Promise<CurrentNoteState> {
    const observed = await this.readObserved(path);
    if (observed === null) {
      return { kind: CURRENT_NOTE_STATE_KIND.absent, path };
    }

    switch (observed.decoded.kind) {
      case CURRENT_NOTE_STATE_KIND.legacy:
        return { kind: CURRENT_NOTE_STATE_KIND.legacy, path };
      case CURRENT_NOTE_STATE_KIND.live:
        return {
          kind: CURRENT_NOTE_STATE_KIND.live,
          path,
          revision: observed.decoded.revision,
          receipt: observed.decoded.receipt,
          contentSha256: observed.decoded.contentSha256,
        };
      case CURRENT_NOTE_STATE_KIND.tombstone:
        return {
          kind: CURRENT_NOTE_STATE_KIND.tombstone,
          path,
          revision: observed.decoded.revision,
          receipt: observed.decoded.receipt,
          deletedRevision: observed.decoded.deletedRevision,
          recoveryId: observed.decoded.recoveryId,
        };
    }
  }

  /**
   * Applies one conditional mutation and hides successful R2 generation metadata.
   *
   * @param request - Absence-only or exact application-revision mutation.
   * @returns Slice 1 effect certainty with the exact application acknowledgment.
   */
  async mutate(
    request: ConditionalMutationRequest,
  ): Promise<ConditionalMutationResult> {
    const result = await this.mutateStored(request);
    if (result.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      return result;
    }

    return {
      kind: MUTATION_EFFECT_CERTAINTY.confirmed,
      confirmed: result.confirmed.acknowledgement,
    };
  }

  /**
   * Applies one conditional mutation while retaining direct successful-PUT evidence.
   *
   * This private Worker boundary supports later recovery sealing without deriving
   * tombstone time from a request clock or unrelated HEAD.
   *
   * @param request - Exact application mutation to encode and conditionally store.
   * @returns Conservative effect certainty plus direct R2 metadata on confirmation.
   */
  async mutateStored(
    request: ConditionalMutationRequest,
  ): Promise<StoredCurrentMutationResult> {
    try {
      if (
        request.action !== MUTATION_ACTION.tombstone &&
        new TextEncoder().encode(request.content).byteLength >
          MAX_NOTE_SIZE_BYTES
      ) {
        return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
      }
      if (request.action === MUTATION_ACTION.create) {
        return await this.create(request);
      }

      const observed = await this.readObserved(request.path);
      if (!this.matchesMutationTarget(observed, request)) {
        return { kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused };
      }

      const candidate = await this.encodeMatchingCandidate(request);
      return await this.conditionalPut(
        request.path,
        candidate.encoded,
        { etagMatches: observed.storageEtag },
        candidate.acknowledgement,
        candidate.maximumBytes,
      );
    } catch (error) {
      if (error instanceof StoredObjectDataError) throw error;
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }
  }

  /**
   * Performs an absence-only create using an actual constructed Headers predicate.
   *
   * @param request - Validated create intent and exact Markdown content.
   * @returns Conservative storage effect and direct metadata on confirmation.
   */
  private async create(
    request: Extract<ConditionalMutationRequest, { action: "create" }>,
  ): Promise<StoredCurrentMutationResult> {
    const revision = generateApplicationRevision();
    const contentSha256 = await sha256Content(request.content);
    const receipt: ContentOperationReceipt = {
      action: request.action,
      associationId: request.associationId,
      operationId: request.operationId,
      precondition: request.precondition,
      contentSha256,
    };
    const acknowledgement = { path: request.path, revision, receipt };
    const encoded = encodeLiveCurrentObject({
      kind: CURRENT_NOTE_STATE_KIND.live,
      revision,
      receipt,
      contentSha256,
      content: request.content,
    });
    const onlyIf = new Headers();
    onlyIf.set(R2_IF_NONE_MATCH_HEADER, R2_ABSENCE_WILDCARD);

    return this.conditionalPut(
      request.path,
      encoded,
      onlyIf,
      acknowledgement,
      MAX_LIVE_CURRENT_OBJECT_BYTES,
    );
  }

  /**
   * Encodes a matching live update, tombstone recreation, or live tombstone.
   *
   * @param request - Matching-revision mutation already checked against observed state.
   * @returns Encoded candidate, application ACK, and representation byte bound.
   */
  private async encodeMatchingCandidate(
    request: Exclude<ConditionalMutationRequest, { action: "create" }>,
  ): Promise<{
    readonly encoded: string;
    readonly acknowledgement: MutationAcknowledgement;
    readonly maximumBytes: number;
  }> {
    const revision = generateApplicationRevision();
    if (request.action === MUTATION_ACTION.tombstone) {
      const receipt: TombstoneOperationReceipt = {
        action: request.action,
        associationId: request.associationId,
        operationId: request.operationId,
        precondition: request.precondition,
      };
      return {
        acknowledgement: { path: request.path, revision, receipt },
        encoded: encodeTombstoneCurrentObject({
          kind: CURRENT_NOTE_STATE_KIND.tombstone,
          revision,
          receipt,
          deletedRevision: request.precondition.revision,
          recoveryId: request.operationId,
        }),
        maximumBytes: MAX_TOMBSTONE_CURRENT_OBJECT_BYTES,
      };
    }

    const contentSha256 = await sha256Content(request.content);
    const receipt: ContentOperationReceipt = {
      action: request.action,
      associationId: request.associationId,
      operationId: request.operationId,
      precondition: request.precondition,
      contentSha256,
    };
    return {
      acknowledgement: { path: request.path, revision, receipt },
      encoded: encodeLiveCurrentObject({
        kind: CURRENT_NOTE_STATE_KIND.live,
        revision,
        receipt,
        contentSha256,
        content: request.content,
      }),
      maximumBytes: MAX_LIVE_CURRENT_OBJECT_BYTES,
    };
  }

  /**
   * Checks application state and revision before translating to the observed R2 ETag.
   *
   * @param observed - Exact decoded R2 generation, or absence.
   * @param request - Matching application mutation requirement.
   * @returns Whether this generation is the action's required state and revision.
   */
  private matchesMutationTarget(
    observed: ObservedCurrentObject | null,
    request: Exclude<ConditionalMutationRequest, { action: "create" }>,
  ): observed is ObservedCurrentObject {
    if (
      observed === null ||
      observed.decoded.kind === CURRENT_NOTE_STATE_KIND.legacy ||
      observed.decoded.revision !== request.precondition.revision
    ) {
      return false;
    }
    if (request.action === MUTATION_ACTION.recreate) {
      return observed.decoded.kind === CURRENT_NOTE_STATE_KIND.tombstone;
    }

    return observed.decoded.kind === CURRENT_NOTE_STATE_KIND.live;
  }

  /**
   * Reads and validates one exact R2 generation while retaining private CAS evidence.
   *
   * @param path - Validated path whose exact current key is read once.
   * @returns Absence or decoded content plus its private R2 validator/timestamp.
   */
  private async readObserved(
    path: NotePath,
  ): Promise<ObservedCurrentObject | null> {
    const key = this.objectKey(path);
    const object = await this.bucket.get(key);
    if (object === null) return null;
    if (!isExactR2Generation(object, key)) {
      throw new StoredObjectDataError(STORED_OBJECT_DATA_ERROR_KIND.malformed);
    }
    if (object.size > MAX_LIVE_CURRENT_OBJECT_BYTES) {
      throw new StoredObjectDataError(STORED_OBJECT_DATA_ERROR_KIND.tooLarge);
    }

    const bytes = new Uint8Array(await object.arrayBuffer());
    const decoded = await decodeCurrentObject(
      bytes,
      object.customMetadata?.[BRIDGE_STORAGE_FORMAT_METADATA_KEY],
    );
    return {
      decoded,
      storageEtag: object.etag,
      uploaded: object.uploaded,
    };
  }

  /**
   * Dispatches one R2 put and maps null/errors without claiming rollback.
   *
   * @param path - Validated application path used to derive the private key.
   * @param encoded - Exact candidate envelope bytes represented as text.
   * @param onlyIf - Atomic absence or observed-R2-ETag predicate.
   * @param acknowledgement - Application ACK for only this candidate generation.
   * @param maximumBytes - Representation-specific encoded byte bound.
   * @returns Conservative effect certainty and direct metadata on confirmation.
   */
  private async conditionalPut(
    path: NotePath,
    encoded: string,
    onlyIf: Headers | { readonly etagMatches: string },
    acknowledgement: MutationAcknowledgement,
    maximumBytes: number,
  ): Promise<StoredCurrentMutationResult> {
    if (new TextEncoder().encode(encoded).byteLength > maximumBytes) {
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }

    try {
      const stored: R2ConditionalObjectMetadata | null = await this.bucket.put(
        this.objectKey(path),
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
      if (!isExactR2Generation(stored, this.objectKey(path))) {
        return { kind: MUTATION_EFFECT_CERTAINTY.unknown };
      }

      return {
        kind: MUTATION_EFFECT_CERTAINTY.confirmed,
        confirmed: {
          acknowledgement,
          storageEtag: stored.etag,
          uploaded: stored.uploaded,
        },
      };
    } catch {
      return { kind: MUTATION_EFFECT_CERTAINTY.unknown };
    }
  }

  /**
   * Adds the adapter-private current-object namespace to a validated note path.
   *
   * @param path - Validated application note path.
   * @returns Exact private R2 key.
   */
  private objectKey(path: NotePath): string {
    return `${VAULT_OBJECT_PREFIX}${path}`;
  }
}
