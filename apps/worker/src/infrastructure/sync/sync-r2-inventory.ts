import {
  syncInventoryActiveKey,
  syncInventoryChunkKey,
  syncInventoryManifestKey,
} from "@protocol/sync.codec";
import type { SyncInventoryIdDto, SyncVaultIdDto } from "@protocol/sync.types";
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
import {
  SYNC_RECORD_LIMITS,
  syncInventoryChunkSchema,
  syncInventoryManifestSchema,
  syncInventorySlotSchema,
} from "@worker/infrastructure/sync/sync-record.schemas";
import type {
  SyncDecodedRecord,
  SyncInventoryChunk,
  SyncInventoryManifest,
  SyncInventorySlot,
} from "@worker/infrastructure/sync/sync-record.types";

/** Single-object persistence boundary for resumable inventory scratch evidence. */
export interface SyncR2InventoryScratch {
  /** Reads only the exact mutable active-slot key and preserves its observed ETag. */
  readActive(
    vaultId: SyncVaultIdDto,
  ): Promise<SyncRecordRead<SyncInventorySlot>>;
  /** Creates the active-slot key using create-only conditional storage semantics. */
  createActive(slot: SyncInventorySlot): Promise<SyncR2WriteResult>;
  /** Replaces only the exact previously observed active-slot generation. */
  replaceActive(
    observed: SyncRecordObservation<SyncInventorySlot>,
    slot: SyncInventorySlot,
  ): Promise<SyncR2WriteResult>;
  /** Reads one manifest by its exact vault and immutable inventory identity. */
  readManifest(
    vaultId: SyncVaultIdDto,
    inventoryId: SyncInventoryIdDto,
  ): Promise<SyncRecordRead<SyncInventoryManifest>>;
  /** Creates one manifest using create-only conditional storage semantics. */
  createManifest(record: SyncInventoryManifest): Promise<SyncR2WriteResult>;
  /** Replaces only the exact previously observed manifest generation. */
  replaceManifest(
    observed: SyncRecordObservation<SyncInventoryManifest>,
    record: SyncInventoryManifest,
  ): Promise<SyncR2WriteResult>;
  /** Reads one immutable chunk only when key, embedded step, and cursor digest validate. */
  readChunk(
    vaultId: SyncVaultIdDto,
    inventoryId: SyncInventoryIdDto,
    step: number,
  ): Promise<SyncRecordRead<SyncInventoryChunk>>;
  /** Creates one immutable chunk using create-only conditional storage semantics. */
  createChunk(record: SyncInventoryChunk): Promise<SyncR2WriteResult>;
}

/** Composes strict inventory records with the one-key conditional R2 boundary.
 * @param objects Conditional single-key storage capability.
 * @returns Inventory scratch operations without scan policy or completion authority.
 */
