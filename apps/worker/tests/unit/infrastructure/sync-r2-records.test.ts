import { createContentSha256 } from "@obsidian-ai-bridge/core";
import {
  syncContentKey,
  syncHeadKey,
  syncRecoveryKey,
  syncVaultMarkerKey,
  syncVersionKey,
} from "@protocol/sync.codec";
import {
  syncDeviceIdSchema,
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
import { syncR2Records } from "@worker/infrastructure/sync/sync-r2-records";
import { encodeSyncRecord } from "@worker/infrastructure/sync/sync-record.codec";
import type {
  SyncHeadRecord,
  SyncRecoveryMetadata,
} from "@worker/infrastructure/sync/sync-record.types";
import { beforeEach, describe, expect, it } from "vitest";

const vaultId = syncVaultIdSchema.parse("11111111-1111-4111-8111-111111111111");
const path = syncNotePathSchema.parse("notes/example.md");
const revision = syncRevisionSchema.parse(
  "22222222-2222-4222-8222-222222222222",
);
const alternateRevision = syncRevisionSchema.parse(
  "33333333-3333-4333-8333-333333333333",
);
const operationId = syncOperationIdSchema.parse(
  "44444444-4444-4444-8444-444444444444",
);
const deviceId = syncDeviceIdSchema.parse(
  "55555555-5555-4555-8555-555555555555",
);
const payload = new TextEncoder().encode("# Exact\r\nbody 🌐\n");
const digest = checkedSha256(
  "5233e986028efd912c63be9f5576784bea82ec1cbb7e5e0ea22ce9b40e08a70d",
);

function checkedSha256(value: string) {
  const parsed = createContentSha256(value);
  if (parsed === undefined) throw new Error("Expected valid fixture SHA-256.");
  return parsed;
}

function markerKey(): string {
  const key = createSyncR2Key(syncVaultMarkerKey(vaultId), vaultId);
  if (key === undefined) throw new Error("Expected canonical marker key.");
  return key;
}

class MemoryObject implements R2ConditionalStoredObject {
  readonly size: number;
  readonly etag: string;
  readonly uploaded: Date;
  readonly customMetadata = {};
  private readonly body: Uint8Array;

  constructor(
    readonly key: string,
    bytes: Uint8Array,
    etag: string,
    uploaded: number,
  ) {
    this.body = bytes.slice();
    this.size = bytes.byteLength;
    this.etag = etag;
    this.uploaded = new Date(uploaded);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.body.slice().buffer;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.body);
  }
}

class MemoryBucket implements R2ConditionalBucketPort {
  readonly objects = new Map<string, MemoryObject>();
  readonly puts: { key: string; options: R2ConditionalPutOptions }[] = [];
  failure: Error | undefined;
  readonly unavailableKeys = new Set<string>();
  getHook: ((key: string) => void) | undefined;
  failReadback = false;
  sequence = 0;

  async get(key: string): Promise<R2ConditionalStoredObject | null> {
    this.getHook?.(key);
    if (this.unavailableKeys.has(key)) throw new Error("storage unavailable");
    if (this.failReadback && this.puts.some((put) => put.key === key)) {
      throw new Error("read-back unavailable");
    }
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
    const predicate = options.onlyIf;
    const accepted =
      predicate instanceof Headers
        ? previous === undefined && predicate.get("If-None-Match") === "*"
        : previous?.etag === predicate.etagMatches;
    if (!accepted) return null;
    if (this.failure !== undefined) throw this.failure;
    const bytes =
      typeof content === "string" ? new TextEncoder().encode(content) : content;
    const object = new MemoryObject(
      key,
      bytes,
      `etag-${++this.sequence}`,
      10_000,
    );
    this.objects.set(key, object);
    return object;
  }

  seed(key: string, bytes: Uint8Array): void {
    this.objects.set(
      key,
      new MemoryObject(key, bytes, `etag-${++this.sequence}`, 1),
    );
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digestBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", copy.buffer),
  );
  return Array.from(digestBytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function makeHead(
  currentRevision = revision,
  contentSha256 = digest,
  byteSize = payload.byteLength,
): SyncHeadRecord {
  return {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    path,
    revision: currentRevision,
    parent: { kind: "never_seen" },
    contentSha256,
    byteSize,
    mediaType: "text/markdown",
    operationId,
    origin: deviceId,
    kind: "live",
  };
}

function makeRecovery(): SyncRecoveryMetadata {
  return {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    path,
    operationId,
    sourceRevision: revision,
    contentSha256: digest,
    byteSize: payload.byteLength,
    mediaType: "text/markdown",
    origin: deviceId,
  };
}

let bucket: MemoryBucket;
let records: ReturnType<typeof syncR2Records>;

beforeEach(() => {
  bucket = new MemoryBucket();
  records = syncR2Records(syncR2ObjectStore(bucket, () => 20_000));
});

async function seedMarker(): Promise<void> {
  bucket.seed(
    markerKey(),
    new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        protocolMajor: 1,
        vaultId,
      }),
    ),
  );
}

