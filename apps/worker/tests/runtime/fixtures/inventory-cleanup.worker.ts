import { createContentSha256 } from "@obsidian-ai-bridge/core";
import {
  syncInventoryActiveKey,
  syncInventoryChunkKey,
  syncInventoryClaimKey,
  syncInventoryCursorWitnessKey,
  syncInventoryManifestKey,
} from "@protocol/sync.codec";
import {
  MAX_INVENTORY_SUBREQUESTS_PER_INVOCATION,
  SYNC_FEED_LANE_COUNT,
} from "@protocol/sync.constants";
import {
  syncInventoryIdSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import { createSyncInventoryInvocationBudget } from "@worker/infrastructure/sync/sync-r2-inventory-budget";
import {
  reapExpiredSyncInventoryScratch,
  type SyncInventoryCleanupBucket,
} from "@worker/infrastructure/sync/sync-r2-inventory-cleanup";
import { encodeSyncRecord } from "@worker/infrastructure/sync/sync-record.codec";
import { z } from "zod";

/** Future injected epoch proves synthetic expiry; it is not throughput, CPU or real-time expiry evidence. */
const CLOCK_MS = 2_000_000_000_000;
/** Fixed test-only preflight allowance; never measured isolate CPU or remote qualification. */
const SYNTHETIC_CPU_ALLOWANCE_MS = 20;
/** Isolated fixture namespace; every test owns a disposable native emulator. */
const VAULT_ID = syncVaultIdSchema.parse(
  "11111111-1111-4111-8111-111111111111",
);
/** Expired scan being inspected; its permanent manifest must never be deleted. */
const SCAN_ID = syncInventoryIdSchema.parse(
  "22222222-2222-4222-8222-222222222222",
);
/** Different scan owns the slot and unrelated scratch; cleanup must not mutate either. */
const PEER_ID = syncInventoryIdSchema.parse(
  "33333333-3333-4333-8333-333333333333",
);
/** Canonical v2 cursor witness identity, independent of any real content. */
const WITNESS = createContentSha256("a".repeat(64));
if (WITNESS === undefined) throw new RangeError("Invalid synthetic witness.");
/** Exact canonical disposable keys admitted by the production cleanup policy. */
const SCRATCH_KEYS = [
  syncInventoryChunkKey(VAULT_ID, SCAN_ID, 0),
  syncInventoryClaimKey(VAULT_ID, SCAN_ID, 0),
  syncInventoryCursorWitnessKey(VAULT_ID, SCAN_ID, WITNESS),
];
/** Non-target keys demonstrate namespace isolation without using vault/user content. */
const SENTINEL_KEYS = [
  "vault/native-cleanup-sentinel.md",
  syncInventoryChunkKey(VAULT_ID, PEER_ID, 0),
];
/** Test-only entry distinguishes fixture setup/inspection from one production cleanup invocation. */
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("seed"), live: z.boolean() }).strict(),
  z
    .object({ action: z.literal("cleanup"), lostDeleteReply: z.boolean() })
    .strict(),
  z.object({ action: z.literal("inspect") }).strict(),
]);
/** Native R2 binding with cleanup-only deletion, confined to this local fixture. */
interface CleanupEnv {
  /** Disposable native binding; no production bootstrap receives deletion capability. */
  readonly BUCKET: SyncInventoryCleanupBucket;
}

