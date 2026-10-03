import type { SyncStore } from "@core/sync/sync-store.port";
import type {
  SyncInventoryProgress,
  SyncInventoryResult,
} from "@core/sync/sync-store.types";
import { SYNC_FEED_LANE_COUNT } from "@protocol/sync.constants";
import {
  syncInventoryIdSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type { SyncInventoryIdDto, SyncVaultIdDto } from "@protocol/sync.types";
import type { SyncR2WriteResult } from "@worker/infrastructure/sync/sync-r2.types";
import type { SyncR2InventoryScratch } from "@worker/infrastructure/sync/sync-r2-inventory";
import type { SyncInventoryInvocationBudget } from "@worker/infrastructure/sync/sync-r2-inventory-budget";
import type { SyncR2InventoryListing } from "@worker/infrastructure/sync/sync-r2-inventory-list";
import { runSyncInventoryStep } from "@worker/infrastructure/sync/sync-r2-inventory-replay";
import type { SyncServerClock } from "@worker/infrastructure/sync/sync-r2-mutation.types";
import type { SyncR2Publication } from "@worker/infrastructure/sync/sync-r2-publication";
import type { SyncInventoryManifest } from "@worker/infrastructure/sync/sync-record.types";

/** Fixed 24-hour lifetime of one bounded scratch scan. */
const INVENTORY_LIFETIME_MS = 24 * 60 * 60 * 1_000;
/** Protocol-v1 zero feed position used before a scan has captured its start vector. */
const ZERO_SEQUENCE = syncSequenceSchema.parse("00000000000000000000");

/** Creates the strict initial scan state without claiming a complete inventory.
 * @param vaultId Validated vault namespace.
 * @param inventoryId Stable scan identity.
 * @param now Server time establishing this scan's immutable expiry.
 * @returns Persistable manifest with no cursor, attempts, pages, or evidence.
 */
function startingManifest(
  vaultId: SyncVaultIdDto,
  inventoryId: SyncInventoryIdDto,
  now: number,
): SyncInventoryManifest {
  return {
    schemaVersion: 2,
    cursorWitnessMode: 1,
    protocolMajor: 1,
    vaultId,
    inventoryId,
    phase: "starting",
    startVector: Array(SYNC_FEED_LANE_COUNT).fill(ZERO_SEQUENCE),
    cursor: null,
    lastKey: null,
    emptyPageCount: 0,
    nextStep: 0,
    listPageCount: 0,
    headCount: 0,
    listAttemptCount: 0,
    headGetAttemptCount: 0,
    uniqueHeadBodyBytes: 0,
    actualHeadBodyBytes: 0,
    evidenceBytes: 0,
    chunkCount: 0,
    chunkHash: null,
    reservedAttempt: 0,
    expiresAtEpochMs: now + INVENTORY_LIFETIME_MS,
  };
}

/** Admits one persistent scan identity before any active-slot or listing activity.
 * @param scratch Strict inventory manifest/slot persistence.
 * @param publication Marker-gated lane-head reader for later vector capture.
 * @param budget Shared physically counted invocation preflight capability.
 * @param clock Server time used for fixed scan expiry.
 * @param listing Optional one-page listing capability; required before a scanning continuation can run.
 * @returns Private bounded inventory admission and continuation methods.
 */
export function syncR2InventoryRunner(
  scratch: SyncR2InventoryScratch,
  publication: SyncR2Publication,
  budget: SyncInventoryInvocationBudget,
  clock: SyncServerClock,
  listing?: SyncR2InventoryListing,
): Pick<SyncStore, "startInventory" | "continueInventory"> {
  /** Returns a stable same-ID progress marker without claiming a complete scan.
   * @param vaultId Namespace of the reserved inventory.
   * @param inventoryId Identity a caller must reuse after interruption.
   * @returns Nonterminal progress only.
   */
  function progress(
    vaultId: SyncVaultIdDto,
    inventoryId: SyncInventoryIdDto,
  ): SyncInventoryProgress {
    return { kind: "inventory_in_progress", vaultId, inventoryId };
  }

  /** Preserves a definite write cooldown as a same-ID continuation, never a completed scan.
   * @param result Exact one-key write certainty.
   * @param vaultId Scan's immutable vault.
   * @param inventoryId Stable scan to resume.
   * @returns Progress on confirmation/throttle, uncertainty otherwise.
   */
  function writeProgress(
    result: SyncR2WriteResult,
    vaultId: SyncVaultIdDto,
    inventoryId: SyncInventoryIdDto,
  ): SyncInventoryResult {
    if (result.kind === "confirmed") return progress(vaultId, inventoryId);
    if (result.kind === "throttled") {
      return {
        ...progress(vaultId, inventoryId),
        retryAfterEpochMs: result.retryAfterEpochMs,
      };
    }
    return { kind: "error", code: "effect_unknown", inventoryId };
  }

  /** Releases a failed scan's exact active-slot generation on either same-ID resume entry.
   * @param vaultId Namespace owning the failed scan's exclusive slot.
   * @param inventoryId Persisted failed scan whose slot may still be active.
   * @returns Incomplete only after release or proof the slot no longer belongs to this scan.
   */
  async function releaseFailedScan(
    vaultId: SyncVaultIdDto,
    inventoryId: SyncInventoryIdDto,
  ): Promise<SyncInventoryResult> {
    if (!budget.reserve(4, 1)) return progress(vaultId, inventoryId);
    const slot = await scratch.readActive(vaultId);
    if (slot.kind !== "observed")
      return { kind: "error", code: "storage_unavailable", inventoryId };
    if (
      slot.observation.value.state === "empty" ||
      slot.observation.value.inventoryId !== inventoryId
    ) {
      return { kind: "error", code: "inventory_incomplete" };
    }
    const released = await scratch.replaceActive(slot.observation, {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      state: "empty",
    });
    if (released.kind === "confirmed")
      return { kind: "error", code: "inventory_incomplete" };
    return writeProgress(released, vaultId, inventoryId);
  }

  return {
    async startInventory({ vaultId, inventoryId }) {
      if (
        !syncVaultIdSchema.safeParse(vaultId).success ||
        !syncInventoryIdSchema.safeParse(inventoryId).success
      ) {
        return { kind: "error", code: "invalid_input" };
      }
      const now = clock();
      if (
        !Number.isSafeInteger(now) ||
        now < 0 ||
        !Number.isSafeInteger(now + INVENTORY_LIFETIME_MS)
      ) {
        return { kind: "error", code: "storage_unavailable", inventoryId };
      }
      // Initial manifest/slot admission may require three R2 calls for one conditional write.
      if (!budget.reserve(6, 1)) return progress(vaultId, inventoryId);
      const read = await scratch.readManifest(vaultId, inventoryId);
      if (read.kind === "unavailable")
        return { kind: "error", code: "storage_unavailable", inventoryId };
      if (read.kind === "observed") {
        if (read.observation.value.expiresAtEpochMs <= now)
          return { kind: "error", code: "inventory_expired" };
        if (read.observation.value.schemaVersion !== 2)
          return { kind: "error", code: "inventory_incomplete" };
        if (read.observation.value.phase === "failed")
          return releaseFailedScan(vaultId, inventoryId);
        if (read.observation.value.phase !== "starting")
          return progress(vaultId, inventoryId);
        const slot = await scratch.readActive(vaultId);
        if (slot.kind === "unavailable")
          return { kind: "error", code: "storage_unavailable", inventoryId };
        const target = {
          schemaVersion: 1,
          protocolMajor: 1,
          vaultId,
          state: "active",
          inventoryId,
        } as const;
        if (slot.kind === "absent") {
          const claim = await scratch.createActive(target);
          return writeProgress(claim, vaultId, inventoryId);
        }
        if (slot.observation.value.state === "active") {
          if (slot.observation.value.inventoryId !== inventoryId) {
            if (!budget.reserve(2, 1)) return progress(vaultId, inventoryId);
            const competingId = slot.observation.value.inventoryId;
            const competing = await scratch.readManifest(vaultId, competingId);
            if (competing.kind !== "observed")
              return {
                kind: "error",
                code: "storage_unavailable",
                inventoryId,
              };
            if (competing.observation.value.expiresAtEpochMs > now)
              return progress(vaultId, competingId);
            const claim = await scratch.replaceActive(slot.observation, target);
            return writeProgress(claim, vaultId, inventoryId);
          }
          // Each marker-gated lane read may make two physical R2 GET calls.
          if (!budget.reserve(SYNC_FEED_LANE_COUNT * 2 + 2, 1))
            return progress(vaultId, inventoryId);
          const vector = [];
          for (let lane = 0; lane < SYNC_FEED_LANE_COUNT; lane += 1) {
            const head = await publication.readLaneHead(vaultId, lane);
            if (head.kind === "unavailable")
              return {
                kind: "error",
                code: "storage_unavailable",
                inventoryId,
              };
            if (
              head.kind === "observed" &&
              head.observation.value.pending !== undefined
            ) {
              const failed = await scratch.replaceManifest(read.observation, {
                ...read.observation.value,
                phase: "failed",
              });
              return writeProgress(failed, vaultId, inventoryId);
            }
            vector.push(
              head.kind === "absent"
                ? ZERO_SEQUENCE
                : head.observation.value.committedSequence,
            );
          }
          const updated = await scratch.replaceManifest(read.observation, {
            ...read.observation.value,
            phase: "scanning",
            startVector: vector,
          });
          return writeProgress(updated, vaultId, inventoryId);
        }
        const claim = await scratch.replaceActive(slot.observation, target);
        return writeProgress(claim, vaultId, inventoryId);
      }
      const created = await scratch.createManifest(
        startingManifest(vaultId, inventoryId, now),
      );
      return writeProgress(created, vaultId, inventoryId);
    },
    async continueInventory({ vaultId, inventoryId }) {
      if (
        !syncVaultIdSchema.safeParse(vaultId).success ||
        !syncInventoryIdSchema.safeParse(inventoryId).success
      ) {
        return { kind: "error", code: "invalid_input" };
      }
      if (!budget.reserve(2, 1)) return progress(vaultId, inventoryId);
      const read = await scratch.readManifest(vaultId, inventoryId);
      if (read.kind !== "observed")
        return { kind: "error", code: "storage_unavailable", inventoryId };
      if (read.observation.value.expiresAtEpochMs <= clock())
        return { kind: "error", code: "inventory_expired" };
      if (read.observation.value.schemaVersion !== 2)
        return { kind: "error", code: "inventory_incomplete" };
      if (read.observation.value.phase === "failed")
        return releaseFailedScan(vaultId, inventoryId);
      if (read.observation.value.phase === "starting")
        return progress(vaultId, inventoryId);
      if (!budget.reserve(1, 0)) return progress(vaultId, inventoryId);
      const slot = await scratch.readActive(vaultId);
      if (slot.kind !== "observed")
        return { kind: "error", code: "storage_unavailable", inventoryId };
      if (read.observation.value.phase === "complete") {
        const root = read.observation.value.chunkHash;
        if (
          root === null ||
          (slot.observation.value.state === "active" &&
            slot.observation.value.inventoryId !== inventoryId)
        ) {
          return { kind: "error", code: "effect_unknown", inventoryId };
        }
        if (slot.observation.value.state === "active") {
          if (!budget.reserve(3, 1)) return progress(vaultId, inventoryId);
          const released = await scratch.replaceActive(slot.observation, {
            schemaVersion: 1,
            protocolMajor: 1,
            vaultId,
            state: "empty",
          });
          if (released.kind === "throttled")
            return {
              ...progress(vaultId, inventoryId),
              retryAfterEpochMs: released.retryAfterEpochMs,
            };
          if (released.kind !== "confirmed")
            return { kind: "error", code: "effect_unknown", inventoryId };
        }
        return {
          kind: "complete",
          vaultId,
          inventoryId,
          vector: read.observation.value.startVector,
          entryCount: read.observation.value.headCount,
          chunkCount: read.observation.value.chunkCount,
          root,
        };
      }
      if (
        slot.observation.value.state !== "active" ||
        slot.observation.value.inventoryId !== inventoryId
      ) {
        return { kind: "error", code: "effect_unknown", inventoryId };
      }
      if (
        read.observation.value.cursor === null &&
        read.observation.value.listPageCount > 0
      ) {
        if (!budget.reserve(SYNC_FEED_LANE_COUNT * 2 + 3, 1))
          return progress(vaultId, inventoryId);
        for (let lane = 0; lane < SYNC_FEED_LANE_COUNT; lane += 1) {
          const head = await publication.readLaneHead(vaultId, lane);
          if (head.kind === "unavailable")
            return { kind: "error", code: "storage_unavailable", inventoryId };
          if (
            head.kind === "observed" &&
            head.observation.value.pending !== undefined
          ) {
            return { kind: "error", code: "effect_unknown", inventoryId };
          }
          const position =
            head.kind === "absent"
              ? ZERO_SEQUENCE
              : head.observation.value.committedSequence;
          if (position !== read.observation.value.startVector[lane]) {
            return { kind: "error", code: "effect_unknown", inventoryId };
          }
        }
        const finished = await scratch.replaceManifest(read.observation, {
          ...read.observation.value,
          phase: "complete",
        });
        return writeProgress(finished, vaultId, inventoryId);
      }
      if (listing === undefined)
        return { kind: "error", code: "storage_unavailable", inventoryId };
      return runSyncInventoryStep(
        read.observation,
        scratch,
        listing,
        budget,
        clock,
      );
    },
  };
}
