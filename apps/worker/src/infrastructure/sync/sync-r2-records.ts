import {
  syncContentKey,
  syncHeadKey,
  syncRecoveryKey,
  syncVaultMarkerKey,
  syncVersionKey,
} from "@protocol/sync.codec";
import { syncVaultMarkerSchema } from "@protocol/sync.schemas";
import type {
  SyncNotePathDto,
  SyncOperationIdDto,
  SyncRevisionDto,
  SyncVaultIdDto,
} from "@protocol/sync.types";
import type {
  SyncR2Key,
  SyncR2ObjectStore,
  SyncR2RetryContext,
  SyncR2WriteResult,
  SyncRecordObservation,
  SyncRecordRead,
} from "@worker/infrastructure/sync/sync-r2.types";
import { createSyncR2Key } from "@worker/infrastructure/sync/sync-r2-key";
import {
  decodeSyncRecord,
  encodeSyncRecord,
} from "@worker/infrastructure/sync/sync-record.codec";
import { SYNC_RECORD_LIMITS } from "@worker/infrastructure/sync/sync-record.schemas";
import type {
  SyncBodyRecord,
  SyncDecodedRecord,
  SyncHeadRecord,
  SyncRecoveryMetadata,
  SyncVersionMetadata,
} from "@worker/infrastructure/sync/sync-record.types";

/** Exact validation outcome for the namespace marker prerequisite. */
type SyncMarkerEvidence =
  | { readonly kind: "valid" }
  | { readonly kind: "refused" }
  | { readonly kind: "unavailable" };

