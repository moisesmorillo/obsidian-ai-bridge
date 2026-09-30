import { createContentSha256 } from "@obsidian-ai-bridge/core";
import {
  syncFeedEventKey,
  syncFeedLaneForPath,
  syncFeedLaneHeadKey,
  syncOperationKey,
  syncRecoveryKey,
  syncVaultMarkerKey,
  syncVersionKey,
} from "@protocol/sync.codec";
import {
  syncNotePathSchema as notePathSchema,
  syncDeviceIdSchema,
  syncEventSequenceSchema,
  syncOperationIdSchema,
  syncRevisionSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type { SyncOperationIdDto } from "@protocol/sync.types";
import type {
  R2ConditionalBucketPort,
  R2ConditionalObjectMetadata,
  R2ConditionalPutOptions,
  R2ConditionalStoredObject,
} from "@worker/infrastructure/r2.types";
import { encodeSyncPublication } from "@worker/infrastructure/sync/sync-publication.codec";
import { SYNC_PUBLICATION_LIMITS } from "@worker/infrastructure/sync/sync-publication.schemas";
import type {
  SyncFeedEventRecord,
  SyncJournalRecord,
  SyncLaneHeadRecord,
  SyncPendingJournalRecord,
} from "@worker/infrastructure/sync/sync-publication.types";
import type { SyncR2ObjectStore } from "@worker/infrastructure/sync/sync-r2.types";
import { createSyncR2Key } from "@worker/infrastructure/sync/sync-r2-key";
import { syncR2ObjectStore } from "@worker/infrastructure/sync/sync-r2-object";
import { syncR2Publication } from "@worker/infrastructure/sync/sync-r2-publication";
import { beforeEach, describe, expect, it } from "vitest";

const vaultId = syncVaultIdSchema.parse("11111111-1111-4111-8111-111111111111");
const operationId = syncOperationIdSchema.parse(
  "22222222-2222-4222-8222-222222222222",
);
const alternateOperationId = syncOperationIdSchema.parse(
  "33333333-3333-4333-8333-333333333333",
);
const revision = syncRevisionSchema.parse(
  "44444444-4444-4444-8444-444444444444",
);
const parentRevision = syncRevisionSchema.parse(
  "66666666-6666-4666-8666-666666666666",
);
const origin = syncDeviceIdSchema.parse("55555555-5555-4555-8555-555555555555");
const alternateOrigin = syncDeviceIdSchema.parse(
  "77777777-7777-4777-8777-777777777777",
);
const path = notePathSchema.parse("notes/exact.md");
const encoder = new TextEncoder();

class MemoryObject implements R2ConditionalStoredObject {
  readonly size: number;
  readonly customMetadata = {};
  private readonly bytes: Uint8Array;
  arrayBufferCalls = 0;

  constructor(
    readonly key: string,
    bytes: Uint8Array,
    readonly etag: string,
    readonly uploaded: Date,
  ) {
    this.bytes = bytes.slice();
    this.size = bytes.byteLength;
  }

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
    readonly key: string;
    readonly bytes: Uint8Array;
    readonly options: R2ConditionalPutOptions;
  }[] = [];
  readonly unavailableKeys = new Set<string>();
  failure: Error | undefined;
  failReadback = false;
  private etagSequence = 0;

  constructor(private readonly epochNow: () => number) {}

  async get(key: string): Promise<R2ConditionalStoredObject | null> {
    if (this.unavailableKeys.has(key)) throw new Error("R2 read unavailable");
    if (this.failReadback && this.puts.some((put) => put.key === key)) {
      throw new Error("R2 read-back unavailable");
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
    const bytes =
      typeof content === "string" ? encoder.encode(content) : content.slice();
    this.puts.push({ key, bytes, options });
    const previous = this.objects.get(key);
    const condition = options.onlyIf;
    const accepted =
      condition instanceof Headers
        ? previous === undefined && condition.get("If-None-Match") === "*"
        : previous?.etag === condition.etagMatches;
    if (!accepted) return null;
    if (this.failure !== undefined) throw this.failure;
    const object = new MemoryObject(
      key,
      bytes,
      `etag-${++this.etagSequence}`,
      new Date(this.epochNow()),
    );
    this.objects.set(key, object);
    return object;
  }

  seed(
    key: string,
    bytes: Uint8Array,
    uploadedAtEpochMs: number,
  ): MemoryObject {
    const object = new MemoryObject(
      key,
      bytes,
      `etag-${++this.etagSequence}`,
      new Date(uploadedAtEpochMs),
    );
    this.objects.set(key, object);
    return object;
  }
}

let epochNow: number;
let bucket: MemoryBucket;
let publication: ReturnType<typeof syncR2Publication>;

beforeEach(() => {
  epochNow = 10_000;
  bucket = new MemoryBucket(() => epochNow);
  publication = syncR2Publication(syncR2ObjectStore(bucket, () => epochNow));
});

async function seedMarker(forVault = vaultId): Promise<void> {
  const key = syncVaultMarkerKey(vaultId);
  bucket.seed(
    key,
    encoder.encode(
      JSON.stringify({ schemaVersion: 1, protocolMajor: 1, vaultId: forVault }),
    ),
    epochNow - 5_000,
  );
}

async function journal(
  content = "# Exact\r\nUnicode 🌐 and NUL \u0000",
  step: "reserve_lane" | "immutable_create" | "commit_journal" = "reserve_lane",
  journalOperationId: SyncOperationIdDto = operationId,
): Promise<SyncPendingJournalRecord> {
  const lane = await syncFeedLaneForPath(path);
  const bytes = encoder.encode(content);
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const contentSha256 = createContentSha256(
    Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput.buffer)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join(""),
  );
  if (contentSha256 === undefined) throw new Error("Invalid fixture digest.");
  const targetKey =
    step === "reserve_lane"
      ? syncFeedLaneHeadKey(vaultId, lane)
      : step === "immutable_create"
        ? syncVersionKey(vaultId, revision)
        : syncOperationKey(vaultId, journalOperationId);
  return {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    kind: "journal",
    status: "pending",
    operationId: journalOperationId,
    request: {
      kind: "create",
      vaultId,
      path,
      operationId: journalOperationId,
      revision,
      parent: { kind: "never_seen" },
      contentSha256,
      content,
      mediaType: "text/markdown",
      origin,
    },
    payload: { byteSize: bytes.byteLength },
    reservation: {
      lane,
      sequence: syncEventSequenceSchema.parse("00000000000000000001"),
      previousCommittedAtEpochMs: 0,
    },
    stepEvidence: {
      step,
      key: targetKey,
      precondition:
        step === "commit_journal"
          ? { kind: "journal_phase", status: "pending" }
          : { kind: "absent" },
      retryAfterEpochMs: null,
    },
  };
}

