import { createContentSha256 } from "@obsidian-ai-bridge/core";
import {
  syncInventoryChunkKey,
  syncInventoryClaimKey,
  syncInventoryCursorWitnessKey,
  syncVaultPrefix,
} from "@protocol/sync.codec";
import { SYNC_OBJECT_SEGMENT } from "@protocol/sync.constants";
import {
  syncInventoryIdSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type { SyncInventoryIdDto, SyncVaultIdDto } from "@protocol/sync.types";
import type { R2ConditionalBucketPort } from "@worker/infrastructure/r2.types";
import { syncR2InventoryScratch } from "@worker/infrastructure/sync/sync-r2-inventory";
import type { SyncInventoryInvocationBudget } from "@worker/infrastructure/sync/sync-r2-inventory-budget";
import type { SyncServerClock } from "@worker/infrastructure/sync/sync-r2-mutation.types";
import { syncR2ObjectStore } from "@worker/infrastructure/sync/sync-r2-object";
import { SYNC_RECORD_LIMITS } from "@worker/infrastructure/sync/sync-record.schemas";

/** Isolated deletion authority; no mutation, feed or generic storage facade receives it. */
export interface SyncInventoryCleanupBucket extends R2ConditionalBucketPort {
  /** Removes only a key admitted by the cleanup policy after exact expiry evidence. */
  delete(key: string): Promise<void>;
}

/** Bounded result that never implies a live inventory has been removed. */
export type SyncInventoryCleanupResult =
  | { readonly kind: "deferred" | "effect_unknown" | "retained" }
  | { readonly kind: "reaped"; readonly key: string };

/** Admits only canonical chunk and version-permitted cursor scratch under an expired scan.
 * @param key Listed candidate returned under the exact scan prefix.
 * @param vaultId Validated vault namespace.
 * @param inventoryId Expired scan whose manifest remains permanent.
 * @param nextStep Last potentially reserved immutable chunk step.
 * @param version Historical v1 permits chunks only; v2 also permits journals and witnesses.
 * @returns Whether deletion is limited to this scan's canonical disposable scratch.
 */
function isExpiredScanKey(
  key: string,
  vaultId: SyncVaultIdDto,
  inventoryId: SyncInventoryIdDto,
  nextStep: number,
  version: 1 | 2,
): boolean {
  const prefix = `${syncVaultPrefix(vaultId)}${SYNC_OBJECT_SEGMENT.inventories}/${SYNC_OBJECT_SEGMENT.scans}/${inventoryId}/${SYNC_OBJECT_SEGMENT.chunks}/`;
  if (!key.startsWith(prefix)) return false;
  const suffix = key.slice(prefix.length);
  const claimPrefix = `${SYNC_OBJECT_SEGMENT.claims}/`;
  const stepSuffix = suffix.startsWith(claimPrefix)
    ? suffix.slice(claimPrefix.length)
    : suffix;
  if (/^(0|[1-9][0-9]*)\.json$/.test(stepSuffix)) {
    const step = Number(stepSuffix.slice(0, -5));
    if (
      !Number.isSafeInteger(step) ||
      step > nextStep ||
      step >= SYNC_RECORD_LIMITS.inventorySteps
    ) {
      return false;
    }
    return suffix === stepSuffix
      ? key === syncInventoryChunkKey(vaultId, inventoryId, step)
      : version === 2 &&
          key === syncInventoryClaimKey(vaultId, inventoryId, step);
  }
  const cursorPrefix = `${SYNC_OBJECT_SEGMENT.cursors}/`;
  if (
    version !== 2 ||
    !suffix.startsWith(cursorPrefix) ||
    !suffix.endsWith(".json")
  ) {
    return false;
  }
  const digest = createContentSha256(suffix.slice(cursorPrefix.length, -5));
  return (
    digest !== undefined &&
    key === syncInventoryCursorWitnessKey(vaultId, inventoryId, digest)
  );
}

/** Reaps at most one canonical expired scratch object, retaining the no-reuse manifest.
 * @param vaultId Strict sync-v1 vault namespace.
 * @param inventoryId Expired inventory whose manifest must remain available during proof.
 * @param bucket Cleanup-only deletion capability, never passed to mutation or generic records.
 * @param budget Fresh shared budget for every R2 read, LIST, write, DELETE and read-back.
 * @param clock Server time required to prove the manifest expiry before listing scratch.
 * @returns One confirmed removed scratch key, retained manifest, deferral, or uncertain deletion.
 */
export async function reapExpiredSyncInventoryScratch(
  vaultId: SyncVaultIdDto,
  inventoryId: SyncInventoryIdDto,
  bucket: SyncInventoryCleanupBucket,
  budget: SyncInventoryInvocationBudget,
  clock: SyncServerClock,
): Promise<SyncInventoryCleanupResult> {
  if (
    !syncVaultIdSchema.safeParse(vaultId).success ||
    !syncInventoryIdSchema.safeParse(inventoryId).success
  ) {
    return { kind: "deferred" };
  }
  if (!budget.reserve(8, 1)) return { kind: "deferred" };
  const counted = budget.wrap(bucket);
  const scratch = syncR2InventoryScratch(syncR2ObjectStore(counted, clock));
  const manifest = await scratch.readManifest(vaultId, inventoryId);
  if (manifest.kind !== "observed") return { kind: "deferred" };
  const now = clock();
  if (
    !Number.isSafeInteger(now) ||
    manifest.observation.value.expiresAtEpochMs > now
  ) {
    return { kind: "deferred" };
  }
  const slot = await scratch.readActive(vaultId);
  if (slot.kind !== "observed") return { kind: "deferred" };
  if (
    slot.observation.value.state === "active" &&
    slot.observation.value.inventoryId === inventoryId
  ) {
    const released = await scratch.replaceActive(slot.observation, {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      state: "empty",
    });
    return released.kind === "confirmed"
      ? { kind: "deferred" }
      : { kind: "effect_unknown" };
  }
  const prefix = `${syncVaultPrefix(vaultId)}${SYNC_OBJECT_SEGMENT.inventories}/${SYNC_OBJECT_SEGMENT.scans}/${inventoryId}/${SYNC_OBJECT_SEGMENT.chunks}/`;
  let page: Awaited<ReturnType<R2ConditionalBucketPort["list"]>>;
  try {
    page = await counted.list({ prefix, limit: 1 });
  } catch {
    return { kind: "effect_unknown" };
  }
  if (page.objects.length > 1 || (page.objects.length === 0 && page.truncated))
    return { kind: "effect_unknown" };
  if (page.objects.length === 0) return { kind: "retained" };
  const key = page.objects[0]?.key;
  if (
    key === undefined ||
    !isExpiredScanKey(
      key,
      vaultId,
      inventoryId,
      manifest.observation.value.nextStep,
      manifest.observation.value.schemaVersion,
    )
  ) {
    return { kind: "effect_unknown" };
  }
  try {
    await budget.wrapDelete((allowedKey) => bucket.delete(allowedKey))(key);
    const readback = await counted.get(key);
    return readback === null
      ? { kind: "reaped", key }
      : { kind: "effect_unknown" };
  } catch {
    return { kind: "effect_unknown" };
  }
}
