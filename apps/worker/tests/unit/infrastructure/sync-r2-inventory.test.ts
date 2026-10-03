import type { SyncCompleteInventory } from "@core/sync/sync-store.types";
import { createContentSha256, encodeBase64Url } from "@obsidian-ai-bridge/core";
import {
  syncHeadKey,
  syncInventoryActiveKey,
  syncInventoryChunkKey,
  syncInventoryClaimKey,
  syncInventoryCursorWitnessKey,
  syncInventoryManifestKey,
  syncVaultMarkerKey,
} from "@protocol/sync.codec";
import {
  syncInventoryIdSchema,
  syncNotePathSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type {
  R2ConditionalBucketPort,
  R2ConditionalObjectMetadata,
  R2ConditionalPutOptions,
  R2ConditionalStoredObject,
  R2ListResult,
} from "@worker/infrastructure/r2.types";
import type { SyncR2Key } from "@worker/infrastructure/sync/sync-r2.types";
import { syncR2InventoryScratch } from "@worker/infrastructure/sync/sync-r2-inventory";
import { createSyncInventoryInvocationBudget } from "@worker/infrastructure/sync/sync-r2-inventory-budget";
import {
  type SyncR2InventoryListing,
  syncR2InventoryListing,
} from "@worker/infrastructure/sync/sync-r2-inventory-list";
import { syncR2InventoryPages } from "@worker/infrastructure/sync/sync-r2-inventory-pages";
import { runSyncInventoryStep } from "@worker/infrastructure/sync/sync-r2-inventory-replay";
import { syncR2InventoryRunner } from "@worker/infrastructure/sync/sync-r2-inventory-runner";
import { createSyncR2Key } from "@worker/infrastructure/sync/sync-r2-key";
import { syncR2ObjectStore } from "@worker/infrastructure/sync/sync-r2-object";
import { syncR2Publication } from "@worker/infrastructure/sync/sync-r2-publication";
import { encodeSyncRecord } from "@worker/infrastructure/sync/sync-record.codec";
import {
  syncInventoryCursorJournalSchema,
  syncInventoryCursorWitnessSchema,
} from "@worker/infrastructure/sync/sync-record.schemas";
import type {
  SyncInventoryChunk,
  SyncInventoryManifest,
  SyncInventoryPageChunk,
  SyncInventorySlot,
} from "@worker/infrastructure/sync/sync-record.types";
import { sha256Content } from "@worker/storage/storage-crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const vaultId = syncVaultIdSchema.parse("11111111-1111-4111-8111-111111111111");
const otherVaultId = syncVaultIdSchema.parse(
  "66666666-6666-4666-8666-666666666666",
);
const inventoryId = syncInventoryIdSchema.parse(
  "22222222-2222-4222-8222-222222222222",
);
const otherInventoryId = syncInventoryIdSchema.parse(
  "33333333-3333-4333-8333-333333333333",
);
const digest = contentSha256(
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);
const emptyDigest = contentSha256(
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
);

function contentSha256(value: string) {
  const parsed = createContentSha256(value);
  if (parsed === undefined) throw new Error("Expected SHA-256 fixture.");
  return parsed;
}

class MemoryObject implements R2ConditionalStoredObject {
  readonly size: number;
  readonly uploaded: Date;
  readonly customMetadata = {};

  constructor(
    readonly key: string,
    private readonly bytes: Uint8Array,
    readonly etag: string,
    uploaded = 1_000,
  ) {
    this.size = bytes.byteLength;
    this.uploaded = new Date(uploaded);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.slice().buffer;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.bytes);
  }
}

class MemoryBucket implements R2ConditionalBucketPort {
  readonly objects = new Map<string, MemoryObject>();
  readonly puts: {
    readonly key: string;
    readonly options: R2ConditionalPutOptions;
  }[] = [];
  readonly reads: string[] = [];
  unavailable = false;
  putFailure: Error | undefined;
  sequence = 0;
  now = 20_000;

  async get(key: string): Promise<R2ConditionalStoredObject | null> {
    this.reads.push(key);
    if (this.unavailable) throw new Error("storage unavailable");
    return this.objects.get(key) ?? null;
  }

  async head(): Promise<null> {
    return null;
  }

  async list(): Promise<R2ListResult> {
    return { objects: [], truncated: false };
  }

  async put(
    key: string,
    content: string | Uint8Array,
    options: R2ConditionalPutOptions,
  ): Promise<R2ConditionalObjectMetadata | null> {
    this.puts.push({ key, options });
    const previous = this.objects.get(key);
    const accepted =
      options.onlyIf instanceof Headers
        ? previous === undefined && options.onlyIf.get("If-None-Match") === "*"
        : previous?.etag === options.onlyIf.etagMatches;
    if (!accepted) return null;
    if (this.putFailure !== undefined) throw this.putFailure;
    const bytes =
      typeof content === "string" ? new TextEncoder().encode(content) : content;
    const object = new MemoryObject(
      key,
      bytes,
      `etag-${++this.sequence}`,
      this.now,
    );
    this.objects.set(key, object);
    return object;
  }

  seed(key: string, bytes: Uint8Array): void {
    this.objects.set(
      key,
      new MemoryObject(key, bytes, `seed-${++this.sequence}`),
    );
  }
}

function keyFor(value: string, forVaultId = vaultId): SyncR2Key {
  const key = createSyncR2Key(value, forVaultId);
  if (key === undefined) throw new Error("Expected canonical inventory key.");
  return key;
}

function makeSlot(
  state: "empty" | "active" = "active",
  selectedInventoryId = inventoryId,
): SyncInventorySlot {
  return state === "empty"
    ? { schemaVersion: 1, protocolMajor: 1, vaultId, state }
    : {
        schemaVersion: 1,
        protocolMajor: 1,
        vaultId,
        state,
        inventoryId: selectedInventoryId,
      };
}