async function updateJournalRecord(
  journalOperationId: SyncOperationIdDto,
): Promise<SyncPendingJournalRecord> {
  const original = await journal(
    "# update request",
    "immutable_create",
    journalOperationId,
  );
  if (original.request.kind !== "create") {
    throw new Error("Expected a create-shaped fixture before conversion.");
  }
  return {
    ...original,
    request: {
      ...original.request,
      kind: "update",
      parent: { kind: "revision", revision: parentRevision },
    },
    reservation: {
      ...original.reservation,
      sequence: syncEventSequenceSchema.parse("00000000000000000002"),
      previousCommittedAtEpochMs: 100,
    },
  };
}

async function tombstoneJournalRecord(
  journalOperationId: SyncOperationIdDto,
): Promise<SyncPendingJournalRecord> {
  const original = await journal(
    "# tombstone parent",
    "immutable_create",
    journalOperationId,
  );
  if (original.request.kind !== "create") {
    throw new Error("Expected a create-shaped fixture before conversion.");
  }
  const sequence = syncEventSequenceSchema.parse("00000000000000000002");
  return {
    ...original,
    request: {
      kind: "tombstone",
      vaultId,
      path,
      operationId: journalOperationId,
      revision,
      parent: { kind: "revision", revision: parentRevision },
      contentSha256: original.request.contentSha256,
      origin,
    },
    payload: null,
    reservation: {
      ...original.reservation,
      sequence,
      previousCommittedAtEpochMs: 100,
    },
    stepEvidence: {
      step: "immutable_create",
      key: syncRecoveryKey(vaultId, journalOperationId, "metadata"),
      precondition: { kind: "absent" },
      retryAfterEpochMs: null,
    },
  };
}

