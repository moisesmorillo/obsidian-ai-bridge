import { syncVaultMarkerKey } from "@protocol/sync.codec";
import { syncVaultIdSchema } from "@protocol/sync.schemas";
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

  constructor(key: string, bytes: Uint8Array, etag: string, uploaded: Date) {
    this.key = key;
    this.size = bytes.byteLength;
    this.etag = etag;
    this.uploaded = uploaded;
    this.bytes = bytes.slice();
  }
  private readonly bytes: Uint8Array;
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
    key: string;
    bytes: Uint8Array;
    options: R2ConditionalPutOptions;
  }[] = [];
  putFailure: Error | undefined;
  getFailure: Error | undefined;
  forceRefusal = false;
  writeThenFail = false;
  replacementOnFailure: Uint8Array | undefined;
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
    if (!expected || this.forceRefusal) return null;
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
  ): Promise<MemoryObject> {
    const object = new MemoryObject(
      key,
      bytes,
      `etag-${++this.etagSequence}`,
      new Date(uploaded),
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

  it("returns a timeout cooldown and permits the same create only after that lower bound", async () => {
    bucket.putFailure = new Error("network timeout");
    const uncertain = await store.create(key, data);
    expect(uncertain).toEqual({
      kind: "effect_unknown",
      retryAfterEpochMs: now + 1_100,
    });
    expect(await store.create(key, data)).toEqual({
      kind: "throttled",
      retryAfterEpochMs: now + 1_100,
    });
    now += 1_100;
    bucket.putFailure = undefined;
    expect((await store.create(key, data)).kind).toBe("confirmed");
  });

  it("rejects non-sync and oversized keys/bodies before storage access", async () => {
    const reads = vi.spyOn(bucket, "get");
    expect(createSyncR2Key("vault/legacy.md", vaultId)).toBeUndefined();
    expect(reads).not.toHaveBeenCalled();
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
