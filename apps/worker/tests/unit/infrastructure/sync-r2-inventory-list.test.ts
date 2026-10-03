import { createContentSha256 } from "@obsidian-ai-bridge/core";
import { syncHeadKey, syncVaultPrefix } from "@protocol/sync.codec";
import {
  syncDeviceIdSchema,
  syncNotePathSchema,
  syncOperationIdSchema,
  syncRevisionSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type { R2ConditionalBucketPort } from "@worker/infrastructure/r2.types";
import { syncR2InventoryListing } from "@worker/infrastructure/sync/sync-r2-inventory-list";
import { encodeSyncRecord } from "@worker/infrastructure/sync/sync-record.codec";
import type { SyncHeadRecord } from "@worker/infrastructure/sync/sync-record.types";
import { describe, expect, it, vi } from "vitest";

const vaultId = syncVaultIdSchema.parse("11111111-1111-4111-8111-111111111111");
const otherVault = syncVaultIdSchema.parse(
  "22222222-2222-4222-8222-222222222222",
);
const path = syncNotePathSchema.parse("notes/inventory.md");

/** Provides raw R2 behavior with no trusted inventory data.
 * @returns Conditional binding and exact raw-call spies.
 */
function fixture() {
  const list = vi.fn<R2ConditionalBucketPort["list"]>(async () => ({
    objects: [],
    truncated: false,
  }));
  const get = vi.fn<R2ConditionalBucketPort["get"]>(async () => null);
  const bucket: R2ConditionalBucketPort = {
    list,
    get,
    async put() {
      throw new Error("Inventory listing must never write");
    },
  };
  return { listing: syncR2InventoryListing(bucket), list, get };
}

describe("inventory listing boundary", () => {
  it("does not dispatch a LIST with an empty continuation and maps a rejected LIST to unavailable evidence", async () => {
    const { listing, list } = fixture();
    expect(await listing.listHeads(vaultId, "")).toEqual({
      kind: "unavailable",
    });
    expect(list).not.toHaveBeenCalled();
    list.mockRejectedValueOnce(new Error("R2 LIST unavailable"));
    expect(await listing.listHeads(vaultId, null)).toEqual({
      kind: "unavailable",
    });
    expect(list).toHaveBeenCalledExactlyOnceWith({
      prefix: `${syncVaultPrefix(vaultId)}heads/`,
      limit: 1,
    });
  });

  it.each([-1, Number.NaN, 2_049])(
    "rejects an unsafe head byte bound %s before GET",
    async (limit) => {
      const { listing, get } = fixture();
      expect(
        await listing.readHead(vaultId, syncHeadKey(vaultId, path), limit),
      ).toEqual({ kind: "unavailable" });
      expect(get).not.toHaveBeenCalled();
    },
  );

  it("withholds an observed head whose bounded body cannot be decoded", async () => {
    const { listing, get } = fixture();
    const key = syncHeadKey(vaultId, path);
    const bytes = new TextEncoder().encode("{");
    get.mockResolvedValue({
      key,
      etag: "broken-head",
      uploaded: new Date(1_000),
      size: bytes.byteLength,
      async arrayBuffer() {
        return bytes.slice().buffer;
      },
    });
    expect(await listing.readHead(vaultId, key, 2_048)).toEqual({
      kind: "unavailable",
    });
    expect(get).toHaveBeenCalledExactlyOnceWith(key);
  });
  it("lists only the caller's sync-v1 heads prefix at limit one with a private opaque cursor", async () => {
    const { listing, list } = fixture();
    expect(await listing.listHeads(vaultId, "opaque-cursor")).toEqual({
      kind: "page",
      page: { objects: [], truncated: false },
    });
    expect(list).toHaveBeenCalledExactlyOnceWith({
      prefix: `${syncVaultPrefix(vaultId)}heads/`,
      cursor: "opaque-cursor",
      limit: 1,
    });
  });

  it("refuses malformed continuation pages rather than manufacturing a durable cursor", async () => {
    const { listing, list } = fixture();
    list.mockResolvedValue({ objects: [], truncated: true, cursor: "" });
    expect(await listing.listHeads(vaultId, null)).toEqual({
      kind: "unavailable",
    });
    const missing = { objects: [], truncated: true, cursor: "opaque" };
    Object.defineProperty(missing, "cursor", { value: undefined });
    list.mockResolvedValue(missing);
    expect(await listing.listHeads(vaultId, null)).toEqual({
      kind: "unavailable",
    });
  });

  it("never GETs a foreign vault, recovery key or malformed head key", async () => {
    const { listing, get } = fixture();
    expect(
      await listing.readHead(vaultId, syncHeadKey(otherVault, path), 2048),
    ).toEqual({ kind: "unavailable" });
    expect(
      await listing.readHead(
        vaultId,
        `${syncVaultPrefix(vaultId)}heads/invalid!.json`,
        2048,
      ),
    ).toEqual({ kind: "unavailable" });
    expect(
      await listing.readHead(
        vaultId,
        `${syncVaultPrefix(vaultId)}recovery/fake.json`,
        2048,
      ),
    ).toEqual({ kind: "unavailable" });
    expect(get).not.toHaveBeenCalled();
  });

  it("returns only strictly decoded bounded head metadata without note content", async () => {
    const { listing, get } = fixture();
    const contentSha256 = createContentSha256(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    if (!contentSha256) throw new Error("Invalid digest fixture");
    const record: SyncHeadRecord = {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      path,
      kind: "live",
      parent: { kind: "never_seen" },
      revision: syncRevisionSchema.parse(
        "33333333-3333-4333-8333-333333333333",
      ),
      operationId: syncOperationIdSchema.parse(
        "44444444-4444-4444-8444-444444444444",
      ),
      origin: syncDeviceIdSchema.parse("55555555-5555-4555-8555-555555555555"),
      contentSha256,
      byteSize: 4,
      mediaType: "text/markdown",
    };
    const key = syncHeadKey(vaultId, path);
    const bytes = await encodeSyncRecord({ kind: "head", record });
    get.mockResolvedValue({
      key,
      etag: "etag",
      uploaded: new Date(1_000),
      size: bytes.byteLength,
      async arrayBuffer() {
        return bytes.slice().buffer;
      },
    });
    const read = await listing.readHead(vaultId, key, 2048);
    expect(read.kind).toBe("observed");
    if (read.kind === "observed")
      expect(read.observation.value).toEqual(record);
    expect(get).toHaveBeenCalledExactlyOnceWith(key);
  });
});