export function syncR2InventoryScratch(
  objects: SyncR2ObjectStore,
): SyncR2InventoryScratch {
  /** Reconstructs a canonical key for the exact inventory record identity.
   * @param value Candidate key produced by the protocol codec.
   * @param vaultId Validated vault namespace required by the key prefix.
   * @returns Canonical private R2 key, or undefined if reconstruction fails.
   */
  function keyFor(
    value: string,
    vaultId: SyncVaultIdDto,
  ): SyncR2Key | undefined {
    return createSyncR2Key(value, vaultId);
  }

  /** Reads one exact key and exposes only its strictly decoded typed evidence.
   * @param kind Expected persisted record family.
   * @param keyValue Exact protocol key for the requested record.
   * @param vaultId Validated namespace identity.
   * @param project Narrows the decoded closed record to the requested result type.
   * @returns Typed absence, unavailability, or exact-generation observation.
   */
  async function readRecord<T>(
    kind: "activeSlot" | "manifest" | "chunk",
    keyValue: string,
    vaultId: SyncVaultIdDto,
    project: (decoded: SyncDecodedRecord) => T | undefined,
  ): Promise<SyncRecordRead<T>> {
    const key = keyFor(keyValue, vaultId);
    if (key === undefined) return { kind: "unavailable" };
    const raw = await objects.read(key, maxBytes(kind));
    if (raw.kind !== "observed") return raw;
    try {
      const decoded = await decodeSyncRecord(
        kind,
        key,
        raw.observation.bytes,
        vaultId,
      );
      const value = project(decoded);
      return value === undefined
        ? { kind: "unavailable" }
        : {
            kind: "observed",
            observation: { value, observed: raw.observation },
          };
    } catch {
      return { kind: "unavailable" };
    }
  }

  /** Validates and encodes one record before a create-only write at its canonical key.
   * @param record Strict inventory record selected for creation.
   * @param keyValue Exact protocol key derived from the record identity.
   * @returns Conditional-write certainty without inferring successful progress.
   */
  async function createRecord(
    record: Extract<
      SyncDecodedRecord,
      { readonly kind: "activeSlot" | "manifest" | "chunk" }
    >,
    keyValue: string,
  ): Promise<SyncR2WriteResult> {
    const vaultId = record.record.vaultId;
    const key = keyFor(keyValue, vaultId);
    if (key === undefined) return { kind: "effect_unknown" };
    let bytes: Uint8Array;
    try {
      validateRecord(record);
      bytes = await encodeSyncRecord(record);
    } catch {
      return { kind: "refused" };
    }
    try {
      return await objects.create(key, bytes);
    } catch {
      return { kind: "effect_unknown" };
    }
  }

  /** Replaces one observed record only if its retained bytes still decode to its typed value.
   * @param kind Mutable inventory record family.
   * @param observed Typed observation and exact R2 generation evidence.
   * @param record Replacement record with the same identity.
   * @param keyValue Canonical active-slot or manifest key.
   * @param vaultId Validated namespace identity.
   * @returns Exact-CAS certainty; stale observations are never refreshed.
   */
  async function replaceRecord<T>(
    kind: "activeSlot" | "manifest",
    observed: SyncRecordObservation<T>,
    record: Extract<
      SyncDecodedRecord,
      { readonly kind: "activeSlot" | "manifest" }
    >,
    keyValue: string,
    vaultId: SyncVaultIdDto,
  ): Promise<SyncR2WriteResult> {
    const key = keyFor(keyValue, vaultId);
    if (
      key === undefined ||
      observed.observed.key !== key ||
      record.record.vaultId !== vaultId
    ) {
      return { kind: "refused" };
    }
    let bytes: Uint8Array;
    try {
      const decoded = await decodeSyncRecord(
        kind,
        key,
        observed.observed.bytes,
        vaultId,
      );
      if (!sameValue(decoded, kind, observed.value)) return { kind: "refused" };
      validateRecord(record);
      bytes = await encodeSyncRecord(record);
    } catch {
      return { kind: "refused" };
    }
    try {
      return await objects.replace(observed.observed, bytes);
    } catch {
      return { kind: "effect_unknown" };
    }
  }

  return {
    readActive(vaultId) {
      return readRecord(
        "activeSlot",
        syncInventoryActiveKey(vaultId),
        vaultId,
        (decoded) =>
          decoded.kind === "activeSlot" && decoded.record.vaultId === vaultId
            ? decoded.record
            : undefined,
      );
    },
    createActive(slot) {
      return createRecord(
        { kind: "activeSlot", record: slot },
        syncInventoryActiveKey(slot.vaultId),
      );
    },
    replaceActive(observed, slot) {
      return replaceRecord(
        "activeSlot",
        observed,
        { kind: "activeSlot", record: slot },
        syncInventoryActiveKey(slot.vaultId),
        slot.vaultId,
      );
    },
    readManifest(vaultId, inventoryId) {
      return readRecord(
        "manifest",
        syncInventoryManifestKey(vaultId, inventoryId),
        vaultId,
        (decoded) =>
          decoded.kind === "manifest" &&
          decoded.record.vaultId === vaultId &&
          decoded.record.inventoryId === inventoryId
            ? decoded.record
            : undefined,
      );
    },
    createManifest(record) {
      return createRecord(
        { kind: "manifest", record },
        syncInventoryManifestKey(record.vaultId, record.inventoryId),
      );
    },
    replaceManifest(observed, record) {
      return replaceRecord(
        "manifest",
        observed,
        { kind: "manifest", record },
        syncInventoryManifestKey(record.vaultId, record.inventoryId),
        record.vaultId,
      );
    },
    readChunk(vaultId, inventoryId, step) {
      return readRecord(
        "chunk",
        syncInventoryChunkKey(vaultId, inventoryId, step),
        vaultId,
        (decoded) =>
          decoded.kind === "chunk" &&
          decoded.record.vaultId === vaultId &&
          decoded.record.inventoryId === inventoryId &&
          decoded.record.step === step
            ? decoded.record
            : undefined,
      );
    },
    createChunk(record) {
      return createRecord(
        { kind: "chunk", record },
        syncInventoryChunkKey(record.vaultId, record.inventoryId, record.step),
      );
    },
  };
}

/** Applies the authoritative family schema before an inventory write reaches R2.
 * @param record Closed inventory record variant to validate.
 * @returns Nothing when valid; throws a schema error when the record is invalid.
 */
function validateRecord(
  record: Extract<
    SyncDecodedRecord,
    { kind: "activeSlot" | "manifest" | "chunk" }
  >,
): void {
  switch (record.kind) {
    case "activeSlot":
      syncInventorySlotSchema.parse(record.record);
      return;
    case "manifest":
      syncInventoryManifestSchema.parse(record.record);
      return;
    case "chunk":
      syncInventoryChunkSchema.parse(record.record);
  }
}

/** Selects the type-family allocation ceiling before the object body is decoded.
 * @param kind Record family whose bytes will be read.
 * @returns Maximum permitted allocation in bytes.
 */
function maxBytes(kind: "activeSlot" | "manifest" | "chunk"): number {
  switch (kind) {
    case "activeSlot":
      return SYNC_RECORD_LIMITS.headBytes;
    case "manifest":
      return SYNC_RECORD_LIMITS.manifestBytes;
    case "chunk":
      return SYNC_RECORD_LIMITS.chunkBytes;
  }
}

/** Confirms an observed private record matches the value supplied for exact replacement.
 * @param decoded Strictly decoded storage value.
 * @param kind Expected mutable record family.
 * @param value Typed value carried by the observation.
 * @returns Whether decoded stored evidence is structurally equal to that observation.
 */
function sameValue<T>(
  decoded: SyncDecodedRecord,
  kind: "activeSlot" | "manifest",
  value: T,
): boolean {
  return (
    decoded.kind === kind &&
    JSON.stringify(decoded.record) === JSON.stringify(value)
  );
}
