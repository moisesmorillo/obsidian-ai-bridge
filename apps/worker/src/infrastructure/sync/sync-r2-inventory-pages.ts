import type { SyncStore } from "@core/sync/sync-store.port";
import type {
  SyncCompleteInventory,
  SyncInventorySummary,
  SyncReadInventoryPageResult,
} from "@core/sync/sync-store.types";
import {
  type ContentSha256,
  createContentSha256,
  decodeBase64Url,
  decodeUtf8,
  encodeBase64Url,
} from "@obsidian-ai-bridge/core";
import { decodeSyncPathKey } from "@protocol/sync.codec";
import {
  syncInventoryIdSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type { SyncR2InventoryScratch } from "@worker/infrastructure/sync/sync-r2-inventory";
import type { SyncInventoryInvocationBudget } from "@worker/infrastructure/sync/sync-r2-inventory-budget";
import type { SyncInventoryChunkPosition } from "@worker/infrastructure/sync/sync-r2-inventory-evidence";
import { verifySyncInventoryChunk } from "@worker/infrastructure/sync/sync-r2-inventory-evidence";
import type { SyncServerClock } from "@worker/infrastructure/sync/sync-r2-mutation.types";
import { SYNC_RECORD_LIMITS } from "@worker/infrastructure/sync/sync-record.schemas";
import { sha256Content } from "@worker/storage/storage-crypto";
import { z } from "zod";

/** Maximum contiguous immutable chunks inspected in one evidence response. */
const EVIDENCE_CHUNKS_PER_CALL = 16;
/** Validates a canonical SHA-256 digest before it becomes evidence cursor authority. */
const digestSchema = z.custom<ContentSha256>(
  (value) =>
    typeof value === "string" && createContentSha256(value) !== undefined,
);
/** Private versioned continuation state; it contains digests, never an R2 listing cursor. */
const evidenceCursorSchema = z
  .object({
    version: z.literal(1),
    vaultId: syncVaultIdSchema,
    inventoryId: syncInventoryIdSchema,
    root: digestSchema,
    vectorDigest: digestSchema,
    step: z.number().int().min(0).max(SYNC_RECORD_LIMITS.inventorySteps),
    count: z.number().int().min(0).max(SYNC_RECORD_LIMITS.inventoryHeads),
    evidenceBytes: z
      .number()
      .int()
      .min(0)
      .max(SYNC_RECORD_LIMITS.inventoryEvidenceBytes),
    priorHash: digestSchema.nullable(),
    inputDigest: digestSchema,
    lastKey: z.string().nullable(),
  })
  .strict();
/** Canonical UTF-8 bytes for the bounded private evidence continuation. */
const encoder = new TextEncoder();

/** Encodes one strict private evidence position without disclosing the R2 list cursor.
 * @param checkpoint Vault/scan/root-bound continuation after verified chunks.
 * @returns Canonical opaque base64url checkpoint.
 */
function encodeEvidenceCursor(
  checkpoint: z.infer<typeof evidenceCursorSchema>,
): string {
  return encodeBase64Url(
    encoder.encode(JSON.stringify(evidenceCursorSchema.parse(checkpoint))),
  );
}

/** Decodes and validates a canonical evidence position as one unit.
 * @param cursor Untrusted caller-supplied opaque continuation.
 * @returns Strict checkpoint, or undefined for malformed/noncanonical bytes.
 */
function decodeEvidenceCursor(
  cursor: string,
): z.infer<typeof evidenceCursorSchema> | undefined {
  if (cursor.length > 8192) return undefined;
  const raw = decodeBase64Url(cursor);
  const text = raw === undefined ? undefined : decodeUtf8(raw);
  if (text === undefined) return undefined;
  try {
    const parsed = evidenceCursorSchema.safeParse(JSON.parse(text));
    if (!parsed.success || encodeEvidenceCursor(parsed.data) !== cursor)
      return undefined;
    return parsed.data;
  } catch {
    return undefined;
  }
}

/** Verifies handle identity and binds it to the exact complete manifest and released slot.
 * @param handle Untrusted complete-handle value from the caller.
 * @param manifest Persisted strict completed scan value.
 * @returns Whether every handle field matches the complete persisted authority.
 */
function matchesCompleteHandle(
  handle: SyncCompleteInventory,
  manifest: Awaited<ReturnType<SyncR2InventoryScratch["readManifest"]>>,
): boolean {
  return (
    manifest.kind === "observed" &&
    manifest.observation.value.schemaVersion === 2 &&
    manifest.observation.value.phase === "complete" &&
    manifest.observation.value.cursor === null &&
    manifest.observation.value.reservedAttempt === 0 &&
    manifest.observation.value.nextStep ===
      manifest.observation.value.chunkCount &&
    manifest.observation.value.vaultId === handle.vaultId &&
    manifest.observation.value.inventoryId === handle.inventoryId &&
    manifest.observation.value.chunkHash === handle.root &&
    manifest.observation.value.chunkCount === handle.chunkCount &&
    manifest.observation.value.headCount === handle.entryCount &&
    JSON.stringify(manifest.observation.value.startVector) ===
      JSON.stringify(handle.vector)
  );
}

/** Pages immutable evidence only after both complete manifest and empty slot are verified.
 * @param scratch Strict read-only manifest/active-slot/chunk capability.
 * @param budget Physical-call reservation shared with every underlying storage facade.
 * @param clock Server time that fences the manifest's 24-hour scratch lifetime.
 * @returns Content-free inventory evidence pages with a strict final chain marker.
 */
export function syncR2InventoryPages(
  scratch: SyncR2InventoryScratch,
  budget: SyncInventoryInvocationBudget,
  clock: SyncServerClock,
): Pick<SyncStore, "readInventoryPage"> {
  return {
    async readInventoryPage({
      vaultId,
      handle,
      cursor,
    }): Promise<SyncReadInventoryPageResult> {
      if (
        !syncVaultIdSchema.safeParse(vaultId).success ||
        !syncInventoryIdSchema.safeParse(handle.inventoryId).success ||
        handle.vaultId !== vaultId ||
        !Array.isArray(handle.vector) ||
        handle.vector.length !== 64 ||
        !handle.vector.every(
          (value) => syncSequenceSchema.safeParse(value).success,
        ) ||
        !Number.isSafeInteger(handle.chunkCount) ||
        handle.chunkCount < 1 ||
        handle.chunkCount > SYNC_RECORD_LIMITS.inventorySteps ||
        !Number.isSafeInteger(handle.entryCount) ||
        handle.entryCount < 0 ||
        handle.entryCount > SYNC_RECORD_LIMITS.inventoryHeads
      ) {
        return { kind: "error", code: "invalid_input" };
      }
      const vectorDigest = await sha256Content(JSON.stringify(handle.vector));
      const zeroDigest = await sha256Content("");
      const checkpoint =
        cursor === ""
          ? {
              version: 1 as const,
              vaultId,
              inventoryId: handle.inventoryId,
              root: handle.root,
              vectorDigest,
              step: 0,
              count: 0,
              evidenceBytes: 0,
              priorHash: null,
              inputDigest: zeroDigest,
              lastKey: null,
            }
          : decodeEvidenceCursor(cursor);
      if (
        checkpoint === undefined ||
        checkpoint.vaultId !== vaultId ||
        checkpoint.inventoryId !== handle.inventoryId ||
        checkpoint.root !== handle.root ||
        checkpoint.vectorDigest !== vectorDigest ||
        checkpoint.step >= handle.chunkCount
      ) {
        return { kind: "error", code: "inventory_incomplete" };
      }
      if (!budget.reserve(2 + EVIDENCE_CHUNKS_PER_CALL, 1))
        return {
          kind: "error",
          code: "storage_unavailable",
          inventoryId: handle.inventoryId,
        };
      const manifest = await scratch.readManifest(vaultId, handle.inventoryId);
      if (manifest.kind === "unavailable")
        return {
          kind: "error",
          code: "storage_unavailable",
          inventoryId: handle.inventoryId,
        };
      if (
        manifest.kind !== "observed" ||
        !matchesCompleteHandle(handle, manifest)
      )
        return { kind: "error", code: "inventory_incomplete" };
      if (manifest.observation.value.expiresAtEpochMs <= clock())
        return { kind: "error", code: "inventory_expired" };
      const slot = await scratch.readActive(vaultId);
      if (slot.kind === "unavailable")
        return {
          kind: "error",
          code: "storage_unavailable",
          inventoryId: handle.inventoryId,
        };
      if (slot.kind !== "observed" || slot.observation.value.state !== "empty")
        return { kind: "error", code: "inventory_incomplete" };
      let step = checkpoint.step;
      let count = checkpoint.count;
      let evidenceBytes = checkpoint.evidenceBytes;
      let priorHash = checkpoint.priorHash;
      let inputDigest = checkpoint.inputDigest;
      let lastKey = checkpoint.lastKey;
      const summaries: SyncInventorySummary[] = [];
      for (
        let readCount = 0;
        readCount < EVIDENCE_CHUNKS_PER_CALL && step < handle.chunkCount;
        readCount += 1
      ) {
        const read = await scratch.readChunk(vaultId, handle.inventoryId, step);
        if (read.kind === "unavailable")
          return {
            kind: "error",
            code: "storage_unavailable",
            inventoryId: handle.inventoryId,
          };
        if (read.kind !== "observed")
          return { kind: "error", code: "inventory_incomplete" };
        const position: SyncInventoryChunkPosition = {
          vaultId,
          inventoryId: handle.inventoryId,
          nextStep: step,
          chunkHash: priorHash,
          inputCursorDigest: inputDigest,
          lastKey,
        };
        const verified = await verifySyncInventoryChunk(
          position,
          read.observation,
        );
        if (verified === undefined)
          return { kind: "error", code: "inventory_incomplete" };
        if (verified.record.headSummary !== null) {
          const path = decodeSyncPathKey(verified.record.headSummary.pathKey);
          if (path === undefined)
            return { kind: "error", code: "inventory_incomplete" };
          summaries.push({
            path,
            kind: verified.record.headSummary.kind,
            revision: verified.record.headSummary.revision,
          });
          count += 1;
        }
        step += 1;
        evidenceBytes += verified.byteSize;
        priorHash = verified.hash;
        inputDigest = verified.record.outputCursorDigest;
        lastKey = verified.listedKey ?? lastKey;
        if (
          count > handle.entryCount ||
          evidenceBytes > manifest.observation.value.evidenceBytes ||
          (step < handle.chunkCount && !verified.record.truncated)
        ) {
          return { kind: "error", code: "inventory_incomplete" };
        }
      }
      if (step === handle.chunkCount) {
        if (
          count !== handle.entryCount ||
          evidenceBytes !== manifest.observation.value.evidenceBytes ||
          priorHash !== handle.root ||
          manifest.observation.value.lastKey !== lastKey ||
          inputDigest !== zeroDigest
        ) {
          return { kind: "error", code: "inventory_incomplete" };
        }
        return { kind: "complete", summaries, nextCursor: null, final: true };
      }
      return {
        kind: "page",
        summaries,
        final: false,
        nextCursor: encodeEvidenceCursor({
          version: 1,
          vaultId,
          inventoryId: handle.inventoryId,
          root: handle.root,
          vectorDigest,
          step,
          count,
          evidenceBytes,
          priorHash,
          inputDigest,
          lastKey,
        }),
      };
    },
  };
}