async function seedContent(
  forRevision = revision,
  bytes = payload,
): Promise<void> {
  const key = createSyncR2Key(syncContentKey(vaultId, forRevision), vaultId);
  if (key === undefined) throw new Error("Expected canonical content key.");
  bucket.seed(key, bytes);
}

async function seedVersion(record = makeHead()): Promise<void> {
  const key = createSyncR2Key(
    syncVersionKey(vaultId, record.revision),
    vaultId,
  );
  if (key === undefined) throw new Error("Expected canonical version key.");
  const encoded = await encodeSyncRecord({ kind: "version", record });
  bucket.seed(key, encoded);
}

describe("marker-gated isolated sync current and recovery records", () => {
  it("does not treat missing records as absent until the matching marker is validated", async () => {
    expect(await records.readHead(vaultId, path)).toEqual({
      kind: "unavailable",
    });
    expect((await records.readVersion(vaultId, revision)).kind).toBe(
      "unavailable",
    );
    expect((await records.readRecovery(vaultId, operationId)).kind).toBe(
      "unavailable",
    );
    await seedMarker();
    expect(await records.readHead(vaultId, path)).toEqual({ kind: "absent" });
  });

  it("distinguishes definite marker and linked-body rejection from unavailable evidence", async () => {
    expect(
      (await records.createHead(makeHead(), { retryAfterEpochMs: 99_000 }))
        .kind,
    ).toBe("refused");
    bucket.unavailableKeys.add(markerKey());
    expect((await records.createHead(makeHead())).kind).toBe("effect_unknown");

    bucket.unavailableKeys.clear();
    await seedMarker();
    expect((await records.createVersion(makeHead())).kind).toBe("refused");
    const contentKey = syncContentKey(vaultId, revision);
    bucket.unavailableKeys.add(contentKey);
    expect((await records.createVersion(makeHead())).kind).toBe(
      "effect_unknown",
    );

    bucket.unavailableKeys.clear();
    bucket.seed(contentKey, new TextEncoder().encode("different bytes"));
    expect((await records.createVersion(makeHead())).kind).toBe("refused");
  });

  it("refuses reads and writes when the vault marker is absent, malformed, or cross-vault", async () => {
    expect((await records.createHead(makeHead())).kind).toBe("refused");
    bucket.seed(markerKey(), new TextEncoder().encode("{"));
    expect((await records.readHead(vaultId, path)).kind).toBe("unavailable");
    bucket.seed(
      markerKey(),
      new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          protocolMajor: 1,
          vaultId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }),
      ),
    );
    expect((await records.createHead(makeHead())).kind).toBe("refused");
  });

  it("validates same-vault head identity against the exact canonical path key", async () => {
    await seedMarker();
    const wrongPathKey = createSyncR2Key(
      syncHeadKey(vaultId, syncNotePathSchema.parse("notes/other.md")),
      vaultId,
    );
    if (wrongPathKey === undefined)
      throw new Error("Expected canonical head key.");
    const encoded = await encodeSyncRecord({
      kind: "head",
      record: makeHead(),
    });
    bucket.seed(wrongPathKey, encoded);
    expect(
      (
        await records.readHead(
          vaultId,
          syncNotePathSchema.parse("notes/other.md"),
        )
      ).kind,
    ).toBe("unavailable");
  });

  it("requires exact version content digest and size before returning version metadata", async () => {
    await seedMarker();
    expect((await records.readVersion(vaultId, revision)).kind).toBe("absent");
    await seedContent();
    expect((await records.readVersion(vaultId, revision)).kind).toBe(
      "unavailable",
    );
    await seedVersion();
    await seedContent();
    const result = await records.readVersion(vaultId, revision);
    expect(result.kind).toBe("observed");
    if (result.kind === "observed")
      expect(result.observation.value).toEqual(makeHead());

    bucket.seed(
      createSyncR2Key(syncContentKey(vaultId, revision), vaultId) ?? "",
      new TextEncoder().encode("different body"),
    );
    expect((await records.readVersion(vaultId, revision)).kind).toBe(
      "unavailable",
    );
  });

  it("does not synthesize a present version when linked content is missing", async () => {
    await seedMarker();
    await seedVersion();
    expect((await records.readVersion(vaultId, revision)).kind).toBe(
      "unavailable",
    );
    await seedContent(revision, payload);
    const wrongSize = makeHead(revision, digest, payload.byteLength + 1);
    const versionKey = createSyncR2Key(
      syncVersionKey(vaultId, revision),
      vaultId,
    );
    if (versionKey === undefined)
      throw new Error("Expected canonical version key.");
    bucket.seed(
      versionKey,
      await encodeSyncRecord({ kind: "version", record: wrongSize }),
    );
    expect((await records.readVersion(vaultId, revision)).kind).toBe(
      "unavailable",
    );
  });

  it("preserves exact 1 MiB body bytes and rejects mismatched metadata", async () => {
    await seedMarker();
    const largePayload = new Uint8Array(1_048_576);
    largePayload[0] = 0x0a;
    const largeDigest = checkedSha256(await sha256Hex(largePayload));
    await seedVersion(makeHead(revision, largeDigest, largePayload.byteLength));
    await seedContent(revision, largePayload);
    const result = await records.readVersion(vaultId, revision);
    expect(result.kind).toBe("observed");
    const content = await records.readContent(vaultId, revision);
    expect(content.kind).toBe("observed");
    if (content.kind === "observed") {
      expect(content.observation.value.bytes).toEqual(largePayload);
      expect(content.observation.value.byteSize).toBe(largePayload.byteLength);
      expect(content.observation.value.contentSha256).toBe(largeDigest);
    }
  });

  it("rejects second-read content that no longer matches verified version metadata", async () => {
    await seedMarker();
    await seedVersion();
    await seedContent();
    const key = syncContentKey(vaultId, revision);
    let reads = 0;
    bucket.getHook = (requestedKey) => {
      if (requestedKey === key && ++reads === 2)
        bucket.seed(key, new TextEncoder().encode("divergent second read"));
    };
    expect((await records.readContent(vaultId, revision)).kind).toBe(
      "unavailable",
    );
  });

  it("does not return content when its body disappears after verification", async () => {
    await seedMarker();
    await seedVersion();
    await seedContent();
    const key = syncContentKey(vaultId, revision);
    let reads = 0;
    bucket.getHook = (requestedKey) => {
      if (requestedKey === key && ++reads === 2) bucket.objects.delete(key);
    };
    expect((await records.readContent(vaultId, revision)).kind).toBe(
      "unavailable",
    );
  });

  it("does not return content when its second body read becomes unavailable", async () => {
    await seedMarker();
    await seedVersion();
    await seedContent();
    const key = syncContentKey(vaultId, revision);
    let reads = 0;
    bucket.getHook = (requestedKey) => {
      if (requestedKey === key && ++reads === 2)
        bucket.unavailableKeys.add(key);
    };
    expect((await records.readContent(vaultId, revision)).kind).toBe(
      "unavailable",
    );
  });

  it("creates same-content revisions at distinct immutable keys and refuses conflicts", async () => {
    await seedMarker();
    const first = makeHead(revision);
    const second = makeHead(alternateRevision);
    expect(
      (
        await records.createContent({
          kind: "contentBody",
          vaultId,
          revision,
          bytes: payload,
          byteSize: payload.byteLength,
          contentSha256: digest,
        })
      ).kind,
    ).toBe("confirmed");
    expect(
      (
        await records.createContent({
          kind: "contentBody",
          vaultId,
          revision: alternateRevision,
          bytes: payload,
          byteSize: payload.byteLength,
          contentSha256: digest,
        })
      ).kind,
    ).toBe("confirmed");
    const conflictingBytes = new TextEncoder().encode("different exact body");
    const conflictingDigest = checkedSha256(await sha256Hex(conflictingBytes));
    expect(
      (
        await records.createContent({
          kind: "contentBody",
          vaultId,
          revision,
          bytes: conflictingBytes,
          byteSize: conflictingBytes.byteLength,
          contentSha256: conflictingDigest,
        })
      ).kind,
    ).toBe("refused");
    expect((await records.createVersion(first)).kind).toBe("confirmed");
    expect((await records.createVersion(second)).kind).toBe("confirmed");
    expect(bucket.objects.has(syncVersionKey(vaultId, revision))).toBe(true);
    expect(bucket.objects.has(syncVersionKey(vaultId, alternateRevision))).toBe(
      true,
    );
    expect(
      (
        await records.createVersion({
          ...first,
          operationId: syncOperationIdSchema.parse(
            "66666666-6666-4666-8666-666666666666",
          ),
        })
      ).kind,
    ).toBe("refused");
  });

  it("does not persist a head whose parent repeats its own revision", async () => {
    await seedMarker();
    const putsBeforeInvalidRecord = bucket.puts.length;
    expect(
      (
        await records.createHead({
          ...makeHead(),
          parent: { kind: "revision", revision },
        })
      ).kind,
    ).toBe("effect_unknown");
    expect(bucket.puts).toHaveLength(putsBeforeInvalidRecord);
  });

  it("refuses exact-head replacement after the observed generation becomes stale", async () => {
    await seedMarker();
    expect((await records.createHead(makeHead())).kind).toBe("confirmed");
    const observed = await records.readHead(vaultId, path);
    expect(observed.kind).toBe("observed");
    if (observed.kind !== "observed") return;
    const key = syncHeadKey(vaultId, path);
    const putsBeforeStaleAttempt = bucket.puts.length;
    const winner = {
      ...makeHead(alternateRevision),
      parent: { kind: "revision" as const, revision },
    };
    bucket.seed(key, await encodeSyncRecord({ kind: "head", record: winner }));
    expect((await records.replaceHead(observed.observation, winner)).kind).toBe(
      "refused",
    );
    expect(bucket.puts).toHaveLength(putsBeforeStaleAttempt);
  });

  it("rejects forged or malformed observed head evidence before replacement", async () => {
    await seedMarker();
    expect((await records.createHead(makeHead())).kind).toBe("confirmed");
    const observed = await records.readHead(vaultId, path);
    if (observed.kind !== "observed")
      throw new Error("Expected exact head observation.");
    const replacement = {
      ...makeHead(alternateRevision),
      parent: { kind: "revision" as const, revision },
    };
    const putsBeforeForgery = bucket.puts.length;
    expect(
      (
        await records.replaceHead(
          { ...observed.observation, value: makeHead(alternateRevision) },
          replacement,
        )
      ).kind,
    ).toBe("refused");
    expect(
      (
        await records.replaceHead(
          {
            ...observed.observation,
            value: {
              ...observed.observation.value,
              path: syncNotePathSchema.parse("notes/foreign.md"),
            },
          },
          replacement,
        )
      ).kind,
    ).toBe("refused");
    expect(bucket.puts).toHaveLength(putsBeforeForgery);

    expect(
      (
        await records.replaceHead(
          {
            ...observed.observation,
            observed: {
              ...observed.observation.observed,
              bytes: new TextEncoder().encode("{"),
            },
          },
          replacement,
        )
      ).kind,
    ).toBe("effect_unknown");
    expect(bucket.puts).toHaveLength(putsBeforeForgery);
  });

  it("does not confirm an uncertain create without exact linked read-back", async () => {
    await seedMarker();
    bucket.failure = new Error("network timeout");
    bucket.failReadback = true;
    const result = await records.createHead(makeHead());
    expect(result.kind).toBe("effect_unknown");
  });

  it.each([
    ["timeout", new Error("write timeout"), "effect_unknown"],
    [
      "rate limit",
      Object.assign(new Error("R2 rate limit"), { status: 429 }),
      "throttled",
    ],
  ] as const)(
    "forwards a %s create cooldown to a fresh records facade",
    async (_label, failure, expectedKind) => {
      await seedMarker();
      bucket.failure = failure;
      const first = await records.createHead(makeHead());
      expect(first.kind).toBe(expectedKind);
      if (
        (first.kind !== "effect_unknown" && first.kind !== "throttled") ||
        first.retryAfterEpochMs === undefined
      )
        throw new Error("Expected write cooldown evidence.");
      const retryContext = { retryAfterEpochMs: first.retryAfterEpochMs };

      bucket.failure = undefined;
      const freshRecords = syncR2Records(
        syncR2ObjectStore(bucket, () => 20_000),
      );
      const putsBeforeEarlyRetry = bucket.puts.length;
      expect(await freshRecords.createHead(makeHead(), retryContext)).toEqual({
        kind: "throttled",
        retryAfterEpochMs: first.retryAfterEpochMs,
      });
      expect(bucket.puts).toHaveLength(putsBeforeEarlyRetry);

      expect(first.retryAfterEpochMs).toBe(21_100);
      expect(await freshRecords.createHead(makeHead(), retryContext)).toEqual({
        kind: "throttled",
        retryAfterEpochMs: 21_100,
      });
      const atFloorRecords = syncR2Records(
        syncR2ObjectStore(bucket, () => 21_100),
      );
      expect(await atFloorRecords.createHead(makeHead(), retryContext)).toEqual(
        { kind: "confirmed" },
      );
    },
  );

  it("forwards exact-head replacement cooldown while retaining the observed ETag", async () => {
    await seedMarker();
    expect((await records.createHead(makeHead())).kind).toBe("confirmed");
    const observed = await records.readHead(vaultId, path);
    if (observed.kind !== "observed")
      throw new Error("Expected head observation.");
    const replacement = {
      ...makeHead(alternateRevision),
      parent: { kind: "revision" as const, revision },
    };

    bucket.failure = new Error("write timeout");
    const first = await records.replaceHead(observed.observation, replacement);
    expect(first.kind).toBe("effect_unknown");
    if (
      first.kind !== "effect_unknown" ||
      first.retryAfterEpochMs === undefined
    )
      throw new Error("Expected uncertain-write cooldown evidence.");
    const retryAfterEpochMs = first.retryAfterEpochMs;
    const retryContext = { retryAfterEpochMs };

    bucket.failure = undefined;
    const freshRecords = syncR2Records(syncR2ObjectStore(bucket, () => 20_000));
    const putsBeforeEarlyRetry = bucket.puts.length;
    expect(
      await freshRecords.replaceHead(
        observed.observation,
        replacement,
        retryContext,
      ),
    ).toEqual({
      kind: "throttled",
      retryAfterEpochMs,
    });
    expect(bucket.puts).toHaveLength(putsBeforeEarlyRetry);
    const atFloorRecords = syncR2Records(
      syncR2ObjectStore(bucket, () => retryAfterEpochMs),
    );
    expect(
      await atFloorRecords.replaceHead(
        observed.observation,
        replacement,
        retryContext,
      ),
    ).toEqual({ kind: "confirmed" });
    expect(bucket.puts.at(-1)?.options.onlyIf).toEqual({
      etagMatches: observed.observation.observed.etag,
    });
  });

  it("validates recovery metadata and raw recovery body together", async () => {
    await seedMarker();
    expect((await records.readRecovery(vaultId, operationId)).kind).toBe(
      "absent",
    );
    const metadataKey = createSyncR2Key(
      syncRecoveryKey(vaultId, operationId, "metadata"),
      vaultId,
    );
    const bodyKey = createSyncR2Key(
      syncRecoveryKey(vaultId, operationId, "content"),
      vaultId,
    );
    if (metadataKey === undefined || bodyKey === undefined)
      throw new Error("Expected recovery keys.");
    const metadata: SyncRecoveryMetadata = makeRecovery();
    bucket.seed(bodyKey, payload);
    expect((await records.readRecovery(vaultId, operationId)).kind).toBe(
      "unavailable",
    );
    const encoded = await encodeSyncRecord({
      kind: "recoveryMetadata",
      record: metadata,
    });
    bucket.seed(metadataKey, encoded);
    bucket.seed(bodyKey, payload);
    expect((await records.readRecovery(vaultId, operationId)).kind).toBe(
      "observed",
    );
    bucket.seed(bodyKey, new TextEncoder().encode("wrong"));
    expect((await records.readRecovery(vaultId, operationId)).kind).toBe(
      "unavailable",
    );
  });

  it("creates recovery metadata only after its exact body has been persisted", async () => {
    await seedMarker();
    const record = makeRecovery();
    expect((await records.createRecovery(record)).kind).toBe("refused");

    const bodyRecord = {
      kind: "recoveryBody" as const,
      vaultId,
      operationId,
      bytes: payload,
      byteSize: payload.byteLength,
      contentSha256: digest,
    };
    expect((await records.createRecoveryBody(bodyRecord)).kind).toBe(
      "confirmed",
    );
    expect(
      (
        await records.createRecovery({
          ...record,
          contentSha256: checkedSha256("a".repeat(64)),
        })
      ).kind,
    ).toBe("refused");
    expect((await records.createRecovery(record)).kind).toBe("confirmed");
    expect((await records.readRecovery(vaultId, operationId)).kind).toBe(
      "observed",
    );
  });
});