function makeManifest(
  selectedInventoryId = inventoryId,
): SyncInventoryManifest {
  return {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    inventoryId: selectedInventoryId,
    phase: "starting",
    startVector: Array.from({ length: 64 }, () =>
      syncSequenceSchema.parse("00000000000000000001"),
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
    expiresAtEpochMs: 1_800_000_000_000,
  };
}

function makeChunk(
  overrides: Partial<SyncInventoryPageChunk> = {},
): SyncInventoryPageChunk {
  return {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    inventoryId,
    step: 0,
    previousChunkHash: null,
    inputCursorDigest: digest,
    outputCursorDigest: emptyDigest,
    outputCursor: null,
    truncated: false,
    transcript: "[]",
    headSummary: null,
    ...overrides,
  };
}

let bucket: MemoryBucket;
let scratch: ReturnType<typeof syncR2InventoryScratch>;

beforeEach(() => {
  bucket = new MemoryBucket();
  scratch = syncR2InventoryScratch(syncR2ObjectStore(bucket, () => bucket.now));
});

describe("terminal post-reservation inventory failures", () => {
  it.each([
    "lost_failure_response",
    "peer_manifest",
    "foreign_slot",
    "unavailable_head",
  ] as const)("preserves uncertainty and ownership at %s", async (fault) => {
    const manifest: SyncInventoryManifest = {
      ...makeManifest(),
      schemaVersion: 2,
      cursorWitnessMode: 1,
      phase: "scanning",
    };
    bucket.seed(
      syncInventoryManifestKey(vaultId, inventoryId),
      await encodeSyncRecord({ kind: "manifest", record: manifest }),
    );
    bucket.seed(
      syncInventoryActiveKey(vaultId),
      await encodeSyncRecord({ kind: "activeSlot", record: makeSlot() }),
    );
    bucket.seed(
      syncVaultMarkerKey(vaultId),
      await encodeSyncRecord({
        kind: "vaultMarker",
        vaultId,
        schemaVersion: 1,
        protocolMajor: 1,
      }),
    );
    const headKey = syncHeadKey(
      vaultId,
      syncNotePathSchema.parse("notes/missing.md"),
    );
    const failureKey = syncInventoryChunkKey(vaultId, inventoryId, 0);
    const list = vi.spyOn(bucket, "list").mockImplementation(async () => {
      bucket.now += 1_100;
      return { objects: [{ key: headKey, size: 1 }], truncated: false };
    });
    const originalGet = bucket.get.bind(bucket);
    let lost = false;
    vi.spyOn(bucket, "get").mockImplementation(async (key) => {
      if (
        (fault === "lost_failure_response" && lost && key === failureKey) ||
        (fault === "unavailable_head" && key === headKey)
      )
        throw new Error("Unavailable GET capability");
      return originalGet(key);
    });
    if (fault === "lost_failure_response") {
      const originalPut = bucket.put.bind(bucket);
      vi.spyOn(bucket, "put").mockImplementation(async (key, body, options) => {
        const result = await originalPut(key, body, options);
        if (key === failureKey) {
          lost = true;
          throw new Error("Applied failure latch without acknowledgement");
        }
        return result;
      });
    }
    if (fault === "peer_manifest") {
      const originalCreate = scratch.createChunk.bind(scratch);
      vi.spyOn(scratch, "createChunk").mockImplementation(async (chunk) => {
        const result = await originalCreate(chunk);
        const current = await scratch.readManifest(vaultId, inventoryId);
        if (current.kind !== "observed")
          throw new Error("Expected claimed generation");
        bucket.now += 1_100;
        expect(
          await scratch.replaceManifest(current.observation, {
            ...current.observation.value,
            reservedAttempt: 2,
          }),
        ).toEqual({ kind: "confirmed" });
        return result;
      });
    }
    const continuation = () =>
      syncR2InventoryRunner(
        scratch,
        syncR2Publication(syncR2ObjectStore(bucket, () => bucket.now)),
        createSyncInventoryInvocationBudget(() => 20),
        () => bucket.now,
        syncR2InventoryListing(bucket),
      ).continueInventory({ vaultId, inventoryId });
    expect(await continuation()).toMatchObject({
      kind: "error",
      code:
        fault === "foreign_slot"
          ? "inventory_incomplete"
          : fault === "unavailable_head"
            ? "storage_unavailable"
            : "effect_unknown",
    });
    expect(await scratch.readActive(vaultId)).toMatchObject({
      kind: "observed",
      observation: { value: { state: "active", inventoryId } },
    });
    if (fault === "unavailable_head") {
      expect(await scratch.readChunk(vaultId, inventoryId, 0)).toEqual({
        kind: "absent",
      });
      expect(await scratch.readManifest(vaultId, inventoryId)).toMatchObject({
        kind: "observed",
        observation: { value: { phase: "scanning" } },
      });
      return;
    }
    if (fault === "peer_manifest")
      expect(await scratch.readManifest(vaultId, inventoryId)).toMatchObject({
        kind: "observed",
        observation: { value: { phase: "scanning", reservedAttempt: 2 } },
      });
    lost = false;
    bucket.now += 1_100;
    if (fault === "foreign_slot")
      bucket.seed(
        syncInventoryActiveKey(vaultId),
        await encodeSyncRecord({
          kind: "activeSlot",
          record: makeSlot("active", otherInventoryId),
        }),
      );
    expect(await continuation()).toEqual({
      kind: "error",
      code: "inventory_incomplete",
    });
    bucket.now += 1_100;
    expect(await continuation()).toEqual({
      kind: "error",
      code: "inventory_incomplete",
    });
    expect(await scratch.readActive(vaultId)).toMatchObject({
      kind: "observed",
      observation: {
        value:
          fault === "foreign_slot"
            ? { state: "active", inventoryId: otherInventoryId }
            : { state: "empty" },
      },
    });
    expect(list).toHaveBeenCalledOnce();
  });

  it("retains a durable failure latch through the post-reservation cooldown instead of relisting", async () => {
    const manifest: SyncInventoryManifest = {
      ...makeManifest(),
      schemaVersion: 2,
      cursorWitnessMode: 1,
      phase: "scanning",
    };
    bucket.seed(
      syncInventoryManifestKey(vaultId, inventoryId),
      await encodeSyncRecord({ kind: "manifest", record: manifest }),
    );
    bucket.seed(
      syncInventoryActiveKey(vaultId),
      await encodeSyncRecord({ kind: "activeSlot", record: makeSlot() }),
    );
    bucket.seed(
      syncVaultMarkerKey(vaultId),
      await encodeSyncRecord({
        kind: "vaultMarker",
        vaultId,
        schemaVersion: 1,
        protocolMajor: 1,
      }),
    );
    const list = vi.spyOn(bucket, "list").mockResolvedValue({
      objects: [
        {
          key: syncHeadKey(
            vaultId,
            syncNotePathSchema.parse("notes/absent.md"),
          ),
          size: 1,
        },
      ],
      truncated: false,
    });
    const continuation = () =>
      syncR2InventoryRunner(
        scratch,
        syncR2Publication(syncR2ObjectStore(bucket, () => bucket.now)),
        createSyncInventoryInvocationBudget(() => 20),
        () => bucket.now,
        syncR2InventoryListing(bucket),
      ).continueInventory({ vaultId, inventoryId });
    expect(await continuation()).toEqual({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
      retryAfterEpochMs: bucket.now + 1_100,
    });
    expect(await scratch.readChunk(vaultId, inventoryId, 0)).toMatchObject({
      kind: "observed",
      observation: {
        value: { schemaVersion: 2, failureCode: "inventory_incomplete" },
      },
    });
    list.mockResolvedValue({ objects: [], truncated: false });
    bucket.now += 1_100;
    expect(await continuation()).toEqual({
      kind: "error",
      code: "inventory_incomplete",
    });
    expect(await scratch.readManifest(vaultId, inventoryId)).toMatchObject({
      kind: "observed",
      observation: { value: { phase: "failed" } },
    });
    bucket.now += 1_100;
    expect(await continuation()).toEqual({
      kind: "error",
      code: "inventory_incomplete",
    });
    expect(await scratch.readActive(vaultId)).toMatchObject({
      kind: "observed",
      observation: { value: { state: "empty" } },
    });
    expect(list).toHaveBeenCalledOnce();
  });

  it.each([
    "invalid_page",
    "missing_truncated",
    "non_boolean_truncated",
    "missing_key",
    "non_string_key",
    "repeated_cursor",
    "unordered_key",
    "absent_head",
    "malformed_head",
    "head_limit",
  ] as const)(
    "durably fails %s and never LISTs again on same-ID continuation",
    async (fault) => {
      const manifest: SyncInventoryManifest = {
        ...makeManifest(),
        schemaVersion: 2,
        cursorWitnessMode: 1,
        phase: "scanning",
      };
      const headKey = syncHeadKey(
        vaultId,
        syncNotePathSchema.parse("notes/failure.md"),
      );
      const saved =
        fault === "repeated_cursor" ||
        fault === "unordered_key" ||
        fault === "head_limit"
          ? {
              ...manifest,
              cursor: "QQ",
              lastKey: headKey,
              nextStep: 1,
              listPageCount: 1,
              chunkCount: 1,
              chunkHash: digest,
              headCount: fault === "head_limit" ? 10_000 : 1,
              listAttemptCount: 1,
              headGetAttemptCount: 1,
            }
          : manifest;
      // The head-limit fixture has a valid counter history at its actual persisted boundary.
      const initial =
        fault === "head_limit"
          ? {
              ...saved,
              nextStep: 10_000,
              listPageCount: 10_000,
              chunkCount: 10_000,
              listAttemptCount: 10_000,
              headGetAttemptCount: 10_000,
              lastKey: syncHeadKey(
                vaultId,
                syncNotePathSchema.parse("notes/0000.md"),
              ),
            }
          : saved;
      bucket.seed(
        syncInventoryManifestKey(vaultId, inventoryId),
        await encodeSyncRecord({ kind: "manifest", record: initial }),
      );
      bucket.seed(
        syncInventoryActiveKey(vaultId),
        await encodeSyncRecord({ kind: "activeSlot", record: makeSlot() }),
      );
      const marker = keyFor(syncVaultMarkerKey(vaultId));
      bucket.seed(
        marker,
        await encodeSyncRecord({
          kind: "vaultMarker",
          vaultId,
          schemaVersion: 1,
          protocolMajor: 1,
        }),
      );
      if (fault === "malformed_head")
        bucket.seed(headKey, new TextEncoder().encode("{"));
      const list = vi.spyOn(bucket, "list").mockImplementation(async () => {
        bucket.now += 1_100;
        if (fault === "invalid_page")
          return { objects: [], truncated: true, cursor: "" };
        if (
          fault === "missing_truncated" ||
          fault === "non_boolean_truncated"
        ) {
          const page: R2ListResult = { objects: [], truncated: false };
          if (fault === "missing_truncated")
            Reflect.deleteProperty(page, "truncated");
          else Object.defineProperty(page, "truncated", { value: "false" });
          return page;
        }
        if (fault === "missing_key" || fault === "non_string_key") {
          const entry = { key: headKey, size: 1 };
          if (fault === "missing_key") Reflect.deleteProperty(entry, "key");
          else Object.defineProperty(entry, "key", { value: 12 });
          return { objects: [entry], truncated: false };
        }
        if (fault === "repeated_cursor")
          return { objects: [], truncated: true, cursor: "A" };
        return { objects: [{ key: headKey, size: 1 }], truncated: false };
      });
      const continuation = () =>
        syncR2InventoryRunner(
          scratch,
          syncR2Publication(syncR2ObjectStore(bucket, () => bucket.now)),
          createSyncInventoryInvocationBudget(() => 20),
          () => bucket.now,
          syncR2InventoryListing(bucket),
        ).continueInventory({ vaultId, inventoryId });
      expect(await continuation()).toEqual({
        kind: "error",
        code:
          fault === "head_limit"
            ? "inventory_limit_exceeded"
            : "inventory_incomplete",
      });
      expect(await scratch.readManifest(vaultId, inventoryId)).toMatchObject({
        kind: "observed",
        observation: { value: { phase: "failed", reservedAttempt: 1 } },
      });
      list.mockResolvedValue({ objects: [], truncated: false });
      bucket.now += 1_100;
      expect(await continuation()).toEqual({
        kind: "error",
        code: "inventory_incomplete",
      });
      expect(await scratch.readActive(vaultId)).toMatchObject({
        kind: "observed",
        observation: { value: { state: "empty" } },
      });
      expect(await continuation()).toEqual({
        kind: "error",
        code: "inventory_incomplete",
      });
      expect(list).toHaveBeenCalledOnce();
    },
  );
});

/** Seeds one strict reserved v2 chunk and exposes counted fresh-invocation replay.
 * @returns Canonical output binding and an invocation that asserts raw R2 accounting.
 */
async function witnessedStepFixture() {
  const manifest: SyncInventoryManifest = {
    ...makeManifest(),
    schemaVersion: 2,
    cursorWitnessMode: 1,
    phase: "scanning",
    reservedAttempt: 1,
  };
  const outputDigest = await sha256Content("A");
  const inputDigest = await sha256Content("");
  const chunk = makeChunk({
    inputCursorDigest: inputDigest,
    outputCursorDigest: outputDigest,
    outputCursor: "QQ",
    truncated: true,
    transcript: JSON.stringify({
      objectCount: 0,
      keySha256: null,
      headBodyBytes: 0,
      truncated: true,
    }),
  });
  const chunkBytes = await encodeSyncRecord({ kind: "chunk", record: chunk });
  const chunkHash = await sha256Content(new TextDecoder().decode(chunkBytes));
  bucket.seed(
    syncInventoryManifestKey(vaultId, inventoryId),
    await encodeSyncRecord({ kind: "manifest", record: manifest }),
  );
  bucket.seed(
    syncInventoryActiveKey(vaultId),
    await encodeSyncRecord({ kind: "activeSlot", record: makeSlot() }),
  );
  bucket.seed(syncInventoryChunkKey(vaultId, inventoryId, 0), chunkBytes);
  const listing: SyncR2InventoryListing = {
    async listHeads() {
      throw new Error("Replayed chunk must not relist");
    },
    async readHead() {
      throw new Error("Empty page must not read a head");
    },
  };
  /** Reserves admission and step calls independently, then checks each physical GET/PUT.
   * @returns Private step result without assuming that a PUT response advanced the manifest.
   */
  async function invoke() {
    const budget = createSyncInventoryInvocationBudget(() => 20);
    const counted = syncR2InventoryScratch(
      syncR2ObjectStore(budget.wrap(bucket), () => bucket.now),
    );
    expect(budget.reserve(1, 0)).toBe(true);
    const existing = await counted.readManifest(vaultId, inventoryId);
    if (existing.kind !== "observed")
      throw new Error("Expected reserved manifest");
    bucket.reads.length = 0;
    bucket.puts.length = 0;
    const result = await runSyncInventoryStep(
      existing.observation,
      counted,
      listing,
      budget,
      () => bucket.now,
    );
    expect(bucket.reads.length + bucket.puts.length).toBe(
      budget.actualCalls - 1,
    );
    expect(budget.actualCalls - 1).toBeLessThanOrEqual(32);
    return result;
  }
  return { invoke, outputDigest, chunkHash };
}

describe("isolated inventory scratch persistence", () => {
  it("counts the 64-lane finalization and separate same-ID slot release without returning an early handle", async () => {
    const zero = syncSequenceSchema.parse("00000000000000000000");
    const manifest: SyncInventoryManifest = {
      ...makeManifest(),
      schemaVersion: 2,
      cursorWitnessMode: 1,
      phase: "scanning",
      startVector: Array(64).fill(zero),
      nextStep: 1,
      listPageCount: 1,
      chunkCount: 1,
      chunkHash: digest,
    };
    bucket.seed(
      syncVaultMarkerKey(vaultId),
      await encodeSyncRecord({
        kind: "vaultMarker",
        schemaVersion: 1,
        protocolMajor: 1,
        vaultId,
      }),
    );
    bucket.seed(
      syncInventoryManifestKey(vaultId, inventoryId),
      await encodeSyncRecord({
        kind: "manifest",
        record: manifest,
      }),
    );
    bucket.seed(
      syncInventoryActiveKey(vaultId),
      await encodeSyncRecord({
        kind: "activeSlot",
        record: makeSlot(),
      }),
    );
    const run = async () => {
      const budget = createSyncInventoryInvocationBudget(() => 20);
      const objects = syncR2ObjectStore(budget.wrap(bucket), () => bucket.now);
      const runner = syncR2InventoryRunner(
        syncR2InventoryScratch(objects),
        syncR2Publication(objects),
        budget,
        () => bucket.now,
      );
      return {
        result: await runner.continueInventory({ vaultId, inventoryId }),
        calls: budget.actualCalls,
      };
    };
    const finalized = await run();
    expect(finalized.result).toEqual({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
    });
    expect(finalized.calls).toBeLessThanOrEqual(134);
    expect(
      bucket.reads.filter((key) => key === syncVaultMarkerKey(vaultId)),
    ).toHaveLength(64);
    bucket.now += 1_100;
    const released = await run();
    expect(released.result).toMatchObject({
      kind: "complete",
      vaultId,
      inventoryId,
      root: digest,
      chunkCount: 1,
    });
    expect(released.calls).toBeLessThanOrEqual(8);
  });

  it("counts all raw R2 calls through three new-scan admission invocations and 64 lane reads", async () => {
    bucket.seed(
      syncVaultMarkerKey(vaultId),
      await encodeSyncRecord({
        kind: "vaultMarker",
        schemaVersion: 1,
        protocolMajor: 1,
        vaultId,
      }),
    );
    const start = async () => {
      const budget = createSyncInventoryInvocationBudget(() => 20);
      const objects = syncR2ObjectStore(budget.wrap(bucket), () => bucket.now);
      const runner = syncR2InventoryRunner(
        syncR2InventoryScratch(objects),
        syncR2Publication(objects),
        budget,
        () => bucket.now,
      );
      return {
        result: await runner.startInventory({ vaultId, inventoryId }),
        calls: budget.actualCalls,
      };
    };
    const created = await start();
    expect(created.result).toMatchObject({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
    });
    expect(created.calls).toBeLessThanOrEqual(6);
    const claimed = await start();
    expect(claimed.result).toMatchObject({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
    });
    expect(claimed.calls).toBeLessThanOrEqual(6);
    bucket.now += 1_100;
    const scanned = await start();
    expect(scanned.result).toMatchObject({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
    });
    expect(scanned.calls).toBeLessThanOrEqual(136);
    expect(
      bucket.reads.filter((key) => key === syncVaultMarkerKey(vaultId)),
    ).toHaveLength(64);
    const stored = await scratch.readManifest(vaultId, inventoryId);
    expect(stored).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          schemaVersion: 2,
          phase: "scanning",
          startVector: Array(64).fill("00000000000000000000"),
        },
      },
    });
  });

  it("bounds a complete 16-chunk evidence page at 18 physically counted R2 reads", async () => {
    const vector = Array(64).fill(
      syncSequenceSchema.parse("00000000000000000000"),
    );
    const noCursor = await sha256Content("");
    let previousHash: SyncInventoryChunk["previousChunkHash"] = null;
    let inputDigest = noCursor;
    let evidenceBytes = 0;
    for (let step = 0; step < 16; step += 1) {
      const output = step === 15 ? null : String(step + 1);
      const chunk: SyncInventoryChunk = {
        schemaVersion: 1,
        protocolMajor: 1,
        vaultId,
        inventoryId,
        step,
        previousChunkHash: previousHash,
        inputCursorDigest: inputDigest,
        outputCursorDigest: await sha256Content(output ?? ""),
        outputCursor:
          output === null
            ? null
            : encodeBase64Url(new TextEncoder().encode(output)),
        truncated: output !== null,
        transcript: JSON.stringify({
          objectCount: 0,
          keySha256: null,
          headBodyBytes: 0,
          truncated: output !== null,
        }),
        headSummary: null,
      };
      const bytes = await encodeSyncRecord({ kind: "chunk", record: chunk });
      bucket.seed(syncInventoryChunkKey(vaultId, inventoryId, step), bytes);
      evidenceBytes += bytes.byteLength;
      previousHash = await sha256Content(new TextDecoder().decode(bytes));
      inputDigest = chunk.outputCursorDigest;
    }
    if (previousHash === null)
      throw new Error("Missing verified chunk chain root.");
    const manifest: SyncInventoryManifest = {
      ...makeManifest(),
      schemaVersion: 2,
      cursorWitnessMode: 1,
      phase: "complete",
      startVector: vector,
      nextStep: 16,
      listPageCount: 16,
      listAttemptCount: 16,
      chunkCount: 16,
      chunkHash: previousHash,
      evidenceBytes,
    };
    bucket.seed(
      syncInventoryManifestKey(vaultId, inventoryId),
      await encodeSyncRecord({ kind: "manifest", record: manifest }),
    );
    bucket.seed(
      syncInventoryActiveKey(vaultId),
      await encodeSyncRecord({ kind: "activeSlot", record: makeSlot("empty") }),
    );
    const handle: SyncCompleteInventory = {
      kind: "complete",
      vaultId,
      inventoryId,
      root: previousHash,
      vector,
      entryCount: 0,
      chunkCount: 16,
    };
    const budget = createSyncInventoryInvocationBudget(() => 20);
    const pages = syncR2InventoryPages(
      syncR2InventoryScratch(
        syncR2ObjectStore(budget.wrap(bucket), () => bucket.now),
      ),
      budget,
      () => bucket.now,
    );
    expect(
      await pages.readInventoryPage({ vaultId, handle, cursor: "" }),
    ).toEqual({
      kind: "complete",
      summaries: [],
      nextCursor: null,
      final: true,
    });
    expect(budget.actualCalls).toBe(18);
    expect(bucket.reads.filter((key) => key.includes("/chunks/"))).toHaveLength(
      16,
    );
  });

  it("counts every raw R2 call on a fresh witnessed chunk and original-generation replay", async () => {
    const { invoke, outputDigest } = await witnessedStepFixture();
    expect(await invoke()).toEqual({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
    });
    expect(bucket.puts.map(({ key }) => key)).toEqual([
      syncInventoryClaimKey(vaultId, inventoryId, 0),
      syncInventoryCursorWitnessKey(vaultId, inventoryId, outputDigest),
    ]);
    bucket.now += 2_201;
    expect(await invoke()).toEqual({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
    });
    expect(bucket.puts.map(({ key }) => key)).toEqual([
      syncInventoryManifestKey(vaultId, inventoryId),
    ]);
    const advanced = await scratch.readManifest(vaultId, inventoryId);
    expect(
      advanced.kind === "observed" && advanced.observation.value.nextStep,
    ).toBe(1);
  });

  it("counts each real R2 branch of crash recovery without another LIST or shared UUID", async () => {
    const { invoke, outputDigest, chunkHash } = await witnessedStepFixture();
    const claimKey = syncInventoryClaimKey(vaultId, inventoryId, 0);
    const initialClaim = syncInventoryCursorJournalSchema.parse({
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      inventoryId,
      step: 0,
      chunkHash,
      cursorDigest: outputDigest,
      state: "attempting",
      claimId: "33333333-3333-4333-8333-333333333333",
    });
    bucket.seed(
      claimKey,
      await encodeSyncRecord({ kind: "cursorJournal", record: initialClaim }),
    );
    expect(await invoke()).toMatchObject({
      kind: "inventory_in_progress",
      retryAfterEpochMs: bucket.now + 1_100,
    });
    expect(bucket.puts.map(({ key }) => key)).toEqual([claimKey]);
    bucket.now += 2_201;
    expect(await invoke()).toEqual({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
    });
    expect(bucket.puts.map(({ key }) => key)).toEqual([
      claimKey,
      syncInventoryCursorWitnessKey(vaultId, inventoryId, outputDigest),
    ]);
    bucket.now += 2_201;
    expect(await invoke()).toEqual({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
    });
    expect(bucket.puts.map(({ key }) => key)).toEqual([
      syncInventoryManifestKey(vaultId, inventoryId),
    ]);
  });

  it("lets at most one concurrent journal CAS winner dispatch a target PUT", async () => {
    const { outputDigest, chunkHash } = await witnessedStepFixture();
    const claimKey = syncInventoryClaimKey(vaultId, inventoryId, 0);
    const waiting = syncInventoryCursorJournalSchema.parse({
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      inventoryId,
      step: 0,
      chunkHash,
      cursorDigest: outputDigest,
      state: "retry_wait",
      claimId: "33333333-3333-4333-8333-333333333333",
      retryAfterEpochMs: bucket.now - 1,
    });
    bucket.seed(
      claimKey,
      await encodeSyncRecord({ kind: "cursorJournal", record: waiting }),
    );
    const admitted = await scratch.readManifest(vaultId, inventoryId);
    if (admitted.kind !== "observed") throw new Error("Expected reserved scan");
    const read = bucket.get.bind(bucket);
    let journalReads = 0;
    let release = () => {};
    const bothObserved = new Promise<void>((resolve) => {
      release = resolve;
    });
    bucket.get = async (key) => {
      if (key !== claimKey || journalReads >= 2) return read(key);
      const observed = await read(key);
      journalReads += 1;
      if (journalReads === 2) release();
      await bothObserved;
      return observed;
    };
    bucket.reads.length = 0;
    bucket.puts.length = 0;
    const budgets = Array.from({ length: 2 }, () =>
      createSyncInventoryInvocationBudget(() => 20),
    );
    const results = await Promise.all(
      budgets.map((budget) => {
        const counted = syncR2InventoryScratch(
          syncR2ObjectStore(budget.wrap(bucket), () => bucket.now),
        );
        const listing: SyncR2InventoryListing = {
          async listHeads() {
            throw new Error("Concurrent chunk must not relist");
          },
          async readHead() {
            throw new Error("Empty page must not read a head");
          },
        };
        return runSyncInventoryStep(
          admitted.observation,
          counted,
          listing,
          budget,
          () => bucket.now,
        );
      }),
    );
    expect(results.every(({ kind }) => kind !== "complete")).toBe(true);
    expect(journalReads).toBe(2);
    expect(budgets.every(({ actualCalls }) => actualCalls <= 32)).toBe(true);
    expect(bucket.reads.length + bucket.puts.length).toBe(
      budgets.reduce((total, budget) => total + budget.actualCalls, 0),
    );
    expect(
      bucket.puts.filter(
        ({ key }) =>
          key ===
          syncInventoryCursorWitnessKey(vaultId, inventoryId, outputDigest),
      ),
    ).toHaveLength(1);
  });

  it("creates an active-slot record at the canonical vault key", async () => {
    expect((await scratch.createActive(makeSlot("empty"))).kind).toBe(
      "confirmed",
    );
    expect(bucket.objects.has(keyFor(syncInventoryActiveKey(vaultId)))).toBe(
      true,
    );
  });

  it("uses the exact active-slot ETag for replacement", async () => {
    const key = keyFor(syncInventoryActiveKey(vaultId));
    const initial = await encodeSyncRecord({
      kind: "activeSlot",
      record: makeSlot(),
    });
    bucket.seed(key, initial);
    const observed = await scratch.readActive(vaultId);
    if (observed.kind !== "observed")
      throw new Error("Expected slot observation.");
    const alteredObservation = {
      ...observed.observation,
      value: makeSlot("empty"),
    };
    expect(
      (await scratch.replaceActive(alteredObservation, makeSlot("empty"))).kind,
    ).toBe("refused");
    const foreignKeyObservation = {
      ...observed.observation,
      observed: {
        ...observed.observation.observed,
        key: keyFor(syncInventoryActiveKey(otherVaultId), otherVaultId),
      },
    };
    expect(
      (await scratch.replaceActive(foreignKeyObservation, makeSlot("empty")))
        .kind,
    ).toBe("refused");
    const result = await scratch.replaceActive(
      observed.observation,
      makeSlot("empty"),
    );
    expect(result.kind).toBe("confirmed");
    expect(bucket.puts.at(-1)?.options.onlyIf).toEqual({
      etagMatches: observed.observation.observed.etag,
    });
    expect((await scratch.readActive(vaultId)).kind).toBe("observed");
  });

  it("permits only one competing active-slot claim", async () => {
    const key = keyFor(syncInventoryActiveKey(vaultId));
    bucket.seed(
      key,
      await encodeSyncRecord({ kind: "activeSlot", record: makeSlot("empty") }),
    );
    const observed = await scratch.readActive(vaultId);
    if (observed.kind !== "observed")
      throw new Error("Expected slot observation.");
    const results = await Promise.all([
      scratch.replaceActive(
        observed.observation,
        makeSlot("active", inventoryId),
      ),
      scratch.replaceActive(
        observed.observation,
        makeSlot("active", otherInventoryId),
      ),
    ]);
    expect(results.map(({ kind }) => kind).sort()).toEqual([
      "confirmed",
      "refused",
    ]);
  });

  it("returns unknown when the conditional create adapter throws", async () => {
    const objectStore = syncR2ObjectStore(bucket, () => bucket.now);
    const throwingScratch = syncR2InventoryScratch({
      ...objectStore,
      create: async () => {
        throw new Error("write outcome unavailable");
      },
    });
    expect((await throwingScratch.createActive(makeSlot("empty"))).kind).toBe(
      "effect_unknown",
    );
  });

  it("uses exact manifest ETag CAS and keeps another inventory key separate", async () => {
    const firstKey = keyFor(syncInventoryManifestKey(vaultId, inventoryId));
    const otherKey = keyFor(
      syncInventoryManifestKey(vaultId, otherInventoryId),
    );
    bucket.seed(
      firstKey,
      await encodeSyncRecord({ kind: "manifest", record: makeManifest() }),
    );
    expect((await scratch.readManifest(vaultId, otherInventoryId)).kind).toBe(
      "absent",
    );
    const observed = await scratch.readManifest(vaultId, inventoryId);
    if (observed.kind !== "observed")
      throw new Error("Expected manifest observation.");
    const oversizedReplacement = await scratch.replaceManifest(
      observed.observation,
      { ...makeManifest(), lastKey: "x".repeat(9_000) },
    );
    expect(oversizedReplacement.kind).toBe("refused");
    const throwingReplace = syncR2InventoryScratch({
      ...syncR2ObjectStore(bucket, () => bucket.now),
      replace: async () => {
        throw new Error("write outcome unavailable");
      },
    });
    expect(
      (
        await throwingReplace.replaceManifest(observed.observation, {
          ...makeManifest(),
          phase: "scanning",
        })
      ).kind,
    ).toBe("effect_unknown");
    const result = await scratch.replaceManifest(observed.observation, {
      ...makeManifest(),
      phase: "scanning",
    });
    expect(result.kind).toBe("confirmed");
    expect(bucket.puts.at(-1)?.options.onlyIf).toEqual({
      etagMatches: observed.observation.observed.etag,
    });
    expect(bucket.objects.has(otherKey)).toBe(false);
  });

  it("never upgrades a historical manifest to witnessed authority under the same scan ID", async () => {
    const key = keyFor(syncInventoryManifestKey(vaultId, inventoryId));
    bucket.seed(
      key,
      await encodeSyncRecord({ kind: "manifest", record: makeManifest() }),
    );
    const historical = await scratch.readManifest(vaultId, inventoryId);
    if (historical.kind !== "observed")
      throw new Error("Missing historical manifest");
    const witnessed = {
      ...historical.observation.value,
      schemaVersion: 2,
      cursorWitnessMode: 1,
    } as const;
    expect(
      (await scratch.replaceManifest(historical.observation, witnessed)).kind,
    ).toBe("refused");
    expect(bucket.puts).toHaveLength(0);
    expect(await scratch.readManifest(vaultId, inventoryId)).toMatchObject({
      kind: "observed",
      observation: { value: { schemaVersion: 1 } },
    });
  });

  it("keeps a retryable cursor journal and immutable witness under separate exact scan keys", async () => {
    const witness = syncInventoryCursorWitnessSchema.parse({
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      inventoryId,
      step: 0,
      chunkHash: digest,
      cursorDigest: emptyDigest,
    });
    const attempting = syncInventoryCursorJournalSchema.parse({
      ...witness,
      state: "attempting",
      claimId: "44444444-4444-4444-8444-444444444444",
    });
    expect((await scratch.createCursorJournal(attempting)).kind).toBe(
      "confirmed",
    );
    const observed = await scratch.readCursorJournal(vaultId, inventoryId, 0);
    expect(observed).toMatchObject({
      kind: "observed",
      observation: {
        value: { state: "attempting", claimId: attempting.claimId },
      },
    });
    if (observed.kind !== "observed")
      throw new Error("Missing claim generation");
    const waiting = syncInventoryCursorJournalSchema.parse({
      ...witness,
      state: "retry_wait",
      claimId: attempting.claimId,
      retryAfterEpochMs: 22_201,
    });
    bucket.now = 21_101;
    expect(
      (
        await scratch.replaceCursorJournal(observed.observation, {
          ...waiting,
          chunkHash: emptyDigest,
        })
      ).kind,
    ).toBe("refused");
    const prematureGeneration = syncInventoryCursorJournalSchema.parse({
      ...witness,
      state: "attempting",
      claimId: "55555555-5555-4555-8555-555555555555",
    });
    expect(
      (
        await scratch.replaceCursorJournal(
          observed.observation,
          prematureGeneration,
        )
      ).kind,
    ).toBe("refused");
    expect(
      (await scratch.replaceCursorJournal(observed.observation, waiting)).kind,
    ).toBe("confirmed");
    expect(
      (await scratch.replaceCursorJournal(observed.observation, waiting)).kind,
    ).toBe("refused");
    expect((await scratch.createCursorWitness(witness)).kind).toBe("confirmed");
    expect(
      await scratch.readCursorWitness(vaultId, inventoryId, emptyDigest),
    ).toMatchObject({
      kind: "observed",
      observation: { value: { step: 0, chunkHash: digest } },
    });
    expect(
      (await scratch.createCursorWitness({ ...witness, step: 1 })).kind,
    ).toBe("refused");
    expect(
      bucket.objects.has(
        keyFor(syncInventoryClaimKey(vaultId, inventoryId, 0)),
      ),
    ).toBe(true);
    expect(
      bucket.objects.has(
        keyFor(
          syncInventoryCursorWitnessKey(vaultId, inventoryId, emptyDigest),
        ),
      ),
    ).toBe(true);
    bucket.seed(
      keyFor(syncInventoryCursorWitnessKey(vaultId, inventoryId, digest)),
      await encodeSyncRecord({ kind: "cursorWitness", record: witness }),
    );
    expect(
      await scratch.readCursorWitness(vaultId, inventoryId, digest),
    ).toEqual({ kind: "invalid" });
  });

  it("creates immutable chunks only and rejects a conflicting replay", async () => {
    const record = makeChunk();
    expect((await scratch.createChunk(record)).kind).toBe("confirmed");
    expect(
      (await scratch.createChunk({ ...record, transcript: "[1]" })).kind,
    ).toBe("refused");
    expect(
      bucket.puts.filter(({ key }) => key.endsWith("/chunks/0.json")),
    ).toHaveLength(1);
    expect((await scratch.readChunk(vaultId, inventoryId, 0)).kind).toBe(
      "observed",
    );
  });

  it("rejects a stored chunk whose step disagrees with its requested key", async () => {
    const record = makeChunk({ step: 1, previousChunkHash: digest });
    const bytes = await encodeSyncRecord({ kind: "chunk", record });
    bucket.seed(keyFor(syncInventoryChunkKey(vaultId, inventoryId, 0)), bytes);
    expect(await scratch.readChunk(vaultId, inventoryId, 0)).toEqual({
      kind: "invalid",
    });
  });

  it.each([
    [
      "previous hash",
      '"previousChunkHash":null',
      `"previousChunkHash":"${digest}"`,
    ],
    [
      "output cursor digest",
      `"outputCursorDigest":"${emptyDigest}"`,
      `"outputCursorDigest":"${digest}"`,
    ],
  ])(
    "rejects a stored chunk with mismatched %s evidence",
    async (_label, original, corruptedValue) => {
      const valid = await encodeSyncRecord({
        kind: "chunk",
        record: makeChunk(),
      });
      const source = new TextDecoder().decode(valid);
      const corrupted = new TextEncoder().encode(
        source.replace(original, corruptedValue),
      );
      bucket.seed(
        keyFor(syncInventoryChunkKey(vaultId, inventoryId, 0)),
        corrupted,
      );
      expect(await scratch.readChunk(vaultId, inventoryId, 0)).toEqual({
        kind: "invalid",
      });
    },
  );

  it("limits reads to the exact inventory key and never lists or reads v2 keys", async () => {
    await scratch.readActive(vaultId);
    expect(bucket.reads).toEqual([keyFor(syncInventoryActiveKey(vaultId))]);
    expect(bucket.objects.has("vault/legacy.md")).toBe(false);
  });

  it("preserves unavailable and absent observations distinctly", async () => {
    expect(await scratch.readActive(vaultId)).toEqual({ kind: "absent" });
    bucket.unavailable = true;
    expect(await scratch.readActive(vaultId)).toEqual({ kind: "unavailable" });
  });

  it("carries timeout cooldown evidence into a fresh scratch facade", async () => {
    bucket.putFailure = new Error("write timeout");
    const first = await scratch.createManifest(makeManifest());
    expect(first.kind).toBe("effect_unknown");
    if (
      first.kind !== "effect_unknown" ||
      first.retryAfterEpochMs === undefined
    )
      throw new Error("Expected uncertain-write cooldown evidence.");

    bucket.putFailure = undefined;
    const freshScratch = syncR2InventoryScratch(
      syncR2ObjectStore(bucket, () => bucket.now),
    );
    const putsBeforeEarlyRetry = bucket.puts.length;
    const retryContext = { retryAfterEpochMs: first.retryAfterEpochMs };
    expect(
      await freshScratch.createManifest(makeManifest(), retryContext),
    ).toEqual({
      kind: "throttled",
      retryAfterEpochMs: first.retryAfterEpochMs,
    });
    expect(bucket.puts).toHaveLength(putsBeforeEarlyRetry);

    bucket.now = first.retryAfterEpochMs;
    expect(
      await freshScratch.createManifest(makeManifest(), retryContext),
    ).toEqual({ kind: "confirmed" });
  });

  it("carries exact-slot replacement cooldown across facade instances", async () => {
    const slotKey = keyFor(syncInventoryActiveKey(vaultId));
    bucket.seed(
      slotKey,
      await encodeSyncRecord({ kind: "activeSlot", record: makeSlot() }),
    );
    const observed = await scratch.readActive(vaultId);
    if (observed.kind !== "observed")
      throw new Error("Expected slot observation.");

    bucket.putFailure = new Error("write timeout");
    const first = await scratch.replaceActive(
      observed.observation,
      makeSlot("empty"),
    );
    expect(first.kind).toBe("effect_unknown");
    if (
      first.kind !== "effect_unknown" ||
      first.retryAfterEpochMs === undefined
    )
      throw new Error("Expected uncertain-write cooldown evidence.");

    bucket.putFailure = undefined;
    const freshScratch = syncR2InventoryScratch(
      syncR2ObjectStore(bucket, () => bucket.now),
    );
    const putsBeforeEarlyRetry = bucket.puts.length;
    const retryContext = { retryAfterEpochMs: first.retryAfterEpochMs };
    expect(
      await freshScratch.replaceActive(
        observed.observation,
        makeSlot("empty"),
        retryContext,
      ),
    ).toEqual({
      kind: "throttled",
      retryAfterEpochMs: first.retryAfterEpochMs,
    });
    expect(bucket.puts).toHaveLength(putsBeforeEarlyRetry);

    bucket.now = first.retryAfterEpochMs;
    expect(
      await freshScratch.replaceActive(
        observed.observation,
        makeSlot("empty"),
        retryContext,
      ),
    ).toEqual({ kind: "confirmed" });
    expect(bucket.puts.at(-1)?.options.onlyIf).toEqual({
      etagMatches: observed.observation.observed.etag,
    });
  });

  it("retains uncertain write evidence and defers repeat writes without sleeping", async () => {
    bucket.putFailure = new Error("timeout");
    const result = await scratch.createManifest(makeManifest());
    expect(result.kind).toBe("effect_unknown");
    expect(result).toMatchObject({
      kind: "effect_unknown",
      retryAfterEpochMs: 21_100,
    });
    bucket.putFailure = undefined;
    bucket.now = 20_000;
    const tooEarly = await scratch.createManifest(makeManifest());
    expect(tooEarly).toEqual({ kind: "throttled", retryAfterEpochMs: 21_100 });
    bucket.now = 21_100;
    const created = await scratch.createManifest(makeManifest());
    expect(created.kind).toBe("confirmed");
    const current = await scratch.readManifest(vaultId, inventoryId);
    if (current.kind !== "observed")
      throw new Error("Expected manifest observation.");
    bucket.now = 1_500;
    const deferred = await scratch.replaceManifest(current.observation, {
      ...makeManifest(),
      phase: "scanning",
    });
    expect(deferred).toEqual({ kind: "throttled", retryAfterEpochMs: 22_200 });
  });

  it("refuses oversized cursor, manifest, and chunk encodings before writing", async () => {
    const oversizedCursor = { ...makeManifest(), cursor: "eA".repeat(4_097) };
    expect((await scratch.createManifest(oversizedCursor)).kind).toBe(
      "refused",
    );
    const oversizedManifest = { ...makeManifest(), lastKey: "x".repeat(9_000) };
    expect((await scratch.createManifest(oversizedManifest)).kind).toBe(
      "refused",
    );
    const oversizedChunk = makeChunk({
      transcript: JSON.stringify("x".repeat(300)),
    });
    expect((await scratch.createChunk(oversizedChunk)).kind).toBe("refused");
    expect(bucket.puts).toHaveLength(0);
  });
});
