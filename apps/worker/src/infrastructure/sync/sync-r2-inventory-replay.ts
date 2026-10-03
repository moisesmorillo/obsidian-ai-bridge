import type { SyncInventoryResult } from "@core/sync/sync-store.types";
import {
  decodeBase64Url,
  decodeUtf8,
  encodeBase64Url,
} from "@obsidian-ai-bridge/core";
import {
  decodeSyncPathKey,
  syncHeadKey,
  syncVaultPrefix,
} from "@protocol/sync.codec";
import type { SyncInventoryIdDto, SyncVaultIdDto } from "@protocol/sync.types";
import type { SyncRecordObservation } from "@worker/infrastructure/sync/sync-r2.types";
import type { SyncR2InventoryScratch } from "@worker/infrastructure/sync/sync-r2-inventory";
import type { SyncInventoryInvocationBudget } from "@worker/infrastructure/sync/sync-r2-inventory-budget";
import { checkSyncInventoryCursor } from "@worker/infrastructure/sync/sync-r2-inventory-cursor";
import { verifySyncInventoryChunk } from "@worker/infrastructure/sync/sync-r2-inventory-evidence";
import type { SyncR2InventoryListing } from "@worker/infrastructure/sync/sync-r2-inventory-list";
import type { SyncServerClock } from "@worker/infrastructure/sync/sync-r2-mutation.types";
import { SYNC_RECORD_LIMITS } from "@worker/infrastructure/sync/sync-record.schemas";
import type {
  SyncHeadSummary,
  SyncInventoryChunk,
  SyncInventoryManifest,
} from "@worker/infrastructure/sync/sync-record.types";
import { sha256Content } from "@worker/storage/storage-crypto";

/** Conservative per-step preflight for reservation, LIST, optional head GET and write read-backs. */
const STEP_R2_CALL_ALLOWANCE = 12;
/** Pre-dispatch ceiling for a witnessed replay including journal and exact proof reads. */
const WITNESSED_STEP_R2_CALL_ALLOWANCE = 32;
/** Local conservative CPU allowance; remote Workers Free timing remains unqualified. */
const STEP_CPU_ALLOWANCE_MS = 1;
/** Exact byte encoding of the private R2 listing cursor, never the public feed cursor. */
const encoder = new TextEncoder();

/** Maps one scan identity to nonterminal progress without authorizing completeness.
 * @param vaultId Scan namespace.
 * @param inventoryId Stable caller-owned scan identity.
 * @param retryAfterEpochMs Optional earliest safe same-ID continuation.
 * @returns Nonterminal result that cannot serve as inventory evidence.
 */
function progress(
  vaultId: SyncVaultIdDto,
  inventoryId: SyncInventoryIdDto,
  retryAfterEpochMs?: number,
): SyncInventoryResult {
  return retryAfterEpochMs === undefined
    ? { kind: "inventory_in_progress", vaultId, inventoryId }
    : {
        kind: "inventory_in_progress",
        vaultId,
        inventoryId,
        retryAfterEpochMs,
      };
}

/** Verifies a persisted chunk's exact bytes, cursor digests, transcript and key linkage.
 * @param manifest Exact still-reserved manifest generation whose cursor must be advanced.
 * @param chunk Typed chunk read at its deterministic step key.
 * @returns A strict successor manifest, or undefined when evidence is mismatched.
 */
async function successorManifest(
  manifest: SyncRecordObservation<SyncInventoryManifest>,
  chunk: SyncRecordObservation<SyncInventoryChunk>,
): Promise<SyncInventoryManifest | undefined> {
  const prior = manifest.value;
  const verified = await verifySyncInventoryChunk(prior, chunk);
  if (verified === undefined) return undefined;
  const { record, transcript, listedKey } = verified;
  const nextHeadCount = prior.headCount + transcript.objectCount;
  const nextEmptyPages =
    prior.emptyPageCount +
    (transcript.objectCount === 0 && record.truncated ? 1 : 0);
  const nextListAttempts = prior.listAttemptCount + prior.reservedAttempt;
  const chargedHeadAttempts =
    transcript.objectCount + prior.reservedAttempt - 1;
  const nextHeadAttempts = prior.headGetAttemptCount + chargedHeadAttempts;
  const nextUniqueBytes = prior.uniqueHeadBodyBytes + transcript.headBodyBytes;
  const nextActualBytes =
    prior.actualHeadBodyBytes +
    transcript.headBodyBytes +
    (prior.reservedAttempt - 1) * SYNC_RECORD_LIMITS.headBytes;
  const nextEvidenceBytes = prior.evidenceBytes + verified.byteSize;
  if (
    nextHeadCount > SYNC_RECORD_LIMITS.inventoryHeads ||
    nextEmptyPages > SYNC_RECORD_LIMITS.emptyInventoryPages ||
    nextListAttempts > SYNC_RECORD_LIMITS.inventoryListAttempts ||
    nextHeadAttempts > SYNC_RECORD_LIMITS.inventoryHeadGetAttempts ||
    nextUniqueBytes > SYNC_RECORD_LIMITS.inventoryUniqueHeadBodyBytes ||
    nextActualBytes > SYNC_RECORD_LIMITS.inventoryActualHeadBodyBytes ||
    nextEvidenceBytes > SYNC_RECORD_LIMITS.inventoryEvidenceBytes
  )
    return undefined;
  return {
    ...prior,
    cursor: record.outputCursor,
    lastKey: listedKey ?? prior.lastKey,
    emptyPageCount: nextEmptyPages,
    nextStep: prior.nextStep + 1,
    listPageCount: prior.listPageCount + 1,
    headCount: nextHeadCount,
    listAttemptCount: nextListAttempts,
    headGetAttemptCount: nextHeadAttempts,
    uniqueHeadBodyBytes: nextUniqueBytes,
    actualHeadBodyBytes: nextActualBytes,
    evidenceBytes: nextEvidenceBytes,
    chunkCount: prior.chunkCount + 1,
    chunkHash: verified.hash,
    reservedAttempt: 0,
  };
}

