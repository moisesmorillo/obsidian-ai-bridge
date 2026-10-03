import {
  syncInventoryActiveKey,
  syncInventoryChunkKey,
  syncInventoryClaimKey,
  syncInventoryCursorWitnessKey,
  syncInventoryManifestKey,
} from "@protocol/sync.codec";
import type { SyncInventoryIdDto, SyncVaultIdDto } from "@protocol/sync.types";
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
import {
  SYNC_RECORD_LIMITS,
  syncInventoryChunkSchema,
  syncInventoryCursorJournalSchema,
  syncInventoryCursorWitnessSchema,
  syncInventoryManifestSchema,
  syncInventorySlotSchema,
} from "@worker/infrastructure/sync/sync-record.schemas";
import type {
  SyncDecodedRecord,
  SyncInventoryChunk,
  SyncInventoryCursorJournal,
  SyncInventoryCursorWitness,
  SyncInventoryManifest,
  SyncInventorySlot,
} from "@worker/infrastructure/sync/sync-record.types";

/** Distinguishes malformed persisted scratch from unavailable or absent storage. */
export type SyncInventoryEvidenceRead<T> =
  | SyncRecordRead<T>
  | { readonly kind: "invalid" };

/** Exact immutable chunk read including a distinct malformed-evidence outcome. */
export type SyncInventoryChunkRead =
  SyncInventoryEvidenceRead<SyncInventoryChunk>;