/** One-record current, version, content, and recovery access within a validated sync-v1 vault. */
export interface SyncR2Records {
  /** Reads one current head only after validating the matching namespace marker. */
  readHead(
    vaultId: SyncVaultIdDto,
    path: SyncNotePathDto,
  ): Promise<SyncRecordRead<SyncHeadRecord>>;
  /** Creates a current head after marker validation using create-only R2 semantics.
   * @param retryContext Prior cross-isolate cooldown evidence, when resuming a write.
   */
  createHead(
    record: SyncHeadRecord,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult>;
  /** Replaces only the exact observed head generation after marker validation. */
  replaceHead(
    observed: SyncRecordObservation<SyncHeadRecord>,
    record: SyncHeadRecord,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult>;
  /** Reads live metadata with its body, or tombstone metadata with exact parent recovery evidence. */
  readVersion(
    vaultId: SyncVaultIdDto,
    revision: SyncRevisionDto,
  ): Promise<SyncRecordRead<SyncVersionMetadata>>;
  /** Creates immutable live metadata from its body or tombstone metadata from parent recovery.
   * @param retryContext Prior cross-isolate cooldown evidence, when resuming a write.
   */
  createVersion(
    record: SyncVersionMetadata,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult>;
  /** Reads a live version's exact content only after its metadata and body verify. */
  readContent(
    vaultId: SyncVaultIdDto,
    revision: SyncRevisionDto,
  ): Promise<
    SyncRecordRead<Extract<SyncBodyRecord, { readonly kind: "contentBody" }>>
  >;
  /** Creates one exact immutable content-body object. */
  createContent(
    record: Extract<SyncBodyRecord, { readonly kind: "contentBody" }>,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult>;
  /** Reads recovery metadata only when its exact recovery body verifies against it. */
  readRecovery(
    vaultId: SyncVaultIdDto,
    operationId: SyncOperationIdDto,
  ): Promise<SyncRecordRead<SyncRecoveryMetadata>>;
  /** Creates recovery metadata only when its body already matches.
   * @param retryContext Prior cross-isolate cooldown evidence, when resuming a write.
   */
  createRecovery(
    record: SyncRecoveryMetadata,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult>;
  /** Creates one exact immutable recovery-body object. */
  createRecoveryBody(
    record: Extract<SyncBodyRecord, { readonly kind: "recoveryBody" }>,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult>;
}

/** Composes strict record validation with single-key R2 evidence, never sequencing a mutation.
 * @param objects Conditional one-key adapter for the isolated sync namespace.
 * @returns Marker-gated current, version, content, and recovery record operations.
 */
export function syncR2Records(objects: SyncR2ObjectStore): SyncR2Records {
  /** Confirms exact marker validity separately from known refusal and unavailable reads.
   * @param vaultId Validated immutable vault namespace.
   * @returns Whether the marker validates, is definitely invalid/absent, or cannot be read.
   */
  async function validateMarker(
    vaultId: SyncVaultIdDto,
  ): Promise<SyncMarkerEvidence> {
    const key = createSyncR2Key(syncVaultMarkerKey(vaultId), vaultId);
    if (key === undefined) return { kind: "refused" };
    const result = await objects.read(key, 2_048);
    if (result.kind === "absent") return { kind: "refused" };
    if (result.kind === "unavailable") return { kind: "unavailable" };
    try {
      const decoded = await decodeSyncRecord(
        "vaultMarker",
        key,
        result.observation.bytes,
        vaultId,
      );
      return decoded.kind === "vaultMarker" &&
        decoded.vaultId === vaultId &&
        syncVaultMarkerSchema.safeParse({
          schemaVersion: decoded.schemaVersion,
          protocolMajor: decoded.protocolMajor,
          vaultId: decoded.vaultId,
        }).success
        ? { kind: "valid" }
        : { kind: "refused" };
    } catch {
      return { kind: "refused" };
    }
  }

  /** Reads and strictly decodes one key, preserving exact generation evidence on success.
   * @param kind Strict persisted record family expected at the key.
   * @param key Canonical M7.1 key under the supplied vault.
   * @param vaultId Validated namespace identity used by the codec.
   * @param project Extracts the record variant expected by this read operation.
   * @returns Missing, unavailable, or strictly decoded generation evidence.
   */
  async function readRecord<T>(
    kind: SyncDecodedRecord["kind"],
    key: SyncR2Key,
    vaultId: SyncVaultIdDto,
    project: (decoded: SyncDecodedRecord) => T | undefined,
  ): Promise<SyncRecordRead<T>> {
    const raw = await objects.read(key, maxBytes(kind));
    if (raw.kind === "absent") return { kind: "absent" };
    if (raw.kind === "unavailable") return { kind: "unavailable" };
    try {
      const decoded = await decodeSyncRecord(
        kind,
        key,
        raw.observation.bytes,
        vaultId,
      );
      const value = project(decoded);
      if (value === undefined) return { kind: "unavailable" };
      return {
        kind: "observed",
        observation: { value, observed: raw.observation },
      };
    } catch {
      return { kind: "unavailable" };
    }
  }

  /** Resolves a key only when its protocol builder reproduces an allowed vault key.
   * @param value Candidate full R2 key.
   * @param vaultId Vault namespace the key must belong to.
   * @returns Branded canonical key, or undefined when it fails reconstruction.
   */
  function keyFor(
    value: string,
    vaultId: SyncVaultIdDto,
  ): SyncR2Key | undefined {
    return createSyncR2Key(value, vaultId);
  }

  /** Reads a strict live version with its body or a tombstone with exact parent recovery.
   * @param vaultId Immutable vault identity owning the linked evidence.
   * @param revision Exact immutable version revision encoded into its metadata key.
   * @returns Metadata only after its own live body or operation-bound recovery verifies.
   */
  async function readVerifiedVersion(
    vaultId: SyncVaultIdDto,
    revision: SyncRevisionDto,
  ): Promise<SyncRecordRead<SyncVersionMetadata>> {
    if ((await validateMarker(vaultId)).kind !== "valid")
      return { kind: "unavailable" };
    const key = keyFor(syncVersionKey(vaultId, revision), vaultId);
    if (key === undefined) return { kind: "unavailable" };
    const metadata = await readRecord("version", key, vaultId, (decoded) =>
      decoded.kind === "version" ? decoded.record : undefined,
    );
    if (metadata.kind === "absent") {
      const orphanBody = await readBody(
        "contentBody",
        syncContentKey(vaultId, revision),
        vaultId,
      );
      return orphanBody.kind === "absent"
        ? { kind: "absent" }
        : { kind: "unavailable" };
    }
    if (metadata.kind !== "observed") return metadata;
    if (metadata.observation.value.kind === "tombstone") {
      const recovery = await readVerifiedRecovery(
        vaultId,
        metadata.observation.value.operationId,
      );
      return recovery.kind === "observed" &&
        recoveryMatchesTombstone(
          metadata.observation.value,
          recovery.observation.value,
        )
        ? metadata
        : { kind: "unavailable" };
    }
    const body = await readBody(
      "contentBody",
      syncContentKey(vaultId, revision),
      vaultId,
    );
    if (body.kind !== "observed") return { kind: "unavailable" };
    return bodyMatches(metadata.observation.value, body.observation.value)
      ? metadata
      : { kind: "unavailable" };
  }

  /** Reads strict recovery metadata and the exact raw body it declares.
   * @param vaultId Immutable vault identity owning both objects.
   * @param operationId Exact tombstone operation encoded into both recovery keys.
   * @returns Metadata only after raw body size and SHA-256 match; incomplete evidence is unavailable.
   */
  async function readVerifiedRecovery(
    vaultId: SyncVaultIdDto,
    operationId: SyncOperationIdDto,
  ): Promise<SyncRecordRead<SyncRecoveryMetadata>> {
    if ((await validateMarker(vaultId)).kind !== "valid")
      return { kind: "unavailable" };
    const key = keyFor(
      syncRecoveryKey(vaultId, operationId, "metadata"),
      vaultId,
    );
    if (key === undefined) return { kind: "unavailable" };
    const metadata = await readRecord(
      "recoveryMetadata",
      key,
      vaultId,
      (decoded) =>
        decoded.kind === "recoveryMetadata" ? decoded.record : undefined,
    );
    if (metadata.kind === "absent") {
      const orphanBody = await readBody(
        "recoveryBody",
        syncRecoveryKey(vaultId, operationId, "content"),
        vaultId,
      );
      return orphanBody.kind === "absent"
        ? { kind: "absent" }
        : { kind: "unavailable" };
    }
    if (metadata.kind !== "observed") return metadata;
    const body = await readBody(
      "recoveryBody",
      syncRecoveryKey(vaultId, operationId, "content"),
      vaultId,
    );
    if (body.kind !== "observed") return { kind: "unavailable" };
    return bodyMatches(metadata.observation.value, body.observation.value)
      ? metadata
      : { kind: "unavailable" };
  }

  /** Reads and validates raw body identity, bytes, UTF-8 and computed digest evidence.
   * @param kind Content or recovery body family expected at the key.
   * @param keyValue Exact key rebuilt from the M7.1 key codec.
   * @param vaultId Vault identity required in the key and decoded record.
   * @returns Decoded exact body evidence, verified absence, or unavailable.
   */
  async function readBody(
    kind: "contentBody" | "recoveryBody",
    keyValue: string,
    vaultId: SyncVaultIdDto,
  ): Promise<SyncRecordRead<SyncBodyRecord>> {
    const key = keyFor(keyValue, vaultId);
    if (key === undefined) return { kind: "unavailable" };
    return readRecord(kind, key, vaultId, (decoded) => {
      if (decoded.kind !== kind) return undefined;
      return decoded.record;
    });
  }

  /** Validates marker, record encoding, and canonical key before one create-only write.
   * @param record Strict decoded record to encode without mutation sequencing.
   * @param keyValue Exact M7.1 key produced for the record identity.
   * @param retryContext Caller-carried cooldown floor from a prior uncertain/throttled attempt.
   * @returns Conditional-write certainty from the one-key R2 primitive.
   */
  async function createRecord(
    record: SyncDecodedRecord,
    keyValue: string,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult> {
    const marker = await validateMarker(recordVaultId(record));
    if (marker.kind === "refused") return { kind: "refused" };
    if (marker.kind === "unavailable") return { kind: "effect_unknown" };
    const key = keyFor(keyValue, recordVaultId(record));
    if (key === undefined) return { kind: "effect_unknown" };
    let bytes: Uint8Array;
    try {
      bytes = await encodeSyncRecord(record);
    } catch {
      return { kind: "refused" };
    }
    try {
      return await objects.create(key, bytes, retryContext);
    } catch {
      return { kind: "effect_unknown" };
    }
  }

  /** Validates that operation-bound recovery contains the exact tombstone parent's body evidence.
   * @param tombstone Immutable deletion whose digest describes its retained live parent.
   * @param recovery Strict metadata already verified against its raw recovery body.
   * @returns Whether vault, path, operation, parent revision, media type and bytes agree.
   */
  function recoveryMatchesTombstone(
    tombstone: SyncVersionMetadata & { readonly kind: "tombstone" },
    recovery: SyncRecoveryMetadata,
  ): boolean {
    return (
      recovery.vaultId === tombstone.vaultId &&
      recovery.path === tombstone.path &&
      recovery.operationId === tombstone.operationId &&
      recovery.sourceRevision === tombstone.parent.revision &&
      recovery.contentSha256 === tombstone.contentSha256 &&
      recovery.byteSize === tombstone.byteSize &&
      recovery.mediaType === tombstone.mediaType
    );
  }

  /** Validates body metadata equality for either immutable content family.
   * @param metadata Strict version or recovery declaration for raw content bytes.
   * @param body Exact decoded body with computed digest and byte size.
   * @returns Whether both independent body evidence values match the declaration.
   */
  function bodyMatches(
    metadata:
      | Pick<SyncVersionMetadata, "contentSha256" | "byteSize">
      | Pick<SyncRecoveryMetadata, "contentSha256" | "byteSize">,
    body: SyncBodyRecord,
  ): boolean {
    return (
      body.byteSize === metadata.byteSize &&
      body.contentSha256 === metadata.contentSha256
    );
  }

  /** Returns the key-family cap required by the strict decoder.
   * @param kind Record family whose R2 body is bounded before decode.
   * @returns Maximum allocation permitted for this record family.
   */
  function maxBytes(kind: SyncDecodedRecord["kind"]): number {
    switch (kind) {
      case "head":
        return SYNC_RECORD_LIMITS.headBytes;
      case "manifest":
        return SYNC_RECORD_LIMITS.manifestBytes;
      case "chunk":
        return SYNC_RECORD_LIMITS.chunkBytes;
      case "contentBody":
      case "recoveryBody":
        return SYNC_RECORD_LIMITS.contentBodyBytes;
      default:
        return 2_048;
    }
  }

  return {
    async readHead(vaultId, path) {
      if ((await validateMarker(vaultId)).kind !== "valid")
        return { kind: "unavailable" };
      const key = keyFor(syncHeadKey(vaultId, path), vaultId);
      if (key === undefined) return { kind: "unavailable" };
      return readRecord("head", key, vaultId, (decoded) =>
        decoded.kind === "head" ? decoded.record : undefined,
      );
    },
    async createHead(record, retryContext) {
      return createRecord(
        { kind: "head", record },
        syncHeadKey(record.vaultId, record.path),
        retryContext,
      );
    },
    async replaceHead(observed, record, retryContext) {
      const marker = await validateMarker(record.vaultId);
      if (marker.kind === "refused") return { kind: "refused" };
      if (marker.kind === "unavailable") return { kind: "effect_unknown" };
      const expectedKey = keyFor(
        syncHeadKey(record.vaultId, record.path),
        record.vaultId,
      );
      if (
        expectedKey === undefined ||
        observed.observed.key !== expectedKey ||
        observed.value.vaultId !== record.vaultId ||
        observed.value.path !== record.path
      ) {
        return { kind: "refused" };
      }
      let observedBytes: Uint8Array;
      try {
        const decoded = await decodeSyncRecord(
          "head",
          expectedKey,
          observed.observed.bytes,
          record.vaultId,
        );
        observedBytes = await encodeSyncRecord({
          kind: "head",
          record: observed.value,
        });
        if (
          decoded.kind !== "head" ||
          !equalBytes(observedBytes, observed.observed.bytes)
        ) {
          return { kind: "refused" };
        }
      } catch {
        return { kind: "effect_unknown" };
      }
      let bytes: Uint8Array;
      try {
        bytes = await encodeSyncRecord({ kind: "head", record });
      } catch {
        return { kind: "refused" };
      }
      try {
        return await objects.replace(observed.observed, bytes, retryContext);
      } catch {
        return { kind: "effect_unknown" };
      }
    },
    readVersion: readVerifiedVersion,
    async createVersion(record, retryContext) {
      const marker = await validateMarker(record.vaultId);
      if (marker.kind === "refused") return { kind: "refused" };
      if (marker.kind === "unavailable") return { kind: "effect_unknown" };
      if (record.kind === "tombstone") {
        const recovery = await readVerifiedRecovery(
          record.vaultId,
          record.operationId,
        );
        if (recovery.kind === "absent") return { kind: "refused" };
        if (recovery.kind === "unavailable") return { kind: "effect_unknown" };
        if (!recoveryMatchesTombstone(record, recovery.observation.value))
          return { kind: "refused" };
      } else {
        const body = await readBody(
          "contentBody",
          syncContentKey(record.vaultId, record.revision),
          record.vaultId,
        );
        if (body.kind === "absent") return { kind: "refused" };
        if (body.kind === "unavailable") return { kind: "effect_unknown" };
        if (!bodyMatches(record, body.observation.value))
          return { kind: "refused" };
      }
      return createRecord(
        { kind: "version", record },
        syncVersionKey(record.vaultId, record.revision),
        retryContext,
      );
    },
    async readContent(vaultId, revision) {
      const metadata = await readVerifiedVersion(vaultId, revision);
      if (metadata.kind !== "observed") return metadata;
      if (metadata.observation.value.kind === "tombstone")
        return { kind: "unavailable" };
      const body = await readBody(
        "contentBody",
        syncContentKey(vaultId, revision),
        vaultId,
      );
      if (
        body.kind === "observed" &&
        body.observation.value.kind === "contentBody" &&
        bodyMatches(metadata.observation.value, body.observation.value)
      ) {
        return {
          kind: "observed",
          observation: {
            value: body.observation.value,
            observed: body.observation.observed,
          },
        };
      }
      if (body.kind === "absent") return { kind: "unavailable" };
      if (body.kind === "unavailable") return { kind: "unavailable" };
      return { kind: "unavailable" };
    },
    async createContent(record, retryContext) {
      return createRecord(
        { kind: "contentBody", record },
        syncContentKey(record.vaultId, record.revision),
        retryContext,
      );
    },
    readRecovery: readVerifiedRecovery,
    async createRecovery(record, retryContext) {
      const marker = await validateMarker(record.vaultId);
      if (marker.kind === "refused") return { kind: "refused" };
      if (marker.kind === "unavailable") return { kind: "effect_unknown" };
      const body = await readBody(
        "recoveryBody",
        syncRecoveryKey(record.vaultId, record.operationId, "content"),
        record.vaultId,
      );
      if (body.kind === "absent") return { kind: "refused" };
      if (body.kind === "unavailable") return { kind: "effect_unknown" };
      if (!bodyMatches(record, body.observation.value))
        return { kind: "refused" };
      return createRecord(
        { kind: "recoveryMetadata", record },
        syncRecoveryKey(record.vaultId, record.operationId, "metadata"),
        retryContext,
      );
    },
    async createRecoveryBody(record, retryContext) {
      return createRecord(
        { kind: "recoveryBody", record },
        syncRecoveryKey(record.vaultId, record.operationId, "content"),
        retryContext,
      );
    },
  };
}

/** Reads vault identity from each closed record variant without weakening its type.
 * @param record Closed decoded record family.
 * @returns Vault identity carried by the validated record.
 */
function recordVaultId(record: SyncDecodedRecord): SyncVaultIdDto {
  return record.kind === "vaultMarker" ? record.vaultId : record.record.vaultId;
}

/** Compares exact encoded record evidence without text normalization.
 * @param left First canonical byte sequence.
 * @param right Second canonical byte sequence.
 * @returns Whether both sequences have the same length and byte values.
 */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}
