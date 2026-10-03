import type { SyncCompleteInventory } from "@core/sync/sync-store.types";
import { createContentSha256 } from "@obsidian-ai-bridge/core";
import { syncVaultMarkerKey } from "@protocol/sync.codec";
import {
  syncInventoryIdSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type { R2ConditionalBucketPort } from "@worker/infrastructure/r2.types";
import { createSyncR2Store } from "@worker/infrastructure/sync/sync-r2-store";
import { encodeSyncRecord } from "@worker/infrastructure/sync/sync-record.codec";
import { describe, expect, it, vi } from "vitest";

const vaultId = syncVaultIdSchema.parse("11111111-1111-4111-8111-111111111111");
const inventoryId = syncInventoryIdSchema.parse(
  "22222222-2222-4222-8222-222222222222",
);

/** Keeps every synthetic storage request visible in a private composition test.
 * @param marker Optional strictly encoded isolated sync-v1 marker body.
 * @returns Empty conditional R2 port with read, list and write call spies.
 */
function emptyBucket(marker?: Uint8Array) {
  const get = vi.fn<R2ConditionalBucketPort["get"]>(async (key) => {
    if (key !== syncVaultMarkerKey(vaultId) || marker === undefined)
      return null;
    return {
      key,
      size: marker.byteLength,
      etag: "marker-etag",
      uploaded: new Date(1_000),
      async arrayBuffer() {
        return marker.slice().buffer;
      },
    };
  });
  const put = vi.fn<R2ConditionalBucketPort["put"]>(async () => null);
  const list = vi.fn<R2ConditionalBucketPort["list"]>(async () => ({
    objects: [],
    truncated: false,
  }));
  return {
    bucket: { get, put, list } satisfies R2ConditionalBucketPort,
    get,
    put,
    list,
  };
}

describe("private nine-method sync store", () => {
  it("requires explicit CPU admission for inventory even when the store factory's allowance is omitted", async () => {
    const { bucket, get, put, list } = emptyBucket();
    const store = createSyncR2Store(bucket, () => 2_000_000_000_000);
    expect(await store.startInventory({ vaultId, inventoryId })).toEqual({
      kind: "error",
      code: "storage_unavailable",
      inventoryId,
    });
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("forwards an admitted complete-handle page lookup without allowing an unknown manifest to authorize a page", async () => {
    const marker = await encodeSyncRecord({
      kind: "vaultMarker",
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
    });
    const { bucket, get, put, list } = emptyBucket(marker);
    const root = createContentSha256("a".repeat(64));
    if (!root) throw new Error("Expected handle root");
    const handle: SyncCompleteInventory = {
      kind: "complete",
      vaultId,
      inventoryId,
      root,
      vector: Array.from({ length: 64 }, () =>
        syncSequenceSchema.parse("00000000000000000000"),
      ),
      entryCount: 0,
      chunkCount: 1,
    };
    const cpu = vi.fn(() => 20);
    expect(
      await createSyncR2Store(
        bucket,
        () => 2_000_000_000_000,
        cpu,
      ).readInventoryPage({ vaultId, handle, cursor: "" }),
    ).toEqual({ kind: "error", code: "inventory_incomplete" });
    expect(cpu).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });
  it("rejects malformed inventory identities before creating counted R2 capabilities", async () => {
    const { bucket, get, put, list } = emptyBucket();
    const cpu = vi.fn(() => 20);
    const store = createSyncR2Store(bucket, () => 2_000_000_000_000, cpu);
    const root = createContentSha256("a".repeat(64));
    if (!root) throw new Error("Expected root");
    const handle: SyncCompleteInventory = {
      kind: "complete",
      vaultId,
      inventoryId,
      root,
      vector: Array(64).fill(syncSequenceSchema.parse("00000000000000000000")),
      entryCount: 0,
      chunkCount: 1,
    };
    expect(
      // @ts-expect-error Caller-controlled IDs must be validated before admission.
      await store.startInventory({ vaultId, inventoryId: "invalid-id" }),
    ).toEqual({ kind: "error", code: "invalid_input" });
    expect(
      // @ts-expect-error Caller-controlled IDs must be validated before continuation.
      await store.continueInventory({ vaultId: "invalid-vault", inventoryId }),
    ).toEqual({ kind: "error", code: "invalid_input" });
    expect(
      await store.readInventoryPage({
        vaultId,
        // @ts-expect-error A forged handle cannot bypass inventory identity validation.
        handle: { ...handle, inventoryId: "invalid-id" },
        cursor: "",
      }),
    ).toEqual({ kind: "error", code: "invalid_input" });
    expect(cpu).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });
  it("refuses all three inventory operations before R2 when CPU allowance is exhausted", async () => {
    const { bucket, get, put, list } = emptyBucket();
    const root = createContentSha256("a".repeat(64));
    if (!root) throw new Error("Invalid inventory root fixture");
    const handle: SyncCompleteInventory = {
      kind: "complete",
      vaultId,
      inventoryId,
      root,
      vector: Array(64).fill(syncSequenceSchema.parse("00000000000000000000")),
      entryCount: 0,
      chunkCount: 1,
    };
    const store = createSyncR2Store(
      bucket,
      () => 2_000_000_000_000,
      () => 0,
    );
    expect(await store.startInventory({ vaultId, inventoryId })).toEqual({
      kind: "error",
      code: "storage_unavailable",
      inventoryId,
    });
    expect(await store.continueInventory({ vaultId, inventoryId })).toEqual({
      kind: "error",
      code: "storage_unavailable",
      inventoryId,
    });
    expect(
      await store.readInventoryPage({ vaultId, handle, cursor: "" }),
    ).toEqual({
      kind: "error",
      code: "storage_unavailable",
      inventoryId,
    });
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });
  it("gates inventory admission on the isolated vault marker before any scratch write", async () => {
    const { bucket, get, put, list } = emptyBucket();
    const store = createSyncR2Store(
      bucket,
      () => 2_000_000_000_000,
      () => 20,
    );
    expect(Object.keys(store).sort()).toEqual(
      [
        "readCurrent",
        "mutate",
        "readVersion",
        "readRecovery",
        "readChanges",
        "startInventory",
        "continueInventory",
        "readInventoryPage",
        "resumeOperation",
      ].sort(),
    );
    expect(await store.startInventory({ vaultId, inventoryId })).toEqual({
      kind: "error",
      code: "storage_unavailable",
      inventoryId,
    });
    expect(get).toHaveBeenCalled();
    expect(await store.continueInventory({ vaultId, inventoryId })).toEqual({
      kind: "error",
      code: "storage_unavailable",
      inventoryId,
    });
    const root = createContentSha256("a".repeat(64));
    if (!root) throw new Error("Expected inventory root");
    const handle: SyncCompleteInventory = {
      kind: "complete",
      vaultId,
      inventoryId,
      root,
      vector: Array(64).fill(syncSequenceSchema.parse("00000000000000000000")),
      entryCount: 0,
      chunkCount: 1,
    };
    expect(
      await store.readInventoryPage({ vaultId, handle, cursor: "" }),
    ).toEqual({ kind: "error", code: "storage_unavailable", inventoryId });
    expect(put).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(await store.readChanges({ vaultId, cursor: "!" })).toEqual({
      kind: "error",
      code: "invalid_cursor",
    });
  });

  it("uses one counted binding for marker admission and scratch writes without listing legacy namespaces", async () => {
    const marker = await encodeSyncRecord({
      kind: "vaultMarker",
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
    });
    const { bucket, put, list } = emptyBucket(marker);
    const store = createSyncR2Store(
      bucket,
      () => 2_000_000_000_000,
      () => 20,
    );
    expect(await store.startInventory({ vaultId, inventoryId })).toEqual({
      kind: "error",
      code: "effect_unknown",
      inventoryId,
    });
    expect(put).toHaveBeenCalled();
    expect(
      put.mock.calls.every(([key]) =>
        key.startsWith(`sync/v1/vaults/${vaultId}/`),
      ),
    ).toBe(true);
    expect(list).not.toHaveBeenCalled();
    expect(await store.continueInventory({ vaultId, inventoryId })).toEqual({
      kind: "error",
      code: "storage_unavailable",
      inventoryId,
    });
  });
});
