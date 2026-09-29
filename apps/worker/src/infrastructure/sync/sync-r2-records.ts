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

/** One-record current, version, content, and recovery access within a validated sync-v1 vault. */
export interface SyncR2Records {
  /** Reads one current head only after validating the matching namespace marker. */
  readHead(
    vaultId: SyncVaultIdDto,
    path: SyncNotePathDto,
  ): Promise<SyncRecordRead<SyncHeadRecord>>;
  /** Creates a current head after marker validation using create-only R2 semantics. */
  createHead(record: SyncHeadRecord): Promise<SyncR2WriteResult>;
  /** Replaces only the exact observed head generation after marker validation. */
  replaceHead(
    observed: SyncRecordObservation<SyncHeadRecord>,
    record: SyncHeadRecord,
  ): Promise<SyncR2WriteResult>;
  /** Reads immutable metadata only when its exact content object verifies against it. */
  readVersion(
    vaultId: SyncVaultIdDto,
    revision: SyncRevisionDto,
  ): Promise<SyncRecordRead<SyncVersionMetadata>>;
  /** Creates immutable version metadata only when its body already matches. */
  createVersion(record: SyncVersionMetadata): Promise<SyncR2WriteResult>;
  /** Reads exact content only after its version metadata's digest and byte size match. */
  readContent(
    vaultId: SyncVaultIdDto,
    revision: SyncRevisionDto,
  ): Promise<
    SyncRecordRead<Extract<SyncBodyRecord, { readonly kind: "contentBody" }>>
  >;
  /** Creates one exact immutable content-body object. */
  createContent(
    record: Extract<SyncBodyRecord, { readonly kind: "contentBody" }>,
  ): Promise<SyncR2WriteResult>;
  /** Reads recovery metadata only when its exact recovery body verifies against it. */
  readRecovery(
    vaultId: SyncVaultIdDto,
    operationId: SyncOperationIdDto,
  ): Promise<SyncRecordRead<SyncRecoveryMetadata>>;
  /** Creates recovery metadata only when its body already matches. */
  createRecovery(record: SyncRecoveryMetadata): Promise<SyncR2WriteResult>;
  /** Creates one exact immutable recovery-body object. */
  createRecoveryBody(
    record: Extract<SyncBodyRecord, { readonly kind: "recoveryBody" }>,
  ): Promise<SyncR2WriteResult>;
}

/** Composes strict record validation with single-key R2 evidence, never sequencing a mutation.
 * @param objects Conditional one-key adapter for the isolated sync namespace.
 * @returns Marker-gated current, version, content, and recovery record operations.
 */