/** Executes setup, inspection or exactly one cleanup operation per actual workerd request. */
export default {
  async fetch(request: Request, env: CleanupEnv): Promise<Response> {
    const input = requestSchema.parse(await request.json());
    const calls = { get: 0, list: 0, put: 0, delete: 0 };
    /** Counts attempted native binding operations before dispatch, including rejected promises.
     * @param method Native operation being attempted; cleanup's own budget remains independently authoritative.
     */
    function count(method: keyof typeof calls): void {
      if (
        Object.values(calls).reduce((sum, value) => sum + value, 0) >=
        MAX_INVENTORY_SUBREQUESTS_PER_INVOCATION
      )
        throw new RangeError("Native fixture invocation ceiling reached.");
      calls[method] += 1;
    }
    const bucket: SyncInventoryCleanupBucket = {
      get(key) {
        count("get");
        return env.BUCKET.get(key);
      },
      list(options) {
        count("list");
        return env.BUCKET.list(options);
      },
      put(key, body, options) {
        count("put");
        return env.BUCKET.put(key, body, options);
      },
      async delete(key) {
        count("delete");
        await env.BUCKET.delete(key);
        if (input.action === "cleanup" && input.lostDeleteReply)
          throw new Error("Injected lost native DELETE acknowledgement.");
      },
    };
    /** Reads exact synthetic stored bytes for preservation assertions, without granting cleanup authority.
     * @param key Canonical fixture object or non-target sentinel.
     * @returns Exact unsigned byte values, or null for observed absence; no UTF-8 normalization.
     */
    async function bytes(key: string): Promise<number[] | null> {
      const object = await bucket.get(key);
      return object === null
        ? null
        : Array.from(new Uint8Array(await object.arrayBuffer()));
    }
    switch (input.action) {
      case "seed": {
        const manifest = await encodeSyncRecord({
          kind: "manifest",
          record: {
            schemaVersion: 2,
            protocolMajor: 1,
            vaultId: VAULT_ID,
            inventoryId: SCAN_ID,
            phase: "scanning",
            startVector: Array.from({ length: SYNC_FEED_LANE_COUNT }, () =>
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
            expiresAtEpochMs: CLOCK_MS + (input.live ? 1 : -1),
            cursorWitnessMode: 1,
          },
        });
        const slot = await encodeSyncRecord({
          kind: "activeSlot",
          record: {
            schemaVersion: 1,
            protocolMajor: 1,
            vaultId: VAULT_ID,
            state: "active",
            inventoryId: PEER_ID,
          },
        });
        const objects = [
          { key: syncInventoryManifestKey(VAULT_ID, SCAN_ID), body: manifest },
          { key: syncInventoryActiveKey(VAULT_ID), body: slot },
          ...SCRATCH_KEYS.map((key) => ({
            key,
            body: new TextEncoder().encode("synthetic-disposable-scratch"),
          })),
          ...SENTINEL_KEYS.map((key) => ({
            key,
            body: new TextEncoder().encode("unchanged-native-cleanup-sentinel"),
          })),
        ];
        for (const { key, body } of objects) {
          const result = await bucket.put(key, body, {
            onlyIf: new Headers({ "If-None-Match": "*" }),
            customMetadata: { format: "sync-v1" },
            httpMetadata: { contentType: "application/octet-stream" },
          });
          if (result === null) throw new Error("Fixture seed refused.");
        }
        return Response.json({
          manifestBytes: Array.from(manifest),
          slotBytes: Array.from(slot),
          calls,
        });
      }
      case "inspect": {
        const manifestBytes = await bytes(
          syncInventoryManifestKey(VAULT_ID, SCAN_ID),
        );
        const slotBytes = await bytes(syncInventoryActiveKey(VAULT_ID));
        const scratchPresent: boolean[] = [];
        for (const key of SCRATCH_KEYS)
          scratchPresent.push((await bytes(key)) !== null);
        const sentinels: (number[] | null)[] = [];
        for (const key of SENTINEL_KEYS) sentinels.push(await bytes(key));
        return Response.json({
          manifestBytes,
          slotBytes,
          scratchPresent,
          sentinels,
          calls,
        });
      }
      case "cleanup": {
        const budget = createSyncInventoryInvocationBudget(
          () => SYNTHETIC_CPU_ALLOWANCE_MS,
        );
        const result = await reapExpiredSyncInventoryScratch(
          VAULT_ID,
          SCAN_ID,
          bucket,
          budget,
          () => CLOCK_MS,
        );
        return Response.json({
          result,
          actualCalls: budget.actualCalls,
          calls,
          clock: "injected",
          cpu: "unavailable",
        });
      }
    }
  },
};
