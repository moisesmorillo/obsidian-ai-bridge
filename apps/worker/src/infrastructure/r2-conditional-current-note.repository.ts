import {
  type ConditionalCurrentNoteRepository,
  CURRENT_NOTE_STATE_KIND,
  type CurrentGenerationObservation,
  type CurrentGenerationObservationPage,
  type CurrentGenerationReplacement,
  type CurrentNoteState,
  isNormalizedNotePath,
  type LiveCurrentGenerationCandidate,
  MAX_MIRROR_PAGE_SIZE,
  MAX_NOTE_SIZE_BYTES,
  MUTATION_EFFECT_CERTAINTY,
  type MutationEffectResult,
  type NotePath,
  type StoredLiveCurrentGeneration,
  type StoredTombstoneCurrentGeneration,
  type TombstoneCurrentGenerationCandidate,
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
import { sha256Content } from "@worker/storage/storage-crypto";

interface ObservedCurrentObject {
  readonly decoded: DecodedCurrentObject;
  readonly storageEtag: string;
  readonly uploaded: Date;
}

/**
 * R2 adapter for private M3 current-object codecs and atomic conditional writes.
 *
 * It owns envelope validation and R2 predicates only. Application policy supplies
 * exact revisions, receipts, hashes, and allowed state transitions.
 */
export class R2ConditionalCurrentNoteRepository
  implements ConditionalCurrentNoteRepository
{
  /** @param bucket - Delete-free R2 capability admitting only conditional puts. */
  constructor(private readonly bucket: R2ConditionalBucketPort) {}

  /**
   * Reads one exact recognized generation with a private ETag-bound CAS capability.
   *
   * @param path - Validated application note path.
   * @returns Recognized absence/legacy/live/tombstone observation.
   * @throws {StoredObjectDataError} For malformed, oversized, or unsupported persisted data.
   */
  async read(path: NotePath): Promise<CurrentGenerationObservation> {
    const observed = await this.readObserved(path);
    if (observed === null) {
      return {
        kind: CURRENT_NOTE_STATE_KIND.absent,
        state: { kind: CURRENT_NOTE_STATE_KIND.absent, path },
      };
    }

    switch (observed.decoded.kind) {
      case CURRENT_NOTE_STATE_KIND.legacy:
        return {
          kind: CURRENT_NOTE_STATE_KIND.legacy,
          state: { kind: CURRENT_NOTE_STATE_KIND.legacy, path },
          content: observed.decoded.content,
        };
      case CURRENT_NOTE_STATE_KIND.live:
        return {
          kind: CURRENT_NOTE_STATE_KIND.live,
          state: this.liveState(path, observed.decoded),
          content: observed.decoded.content,
          uploaded: observed.uploaded,
          replacement: this.replacement(path, observed.storageEtag),
        };
      case CURRENT_NOTE_STATE_KIND.tombstone:
        return {
          kind: CURRENT_NOTE_STATE_KIND.tombstone,
          state: this.tombstoneState(path, observed.decoded),
          uploaded: observed.uploaded,
          replacement: this.replacement(path, observed.storageEtag),
        };
    }
  }

  /**
   * Writes one application-assembled live generation with create-only semantics.
   *
   * @param path - Validated note path whose current key must be absent.
   * @param candidate - Exact live envelope assembled by application policy.
   * @returns Exact successful generation metadata or conservative certainty.
   */
  async create(
    path: NotePath,
    candidate: LiveCurrentGenerationCandidate,
  ): Promise<MutationEffectResult<StoredLiveCurrentGeneration>> {
    const onlyIf = new Headers();
    onlyIf.set(R2_IF_NONE_MATCH_HEADER, R2_ABSENCE_WILDCARD);
    return this.writeLive(path, candidate, onlyIf);
  }

  /**
   * Lists one bounded storage page and validates each current object sequentially.
   *
   * @param cursor - Opaque R2 continuation cursor.
   * @returns Metadata states, including tombstones for application filtering.
   */
  async list(cursor?: string): Promise<CurrentGenerationObservationPage> {
    const page = await this.bucket.list({
      prefix: VAULT_OBJECT_PREFIX,
      ...(cursor === undefined ? {} : { cursor }),
      limit: MAX_MIRROR_PAGE_SIZE,
    });
    const states: CurrentNoteState[] = [];
    for (const object of page.objects) {
      if (!object.key.startsWith(VAULT_OBJECT_PREFIX)) continue;
      const rawPath = object.key.slice(VAULT_OBJECT_PREFIX.length);
      if (!isNormalizedNotePath(rawPath)) continue;
      const observed = await this.read(rawPath);
      if (observed.state.kind !== CURRENT_NOTE_STATE_KIND.absent) {
        states.push(observed.state);
      }
    }
    return {
      states,
      nextCursor: page.truncated ? page.cursor : null,
    };
  }

  /**
   * Creates an ETag-bound capability that cannot be refreshed by its caller.
   *
   * @param path - Exact application path bound to the observed key.
   * @param storageEtag - Private validator from that exact observation.
   * @returns Replacement capability permanently bound to the observed generation.
   */
  private replacement(
    path: NotePath,
    storageEtag: string,
  ): CurrentGenerationReplacement {
    const onlyIf = { etagMatches: storageEtag };
    return {
      writeLive: (candidate) => this.writeLive(path, candidate, onlyIf),
      writeTombstone: (candidate) =>
        this.writeTombstone(path, candidate, onlyIf),
    };
  }

  /**
   * Encodes and CAS-writes one application-assembled live candidate.
   *
   * @param path - Exact application path for the private current key.
   * @param candidate - Application-assembled live envelope.
   * @param onlyIf - Atomic absence or observed-generation predicate.
   * @returns Exact stored live metadata or conservative effect certainty.
   */
  private async writeLive(
    path: NotePath,
    candidate: LiveCurrentGenerationCandidate,
    onlyIf: Headers | { readonly etagMatches: string },
  ): Promise<MutationEffectResult<StoredLiveCurrentGeneration>> {
    try {
      if (
        new TextEncoder().encode(candidate.content).byteLength >
          MAX_NOTE_SIZE_BYTES ||
        (await sha256Content(candidate.content)) !== candidate.contentSha256
      ) {
        return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
      }
      const encoded = encodeLiveCurrentObject(candidate);
      return await this.conditionalPut(
        path,
        encoded,
        onlyIf,
        MAX_LIVE_CURRENT_OBJECT_BYTES,
        (uploaded) => ({
          state: this.liveState(path, candidate),
          uploaded,
        }),
      );
    } catch {
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }
  }

  /**
   * Encodes and CAS-writes one application-assembled tombstone candidate.
   *
   * @param path - Exact application path for the private current key.
   * @param candidate - Application-assembled content-free tombstone.
   * @param onlyIf - Predicate bound to the observed live generation.
   * @returns Exact stored tombstone metadata or conservative effect certainty.
   */
  private async writeTombstone(
    path: NotePath,
    candidate: TombstoneCurrentGenerationCandidate,
    onlyIf: { readonly etagMatches: string },
  ): Promise<MutationEffectResult<StoredTombstoneCurrentGeneration>> {
    try {
      const encoded = encodeTombstoneCurrentObject(candidate);
      return await this.conditionalPut(
        path,
        encoded,
        onlyIf,
        MAX_TOMBSTONE_CURRENT_OBJECT_BYTES,
        (uploaded) => ({
          state: this.tombstoneState(path, candidate),
          uploaded,
        }),
      );
    } catch {
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }
  }

  /**
   * Reads and validates one exact R2 generation while retaining private CAS evidence.
   *
   * @param path - Validated application path used to derive the private key.
   * @returns Validated object plus private storage metadata, or exact absence.
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

    const decoded = await decodeCurrentObject(
      new Uint8Array(await object.arrayBuffer()),
      object.customMetadata?.[BRIDGE_STORAGE_FORMAT_METADATA_KEY],
    );
    return {
      decoded,
      storageEtag: object.etag,
      uploaded: object.uploaded,
    };
  }

  /**
   * Dispatches one conditional R2 write and returns only its exact metadata.
   *
   * @param path - Validated application path for the private key.
   * @param encoded - Exact encoded envelope body.
   * @param onlyIf - Atomic R2 predicate.
   * @param maximumBytes - Representation-specific encoded byte limit.
   * @param storedGeneration - Converts exact successful PUT metadata to application state.
   * @returns Conservative effect certainty and exact generation metadata on confirmation.
   */
  private async conditionalPut<Stored>(
    path: NotePath,
    encoded: string,
    onlyIf: Headers | { readonly etagMatches: string },
    maximumBytes: number,
    storedGeneration: (uploaded: Date) => Stored,
  ): Promise<MutationEffectResult<Stored>> {
    if (new TextEncoder().encode(encoded).byteLength > maximumBytes) {
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }

    try {
      const key = this.objectKey(path);
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
        confirmed: storedGeneration(stored.uploaded),
      };
    } catch {
      return { kind: MUTATION_EFFECT_CERTAINTY.unknown };
    }
  }

  /**
   * Converts a decoded/candidate live envelope to metadata-only application state.
   *
   * @param path - Validated application path.
   * @param object - Decoded or newly assembled live envelope.
   * @returns Metadata-only live state with exact persisted receipt.
   */
  private liveState(
    path: NotePath,
    object: LiveCurrentGenerationCandidate,
  ): StoredLiveCurrentGeneration["state"] {
    return {
      kind: CURRENT_NOTE_STATE_KIND.live,
      path,
      revision: object.revision,
      receipt: object.receipt,
      contentSha256: object.contentSha256,
    };
  }

  /**
   * Converts a decoded/candidate tombstone envelope to metadata-only application state.
   *
   * @param path - Validated application path.
   * @param object - Decoded or newly assembled tombstone envelope.
   * @returns Metadata-only tombstone state with exact persisted receipt.
   */
  private tombstoneState(
    path: NotePath,
    object: TombstoneCurrentGenerationCandidate,
  ): StoredTombstoneCurrentGeneration["state"] {
    return {
      kind: CURRENT_NOTE_STATE_KIND.tombstone,
      path,
      revision: object.revision,
      receipt: object.receipt,
      deletedRevision: object.deletedRevision,
      recoveryId: object.recoveryId,
    };
  }

  /**
   * Adds the adapter-private current-object namespace to a validated path.
   *
   * @param path - Validated application path.
   * @returns Exact private R2 key.
   */
  private objectKey(path: NotePath): string {
    return `${VAULT_OBJECT_PREFIX}${path}`;
  }
}
