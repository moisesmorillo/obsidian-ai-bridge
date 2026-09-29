import {
  syncContentKey,
  syncFeedEventKey,
  syncFeedLaneHeadKey,
  syncHeadKey,
  syncInventoryActiveKey,
  syncInventoryChunkKey,
  syncInventoryManifestKey,
  syncOperationKey,
  syncRecoveryKey,
  syncVaultMarkerKey,
  syncVersionKey,
} from "@protocol/sync.codec";
import {
  syncEventSequenceSchema,
  syncInventoryIdSchema,
  syncNotePathSchema,
  syncOperationIdSchema,
  syncRevisionSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type {
  R2ConditionalBucketPort,
  R2ConditionalObjectMetadata,
  R2ConditionalPutOptions,
  R2ConditionalStoredObject,
} from "@worker/infrastructure/r2.types";
import { createSyncR2Key } from "@worker/infrastructure/sync/sync-r2-key";
import { syncR2ObjectStore } from "@worker/infrastructure/sync/sync-r2-object";
import { beforeEach, describe, expect, it, vi } from "vitest";

const vaultId = syncVaultIdSchema.parse("11111111-1111-4111-8111-111111111111");
const key = createSyncR2Key(syncVaultMarkerKey(vaultId), vaultId);
if (key === undefined) throw new Error("Expected canonical M7.1 fixture key.");

class MemoryObject implements R2ConditionalStoredObject {
  readonly size: number;
  readonly etag: string;
  readonly uploaded: Date;
  readonly key: string;
  readonly customMetadata = {};

  arrayBufferCalls = 0;
  constructor(
    key: string,
    bytes: Uint8Array,
    etag: string,
    uploaded: Date,
    declaredSize = bytes.byteLength,
  ) {
    this.key = key;
    this.size = declaredSize;
    this.etag = etag;
    this.uploaded = uploaded;
    this.bytes = bytes.slice();
  }
  private readonly bytes: Uint8Array;
  async arrayBuffer(): Promise<ArrayBuffer> {
    this.arrayBufferCalls += 1;
    return this.bytes.slice().buffer;
  }
  async text(): Promise<string> {
    return new TextDecoder().decode(this.bytes);
  }
}

class MemoryBucket implements R2ConditionalBucketPort {
  readonly objects = new Map<string, MemoryObject>();
  readonly puts: {
    key: string;
    bytes: Uint8Array;
    options: R2ConditionalPutOptions;
  }[] = [];
  putFailure: Error | undefined;
  getFailure: Error | undefined;
  forceRefusal = false;
  writeThenFail = false;
  replacementOnFailure: Uint8Array | undefined;
  nullPutHook: ((key: string, bytes: Uint8Array) => Promise<void>) | undefined;
  etagSequence = 0;
  constructor(private readonly clock: () => number) {}
  async get(key: string): Promise<R2ConditionalStoredObject | null> {
    if (this.getFailure) throw this.getFailure;
    return this.objects.get(key) ?? null;
  }
  async head(): Promise<null> {
    return null;
  }
  async list(): Promise<{ objects: readonly []; truncated: false }> {
    return { objects: [], truncated: false };
  }
  async put(
    key: string,
    content: string | Uint8Array,
    options: R2ConditionalPutOptions,
  ): Promise<R2ConditionalObjectMetadata | null> {
    const bytes =
      typeof content === "string"
        ? new TextEncoder().encode(content)
        : content.slice();
    this.puts.push({ key, bytes, options });
    const previous = this.objects.get(key);
    const predicate = options.onlyIf;
    const expected =
      predicate instanceof Headers
        ? predicate.get("If-None-Match") === "*" && previous === undefined
        : previous?.etag === predicate.etagMatches;
    if (!expected || this.forceRefusal) {
      await this.nullPutHook?.(key, bytes);
      return null;
    }
    if (this.putFailure && !this.writeThenFail) throw this.putFailure;
    const object = new MemoryObject(
      key,
      bytes,
      `etag-${++this.etagSequence}`,
      new Date(this.clock()),
    );
    this.objects.set(key, object);
    if (this.putFailure && this.writeThenFail) {
      if (this.replacementOnFailure) {
        await this.seed(key, this.replacementOnFailure, this.clock());
      }
      throw this.putFailure;
    }
    if (this.putFailure) throw this.putFailure;
    return object;
  }
  async seed(
    key: string,
    bytes: Uint8Array,
    uploaded: number,
    declaredSize = bytes.byteLength,
  ): Promise<MemoryObject> {
    const object = new MemoryObject(
      key,
      bytes,
      `etag-${++this.etagSequence}`,
      new Date(uploaded),
      declaredSize,
    );
    this.objects.set(key, object);
    return object;
  }
}

const data = new TextEncoder().encode('{"schemaVersion":1}');
let now = 10_000;
let bucket: MemoryBucket;
let store: ReturnType<typeof syncR2ObjectStore>;

beforeEach(() => {
  now = 10_000;
  bucket = new MemoryBucket(() => now);
  store = syncR2ObjectStore(bucket, () => now);
});

describe("one-key conditional sync R2 storage", () => {
  it("creates only under the sync prefix and exact-read-back confirms bytes", async () => {
    const result = await store.create(key, data);
    expect(result.kind).toBe("confirmed");
    expect(
      (await store.create(key, new TextEncoder().encode("different"))).kind,
    ).toBe("refused");
    const predicate = bucket.puts[0]?.options.onlyIf;
    expect(predicate).toBeInstanceOf(Headers);
    if (!(predicate instanceof Headers))
      throw new Error("Expected create-only R2 predicate.");
    expect(predicate.get("If-None-Match")).toBe("*");
    expect(bucket.puts[0]?.key).toMatch(/^sync\/v1\/vaults\//);
  });

  it("refuses create-only conflicts and stale ETags without refreshing the predicate", async () => {
    await bucket.seed(key, data, now - 5_000);
    const observed = await store.read(key, 100);
    expect(observed.kind).toBe("observed");
    if (observed.kind !== "observed") return;
    bucket.forceRefusal = true;
    const refused = await store.replace(
      observed.observation,
      new TextEncoder().encode("next"),
    );
    expect(refused.kind).toBe("refused");
    expect(bucket.puts.at(-1)?.options.onlyIf).toEqual({
      etagMatches: observed.observation.etag,
    });
    expect(bucket.objects.get(key)?.etag).toBe(observed.observation.etag);
  });

  it("resolves a conditional null by one exact read-back without retrying", async () => {
    const matching = data.slice();
    bucket.forceRefusal = true;
    bucket.nullPutHook = async (putKey, bytes) => {
      await bucket.seed(putKey, bytes, now);
    };
    const createResult = await store.create(key, matching);
    expect(createResult.kind).toBe("confirmed");
    expect(bucket.puts).toHaveLength(1);

    bucket.objects.clear();
    bucket.puts.length = 0;
    bucket.forceRefusal = false;
    const original = await bucket.seed(key, data, now - 5_000);
    const observed = await store.read(key, 100);
    expect(observed.kind).toBe("observed");
    if (observed.kind !== "observed") return;
    bucket.forceRefusal = true;
    bucket.nullPutHook = async (putKey) => {
      await bucket.seed(putKey, new TextEncoder().encode("divergent"), now);
    };
    const replaced = await store.replace(
      observed.observation,
      new TextEncoder().encode("candidate"),
    );
    expect(replaced.kind).toBe("refused");
    expect(bucket.puts).toHaveLength(1);
    expect(bucket.puts[0]?.options.onlyIf).toEqual({
      etagMatches: original.etag,
    });

    bucket.objects.clear();
    bucket.puts.length = 0;
    bucket.forceRefusal = true;
    bucket.nullPutHook = undefined;
    const possibleInFlightCreate = await store.create(key, matching);
    expect(possibleInFlightCreate).toEqual({
      kind: "effect_unknown",
      retryAfterEpochMs: now + 1_100,
    });
    expect(bucket.puts).toHaveLength(1);
    now += 1_100;

    bucket.objects.clear();
    bucket.puts.length = 0;
    bucket.getFailure = undefined;
    bucket.nullPutHook = undefined;
    bucket.forceRefusal = true;
    let getCalls = 0;
    const unavailableReadback = vi
      .spyOn(bucket, "get")
      .mockImplementation(async (requestedKey) => {
        getCalls += 1;
        if (getCalls === 2) throw new Error("storage unavailable");
        return bucket.objects.get(requestedKey) ?? null;
      });
    const unknown = await store.create(key, matching);
    expect(unknown.kind).toBe("effect_unknown");
    expect(bucket.puts).toHaveLength(1);
    unavailableReadback.mockRestore();
  });

  it("keeps a conditional-null replacement with unavailable read-back effect-unknown", async () => {
    const original = await bucket.seed(key, data, now - 5_000);
    const observed = await store.read(key, 100);
    expect(observed.kind).toBe("observed");
    if (observed.kind !== "observed") return;

    bucket.forceRefusal = true;
    let getCalls = 0;
    vi.spyOn(bucket, "get").mockImplementation(async (requestedKey) => {
      getCalls += 1;
      if (getCalls === 2) throw new Error("storage unavailable");
      return bucket.objects.get(requestedKey) ?? null;
    });

    const result = await store.replace(
      observed.observation,
      new TextEncoder().encode("candidate"),
    );

    expect(result).toEqual({
      kind: "effect_unknown",
      retryAfterEpochMs: now + 1_100,
    });
    expect(bucket.puts).toHaveLength(1);
    expect(bucket.puts[0]?.options.onlyIf).toEqual({
      etagMatches: original.etag,
    });
  });

  it("refuses a conditional-null replacement with absent read-back", async () => {
    const original = await bucket.seed(key, data, now - 5_000);
    const observed = await store.read(key, 100);
    expect(observed.kind).toBe("observed");
    if (observed.kind !== "observed") return;
    bucket.forceRefusal = true;
    bucket.nullPutHook = async (putKey) => {
      bucket.objects.delete(putKey);
    };

    const result = await store.replace(
      observed.observation,
      new TextEncoder().encode("candidate"),
    );

    expect(result.kind).toBe("refused");
    expect(bucket.objects.has(key)).toBe(false);
    expect(bucket.puts).toHaveLength(1);
    expect(bucket.puts[0]?.options.onlyIf).toEqual({
      etagMatches: original.etag,
    });
  });

  it("allows only one writer from one observed CAS generation to confirm", async () => {
    await bucket.seed(key, data, now - 5_000);
    const read = await store.read(key, 100);
    expect(read.kind).toBe("observed");
    if (read.kind !== "observed") return;
    const outcomes = await Promise.all([
      store.replace(read.observation, new TextEncoder().encode("first")),
      store.replace(read.observation, new TextEncoder().encode("second")),
    ]);
    expect(outcomes.map(({ kind }) => kind).sort()).toEqual([
      "confirmed",
      "refused",
    ]);
  });

  it("confirms a lost PUT response only when exact read-back matches", async () => {
    bucket.putFailure = new Error("network timeout");
    bucket.writeThenFail = true;
    const confirmed = await store.create(key, data);
    expect(confirmed.kind).toBe("confirmed");
  });

  it("keeps unavailable or divergent read-back unknown", async () => {
    bucket.putFailure = new Error("network timeout");
    bucket.getFailure = new Error("storage unavailable");
    bucket.writeThenFail = true;
    expect((await store.create(key, data)).kind).toBe("effect_unknown");
    bucket.getFailure = undefined;
    bucket.objects.clear();
    bucket.writeThenFail = true;
    bucket.replacementOnFailure = new TextEncoder().encode("divergent");
    expect((await store.create(key, data)).kind).toBe("effect_unknown");
  });

  it("defers retries from uploaded time and uncertain-response time without sleeping", async () => {
    await bucket.seed(key, data, now);
    const observed = await store.read(key, 100);
    expect(observed.kind).toBe("observed");
    if (observed.kind !== "observed") return;
    expect((await store.replace(observed.observation, data)).kind).toBe(
      "throttled",
    );
    now += 1_100;
    bucket.putFailure = new Error("429 rate limit");
    const limited = await store.replace(
      observed.observation,
      new TextEncoder().encode("x"),
    );
    expect(limited).toEqual({
      kind: "throttled",
      retryAfterEpochMs: now + 1_100,
    });
  });

  it("carries timeout cooldown evidence across stores and blocks a pre-floor retry", async () => {
    bucket.putFailure = new Error("network timeout");
    const uncertain = await store.create(key, data);
    expect(uncertain).toEqual({
      kind: "effect_unknown",
      retryAfterEpochMs: now + 1_100,
    });
    if (
      uncertain.kind !== "effect_unknown" ||
      uncertain.retryAfterEpochMs === undefined
    )
      return;

    const nextIsolateStore = syncR2ObjectStore(bucket, () => now);
    const putsBeforeRetry = bucket.puts.length;
    expect(
      await nextIsolateStore.create(key, data, {
        retryAfterEpochMs: uncertain.retryAfterEpochMs,
      }),
    ).toEqual({
      kind: "throttled",
      retryAfterEpochMs: uncertain.retryAfterEpochMs,
    });
    expect(bucket.puts).toHaveLength(putsBeforeRetry);

    now = uncertain.retryAfterEpochMs;
    bucket.putFailure = undefined;
    expect(
      (
        await nextIsolateStore.create(key, data, {
          retryAfterEpochMs: uncertain.retryAfterEpochMs,
        })
      ).kind,
    ).toBe("confirmed");
  });

  it("rejects malformed size limits and inconsistent R2 body evidence", async () => {
    const reads = vi.spyOn(bucket, "get");
    expect((await store.read(key, -1)).kind).toBe("unavailable");
    expect((await store.read(key, 1.5)).kind).toBe("unavailable");
    expect((await store.read(key, 1_048_577)).kind).toBe("unavailable");
    expect(reads).not.toHaveBeenCalled();

    const stored = await bucket.seed(key, data, now, data.byteLength + 1);
    expect((await store.read(key, data.byteLength + 1)).kind).toBe(
      "unavailable",
    );
    expect(stored.arrayBufferCalls).toBe(1);
  });

  it("treats incomplete R2 generation metadata as unavailable, not absence", async () => {
    bucket.objects.set(key, new MemoryObject(key, data, "", new Date(now)));
    expect((await store.read(key, 100)).kind).toBe("unavailable");
    bucket.objects.set(
      key,
      new MemoryObject(key, data, "etag-valid", new Date(Number.NaN)),
    );
    expect((await store.read(key, 100)).kind).toBe("unavailable");
    bucket.objects.set(
      key,
      new MemoryObject("different-key", data, "etag-valid", new Date(now)),
    );
    expect((await store.read(key, 100)).kind).toBe("unavailable");
  });

  it("refuses missing validators and invalid caller retry floors without writing", async () => {
    await bucket.seed(key, data, now - 5_000);
    const read = await store.read(key, 100);
    expect(read.kind).toBe("observed");
    if (read.kind !== "observed") return;
    const putsBeforeInvalidEvidence = bucket.puts.length;
    expect(
      await store.replace(
        { ...read.observation, etag: "" },
        new TextEncoder().encode("next"),
      ),
    ).toEqual({ kind: "effect_unknown" });
    expect(await store.create(key, data, { retryAfterEpochMs: -1 })).toEqual({
      kind: "effect_unknown",
    });
    expect(await store.create(key, data, { retryAfterEpochMs: 1.5 })).toEqual({
      kind: "effect_unknown",
    });
    expect(bucket.puts).toHaveLength(putsBeforeInvalidEvidence);
  });

  it("admits exact canonical keys for each isolated sync record family", () => {
    const revision = syncRevisionSchema.parse(
      "22222222-2222-4222-8222-222222222222",
    );
    const operation = syncOperationIdSchema.parse(
      "33333333-3333-4333-8333-333333333333",
    );
    const inventory = syncInventoryIdSchema.parse(
      "44444444-4444-4444-8444-444444444444",
    );
    const sequence = syncEventSequenceSchema.parse("00000000000000000001");
    const path = syncNotePathSchema.parse("notes/example.md");
    const acceptedKeys = [
      syncVaultMarkerKey(vaultId),
      syncHeadKey(vaultId, path),
      syncVersionKey(vaultId, revision),
      syncContentKey(vaultId, revision),
      syncOperationKey(vaultId, operation),
      syncRecoveryKey(vaultId, operation, "metadata"),
      syncRecoveryKey(vaultId, operation, "content"),
      syncInventoryActiveKey(vaultId),
      syncInventoryManifestKey(vaultId, inventory),
      syncInventoryChunkKey(vaultId, inventory, 0),
      syncFeedLaneHeadKey(vaultId, 63),
      syncFeedEventKey(vaultId, 63, sequence),
    ];
    for (const value of acceptedKeys) {
      expect(createSyncR2Key(value, vaultId)).toBe(value);
    }
  });

  it("rejects malformed canonical key families at key admission", async () => {
    const invalidKeys = [
      "vault/legacy.md",
      `sync/v1/vaults/${vaultId}/heads/not-base64!.json`,
      `sync/v1/vaults/${vaultId}/versions/11111111-1111-4111-8111-11111111111A.json`,
      `sync/v1/vaults/${vaultId}/inventories/scans/22222222-2222-4222-8222-222222222222/chunks/01.json`,
      `sync/v1/vaults/${vaultId}/feed/40/head.json`,
      `sync/v1/vaults/${vaultId}/feed/00/events/00000000000000000000.json`,
    ];
    for (const invalidKey of invalidKeys) {
      expect(createSyncR2Key(invalidKey, vaultId)).toBeUndefined();
    }
    await expect(store.create(key, new Uint8Array(2_049))).rejects.toThrow(
      RangeError,
    );
    await expect(store.create(key, new Uint8Array(1_048_577))).rejects.toThrow(
      RangeError,
    );
    await bucket.seed(key, data, now - 5_000);
    expect((await store.read(key, 1)).kind).toBe("unavailable");
  });
});