export function syncR2Records(objects: SyncR2ObjectStore): SyncR2Records {
  /** Confirms the exact vault marker before the facade relies on namespace state.
   * @param vaultId Validated immutable vault namespace.
   * @returns Whether an exact-key marker strictly identifies this vault.
   */
  async function hasMarker(vaultId: SyncVaultIdDto): Promise<boolean> {
    const key = createSyncR2Key(syncVaultMarkerKey(vaultId), vaultId);
    if (key === undefined) return false;
    const result = await objects.read(key, 2_048);
    if (result.kind !== "observed") return false;
    try {
      const decoded = await decodeSyncRecord(
        "vaultMarker",
        key,
        result.observation.bytes,
        vaultId,
      );
      return (
        decoded.kind === "vaultMarker" &&
        decoded.vaultId === vaultId &&
        syncVaultMarkerSchema.safeParse({
          schemaVersion: decoded.schemaVersion,
          protocolMajor: decoded.protocolMajor,
          vaultId: decoded.vaultId,
        }).success
      );
    } catch {
      return false;
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

  /** Reads a strict version metadata record and its exact linked immutable body.
   * @param vaultId Immutable vault identity owning both objects.
   * @param revision Exact immutable revision encoded into both keys.
   * @returns Metadata only after raw body size and SHA-256 match; incomplete evidence is unavailable.
   */
  async function readVerifiedVersion(
    vaultId: SyncVaultIdDto,
    revision: SyncRevisionDto,
  ): Promise<SyncRecordRead<SyncVersionMetadata>> {
    if (!(await hasMarker(vaultId))) return { kind: "unavailable" };
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
    if (!(await hasMarker(vaultId))) return { kind: "unavailable" };
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
   * @returns Conditional-write certainty from the one-key R2 primitive.
   */
  async function createRecord(
    record: SyncDecodedRecord,
    keyValue: string,
  ): Promise<SyncR2WriteResult> {
    if (!(await hasMarker(recordVaultId(record))))
      return { kind: "effect_unknown" };
    const key = keyFor(keyValue, recordVaultId(record));
    if (key === undefined) return { kind: "effect_unknown" };
    try {
      const bytes = await encodeSyncRecord(record);
      return await objects.create(key, bytes);
    } catch {
      return { kind: "effect_unknown" };
    }
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
      if (!(await hasMarker(vaultId))) return { kind: "unavailable" };
      const key = keyFor(syncHeadKey(vaultId, path), vaultId);
      if (key === undefined) return { kind: "unavailable" };
      return readRecord("head", key, vaultId, (decoded) =>
        decoded.kind === "head" ? decoded.record : undefined,
      );
    },
    async createHead(record) {
      return createRecord(
        { kind: "head", record },
        syncHeadKey(record.vaultId, record.path),
      );
    },
    async replaceHead(observed, record) {
      if (!(await hasMarker(record.vaultId))) return { kind: "effect_unknown" };
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
      try {
        const decoded = await decodeSyncRecord(
          "head",
          expectedKey,
          observed.observed.bytes,
          record.vaultId,
        );
        const observedBytes = await encodeSyncRecord({
          kind: "head",
          record: observed.value,
        });
        if (
          decoded.kind !== "head" ||
          !equalBytes(observedBytes, observed.observed.bytes)
        ) {
          return { kind: "refused" };
        }
        const bytes = await encodeSyncRecord({ kind: "head", record });
        return await objects.replace(observed.observed, bytes);
      } catch {
        return { kind: "effect_unknown" };
      }
    },
    readVersion: readVerifiedVersion,
    async createVersion(record) {
      if (!(await hasMarker(record.vaultId))) return { kind: "effect_unknown" };
      const version = await readBody(
        "contentBody",
        syncContentKey(record.vaultId, record.revision),
        record.vaultId,
      );
      if (
        version.kind !== "observed" ||
        !bodyMatches(record, version.observation.value)
      )
        return { kind: "effect_unknown" };
      return createRecord(
        { kind: "version", record },
        syncVersionKey(record.vaultId, record.revision),
      );
    },
    async readContent(vaultId, revision) {
      const metadata = await readVerifiedVersion(vaultId, revision);
      if (metadata.kind !== "observed") return metadata;
      const body = await readBody(
        "contentBody",
        syncContentKey(vaultId, revision),
        vaultId,
      );
      if (
        body.kind === "observed" &&
        body.observation.value.kind === "contentBody"
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
    async createContent(record) {
      return createRecord(
        { kind: "contentBody", record },
        syncContentKey(record.vaultId, record.revision),
      );
    },
    readRecovery: readVerifiedRecovery,
    async createRecovery(record) {
      if (!(await hasMarker(record.vaultId))) return { kind: "effect_unknown" };
      const body = await readBody(
        "recoveryBody",
        syncRecoveryKey(record.vaultId, record.operationId, "content"),
        record.vaultId,
      );
      if (
        body.kind !== "observed" ||
        !bodyMatches(record, body.observation.value)
      )
        return { kind: "effect_unknown" };
      return createRecord(
        { kind: "recoveryMetadata", record },
        syncRecoveryKey(record.vaultId, record.operationId, "metadata"),
      );
    },
    async createRecoveryBody(record) {
      return createRecord(
        { kind: "recoveryBody", record },
        syncRecoveryKey(record.vaultId, record.operationId, "content"),
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