/** Single-object persistence boundary for resumable inventory scratch evidence. */
export interface SyncR2InventoryScratch {
  /** Reads only the exact mutable active-slot key and preserves its observed ETag. */
  readActive(
    vaultId: SyncVaultIdDto,
  ): Promise<SyncRecordRead<SyncInventorySlot>>;
  /** Creates the active-slot key using create-only conditional storage semantics.
   * @param retryContext Prior cross-isolate cooldown evidence, when resuming a write.
   */
  createActive(
    slot: SyncInventorySlot,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult>;
  /** Replaces only the exact previously observed active-slot generation. */
  replaceActive(
    observed: SyncRecordObservation<SyncInventorySlot>,
    slot: SyncInventorySlot,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult>;
  /** Reads one manifest by its exact vault and immutable inventory identity. */
  readManifest(
    vaultId: SyncVaultIdDto,
    inventoryId: SyncInventoryIdDto,
  ): Promise<SyncRecordRead<SyncInventoryManifest>>;
  /** Creates one manifest using create-only conditional storage semantics.
   * @param retryContext Prior cross-isolate cooldown evidence, when resuming a write.
   */
  createManifest(
    record: SyncInventoryManifest,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult>;
  /** Replaces only the exact previously observed manifest generation. */
  replaceManifest(
    observed: SyncRecordObservation<SyncInventoryManifest>,
    record: SyncInventoryManifest,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult>;
  /** Reads one immutable chunk only when key, embedded step, and cursor digest validate. */
  readChunk(
    vaultId: SyncVaultIdDto,
    inventoryId: SyncInventoryIdDto,
    step: number,
  ): Promise<SyncInventoryChunkRead>;
  /** Creates one immutable chunk using create-only conditional storage semantics.
   * @param retryContext Prior cross-isolate cooldown evidence, when resuming a write.
   */
  createChunk(
    record: SyncInventoryChunk,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult>;
  /** Reads a per-step journal, distinguishing malformed authority from unavailable R2. */
  readCursorJournal(
    vaultId: SyncVaultIdDto,
    inventoryId: SyncInventoryIdDto,
    step: number,
  ): Promise<SyncInventoryEvidenceRead<SyncInventoryCursorJournal>>;
  /** Begins exactly one random-generation target-write claim by create-only persistence. */
  createCursorJournal(
    record: SyncInventoryCursorJournal,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult>;
  /** Replaces only the exact prior journal generation under its original step key. */
  replaceCursorJournal(
    observed: SyncRecordObservation<SyncInventoryCursorJournal>,
    record: SyncInventoryCursorJournal,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult>;
  /** Reads one digest-indexed witness with a distinct malformed-evidence outcome. */
  readCursorWitness(
    vaultId: SyncVaultIdDto,
    inventoryId: SyncInventoryIdDto,
    cursorDigest: SyncInventoryCursorWitness["cursorDigest"],
  ): Promise<SyncInventoryEvidenceRead<SyncInventoryCursorWitness>>;
  /** Creates an immutable witness; a conflicting earlier-step digest is never adopted. */
  createCursorWitness(
    record: SyncInventoryCursorWitness,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult>;
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

  /** Reads strict scratch evidence while distinguishing a malformed observed body from an unavailable R2 call.
   * @param kind Immutable chunk, mutable claim journal or immutable cursor witness family.
   * @param keyValue Canonical key derived from the requested scan/step or digest.
   * @param vaultId Validated scope of the requested scan.
   * @param project Checks the requested embedded identity as well as the key-linked codec.
   * @returns Exact evidence, definite absence, unavailability or a present invalid body.
   */
  async function readScratchEvidence<T>(
    kind: "chunk" | "cursorJournal" | "cursorWitness",
    keyValue: string,
    vaultId: SyncVaultIdDto,
    project: (decoded: SyncDecodedRecord) => T | undefined,
  ): Promise<SyncInventoryEvidenceRead<T>> {
    const key = keyFor(keyValue, vaultId);
    if (key === undefined) return { kind: "unavailable" };
    let raw: Awaited<ReturnType<SyncR2ObjectStore["read"]>>;
    try {
      raw = await objects.read(key, maxBytes(kind));
    } catch {
      return { kind: "unavailable" };
    }
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
        ? { kind: "invalid" }
        : {
            kind: "observed",
            observation: { value, observed: raw.observation },
          };
    } catch {
      return { kind: "invalid" };
    }
  }

  /** Validates and encodes one record before a create-only write at its canonical key.
   * @param record Strict inventory record selected for creation.
   * @param keyValue Exact protocol key derived from the record identity.
   * @param retryContext Caller-carried cooldown floor from a prior uncertain/throttled attempt.
   * @returns Conditional-write certainty without inferring successful progress.
   */
  async function createRecord(
    record: Extract<
      SyncDecodedRecord,
      {
        readonly kind:
          | "activeSlot"
          | "manifest"
          | "chunk"
          | "cursorJournal"
          | "cursorWitness";
      }
    >,
    keyValue: string,
    retryContext?: SyncR2RetryContext,
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
      return await objects.create(key, bytes, retryContext);
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
   * @param retryContext Caller-carried cooldown floor from a prior uncertain/throttled attempt.
   * @returns Exact-CAS certainty; stale observations are never refreshed.
   */
  async function replaceRecord<T>(
    kind: "activeSlot" | "manifest" | "cursorJournal",
    observed: SyncRecordObservation<T>,
    record: Extract<
      SyncDecodedRecord,
      { readonly kind: "activeSlot" | "manifest" | "cursorJournal" }
    >,
    keyValue: string,
    vaultId: SyncVaultIdDto,
    retryContext?: SyncR2RetryContext,
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
      if (
        decoded.kind === "manifest" &&
        record.kind === "manifest" &&
        decoded.record.schemaVersion !== record.record.schemaVersion
      ) {
        return { kind: "refused" };
      }
      if (
        decoded.kind === "cursorJournal" &&
        record.kind === "cursorJournal" &&
        !canReplaceCursorJournal(decoded.record, record.record)
      ) {
        return { kind: "refused" };
      }
      validateRecord(record);
      bytes = await encodeSyncRecord(record);
    } catch {
      return { kind: "refused" };
    }
    try {
      return await objects.replace(observed.observed, bytes, retryContext);
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
    createActive(slot, retryContext) {
      return createRecord(
        { kind: "activeSlot", record: slot },
        syncInventoryActiveKey(slot.vaultId),
        retryContext,
      );
    },
    replaceActive(observed, slot, retryContext) {
      return replaceRecord(
        "activeSlot",
        observed,
        { kind: "activeSlot", record: slot },
        syncInventoryActiveKey(slot.vaultId),
        slot.vaultId,
        retryContext,
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
    createManifest(record, retryContext) {
      return createRecord(
        { kind: "manifest", record },
        syncInventoryManifestKey(record.vaultId, record.inventoryId),
        retryContext,
      );
    },
    replaceManifest(observed, record, retryContext) {
      return replaceRecord(
        "manifest",
        observed,
        { kind: "manifest", record },
        syncInventoryManifestKey(record.vaultId, record.inventoryId),
        record.vaultId,
        retryContext,
      );
    },
    readChunk(vaultId, inventoryId, step) {
      return readScratchEvidence(
        "chunk",
        syncInventoryChunkKey(vaultId, inventoryId, step),
        vaultId,
        (decoded) =>
          decoded.kind === "chunk" &&
          decoded.record.inventoryId === inventoryId &&
          decoded.record.step === step
            ? decoded.record
            : undefined,
      );
    },
    createChunk(record, retryContext) {
      return createRecord(
        { kind: "chunk", record },
        syncInventoryChunkKey(record.vaultId, record.inventoryId, record.step),
        retryContext,
      );
    },
    readCursorJournal(vaultId, inventoryId, step) {
      return readScratchEvidence(
        "cursorJournal",
        syncInventoryClaimKey(vaultId, inventoryId, step),
        vaultId,
        (decoded) =>
          decoded.kind === "cursorJournal" &&
          decoded.record.inventoryId === inventoryId &&
          decoded.record.step === step
            ? decoded.record
            : undefined,
      );
    },
    createCursorJournal(record, retryContext) {
      return createRecord(
        { kind: "cursorJournal", record },
        syncInventoryClaimKey(record.vaultId, record.inventoryId, record.step),
        retryContext,
      );
    },
    replaceCursorJournal(observed, record, retryContext) {
      return replaceRecord(
        "cursorJournal",
        observed,
        { kind: "cursorJournal", record },
        syncInventoryClaimKey(record.vaultId, record.inventoryId, record.step),
        record.vaultId,
        retryContext,
      );
    },
    readCursorWitness(vaultId, inventoryId, cursorDigest) {
      return readScratchEvidence(
        "cursorWitness",
        syncInventoryCursorWitnessKey(vaultId, inventoryId, cursorDigest),
        vaultId,
        (decoded) =>
          decoded.kind === "cursorWitness" &&
          decoded.record.inventoryId === inventoryId &&
          decoded.record.cursorDigest === cursorDigest
            ? decoded.record
            : undefined,
      );
    },
    createCursorWitness(record, retryContext) {
      return createRecord(
        { kind: "cursorWitness", record },
        syncInventoryCursorWitnessKey(
          record.vaultId,
          record.inventoryId,
          record.cursorDigest,
        ),
        retryContext,
      );
    },
  };
}

/** Fences the exact chunk binding and one-generation-at-a-time journal progression.
 * @param observed Strict current journal value from the original R2 generation.
 * @param next Candidate replacement under that same step key.
 * @returns Whether a legal wait or fresh-UUID retry preserves all causal evidence.
 */
function canReplaceCursorJournal(
  observed: SyncInventoryCursorJournal,
  next: SyncInventoryCursorJournal,
): boolean {
  if (
    observed.vaultId !== next.vaultId ||
    observed.inventoryId !== next.inventoryId ||
    observed.step !== next.step ||
    observed.chunkHash !== next.chunkHash ||
    observed.cursorDigest !== next.cursorDigest
  ) {
    return false;
  }
  if (observed.state === "attempting") {
    return next.state === "retry_wait" && next.claimId === observed.claimId;
  }
  return next.state === "attempting" && next.claimId !== observed.claimId;
}

/** Applies the authoritative family schema before an inventory write reaches R2.
 * @param record Closed inventory record variant to validate.
 * @returns Nothing when valid; throws a schema error when the record is invalid.
 */
function validateRecord(
  record: Extract<
    SyncDecodedRecord,
    {
      kind:
        | "activeSlot"
        | "manifest"
        | "chunk"
        | "cursorJournal"
        | "cursorWitness";
    }
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
      return;
    case "cursorJournal":
      syncInventoryCursorJournalSchema.parse(record.record);
      return;
    case "cursorWitness":
      syncInventoryCursorWitnessSchema.parse(record.record);
  }
}

/** Selects the type-family allocation ceiling before the object body is decoded.
 * @param kind Record family whose bytes will be read.
 * @returns Maximum permitted allocation in bytes.
 */
function maxBytes(
  kind: "activeSlot" | "manifest" | "chunk" | "cursorJournal" | "cursorWitness",
): number {
  switch (kind) {
    case "activeSlot":
      return SYNC_RECORD_LIMITS.headBytes;
    case "manifest":
      return SYNC_RECORD_LIMITS.witnessedManifestBytes;
    case "chunk":
      return SYNC_RECORD_LIMITS.chunkBytes;
    case "cursorJournal":
      return SYNC_RECORD_LIMITS.cursorJournalBytes;
    case "cursorWitness":
      return SYNC_RECORD_LIMITS.cursorWitnessBytes;
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
  kind: "activeSlot" | "manifest" | "cursorJournal",
  value: T,
): boolean {
  return (
    decoded.kind === kind &&
    JSON.stringify(decoded.record) === JSON.stringify(value)
  );
}