function nextJournalStep(
  record: SyncPendingJournalRecord,
): SyncPendingJournalRecord {
  return {
    ...record,
    stepEvidence: {
      step: "create_event",
      key: syncFeedEventKey(
        record.vaultId,
        record.reservation.lane,
        record.reservation.sequence,
      ),
      precondition: { kind: "absent" },
      retryAfterEpochMs: null,
    },
  };
}

async function event(): Promise<SyncFeedEventRecord> {
  const lane = await syncFeedLaneForPath(path);
  return {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    kind: "changed",
    lane,
    sequence: syncEventSequenceSchema.parse("00000000000000000001"),
    path,
    result: { kind: "live", revision },
    operationId,
    origin,
    committedAtEpochMs: 1,
  };
}

async function initialLaneHead(): Promise<SyncLaneHeadRecord> {
  const lane = await syncFeedLaneForPath(path);
  return {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    kind: "laneHead",
    lane,
    committedSequence: syncSequenceSchema.parse("00000000000000000000"),
    committedAtEpochMs: 0,
  };
}

describe("marker-gated private sync publication persistence", () => {
  it("create-only replays journals and events with exact canonical read-back bytes", async () => {
    await seedMarker();
    const record = await journal();
    const journalKey = syncOperationKey(vaultId, operationId);

    expect(await publication.createJournal(record)).toEqual({
      kind: "confirmed",
    });
    const firstRead = await publication.readJournal(vaultId, operationId);
    expect(firstRead.kind).toBe("observed");
    if (firstRead.kind !== "observed") return;
    expect(firstRead.observation.value).toEqual(record);
    expect(firstRead.observation.observed.bytes).toEqual(
      bucket.objects.get(journalKey) === undefined
        ? []
        : await bucket.objects
            .get(journalKey)
            ?.arrayBuffer()
            .then((value) => new Uint8Array(value)),
    );
    expect(await publication.createJournal(record)).toEqual({
      kind: "confirmed",
    });
    expect(bucket.puts.filter((put) => put.key === journalKey)).toHaveLength(1);

    const feedEvent = await event();
    const eventKey = syncFeedEventKey(
      vaultId,
      feedEvent.lane,
      feedEvent.sequence,
    );
    expect(
      await publication.readEvent(vaultId, feedEvent.lane, feedEvent.sequence),
    ).toEqual({ kind: "absent" });
    expect(await publication.createEvent(feedEvent)).toEqual({
      kind: "confirmed",
    });
    const eventRead = await publication.readEvent(
      vaultId,
      feedEvent.lane,
      feedEvent.sequence,
    );
    expect(eventRead.kind).toBe("observed");
    if (eventRead.kind !== "observed") return;
    expect(eventRead.observation.value).toEqual(feedEvent);
    expect(eventRead.observation.observed.bytes).toEqual(
      await bucket.objects
        .get(eventKey)
        ?.arrayBuffer()
        .then((value) => new Uint8Array(value)),
    );
    expect(await publication.createEvent(feedEvent)).toEqual({
      kind: "confirmed",
    });
    expect(bucket.puts.filter((put) => put.key === eventKey)).toHaveLength(1);
  });

  it("persists and reads a valid request journal larger than the old 2-KiB operation-key limit", async () => {
    await seedMarker();
    const record = await journal("x".repeat(4_096));
    const key = syncOperationKey(vaultId, operationId);

    expect(await publication.createJournal(record)).toEqual({
      kind: "confirmed",
    });
    const stored = await publication.readJournal(vaultId, operationId);
    expect(stored.kind).toBe("observed");
    if (stored.kind !== "observed") return;
    expect(stored.observation.value.request.kind).toBe("create");
    if (stored.observation.value.request.kind !== "create") return;
    expect(stored.observation.value.request.content).toBe("x".repeat(4_096));
    expect(stored.observation.observed.bytes.byteLength).toBeGreaterThan(2_048);
    expect(bucket.objects.get(key)?.size).toBe(
      stored.observation.observed.bytes.byteLength,
    );
  });

  it("enforces the exact journal byte ceiling for create, replace, and bounded reads", async () => {
    const key = createSyncR2Key(
      syncOperationKey(vaultId, operationId),
      vaultId,
    );
    if (key === undefined) throw new Error("Expected canonical journal key.");
    const objects = syncR2ObjectStore(bucket, () => epochNow);
    const maximumBytes = SYNC_PUBLICATION_LIMITS.journalBytes;

    expect(await objects.create(key, new Uint8Array(maximumBytes))).toEqual({
      kind: "confirmed",
    });
    const oversized = new Uint8Array(maximumBytes + 1);
    await expect(objects.create(key, oversized)).rejects.toThrow("byte limit");
    const observed = await objects.read(key, maximumBytes);
    expect(observed.kind).toBe("observed");
    if (observed.kind !== "observed") return;
    await expect(
      objects.replace(observed.observation, oversized),
    ).rejects.toThrow("byte limit");

    const overLimitObject = bucket.seed(
      syncOperationKey(vaultId, alternateOperationId),
      oversized,
      epochNow - 5_000,
    );
    const overLimitKey = createSyncR2Key(
      syncOperationKey(vaultId, alternateOperationId),
      vaultId,
    );
    if (overLimitKey === undefined)
      throw new Error("Expected canonical journal key.");
    expect(await objects.read(overLimitKey, maximumBytes)).toEqual({
      kind: "unavailable",
    });
    expect(overLimitObject.arrayBufferCalls).toBe(0);
  });

  it("uses one exact observed lane-head ETag and refuses a competing reservation without refreshing", async () => {
    await seedMarker();
    const head = await initialLaneHead();
    const lane = head.lane;
    const key = syncFeedLaneHeadKey(vaultId, lane);
    expect(await publication.createLaneHead(head)).toEqual({
      kind: "confirmed",
    });
    epochNow += 1_100;
    const read = await publication.readLaneHead(vaultId, lane);
    expect(read.kind).toBe("observed");
    if (read.kind !== "observed") return;
    const observedEtag = read.observation.observed.etag;
    const reserved = {
      ...head,
      pending: {
        operationId,
        nextSequence: syncEventSequenceSchema.parse("00000000000000000001"),
      },
    };
    const competing = {
      ...head,
      pending: {
        operationId: alternateOperationId,
        nextSequence: syncEventSequenceSchema.parse("00000000000000000001"),
      },
    };

    expect(
      await publication.createLaneHead({ ...head, pending: reserved.pending }),
    ).toEqual({ kind: "refused" });
    const outcomes = await Promise.all([
      publication.replaceLaneHead(read.observation, reserved),
      publication.replaceLaneHead(read.observation, competing),
    ]);
    expect(outcomes.map(({ kind }) => kind).sort()).toEqual([
      "confirmed",
      "refused",
    ]);
    const casAttempts = bucket.puts.filter((put) => put.key === key).slice(1);
    expect(casAttempts).toHaveLength(2);
    expect(
      casAttempts.every(
        (put) =>
          "etagMatches" in put.options.onlyIf &&
          put.options.onlyIf.etagMatches === observedEtag,
      ),
    ).toBe(true);
  });

  it("refuses to replace an operation journal with a changed normalized request", async () => {
    await seedMarker();
    const original = await journal();
    expect(await publication.createJournal(original)).toEqual({
      kind: "confirmed",
    });
    const observed = await publication.readJournal(vaultId, operationId);
    expect(observed.kind).toBe("observed");
    if (observed.kind !== "observed") return;
    epochNow += 1_100;
    const changedRequest = await journal(
      "# A different operation body",
      "immutable_create",
    );

    expect(
      await publication.replaceJournal(observed.observation, changedRequest),
    ).toEqual({
      kind: "refused",
    });
    const changedOrigin = {
      ...original,
      request: {
        ...original.request,
        origin: alternateOrigin,
      },
    };
    expect(
      await publication.replaceJournal(observed.observation, changedOrigin),
    ).toEqual({ kind: "refused" });
    expect(
      bucket.puts.filter(
        (put) => put.key === syncOperationKey(vaultId, operationId),
      ),
    ).toHaveLength(1);
  });

  it("preserves update and tombstone journal requests across typed step changes", async () => {
    await seedMarker();
    const update = await updateJournalRecord(alternateOperationId);
    const tombstone = await tombstoneJournalRecord(
      syncOperationIdSchema.parse("88888888-8888-4888-8888-888888888888"),
    );
    for (const record of [update, tombstone]) {
      expect(await publication.createJournal(record)).toEqual({
        kind: "confirmed",
      });
      const observed = await publication.readJournal(
        vaultId,
        record.operationId,
      );
      expect(observed.kind).toBe("observed");
      if (observed.kind !== "observed") return;
      epochNow += 1_100;
      expect(
        await publication.replaceJournal(
          observed.observation,
          nextJournalStep(record),
        ),
      ).toEqual({ kind: "confirmed" });
    }
  });

  it("enforces the 1,100-ms cooldown on repeated journal and lane-head writes", async () => {
    await seedMarker();
    const record = await journal();
    const laneHead = await initialLaneHead();
    expect(await publication.createJournal(record)).toEqual({
      kind: "confirmed",
    });
    expect(await publication.createLaneHead(laneHead)).toEqual({
      kind: "confirmed",
    });

    const nextJournal: SyncJournalRecord = {
      ...record,
      stepEvidence: {
        step: "immutable_create",
        key: syncVersionKey(vaultId, revision),
        precondition: { kind: "absent" },
        retryAfterEpochMs: null,
      },
    };
    const journalRead = await publication.readJournal(vaultId, operationId);
    expect(journalRead.kind).toBe("observed");
    if (journalRead.kind !== "observed") return;
    const headRead = await publication.readLaneHead(vaultId, laneHead.lane);
    expect(headRead.kind).toBe("observed");
    if (headRead.kind !== "observed") return;

    const journalCooldown = await publication.replaceJournal(
      journalRead.observation,
      nextJournal,
    );
    const headCooldown = await publication.replaceLaneHead(
      headRead.observation,
      {
        ...laneHead,
        pending: {
          operationId,
          nextSequence: syncEventSequenceSchema.parse("00000000000000000001"),
        },
      },
    );
    expect(journalCooldown).toEqual({
      kind: "throttled",
      retryAfterEpochMs: 11_100,
    });
    expect(headCooldown).toEqual({
      kind: "throttled",
      retryAfterEpochMs: 11_100,
    });

    epochNow = 11_100;
    const cooledJournal = await publication.readJournal(vaultId, operationId);
    const cooledHead = await publication.readLaneHead(vaultId, laneHead.lane);
    expect(cooledJournal.kind).toBe("observed");
    expect(cooledHead.kind).toBe("observed");
    if (cooledJournal.kind !== "observed" || cooledHead.kind !== "observed")
      return;
    expect(
      await publication.replaceJournal(cooledJournal.observation, nextJournal, {
        retryAfterEpochMs: 11_100,
      }),
    ).toEqual({ kind: "confirmed" });
    expect(
      await publication.replaceLaneHead(
        cooledHead.observation,
        {
          ...laneHead,
          pending: {
            operationId,
            nextSequence: syncEventSequenceSchema.parse("00000000000000000001"),
          },
        },
        { retryAfterEpochMs: 11_100 },
      ),
    ).toEqual({ kind: "confirmed" });
  });

  it("refreshes only a journal's exact typed pending phase, never a lane-head CAS", async () => {
    await seedMarker();
    const phase = await journal(undefined, "commit_journal");
    const journalKey = syncOperationKey(vaultId, operationId);
    expect(await publication.createJournal(phase)).toEqual({
      kind: "confirmed",
    });
    const staleRead = await publication.readJournal(vaultId, operationId);
    expect(staleRead.kind).toBe("observed");
    if (staleRead.kind !== "observed") return;

    epochNow += 1_100;
    const current = bucket.seed(
      journalKey,
      staleRead.observation.observed.bytes,
      epochNow - 1_200,
    );
    const next = await journal(
      "# Exact\r\nUnicode 🌐 and NUL \u0000",
      "immutable_create",
    );
    const result = await publication.replaceJournal(
      staleRead.observation,
      next,
    );

    expect(result).toEqual({ kind: "confirmed" });
    expect(bucket.puts.at(-1)?.options.onlyIf).toEqual({
      etagMatches: current.etag,
    });
    expect(bucket.puts.at(-1)?.options.onlyIf).not.toEqual({
      etagMatches: staleRead.observation.observed.etag,
    });
    const writesBeforeReplay = bucket.puts.filter(
      (put) => put.key === journalKey,
    ).length;
    expect(
      await publication.replaceJournal(staleRead.observation, next),
    ).toEqual({ kind: "confirmed" });
    const divergent: SyncPendingJournalRecord = {
      ...next,
      stepEvidence: {
        step: "create_event",
        key: syncFeedEventKey(
          vaultId,
          next.reservation.lane,
          next.reservation.sequence,
        ),
        precondition: { kind: "absent" },
        retryAfterEpochMs: null,
      },
    };
    expect(
      await publication.replaceJournal(staleRead.observation, divergent),
    ).toEqual({ kind: "refused" });
    expect(bucket.puts.filter((put) => put.key === journalKey)).toHaveLength(
      writesBeforeReplay,
    );
  });

  it("returns a retry floor after 429 and preserves uncertainty when timeout read-back is unavailable", async () => {
    await seedMarker();
    const rateLimitedJournal = await journal();
    bucket.failure = Object.assign(new Error("rate limit"), { status: 429 });
    const limited = await publication.createJournal(rateLimitedJournal);
    expect(limited).toEqual({
      kind: "throttled",
      retryAfterEpochMs: epochNow + 1_100,
    });
    const writesAfterLimit = bucket.puts.length;
    bucket.failure = undefined;
    expect(
      await publication.createJournal(rateLimitedJournal, {
        retryAfterEpochMs: epochNow + 1_100,
      }),
    ).toEqual({ kind: "throttled", retryAfterEpochMs: epochNow + 1_100 });
    expect(bucket.puts).toHaveLength(writesAfterLimit);

    const timeoutJournal = await journal(
      "# timeout case",
      "reserve_lane",
      alternateOperationId,
    );
    bucket.failure = new Error("network timeout");
    bucket.failReadback = true;
    const unknown = await publication.createJournal(timeoutJournal);
    expect(unknown).toEqual({
      kind: "effect_unknown",
      retryAfterEpochMs: epochNow + 1_100,
    });
    const writesAfterTimeout = bucket.puts.length;
    bucket.failure = undefined;
    bucket.failReadback = false;
    expect(
      await publication.createJournal(timeoutJournal, {
        retryAfterEpochMs: epochNow + 1_100,
      }),
    ).toEqual({
      kind: "throttled",
      retryAfterEpochMs: epochNow + 1_100,
    });
    expect(bucket.puts).toHaveLength(writesAfterTimeout);
  });

  it("rejects malformed typed identifiers before reading any publication key", async () => {
    expect(await publication.readLaneHead(vaultId, 64)).toEqual({
      kind: "unavailable",
    });
    // @ts-expect-error A free-form vault string is not a validated M7.1 identifier.
    expect(await publication.readJournal("not-a-vault", operationId)).toEqual({
      kind: "unavailable",
    });
    // @ts-expect-error Feed sequence keys require the branded 20-digit sequence DTO.
    expect(await publication.readEvent(vaultId, 0, "1")).toEqual({
      kind: "unavailable",
    });
  });

  it("keeps malformed stored publication bytes unavailable rather than absent", async () => {
    await seedMarker();
    bucket.seed(
      syncOperationKey(vaultId, operationId),
      encoder.encode("{"),
      epochNow - 5_000,
    );

    expect(await publication.readJournal(vaultId, operationId)).toEqual({
      kind: "unavailable",
    });
  });

  it("maps one-key read and write exceptions to conservative publication results", async () => {
    const readFailingObjects: SyncR2ObjectStore = {
      read: async () => {
        throw new Error("marker read failed");
      },
      create: async () => {
        throw new Error("unexpected create");
      },
      replace: async () => {
        throw new Error("unexpected replace");
      },
    };
    const markerUnavailable = syncR2Publication(readFailingObjects);
    expect(await markerUnavailable.readJournal(vaultId, operationId)).toEqual({
      kind: "unavailable",
    });
    expect(await markerUnavailable.createJournal(await journal())).toEqual({
      kind: "effect_unknown",
    });

    await seedMarker();
    const baseObjects = syncR2ObjectStore(bucket, () => epochNow);
    const markerKey = createSyncR2Key(syncVaultMarkerKey(vaultId), vaultId);
    if (markerKey === undefined)
      throw new Error("Expected canonical marker key.");
    const publicationReadFails: SyncR2ObjectStore = {
      read: async (key, maxBytes) => {
        if (key === markerKey) return baseObjects.read(key, maxBytes);
        throw new Error("publication read failed");
      },
      create: (key, bytes, retryContext) =>
        baseObjects.create(key, bytes, retryContext),
      replace: (observed, bytes, retryContext) =>
        baseObjects.replace(observed, bytes, retryContext),
    };
    expect(
      await syncR2Publication(publicationReadFails).readJournal(
        vaultId,
        operationId,
      ),
    ).toEqual({ kind: "unavailable" });

    const writeFails: SyncR2ObjectStore = {
      read: (key, maxBytes) => baseObjects.read(key, maxBytes),
      create: async () => {
        throw new Error("create failed");
      },
      replace: async () => {
        throw new Error("replace failed");
      },
    };
    const writeFailurePublication = syncR2Publication(writeFails);
    expect(
      await writeFailurePublication.createJournal(await journal()),
    ).toEqual({ kind: "effect_unknown" });
    const head = await initialLaneHead();
    const headKey = syncFeedLaneHeadKey(vaultId, head.lane);
    bucket.seed(headKey, await encodeSyncPublication(head), epochNow - 5_000);
    const readHead = await writeFailurePublication.readLaneHead(
      vaultId,
      head.lane,
    );
    expect(readHead.kind).toBe("observed");
    if (readHead.kind !== "observed") return;
    expect(
      await writeFailurePublication.replaceLaneHead(readHead.observation, {
        ...head,
        pending: {
          operationId,
          nextSequence: syncEventSequenceSchema.parse("00000000000000000001"),
        },
      }),
    ).toEqual({ kind: "effect_unknown" });
  });

  it("refuses malformed initial or replacement publication records", async () => {
    await seedMarker();
    const record = await journal();
    const inconsistentRequest = {
      ...record,
      request: {
        ...record.request,
        operationId: alternateOperationId,
      },
    };
    expect(await publication.createJournal(inconsistentRequest)).toEqual({
      kind: "refused",
    });

    const wrongFamily = { ...record, kind: "laneHead" };
    // @ts-expect-error Journal creation accepts only a pending journal family.
    expect(await publication.createJournal(wrongFamily)).toEqual({
      kind: "refused",
    });
    const settled = { ...record, status: "committed" };
    // @ts-expect-error Initial journal creation cannot manufacture a terminal state.
    expect(await publication.createJournal(settled)).toEqual({
      kind: "refused",
    });

    const head = await initialLaneHead();
    const headKey = syncFeedLaneHeadKey(vaultId, head.lane);
    bucket.seed(headKey, await encodeSyncPublication(head), epochNow - 5_000);
    const observed = await publication.readLaneHead(vaultId, head.lane);
    expect(observed.kind).toBe("observed");
    if (observed.kind !== "observed") return;
    const invalidClock = {
      ...head,
      committedSequence: syncSequenceSchema.parse("00000000000000000001"),
      committedAtEpochMs: 0,
    };
    expect(
      await publication.replaceLaneHead(observed.observation, invalidClock),
    ).toEqual({ kind: "refused" });
  });

  it("refuses caller observations whose typed identity or retained key disagrees", async () => {
    await seedMarker();
    const head = await initialLaneHead();
    const key = syncFeedLaneHeadKey(vaultId, head.lane);
    bucket.seed(key, await encodeSyncPublication(head), epochNow - 5_000);
    const observed = await publication.readLaneHead(vaultId, head.lane);
    expect(observed.kind).toBe("observed");
    if (observed.kind !== "observed") return;

    const otherLane = (head.lane + 1) % 64;
    const otherKey = createSyncR2Key(
      syncFeedLaneHeadKey(vaultId, otherLane),
      vaultId,
    );
    if (otherKey === undefined) throw new Error("Expected canonical lane key.");
    const otherHead = {
      ...head,
      lane: otherLane,
      pending: {
        operationId,
        nextSequence: syncEventSequenceSchema.parse("00000000000000000001"),
      },
    };
    expect(
      await publication.replaceLaneHead(observed.observation, otherHead),
    ).toEqual({ kind: "refused" });
    expect(
      await publication.replaceLaneHead(
        {
          ...observed.observation,
          observed: {
            ...observed.observation.observed,
            bytes: encoder.encode("not the observed generation"),
          },
        },
        {
          ...head,
          pending: {
            operationId,
            nextSequence: syncEventSequenceSchema.parse("00000000000000000001"),
          },
        },
      ),
    ).toEqual({ kind: "refused" });
    expect(
      await publication.replaceLaneHead(
        {
          ...observed.observation,
          observed: { ...observed.observation.observed, key: otherKey },
        },
        otherHead,
      ),
    ).toEqual({ kind: "refused" });
    expect(
      await publication.replaceLaneHead(
        {
          ...observed.observation,
          value: { ...observed.observation.value, lane: 64 },
        },
        {
          ...head,
          pending: {
            operationId,
            nextSequence: syncEventSequenceSchema.parse("00000000000000000001"),
          },
        },
      ),
    ).toEqual({ kind: "refused" });
  });

  it("never reports absent records when the matching vault marker is missing, wrong, or unreadable", async () => {
    expect(await publication.readJournal(vaultId, operationId)).toEqual({
      kind: "unavailable",
    });
    expect(await publication.createJournal(await journal())).toEqual({
      kind: "refused",
    });

    await seedMarker(
      syncVaultIdSchema.parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    );
    expect(
      await publication.readEvent(
        vaultId,
        0,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({
      kind: "unavailable",
    });
    expect(await publication.createEvent(await event())).toEqual({
      kind: "refused",
    });

    await seedMarker();
    bucket.unavailableKeys.add(syncVaultMarkerKey(vaultId));
    expect(await publication.readLaneHead(vaultId, 0)).toEqual({
      kind: "unavailable",
    });
    expect(await publication.createLaneHead(await initialLaneHead())).toEqual({
      kind: "effect_unknown",
    });
  });
});
