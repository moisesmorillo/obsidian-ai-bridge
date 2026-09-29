import { createContentSha256 } from "@obsidian-ai-bridge/core";
import {
  syncInventoryActiveKey,
  syncInventoryChunkKey,
  syncInventoryManifestKey,
} from "@protocol/sync.codec";
import {
  syncInventoryIdSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type {
  R2ConditionalBucketPort,
  R2ConditionalObjectMetadata,
  R2ConditionalPutOptions,
  R2ConditionalStoredObject,
} from "@worker/infrastructure/r2.types";
import type { SyncR2Key } from "@worker/infrastructure/sync/sync-r2.types";
import { syncR2InventoryScratch } from "@worker/infrastructure/sync/sync-r2-inventory";
import { createSyncR2Key } from "@worker/infrastructure/sync/sync-r2-key";
import { syncR2ObjectStore } from "@worker/infrastructure/sync/sync-r2-object";
import { encodeSyncRecord } from "@worker/infrastructure/sync/sync-record.codec";
import type {
  SyncInventoryChunk,
  SyncInventoryManifest,
  SyncInventorySlot,
} from "@worker/infrastructure/sync/sync-record.types";
import { beforeEach, describe, expect, it } from "vitest";

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

  async list(): Promise<{
    readonly objects: readonly [];
    readonly truncated: false;
  }> {
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
  overrides: Partial<SyncInventoryChunk> = {},
): SyncInventoryChunk {
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

describe("isolated inventory scratch persistence", () => {
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
      kind: "unavailable",
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
        kind: "unavailable",
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