/** Processes one admitted inventory step without deriving completeness from a LIST page.
 * @param manifest Exact scanning generation supplied by the runner after slot validation.
 * @param scratch Strict conditional manifest and immutable chunk persistence.
 * @param listing One-entry, vault-prefix-constrained R2 listing and head reader.
 * @param budget Shared invocation budget for every physical R2 call made by the collaborators.
 * @param clock Server clock for the durable scan lifetime.
 * @returns Progress or a typed failure; only a later finalizer can return complete.
 */
export async function runSyncInventoryStep(
  manifest: SyncRecordObservation<SyncInventoryManifest>,
  scratch: SyncR2InventoryScratch,
  listing: SyncR2InventoryListing,
  budget: SyncInventoryInvocationBudget,
  clock: SyncServerClock,
): Promise<SyncInventoryResult> {
  const { vaultId, inventoryId } = manifest.value;
  /** Persists terminal scan failure before its active slot can be released by continuation.
   * @param code Deterministic reason a further LIST must never remedy.
   * @returns Failure only after the failed manifest is durably confirmed.
   */
  async function markFailed(
    code: "inventory_incomplete" | "inventory_limit_exceeded",
  ): Promise<SyncInventoryResult> {
    const failed = await scratch.replaceManifest(manifest, {
      ...manifest.value,
      phase: "failed",
    });
    if (failed.kind === "throttled")
      return progress(vaultId, inventoryId, failed.retryAfterEpochMs);
    return failed.kind === "confirmed"
      ? { kind: "error", code }
      : { kind: "error", code: "effect_unknown", inventoryId };
  }
  if (manifest.value.phase !== "scanning")
    return { kind: "error", code: "inventory_incomplete" };
  if (manifest.value.expiresAtEpochMs <= clock())
    return { kind: "error", code: "inventory_expired" };
  if (manifest.value.cursor === null && manifest.value.listPageCount > 0) {
    return progress(vaultId, inventoryId);
  }
  if (manifest.value.nextStep >= SYNC_RECORD_LIMITS.inventorySteps) {
    if (!budget.reserve(3, STEP_CPU_ALLOWANCE_MS))
      return progress(vaultId, inventoryId);
    return markFailed("inventory_limit_exceeded");
  }
  if (
    !budget.reserve(
      manifest.value.schemaVersion === 2
        ? WITNESSED_STEP_R2_CALL_ALLOWANCE
        : STEP_R2_CALL_ALLOWANCE,
      STEP_CPU_ALLOWANCE_MS,
    )
  )
    return progress(vaultId, inventoryId);
  // A reserved attempt must first reconcile its deterministic chunk; it never replays a LIST by default.
  if (manifest.value.reservedAttempt !== 0) {
    const existing = await scratch.readChunk(
      vaultId,
      inventoryId,
      manifest.value.nextStep,
    );
    if (existing.kind === "unavailable")
      return { kind: "error", code: "effect_unknown", inventoryId };
    if (existing.kind === "invalid") return markFailed("inventory_incomplete");
    if (existing.kind === "observed") {
      const next = await successorManifest(manifest, existing.observation);
      if (next === undefined) return markFailed("inventory_incomplete");
      if (manifest.value.schemaVersion === 2) {
        const witness = await checkSyncInventoryCursor(
          manifest,
          existing.observation,
          next,
          scratch,
          clock,
        );
        if (witness.kind === "incomplete")
          return markFailed("inventory_incomplete");
        if (witness.kind === "effect_unknown") {
          return witness.retryAfterEpochMs === undefined
            ? { kind: "error", code: "effect_unknown", inventoryId }
            : {
                kind: "error",
                code: "effect_unknown",
                inventoryId,
                retryAfterEpochMs: witness.retryAfterEpochMs,
              };
        }
        if (witness.kind === "progress")
          return progress(vaultId, inventoryId, witness.retryAfterEpochMs);
      }
      const advanced = await scratch.replaceManifest(manifest, next);
      if (advanced.kind === "throttled")
        return progress(vaultId, inventoryId, advanced.retryAfterEpochMs);
      return advanced.kind === "confirmed"
        ? progress(vaultId, inventoryId)
        : { kind: "error", code: "effect_unknown", inventoryId };
    }
    if (manifest.value.reservedAttempt === 2)
      return markFailed("inventory_limit_exceeded");
  }
  const nextAttempt = manifest.value.reservedAttempt === 0 ? 1 : 2;
  const claimed = await scratch.replaceManifest(manifest, {
    ...manifest.value,
    reservedAttempt: nextAttempt,
  });
  if (claimed.kind === "throttled")
    return progress(vaultId, inventoryId, claimed.retryAfterEpochMs);
  if (claimed.kind !== "confirmed")
    return { kind: "error", code: "effect_unknown", inventoryId };
  const rawInputBytes =
    manifest.value.cursor === null
      ? new Uint8Array()
      : decodeBase64Url(manifest.value.cursor);
  const rawInput =
    rawInputBytes === undefined ? undefined : decodeUtf8(rawInputBytes);
  if (rawInput === undefined)
    return { kind: "error", code: "inventory_incomplete" };
  const listed = await listing.listHeads(
    vaultId,
    rawInput.length === 0 ? null : rawInput,
  );
  if (listed.kind !== "page")
    return { kind: "error", code: "storage_unavailable", inventoryId };
  if (listed.page.objects.length > 1)
    return { kind: "error", code: "inventory_incomplete" };
  const rawOutput = listed.page.truncated ? listed.page.cursor : null;
  if (
    rawOutput !== null &&
    (rawOutput === rawInput ||
      encoder.encode(rawOutput).byteLength > SYNC_RECORD_LIMITS.cursorBytes)
  ) {
    return { kind: "error", code: "inventory_incomplete" };
  }
  const object = listed.page.objects[0];
  let headSummary: SyncHeadSummary | null = null;
  let headBodyBytes = 0;
  if (object !== undefined) {
    const prefix = `${syncVaultPrefix(vaultId)}heads/`;
    if (
      !object.key.startsWith(prefix) ||
      !object.key.endsWith(".json") ||
      (manifest.value.lastKey !== null && object.key <= manifest.value.lastKey)
    ) {
      return { kind: "error", code: "inventory_incomplete" };
    }
    const pathKey = object.key.slice(prefix.length, -5);
    const path = decodeSyncPathKey(pathKey);
    if (path === undefined || syncHeadKey(vaultId, path) !== object.key) {
      return { kind: "error", code: "inventory_incomplete" };
    }
    const read = await listing.readHead(
      vaultId,
      object.key,
      SYNC_RECORD_LIMITS.headBytes,
    );
    if (read.kind !== "observed" || read.observation.value.path !== path) {
      return { kind: "error", code: "inventory_incomplete" };
    }
    headBodyBytes = read.observation.observed.bytes.byteLength;
    headSummary = {
      pathKey,
      revision: read.observation.value.revision,
      kind: read.observation.value.kind,
    };
  }
  const transcript = JSON.stringify({
    objectCount: object === undefined ? 0 : 1,
    keySha256: object === undefined ? null : await sha256Content(object.key),
    headBodyBytes,
    truncated: listed.page.truncated,
  });
  if (
    encoder.encode(transcript).byteLength >
    SYNC_RECORD_LIMITS.chunkTranscriptBytes
  ) {
    return { kind: "error", code: "inventory_limit_exceeded" };
  }
  const chunk: SyncInventoryChunk = {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    inventoryId,
    step: manifest.value.nextStep,
    previousChunkHash: manifest.value.chunkHash,
    inputCursorDigest: await sha256Content(rawInput),
    outputCursorDigest: await sha256Content(rawOutput ?? ""),
    outputCursor:
      rawOutput === null ? null : encodeBase64Url(encoder.encode(rawOutput)),
    truncated: listed.page.truncated,
    transcript,
    headSummary,
  };
  const created = await scratch.createChunk(chunk);
  if (created.kind === "throttled")
    return progress(vaultId, inventoryId, created.retryAfterEpochMs);
  return created.kind === "confirmed"
    ? progress(vaultId, inventoryId)
    : { kind: "error", code: "effect_unknown", inventoryId };
}
