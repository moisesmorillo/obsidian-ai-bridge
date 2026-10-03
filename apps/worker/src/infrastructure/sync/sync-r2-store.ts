import type { SyncStore } from "@core/sync/sync-store.port";
import {
  syncInventoryIdSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type { R2ConditionalBucketPort } from "@worker/infrastructure/r2.types";
import { syncR2Feed } from "@worker/infrastructure/sync/sync-r2-feed";
import { syncR2InventoryScratch } from "@worker/infrastructure/sync/sync-r2-inventory";
import { createSyncInventoryInvocationBudget } from "@worker/infrastructure/sync/sync-r2-inventory-budget";
import { syncR2InventoryListing } from "@worker/infrastructure/sync/sync-r2-inventory-list";
import { syncR2InventoryPages } from "@worker/infrastructure/sync/sync-r2-inventory-pages";
import { syncR2InventoryRunner } from "@worker/infrastructure/sync/sync-r2-inventory-runner";
import {
  createSyncR2MutationInvocationFactory,
  syncR2Mutation,
} from "@worker/infrastructure/sync/sync-r2-mutation";
import type { SyncServerClock } from "@worker/infrastructure/sync/sync-r2-mutation.types";
import { syncR2ObjectStore } from "@worker/infrastructure/sync/sync-r2-object";
import { syncR2Publication } from "@worker/infrastructure/sync/sync-r2-publication";
import { syncR2Records } from "@worker/infrastructure/sync/sync-r2-records";

/** Builds the isolated nine-method sync port without importing it from Worker routes or plugin code.
 * @param bucket Conditional R2 binding whose keys remain under the sync-v1 vault prefix.
 * @param clock Server clock shared by mutation cooldown and inventory expiry.
 * @param remainingCpuAllowance Conservative per-request CPU headroom estimate; default zero prevents unqualified inventory work.
 * @returns Private store whose inventory invocations own fresh counted storage capabilities.
 */
export function createSyncR2Store(
  bucket: R2ConditionalBucketPort,
  clock: SyncServerClock,
  remainingCpuAllowance: () => number = () => 0,
): SyncStore {
  const readOnly = syncR2ObjectStore(bucket, clock);
  const mutation = syncR2Mutation(
    syncR2Records(readOnly),
    createSyncR2MutationInvocationFactory(bucket, clock),
    clock,
  );
  const feed = syncR2Feed(syncR2Publication(readOnly), clock);

  /** Creates fresh physical-call accounting for one inventory public method invocation.
   * @returns Marker-gated and scratch/listing facades sharing one counted raw bucket.
   */
  function inventoryInvocation() {
    const budget = createSyncInventoryInvocationBudget(remainingCpuAllowance);
    const countedBucket = budget.wrap(bucket);
    const objects = syncR2ObjectStore(countedBucket, clock);
    const publication = syncR2Publication(objects);
    const scratch = syncR2InventoryScratch(objects);
    const listing = syncR2InventoryListing(countedBucket);
    return {
      budget,
      publication,
      runner: syncR2InventoryRunner(
        scratch,
        publication,
        budget,
        clock,
        listing,
      ),
      pages: syncR2InventoryPages(scratch, budget, clock),
    };
  }

  return {
    ...mutation,
    readChanges: feed.readChanges,
    async startInventory(input) {
      if (
        !syncVaultIdSchema.safeParse(input.vaultId).success ||
        !syncInventoryIdSchema.safeParse(input.inventoryId).success
      )
        return { kind: "error", code: "invalid_input" };
      const invocation = inventoryInvocation();
      if (
        !invocation.budget.reserve(2, 1) ||
        (await invocation.publication.readLaneHead(input.vaultId, 0)).kind ===
          "unavailable"
      ) {
        return {
          kind: "error",
          code: "storage_unavailable",
          inventoryId: input.inventoryId,
        };
      }
      return invocation.runner.startInventory(input);
    },
    async continueInventory(input) {
      if (
        !syncVaultIdSchema.safeParse(input.vaultId).success ||
        !syncInventoryIdSchema.safeParse(input.inventoryId).success
      )
        return { kind: "error", code: "invalid_input" };
      const invocation = inventoryInvocation();
      if (
        !invocation.budget.reserve(2, 1) ||
        (await invocation.publication.readLaneHead(input.vaultId, 0)).kind ===
          "unavailable"
      ) {
        return {
          kind: "error",
          code: "storage_unavailable",
          inventoryId: input.inventoryId,
        };
      }
      return invocation.runner.continueInventory(input);
    },
    async readInventoryPage(input) {
      if (
        !syncVaultIdSchema.safeParse(input.vaultId).success ||
        !syncInventoryIdSchema.safeParse(input.handle.inventoryId).success
      )
        return { kind: "error", code: "invalid_input" };
      const invocation = inventoryInvocation();
      if (
        !invocation.budget.reserve(2, 1) ||
        (await invocation.publication.readLaneHead(input.vaultId, 0)).kind ===
          "unavailable"
      ) {
        return {
          kind: "error",
          code: "storage_unavailable",
          inventoryId: input.handle.inventoryId,
        };
      }
      return invocation.pages.readInventoryPage(input);
    },
  };
}
