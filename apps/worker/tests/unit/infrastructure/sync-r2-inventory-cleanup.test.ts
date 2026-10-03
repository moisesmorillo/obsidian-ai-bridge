import { createContentSha256 } from "@obsidian-ai-bridge/core";
import {
  syncHeadKey,
  syncInventoryActiveKey,
  syncInventoryChunkKey,
  syncInventoryClaimKey,
  syncInventoryCursorWitnessKey,
  syncInventoryManifestKey,
} from "@protocol/sync.codec";
import {
  syncInventoryIdSchema,
  syncNotePathSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type {
  R2ConditionalBucketPort,
  R2ConditionalStoredObject,
} from "@worker/infrastructure/r2.types";
import { syncR2InventoryScratch } from "@worker/infrastructure/sync/sync-r2-inventory";
import { createSyncInventoryInvocationBudget } from "@worker/infrastructure/sync/sync-r2-inventory-budget";
import { reapExpiredSyncInventoryScratch } from "@worker/infrastructure/sync/sync-r2-inventory-cleanup";
import { syncR2InventoryRunner } from "@worker/infrastructure/sync/sync-r2-inventory-runner";
import { syncR2ObjectStore } from "@worker/infrastructure/sync/sync-r2-object";
import { syncR2Publication } from "@worker/infrastructure/sync/sync-r2-publication";
import { encodeSyncRecord } from "@worker/infrastructure/sync/sync-record.codec";
import type { SyncInventoryManifest } from "@worker/infrastructure/sync/sync-record.types";
import { describe, expect, it, vi } from "vitest";

const vaultId = syncVaultIdSchema.parse("11111111-1111-4111-8111-111111111111");
const inventoryId = syncInventoryIdSchema.parse(
  "22222222-2222-4222-8222-222222222222",
);
const now = 2_000_000_000_000;

/** Produces one strictly encoded expired manifest and empty active-slot object.
 * @returns Synthetic R2 bucket and raw operation spies.
 */
async function fixture() {
  const manifest: SyncInventoryManifest = {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    inventoryId,
    phase: "scanning",
    startVector: Array(64).fill(
      syncSequenceSchema.parse("00000000000000000000"),
    ),
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
    expiresAtEpochMs: now - 1,
  };
  const manifestKey = syncInventoryManifestKey(vaultId, inventoryId);
  const slotKey = syncInventoryActiveKey(vaultId);
  const bodies = new Map<string, Uint8Array>([
    [
      manifestKey,
      await encodeSyncRecord({ kind: "manifest", record: manifest }),
    ],
    [
      slotKey,
      await encodeSyncRecord({
        kind: "activeSlot",
        record: { schemaVersion: 1, protocolMajor: 1, vaultId, state: "empty" },
      }),
    ],
  ]);
  const get = vi.fn<R2ConditionalBucketPort["get"]>(async (key) => {
    const bytes = bodies.get(key);
    if (!bytes) return null;
    return {
      key,
      size: bytes.byteLength,
      etag: "etag",
      uploaded: new Date(now - 2_000),
      async arrayBuffer() {
        return bytes.slice().buffer;
      },
    } satisfies R2ConditionalStoredObject;
  });
  const list = vi.fn<R2ConditionalBucketPort["list"]>(async () => ({
    objects: [],
    truncated: false,
  }));
  const remove = vi.fn(async (key: string) => {
    bodies.delete(key);
  });
  const bucket = {
    get,
    list,
    delete: remove,
    async put() {
      throw new Error("Unexpected cleanup PUT");
    },
  };
  return { bucket, get, list, remove, bodies, manifest };
}

describe("expired inventory scratch reaper", () => {
  it.each(["absent", "malformed", "unavailable"] as const)(
    "does not list or delete scratch when the expiry-authorizing manifest is %s",
    async (failure) => {
      const state = await fixture();
      const manifestKey = syncInventoryManifestKey(vaultId, inventoryId);
      const scratchKey = syncInventoryChunkKey(vaultId, inventoryId, 0);
      state.bodies.set(scratchKey, new Uint8Array([1]));
      if (failure === "absent") state.bodies.delete(manifestKey);
      if (failure === "malformed")
        state.bodies.set(
          manifestKey,
          new TextEncoder().encode("{not canonical JSON"),
        );
      if (failure === "unavailable")
        state.get.mockRejectedValueOnce(
          new Error("Expiry manifest GET unavailable"),
        );
      const before = new Map(state.bodies);
      expect(
        await reapExpiredSyncInventoryScratch(
          vaultId,
          inventoryId,
          state.bucket,
          createSyncInventoryInvocationBudget(() => 20),
          () => now,
        ),
      ).toEqual({ kind: "deferred" });
      expect(state.list).not.toHaveBeenCalled();
      expect(state.remove).not.toHaveBeenCalled();
      expect(state.bodies).toEqual(before);
    },
  );

  it("classifies an unexpectedly rejected scratch-read capability as unavailable, not invalid evidence or proved absence", async () => {
    const state = await fixture();
    const objects = syncR2ObjectStore(state.bucket, () => now);
    const unavailable = syncR2InventoryScratch({
      ...objects,
      read: async () => {
        throw new Error("Scratch read capability unavailable");
      },
    });
    expect(await unavailable.readChunk(vaultId, inventoryId, 0)).toEqual({
      kind: "unavailable",
    });
    expect(state.get).not.toHaveBeenCalled();
    expect(state.list).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
    expect(
      await syncR2InventoryScratch(objects).readChunk(vaultId, inventoryId, 0),
    ).toEqual({ kind: "absent" });
  });
  it.each([
    "budget",
    "slot_absent",
    "list_failure",
    "empty_truncated",
    "multiple_keys",
    "delete_failure",
    "delete_unacknowledged",
    "still_present",
  ] as const)(
    "retains the no-reuse manifest across cleanup boundary %s",
    async (fault) => {
      const state = await fixture();
      const key = syncInventoryChunkKey(vaultId, inventoryId, 0);
      state.bodies.set(key, new Uint8Array([1]));
      state.list.mockResolvedValue({
        objects: [{ key, size: 1 }],
        truncated: false,
      });
      if (fault === "slot_absent")
        state.bodies.delete(syncInventoryActiveKey(vaultId));
      if (fault === "list_failure")
        state.list.mockRejectedValueOnce(new Error("R2 LIST failed"));
      if (fault === "empty_truncated")
        state.list.mockResolvedValue({
          objects: [],
          truncated: true,
          cursor: "next",
        });
      if (fault === "multiple_keys")
        state.list.mockResolvedValue({
          objects: [
            { key, size: 1 },
            { key, size: 1 },
          ],
          truncated: false,
        });
      if (fault === "delete_failure")
        state.remove.mockRejectedValueOnce(
          new Error("R2 DELETE failed before effect"),
        );
      if (fault === "delete_unacknowledged")
        state.remove.mockImplementationOnce(async (removed) => {
          state.bodies.delete(removed);
          throw new Error("R2 DELETE applied but response lost");
        });
      if (fault === "still_present")
        state.remove.mockImplementationOnce(async () => {});
      const budget = createSyncInventoryInvocationBudget(() =>
        fault === "budget" ? 0 : 20,
      );
      expect(
        await reapExpiredSyncInventoryScratch(
          vaultId,
          inventoryId,
          state.bucket,
          budget,
          () => now,
        ),
      ).toEqual({
        kind:
          fault === "budget" || fault === "slot_absent"
            ? "deferred"
            : "effect_unknown",
      });
      expect(
        state.bodies.has(syncInventoryManifestKey(vaultId, inventoryId)),
      ).toBe(true);
      expect(state.remove).toHaveBeenCalledTimes(
        ["delete_failure", "delete_unacknowledged", "still_present"].includes(
          fault,
        )
          ? 1
          : 0,
      );
      expect(budget.actualCalls).toBeLessThanOrEqual(8);
      if (fault === "delete_unacknowledged") {
        state.list.mockResolvedValue({ objects: [], truncated: false });
        expect(
          await reapExpiredSyncInventoryScratch(
            vaultId,
            inventoryId,
            state.bucket,
            createSyncInventoryInvocationBudget(() => 20),
            () => now,
          ),
        ).toEqual({ kind: "retained" });
        expect(
          state.bodies.has(syncInventoryManifestKey(vaultId, inventoryId)),
        ).toBe(true);
      }
    },
  );

  it("rejects malformed scan identities without listing or deleting any object", async () => {
    const state = await fixture();
    expect(
      await reapExpiredSyncInventoryScratch(
        vaultId,
        // @ts-expect-error Cleanup must validate external scan identities.
        "invalid-scan",
        state.bucket,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ),
    ).toEqual({ kind: "deferred" });
    expect(state.get).not.toHaveBeenCalled();
    expect(state.list).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
  });
  it("never deletes a head even when an R2 LIST response strays outside the validated scan prefix", async () => {
    const { bucket, list, remove } = await fixture();
    const head = syncHeadKey(vaultId, syncNotePathSchema.parse("note.md"));
    list.mockResolvedValue({
      objects: [{ key: head, size: 10 }],
      truncated: false,
    });
    const result = await reapExpiredSyncInventoryScratch(
      vaultId,
      inventoryId,
      bucket,
      createSyncInventoryInvocationBudget(() => 20),
      () => now,
    );
    expect(result.kind).not.toBe("reaped");
    expect(remove).not.toHaveBeenCalled();
  });

  it("defers all listing and deletion until exact manifest expiry", async () => {
    const { bucket, list, remove } = await fixture();
    expect(
      await reapExpiredSyncInventoryScratch(
        vaultId,
        inventoryId,
        bucket,
        createSyncInventoryInvocationBudget(() => 20),
        () => now - 2,
      ),
    ).toEqual({ kind: "deferred" });
    expect(list).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("cannot delete an expired scan still holding the active slot until its CAS release succeeds", async () => {
    const { bucket, list, remove, bodies } = await fixture();
    bodies.set(
      syncInventoryActiveKey(vaultId),
      await encodeSyncRecord({
        kind: "activeSlot",
        record: {
          schemaVersion: 1,
          protocolMajor: 1,
          vaultId,
          state: "active",
          inventoryId,
        },
      }),
    );
    expect(
      await reapExpiredSyncInventoryScratch(
        vaultId,
        inventoryId,
        bucket,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ),
    ).toEqual({ kind: "effect_unknown" });
    expect(list).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("retains the expired manifest as a no-reuse tombstone when its chunks are gone", async () => {
    const { bucket, list, remove } = await fixture();
    expect(
      await reapExpiredSyncInventoryScratch(
        vaultId,
        inventoryId,
        bucket,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ),
    ).toEqual({ kind: "retained" });
    expect(list).toHaveBeenCalledExactlyOnceWith({
      prefix: `${syncInventoryManifestKey(vaultId, inventoryId).slice(0, -"manifest.json".length)}chunks/`,
      limit: 1,
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it("prevents new admission under the same scan ID after all chunks are cleaned", async () => {
    const { bucket, bodies } = await fixture();
    const cleanup = await reapExpiredSyncInventoryScratch(
      vaultId,
      inventoryId,
      bucket,
      createSyncInventoryInvocationBudget(() => 20),
      () => now,
    );
    expect(cleanup).toEqual({ kind: "retained" });
    expect(bodies.has(syncInventoryManifestKey(vaultId, inventoryId))).toBe(
      true,
    );
    const objects = syncR2ObjectStore(bucket, () => now);
    const runner = syncR2InventoryRunner(
      syncR2InventoryScratch(objects),
      syncR2Publication(objects),
      createSyncInventoryInvocationBudget(() => 20),
      () => now,
    );
    expect(await runner.startInventory({ vaultId, inventoryId })).toEqual({
      kind: "error",
      code: "inventory_expired",
    });
  });

  it("never deletes a new same-ID generation created after its expired manifest was observed", async () => {
    const { bucket, list, remove, bodies, manifest } = await fixture();
    const key = syncInventoryManifestKey(vaultId, inventoryId);
    const fresh = await encodeSyncRecord({
      kind: "manifest",
      record: {
        ...manifest,
        expiresAtEpochMs: now + 86_400_000,
      },
    });
    list.mockImplementation(async () => {
      bodies.set(key, fresh);
      return { objects: [], truncated: false };
    });
    const result = await reapExpiredSyncInventoryScratch(
      vaultId,
      inventoryId,
      bucket,
      createSyncInventoryInvocationBudget(() => 20),
      () => now,
    );
    expect(result.kind).not.toBe("reaped");
    expect(remove).not.toHaveBeenCalledWith(key);
    expect(bodies.get(key)).toEqual(fresh);
  });

  it("reaps only canonical claim and witness keys under a strict expired v2 scan", async () => {
    const digest = createContentSha256("a".repeat(64));
    if (!digest) throw new Error("Invalid witness digest fixture");
    for (const key of [
      syncInventoryClaimKey(vaultId, inventoryId, 0),
      syncInventoryCursorWitnessKey(vaultId, inventoryId, digest),
    ]) {
      const { bucket, list, remove, bodies, manifest } = await fixture();
      bodies.set(
        syncInventoryManifestKey(vaultId, inventoryId),
        await encodeSyncRecord({
          kind: "manifest",
          record: {
            ...manifest,
            schemaVersion: 2,
            cursorWitnessMode: 1,
          },
        }),
      );
      bodies.set(key, new Uint8Array([1]));
      list.mockResolvedValue({ objects: [{ key, size: 1 }], truncated: false });
      const budget = createSyncInventoryInvocationBudget(() => 20);
      expect(
        await reapExpiredSyncInventoryScratch(
          vaultId,
          inventoryId,
          bucket,
          budget,
          () => now,
        ),
      ).toEqual({
        kind: "reaped",
        key,
      });
      expect(budget.actualCalls).toBeLessThanOrEqual(8);
      expect(remove).toHaveBeenCalledExactlyOnceWith(key);
      expect(bodies.has(syncInventoryManifestKey(vaultId, inventoryId))).toBe(
        true,
      );
    }
  });

  it("refuses noncanonical scratch lookalikes under an expired scan", async () => {
    const { bucket, list, remove, manifest } = await fixture();
    const prefix = syncInventoryManifestKey(vaultId, inventoryId).replace(
      "manifest.json",
      "chunks/",
    );
    for (const key of [
      `${prefix}claims/00.json`,
      `${prefix}claims/20001.json`,
      `${prefix}cursors/${"A".repeat(64)}.json`,
      syncInventoryManifestKey(vaultId, inventoryId),
    ]) {
      list.mockResolvedValue({ objects: [{ key, size: 1 }], truncated: false });
      expect(
        await reapExpiredSyncInventoryScratch(
          vaultId,
          inventoryId,
          bucket,
          createSyncInventoryInvocationBudget(() => 20),
          () => now,
        ),
      ).toEqual({
        kind: "effect_unknown",
      });
    }
    expect(manifest.schemaVersion).toBe(1);
    expect(remove).not.toHaveBeenCalled();
  });

  it("deletes only one expired chunk and confirms its absence, never a version or feed object", async () => {
    const { bucket, list, remove, bodies } = await fixture();
    const chunkKey = syncInventoryChunkKey(vaultId, inventoryId, 0);
    bodies.set(chunkKey, new Uint8Array([1]));
    list.mockResolvedValue({
      objects: [{ key: chunkKey, size: 1 }],
      truncated: false,
    });
    const budget = createSyncInventoryInvocationBudget(() => 20);
    const result = await reapExpiredSyncInventoryScratch(
      vaultId,
      inventoryId,
      bucket,
      budget,
      () => now,
    );
    expect(result).toEqual({ kind: "reaped", key: chunkKey });
    expect(budget.actualCalls).toBeLessThanOrEqual(8);
    expect(remove).toHaveBeenCalledExactlyOnceWith(chunkKey);
    expect(bodies.has(chunkKey)).toBe(false);
  });
});
