import { createContentSha256, encodeBase64Url } from "@obsidian-ai-bridge/core";
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
  SyncAllocatedPendingJournalRecord,
  SyncFeedEventRecord,
  SyncJournalRecord,
  SyncLaneHeadRecord,
  SyncPublicationStepEvidence,
  SyncUnallocatedPendingJournalRecord,
} from "@worker/infrastructure/sync/sync-publication.types";
import type {
  SyncR2ObjectStore,
  SyncRecordObservation,
} from "@worker/infrastructure/sync/sync-r2.types";
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
  readonly unavailableAfterPut = new Set<string>();
  readonly nullPutKeys = new Set<string>();
  failure: Error | undefined;
  failReadback = false;
  private etagSequence = 0;

  constructor(private readonly epochNow: () => number) {}

  async get(key: string): Promise<R2ConditionalStoredObject | null> {
    if (
      this.unavailableKeys.has(key) ||
      (this.unavailableAfterPut.has(key) &&
        this.puts.some((put) => put.key === key))
    ) {
      throw new Error("R2 read unavailable");
    }
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
    if (this.nullPutKeys.delete(key)) {
      this.unavailableAfterPut.add(key);
      return null;
    }
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
  step: "immutable_create" | "commit_journal" = "immutable_create",
  journalOperationId: SyncOperationIdDto = operationId,
): Promise<SyncAllocatedPendingJournalRecord> {
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
    step === "immutable_create"
      ? syncVersionKey(vaultId, revision)
      : syncOperationKey(vaultId, journalOperationId);
  return {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    kind: "journal",
    status: "pending",
    operationId: journalOperationId,
    allocationState: "allocated",
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
): Promise<SyncAllocatedPendingJournalRecord> {
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
): Promise<SyncAllocatedPendingJournalRecord> {
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
  record: SyncAllocatedPendingJournalRecord,
): SyncAllocatedPendingJournalRecord {
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

async function settledJournal(
  pending: SyncAllocatedPendingJournalRecord,
  status: "committed" | "aborted",
): Promise<SyncJournalRecord> {
  const lane = pending.reservation.lane;
  const reservedHead: SyncLaneHeadRecord = {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    kind: "laneHead",
    lane,
    committedSequence: syncSequenceSchema.parse("00000000000000000000"),
    committedAtEpochMs: pending.reservation.previousCommittedAtEpochMs,
    pending: {
      operationId: pending.operationId,
      nextSequence: pending.reservation.sequence,
    },
  };
  const finalEvidence: SyncPublicationStepEvidence = {
    step: "commit_lane",
    key: syncFeedLaneHeadKey(vaultId, lane),
    precondition: {
      kind: "observed",
      etag: "etag-reserved-lane",
      bytes: encodeBase64Url(await encodeSyncPublication(reservedHead)),
      uploadedAtEpochMs: epochNow - 5_000,
    },
    retryAfterEpochMs: null,
  };
  if (status === "committed") {
    return {
      ...pending,
      status,
      stepEvidence: finalEvidence,
      position: { lane, sequence: pending.reservation.sequence },
      revision: pending.request.revision,
      committedAtEpochMs: pending.reservation.previousCommittedAtEpochMs + 1,
    };
  }
  return {
    ...pending,
    status,
    stepEvidence: finalEvidence,
    position: { lane, sequence: pending.reservation.sequence },
    reason: "stale_revision",
    committedAtEpochMs: pending.reservation.previousCommittedAtEpochMs + 1,
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

async function unallocatedJournal(
  head: SyncLaneHeadRecord,
  journalOperationId: SyncOperationIdDto = operationId,
  observed?: SyncRecordObservation<SyncLaneHeadRecord>,
  content = "# Exact\r\nUnicode 🌐 and NUL \u0000",
): Promise<SyncUnallocatedPendingJournalRecord> {
  const allocated = await journal(
    content,
    "immutable_create",
    journalOperationId,
  );
  return {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    kind: "journal",
    status: "pending",
    operationId: journalOperationId,
    request: allocated.request,
    payload: allocated.payload,
    allocationState: "unallocated",
    lane: head.lane,
    laneObservation: {
      key: syncFeedLaneHeadKey(vaultId, head.lane),
      precondition:
        observed === undefined
          ? { kind: "absent" }
          : {
              kind: "observed",
              etag: observed.observed.etag,
              bytes: encodeBase64Url(observed.observed.bytes),
              uploadedAtEpochMs: observed.observed.uploaded.getTime(),
            },
      retryAfterEpochMs: null,
    },
  };
}

function unallocatedFromAllocated(
  allocated: SyncAllocatedPendingJournalRecord,
  head: SyncLaneHeadRecord,
  observation: {
    readonly etag: string;
    readonly bytes: Uint8Array;
    readonly uploaded: Date;
  },
): SyncUnallocatedPendingJournalRecord {
  return {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId: allocated.vaultId,
    kind: "journal",
    status: "pending",
    operationId: allocated.operationId,
    request: allocated.request,
    payload: allocated.payload,
    allocationState: "unallocated",
    lane: head.lane,
    laneObservation: {
      key: syncFeedLaneHeadKey(allocated.vaultId, head.lane),
      precondition: {
        kind: "observed",
        etag: observation.etag,
        bytes: encodeBase64Url(observation.bytes),
        uploadedAtEpochMs: observation.uploaded.getTime(),
      },
      retryAfterEpochMs: null,
    },
  };
}

async function persistAllocatedJournal(
  allocated: SyncAllocatedPendingJournalRecord,
): Promise<void> {
  const priorHead: SyncLaneHeadRecord = {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    kind: "laneHead",
    lane: allocated.reservation.lane,
    committedSequence: syncSequenceSchema.parse(
      (BigInt(allocated.reservation.sequence) - 1n)
        .toString()
        .padStart(20, "0"),
    ),
    committedAtEpochMs: allocated.reservation.previousCommittedAtEpochMs,
  };
  const headBytes = await encodeSyncPublication(priorHead);
  const generation = bucket.seed(
    syncFeedLaneHeadKey(vaultId, priorHead.lane),
    headBytes,
    epochNow - 5_000,
  );
  const laneRead = await publication.readLaneHead(vaultId, priorHead.lane);
  if (laneRead.kind !== "observed") {
    throw new Error("Expected exact prior lane head for allocated fixture.");
  }
  const unallocated = unallocatedFromAllocated(allocated, priorHead, {
    etag: generation.etag,
    bytes: headBytes,
    uploaded: generation.uploaded,
  });
  if ((await publication.createJournal(unallocated)).kind !== "confirmed") {
    throw new Error("Expected initial unallocated journal fixture.");
  }
  const journalRead = await publication.readJournal(
    vaultId,
    allocated.operationId,
  );
  if (journalRead.kind !== "observed") {
    throw new Error("Expected exact unallocated journal fixture.");
  }
  const reservedHead: SyncLaneHeadRecord = {
    ...priorHead,
    pending: {
      operationId: allocated.operationId,
      nextSequence: allocated.reservation.sequence,
    },
  };
  if (
    (await publication.replaceLaneHead(laneRead.observation, reservedHead))
      .kind !== "confirmed"
  ) {
    throw new Error("Expected exact lane reservation fixture.");
  }
  epochNow += 1_100;
  if (
    (await publication.replaceJournal(journalRead.observation, allocated))
      .kind !== "confirmed"
  ) {
    throw new Error("Expected own-marker allocation fixture.");
  }
}

async function allocatedJournal(
  unallocated: SyncUnallocatedPendingJournalRecord,
  priorHead: SyncLaneHeadRecord,
): Promise<SyncAllocatedPendingJournalRecord> {
  const nextSequence = syncEventSequenceSchema.parse(
    (BigInt(priorHead.committedSequence) + 1n).toString().padStart(20, "0"),
  );
  return {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    kind: "journal",
    status: "pending",
    operationId: unallocated.operationId,
    request: unallocated.request,
    payload: unallocated.payload,
    allocationState: "allocated",
    reservation: {
      lane: priorHead.lane,
      sequence: nextSequence,
      previousCommittedAtEpochMs: priorHead.committedAtEpochMs,
    },
    stepEvidence: {
      step: "immutable_create",
      key: syncVersionKey(vaultId, unallocated.request.revision),
      precondition: { kind: "absent" },
      retryAfterEpochMs: null,
    },
  };
}

describe("marker-gated private sync publication persistence", () => {
  it("persists exact unallocated request identity and rejects changed same-ID requests", async () => {
    await seedMarker();
    const head = await initialLaneHead();
    const headKey = syncFeedLaneHeadKey(vaultId, head.lane);
    bucket.seed(headKey, await encodeSyncPublication(head), epochNow - 5_000);
    const headRead = await publication.readLaneHead(vaultId, head.lane);
    expect(headRead.kind).toBe("observed");
    if (headRead.kind !== "observed") return;
    const unallocated = await unallocatedJournal(
      head,
      operationId,
      headRead.observation,
    );
    const key = syncOperationKey(vaultId, operationId);

    expect(await publication.createJournal(unallocated)).toEqual({
      kind: "confirmed",
    });
    expect(await publication.createJournal(unallocated)).toEqual({
      kind: "confirmed",
    });
    const changedRequest = await unallocatedJournal(
      head,
      operationId,
      headRead.observation,
      "different same-ID body",
    );
    expect(await publication.createJournal(changedRequest)).toEqual({
      kind: "refused",
    });
    const read = await publication.readJournal(vaultId, operationId);
    expect(read.kind).toBe("observed");
    if (read.kind !== "observed") return;
    expect(read.observation.value.allocationState).toBe("unallocated");
    expect(read.observation.observed.key).toBe(key);
  });

  it("refuses journal creation after its saved lane absence or generation changes", async () => {
    await seedMarker();
    const head = await initialLaneHead();
    const key = syncFeedLaneHeadKey(vaultId, head.lane);
    const absent = await unallocatedJournal(head);
    bucket.seed(key, await encodeSyncPublication(head), epochNow - 5_000);
    expect(await publication.createJournal(absent)).toEqual({
      kind: "refused",
    });

    const originalHeadRead = await publication.readLaneHead(vaultId, head.lane);
    expect(originalHeadRead.kind).toBe("observed");
    if (originalHeadRead.kind !== "observed") return;
    const observed = await unallocatedJournal(
      head,
      alternateOperationId,
      originalHeadRead.observation,
    );
    const changedHead: SyncLaneHeadRecord = {
      ...head,
      committedSequence: syncSequenceSchema.parse("00000000000000000001"),
      committedAtEpochMs: 101,
    };
    bucket.seed(
      key,
      await encodeSyncPublication(changedHead),
      epochNow - 5_000,
    );
    expect(await publication.createJournal(observed)).toEqual({
      kind: "refused",
    });
  });

  it("does not replace an observed lane condition with fabricated absence", async () => {
    await seedMarker();
    const head = await initialLaneHead();
    const laneKey = syncFeedLaneHeadKey(vaultId, head.lane);
    bucket.seed(laneKey, await encodeSyncPublication(head), epochNow - 5_000);
    const laneRead = await publication.readLaneHead(vaultId, head.lane);
    expect(laneRead.kind).toBe("observed");
    if (laneRead.kind !== "observed") return;
    const original = await unallocatedJournal(
      head,
      operationId,
      laneRead.observation,
    );
    expect(await publication.createJournal(original)).toEqual({
      kind: "confirmed",
    });
    const journalRead = await publication.readJournal(vaultId, operationId);
    expect(journalRead.kind).toBe("observed");
    if (journalRead.kind !== "observed") return;
    const fabricatedAbsence = {
      ...original,
      laneObservation: {
        ...original.laneObservation,
        precondition: { kind: "absent" as const },
        retryAfterEpochMs: null,
      },
    };
    expect(
      await publication.replaceJournal(
        journalRead.observation,
        fabricatedAbsence,
      ),
    ).toEqual({ kind: "refused" });
  });

  it("requires zero-head initialization before refreshing an absent lane observation", async () => {
    await seedMarker();
    const initialHead = await initialLaneHead();
    const original = await unallocatedJournal(initialHead);
    expect(await publication.createJournal(original)).toEqual({
      kind: "confirmed",
    });
    const journalRead = await publication.readJournal(vaultId, operationId);
    expect(journalRead.kind).toBe("observed");
    if (journalRead.kind !== "observed") return;

    const advancedHead: SyncLaneHeadRecord = {
      ...initialHead,
      committedSequence: syncSequenceSchema.parse("00000000000000000001"),
      committedAtEpochMs: 101,
    };
    const key = syncFeedLaneHeadKey(vaultId, initialHead.lane);
    bucket.seed(
      key,
      await encodeSyncPublication(advancedHead),
      epochNow - 5_000,
    );
    const advancedHeadRead = await publication.readLaneHead(
      vaultId,
      initialHead.lane,
    );
    expect(advancedHeadRead.kind).toBe("observed");
    if (advancedHeadRead.kind !== "observed") return;
    const changedObservation = await unallocatedJournal(
      initialHead,
      operationId,
      advancedHeadRead.observation,
    );
    expect(
      await publication.replaceJournal(
        journalRead.observation,
        changedObservation,
      ),
    ).toEqual({ kind: "refused" });
  });

  it("rejects a refreshed generation without committed lane progress", async () => {
    await seedMarker();
    const initialHead = await initialLaneHead();
    const head: SyncLaneHeadRecord = {
      ...initialHead,
      committedSequence: syncSequenceSchema.parse("00000000000000000001"),
      committedAtEpochMs: 101,
    };
    const key = syncFeedLaneHeadKey(vaultId, head.lane);
    const bytes = await encodeSyncPublication(head);
    bucket.seed(key, bytes, epochNow - 5_000);
    const originalHeadRead = await publication.readLaneHead(vaultId, head.lane);
    expect(originalHeadRead.kind).toBe("observed");
    if (originalHeadRead.kind !== "observed") return;
    const original = await unallocatedJournal(
      head,
      operationId,
      originalHeadRead.observation,
    );
    expect(await publication.createJournal(original)).toEqual({
      kind: "confirmed",
    });
    const journalRead = await publication.readJournal(vaultId, operationId);
    expect(journalRead.kind).toBe("observed");
    if (journalRead.kind !== "observed") return;

    bucket.seed(key, bytes, epochNow - 4_000);
    const rewrittenHeadRead = await publication.readLaneHead(
      vaultId,
      head.lane,
    );
    expect(rewrittenHeadRead.kind).toBe("observed");
    if (rewrittenHeadRead.kind !== "observed") return;
    const changedObservation = await unallocatedJournal(
      head,
      operationId,
      rewrittenHeadRead.observation,
    );
    expect(
      await publication.replaceJournal(
        journalRead.observation,
        changedObservation,
      ),
    ).toEqual({ kind: "refused" });
  });

  it("persists monotonic retry floors without changing an observed lane generation", async () => {
    await seedMarker();
    const head = await initialLaneHead();
    const headBytes = await encodeSyncPublication(head);
    bucket.seed(
      syncFeedLaneHeadKey(vaultId, head.lane),
      headBytes,
      epochNow - 5_000,
    );
    const laneRead = await publication.readLaneHead(vaultId, head.lane);
    expect(laneRead.kind).toBe("observed");
    if (laneRead.kind !== "observed") return;
    const original = await unallocatedJournal(
      head,
      operationId,
      laneRead.observation,
    );
    expect(await publication.createJournal(original)).toEqual({
      kind: "confirmed",
    });
    const journalRead = await publication.readJournal(vaultId, operationId);
    expect(journalRead.kind).toBe("observed");
    if (journalRead.kind !== "observed") return;
    const retryAfterEpochMs = epochNow + 2_000;
    const raised = {
      ...original,
      laneObservation: {
        ...original.laneObservation,
        retryAfterEpochMs,
      },
    };

    epochNow += 1_100;
    const laneKey = syncFeedLaneHeadKey(vaultId, head.lane);
    bucket.unavailableKeys.add(laneKey);
    expect(
      await publication.replaceJournal(journalRead.observation, raised),
    ).toEqual({ kind: "effect_unknown" });
    bucket.unavailableKeys.delete(laneKey);
    expect(
      await publication.replaceJournal(journalRead.observation, raised),
    ).toEqual({ kind: "confirmed" });
    const raisedRead = await publication.readJournal(vaultId, operationId);
    expect(raisedRead.kind).toBe("observed");
    if (
      raisedRead.kind !== "observed" ||
      raisedRead.observation.value.status !== "pending" ||
      raisedRead.observation.value.allocationState !== "unallocated"
    ) {
      return;
    }
    expect(raisedRead.observation.value.laneObservation).toEqual(
      raised.laneObservation,
    );
    expect(raisedRead.observation.value.laneObservation.precondition).toEqual(
      original.laneObservation.precondition,
    );

    const invalidFloor = {
      ...raised,
      laneObservation: {
        ...raised.laneObservation,
        retryAfterEpochMs: Number.NaN,
      },
    };
    expect(
      await publication.replaceJournal(raisedRead.observation, invalidFloor),
    ).toEqual({ kind: "refused" });

    const regressed = {
      ...raised,
      laneObservation: {
        ...raised.laneObservation,
        retryAfterEpochMs: retryAfterEpochMs - 1,
      },
    };
    epochNow += 1_100;
    expect(
      await publication.replaceJournal(raisedRead.observation, regressed),
    ).toEqual({ kind: "refused" });
  });

  it("persists a monotonic retry floor while the initial lane head is absent", async () => {
    await seedMarker();
    const head = await initialLaneHead();
    const original = await unallocatedJournal(head);
    expect(await publication.createJournal(original)).toEqual({
      kind: "confirmed",
    });
    const journalRead = await publication.readJournal(vaultId, operationId);
    expect(journalRead.kind).toBe("observed");
    if (journalRead.kind !== "observed") return;
    const retryAfterEpochMs = epochNow + 2_000;
    const raised = {
      ...original,
      laneObservation: {
        ...original.laneObservation,
        retryAfterEpochMs,
      },
    };

    epochNow += 1_100;
    expect(
      await publication.replaceJournal(journalRead.observation, raised),
    ).toEqual({ kind: "confirmed" });
    const raisedRead = await publication.readJournal(vaultId, operationId);
    expect(raisedRead.kind).toBe("observed");
    if (
      raisedRead.kind !== "observed" ||
      raisedRead.observation.value.status !== "pending" ||
      raisedRead.observation.value.allocationState !== "unallocated"
    ) {
      return;
    }
    expect(raisedRead.observation.value.laneObservation).toEqual(
      raised.laneObservation,
    );
    const regressed = {
      ...raised,
      laneObservation: {
        ...raised.laneObservation,
        retryAfterEpochMs: null,
      },
    };
    epochNow += 1_100;
    expect(
      await publication.replaceJournal(raisedRead.observation, regressed),
    ).toEqual({ kind: "refused" });
  });

  it("keeps an unallocated request unchanged while a later lane owner is pending", async () => {
    await seedMarker();
    const head = await initialLaneHead();
    const laneKey = syncFeedLaneHeadKey(vaultId, head.lane);
    bucket.seed(laneKey, await encodeSyncPublication(head), epochNow - 5_000);
    const originalLaneRead = await publication.readLaneHead(vaultId, head.lane);
    expect(originalLaneRead.kind).toBe("observed");
    if (originalLaneRead.kind !== "observed") return;
    const unallocated = await unallocatedJournal(
      head,
      operationId,
      originalLaneRead.observation,
    );
    expect(await publication.createJournal(unallocated)).toEqual({
      kind: "confirmed",
    });
    const journalRead = await publication.readJournal(vaultId, operationId);
    expect(journalRead.kind).toBe("observed");
    if (journalRead.kind !== "observed") return;

    const firstMarker: SyncLaneHeadRecord = {
      ...head,
      pending: {
        operationId: alternateOperationId,
        nextSequence: syncEventSequenceSchema.parse("00000000000000000001"),
      },
    };
    expect(
      await publication.replaceLaneHead(
        originalLaneRead.observation,
        firstMarker,
      ),
    ).toEqual({ kind: "confirmed" });
    const firstMarkerRead = await publication.readLaneHead(vaultId, head.lane);
    expect(firstMarkerRead.kind).toBe("observed");
    if (firstMarkerRead.kind !== "observed") return;
    const releasedHead: SyncLaneHeadRecord = {
      ...head,
      committedSequence: syncSequenceSchema.parse("00000000000000000001"),
      committedAtEpochMs: 101,
    };
    epochNow += 1_100;
    expect(
      await publication.replaceLaneHead(
        firstMarkerRead.observation,
        releasedHead,
      ),
    ).toEqual({ kind: "confirmed" });
    const releasedLaneRead = await publication.readLaneHead(vaultId, head.lane);
    expect(releasedLaneRead.kind).toBe("observed");
    if (releasedLaneRead.kind !== "observed") return;
    const nextMarker: SyncLaneHeadRecord = {
      ...releasedHead,
      pending: {
        operationId: alternateOperationId,
        nextSequence: syncEventSequenceSchema.parse("00000000000000000002"),
      },
    };
    epochNow += 1_100;
    expect(
      await publication.replaceLaneHead(
        releasedLaneRead.observation,
        nextMarker,
      ),
    ).toEqual({ kind: "confirmed" });

    const releasedObservation = await unallocatedJournal(
      releasedHead,
      operationId,
      releasedLaneRead.observation,
    );
    expect(
      await publication.replaceJournal(
        journalRead.observation,
        releasedObservation,
      ),
    ).toEqual({ kind: "refused" });
  });

  it("allocates one same-lane winner and lets only the released loser claim the next sequence", async () => {
    await seedMarker();
    const head = await initialLaneHead();
    const headBytes = await encodeSyncPublication(head);
    bucket.seed(
      syncFeedLaneHeadKey(vaultId, head.lane),
      headBytes,
      epochNow - 5_000,
    );
    const sharedLaneRead = await publication.readLaneHead(vaultId, head.lane);
    expect(sharedLaneRead.kind).toBe("observed");
    if (sharedLaneRead.kind !== "observed") return;
    const first = await unallocatedJournal(
      head,
      operationId,
      sharedLaneRead.observation,
    );
    const second = await unallocatedJournal(
      head,
      alternateOperationId,
      sharedLaneRead.observation,
    );
    expect(await publication.createJournal(first)).toEqual({
      kind: "confirmed",
    });
    expect(await publication.createJournal(second)).toEqual({
      kind: "confirmed",
    });
    const firstRead = await publication.readJournal(vaultId, operationId);
    const secondRead = await publication.readJournal(
      vaultId,
      alternateOperationId,
    );
    const laneRead = await publication.readLaneHead(vaultId, head.lane);
    expect(firstRead.kind).toBe("observed");
    expect(secondRead.kind).toBe("observed");
    expect(laneRead.kind).toBe("observed");
    if (
      firstRead.kind !== "observed" ||
      secondRead.kind !== "observed" ||
      laneRead.kind !== "observed"
    ) {
      return;
    }

    const firstMarker: SyncLaneHeadRecord = {
      ...head,
      pending: {
        operationId,
        nextSequence: syncEventSequenceSchema.parse("00000000000000000001"),
      },
    };
    const secondMarker: SyncLaneHeadRecord = {
      ...head,
      pending: {
        operationId: alternateOperationId,
        nextSequence: syncEventSequenceSchema.parse("00000000000000000001"),
      },
    };
    const reservationResults = await Promise.all([
      publication.replaceLaneHead(laneRead.observation, firstMarker),
      publication.replaceLaneHead(laneRead.observation, secondMarker),
    ]);
    expect(reservationResults.map(({ kind }) => kind).sort()).toEqual([
      "confirmed",
      "refused",
    ]);

    const winnerLane = await publication.readLaneHead(vaultId, head.lane);
    expect(winnerLane.kind).toBe("observed");
    if (winnerLane.kind !== "observed") return;
    const winnerId = winnerLane.observation.value.pending?.operationId;
    expect([operationId, alternateOperationId]).toContain(winnerId);
    if (winnerId === undefined) return;
    const winnerUnallocated = winnerId === operationId ? first : second;
    const loserUnallocated = winnerId === operationId ? second : first;
    const winnerJournalRead = winnerId === operationId ? firstRead : secondRead;
    const loserJournalRead = winnerId === operationId ? secondRead : firstRead;
    const winnerAllocated = await allocatedJournal(winnerUnallocated, head);
    const loserAllocated = await allocatedJournal(loserUnallocated, head);
    epochNow += 1_100;

    expect(
      await publication.replaceJournal(
        winnerJournalRead.observation,
        winnerAllocated,
      ),
    ).toEqual({ kind: "confirmed" });
    const winnerWritesBeforeReplay = bucket.puts.filter(
      (put) => put.key === syncOperationKey(vaultId, winnerId),
    ).length;
    expect(
      await publication.replaceJournal(
        loserJournalRead.observation,
        loserAllocated,
      ),
    ).toEqual({ kind: "refused" });
    expect(
      await publication.replaceJournal(
        winnerJournalRead.observation,
        winnerAllocated,
      ),
    ).toEqual({ kind: "confirmed" });
    expect(
      bucket.puts.filter(
        (put) => put.key === syncOperationKey(vaultId, winnerId),
      ),
    ).toHaveLength(winnerWritesBeforeReplay);
    const loserRead = await publication.readJournal(
      vaultId,
      loserUnallocated.operationId,
    );
    expect(loserRead.kind).toBe("observed");
    if (loserRead.kind !== "observed") return;
    expect(loserRead.observation.value.allocationState).toBe("unallocated");

    const releasedHead: SyncLaneHeadRecord = {
      ...head,
      committedSequence: syncSequenceSchema.parse("00000000000000000001"),
      committedAtEpochMs: 101,
    };
    epochNow += 1_100;
    expect(
      await publication.replaceLaneHead(winnerLane.observation, releasedHead),
    ).toEqual({ kind: "confirmed" });
    const releasedLane = await publication.readLaneHead(vaultId, head.lane);
    expect(releasedLane.kind).toBe("observed");
    if (releasedLane.kind !== "observed") return;
    const rebasedLoser = await unallocatedJournal(
      releasedHead,
      loserUnallocated.operationId,
      releasedLane.observation,
    );
    expect(
      await publication.replaceJournal(loserRead.observation, rebasedLoser),
    ).toEqual({ kind: "confirmed" });
    epochNow += 1_100;
    const currentLane = await publication.readLaneHead(vaultId, head.lane);
    const rebasedJournalRead = await publication.readJournal(
      vaultId,
      loserUnallocated.operationId,
    );
    expect(currentLane.kind).toBe("observed");
    expect(rebasedJournalRead.kind).toBe("observed");
    if (
      currentLane.kind !== "observed" ||
      rebasedJournalRead.kind !== "observed"
    ) {
      return;
    }
    const nextReservation: SyncLaneHeadRecord = {
      ...releasedHead,
      pending: {
        operationId: loserUnallocated.operationId,
        nextSequence: syncEventSequenceSchema.parse("00000000000000000002"),
      },
    };
    expect(
      await publication.replaceLaneHead(
        currentLane.observation,
        nextReservation,
      ),
    ).toEqual({ kind: "confirmed" });
    const loserNextAllocation = await allocatedJournal(
      rebasedLoser,
      releasedHead,
    );
    expect(loserNextAllocation.reservation.sequence).toBe(
      "00000000000000000002",
    );
    expect(loserNextAllocation.reservation.sequence).not.toBe(
      winnerAllocated.reservation.sequence,
    );
    expect(
      await publication.replaceJournal(
        rebasedJournalRead.observation,
        loserNextAllocation,
      ),
    ).toEqual({ kind: "confirmed" });
  });

  it("rejects allocation from absent, mismatched, unavailable, or exhausted lane evidence", async () => {
    await seedMarker();
    const head = await initialLaneHead();
    const absent = await unallocatedJournal(head);
    expect(await publication.createJournal(absent)).toEqual({
      kind: "confirmed",
    });
    const absentRead = await publication.readJournal(vaultId, operationId);
    expect(absentRead.kind).toBe("observed");
    if (absentRead.kind !== "observed") return;
    const fabricated = await allocatedJournal(absent, head);
    expect(
      await publication.replaceJournal(absentRead.observation, fabricated),
    ).toEqual({ kind: "refused" });

    const key = syncFeedLaneHeadKey(vaultId, head.lane);
    const headBytes = await encodeSyncPublication(head);
    bucket.seed(key, headBytes, epochNow - 5_000);
    const initialHeadRead = await publication.readLaneHead(vaultId, head.lane);
    expect(initialHeadRead.kind).toBe("observed");
    if (initialHeadRead.kind !== "observed") return;
    const observed = await unallocatedJournal(
      head,
      operationId,
      initialHeadRead.observation,
    );
    epochNow += 1_100;
    expect(
      await publication.replaceJournal(absentRead.observation, observed),
    ).toEqual({ kind: "confirmed" });
    const updatedRead = await publication.readJournal(vaultId, operationId);
    expect(updatedRead.kind).toBe("observed");
    if (updatedRead.kind !== "observed") return;

    const mismatchedHead: SyncLaneHeadRecord = {
      ...head,
      committedSequence: syncSequenceSchema.parse("00000000000000000001"),
      committedAtEpochMs: 10,
      pending: {
        operationId,
        nextSequence: syncEventSequenceSchema.parse("00000000000000000002"),
      },
    };
    bucket.seed(
      key,
      await encodeSyncPublication(mismatchedHead),
      epochNow - 5_000,
    );
    const wrongAllocation = await allocatedJournal(observed, head);
    expect(
      await publication.replaceJournal(
        updatedRead.observation,
        wrongAllocation,
      ),
    ).toEqual({ kind: "refused" });

    bucket.unavailableKeys.add(key);
    expect(
      await publication.replaceJournal(
        updatedRead.observation,
        wrongAllocation,
      ),
    ).toEqual({ kind: "effect_unknown" });

    bucket.unavailableKeys.delete(key);
    const maximumHead: SyncLaneHeadRecord = {
      ...head,
      committedSequence: syncSequenceSchema.parse("99999999999999999999"),
      committedAtEpochMs: 10,
    };
    bucket.seed(
      key,
      await encodeSyncPublication(maximumHead),
      epochNow - 5_000,
    );
    const maximumHeadRead = await publication.readLaneHead(
      vaultId,
      maximumHead.lane,
    );
    expect(maximumHeadRead.kind).toBe("observed");
    if (maximumHeadRead.kind !== "observed") return;
    const maximumJournal = await unallocatedJournal(
      maximumHead,
      alternateOperationId,
      maximumHeadRead.observation,
    );
    expect(await publication.createJournal(maximumJournal)).toEqual({
      kind: "confirmed",
    });
    const maximumRead = await publication.readJournal(
      vaultId,
      alternateOperationId,
    );
    expect(maximumRead.kind).toBe("observed");
    if (maximumRead.kind !== "observed") return;
    const impossibleAllocation: SyncAllocatedPendingJournalRecord = {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      kind: "journal",
      status: "pending",
      operationId: maximumJournal.operationId,
      request: maximumJournal.request,
      payload: maximumJournal.payload,
      allocationState: "allocated",
      reservation: {
        lane: maximumHead.lane,
        sequence: syncEventSequenceSchema.parse("00000000000000000001"),
        previousCommittedAtEpochMs: maximumHead.committedAtEpochMs,
      },
      stepEvidence: {
        step: "immutable_create",
        key: syncVersionKey(vaultId, maximumJournal.request.revision),
        precondition: { kind: "absent" },
        retryAfterEpochMs: null,
      },
    };
    expect(
      await publication.replaceJournal(
        maximumRead.observation,
        impossibleAllocation,
      ),
    ).toEqual({ kind: "refused" });
  });

  it.each([
    {
      evidence: "matching own marker",
      expected: "confirmed",
    },
    {
      evidence: "missing lane head",
      expected: "refused",
    },
    {
      evidence: "another operation's marker",
      expected: "refused",
    },
    {
      evidence: "wrong sequence marker",
      expected: "refused",
    },
    {
      evidence: "wrong committed clock marker",
      expected: "refused",
    },
    {
      evidence: "unavailable lane head",
      expected: "effect_unknown",
    },
  ] as const)(
    "resolves exact allocated target replay conservatively with $evidence evidence",
    async ({ evidence, expected }) => {
      await seedMarker();
      const initialHead = await initialLaneHead();
      const head: SyncLaneHeadRecord =
        evidence === "wrong committed clock marker"
          ? {
              ...initialHead,
              committedSequence: syncSequenceSchema.parse(
                "00000000000000000001",
              ),
              committedAtEpochMs: 100,
            }
          : initialHead;
      const laneKey = syncFeedLaneHeadKey(vaultId, head.lane);
      bucket.seed(laneKey, await encodeSyncPublication(head), epochNow - 5_000);
      const laneRead = await publication.readLaneHead(vaultId, head.lane);
      expect(laneRead.kind).toBe("observed");
      if (laneRead.kind !== "observed") return;

      const unallocated = await unallocatedJournal(
        head,
        operationId,
        laneRead.observation,
      );
      expect(await publication.createJournal(unallocated)).toEqual({
        kind: "confirmed",
      });
      const journalRead = await publication.readJournal(vaultId, operationId);
      expect(journalRead.kind).toBe("observed");
      if (
        journalRead.kind !== "observed" ||
        journalRead.observation.value.allocationState !== "unallocated"
      ) {
        return;
      }
      const allocated = await allocatedJournal(
        journalRead.observation.value,
        head,
      );
      const ownMarker: SyncLaneHeadRecord = {
        ...head,
        pending: {
          operationId,
          nextSequence: allocated.reservation.sequence,
        },
      };

      switch (evidence) {
        case "matching own marker":
        case "unavailable lane head":
          bucket.seed(
            laneKey,
            await encodeSyncPublication(ownMarker),
            epochNow - 5_000,
          );
          if (evidence === "unavailable lane head") {
            bucket.unavailableKeys.add(laneKey);
          }
          break;
        case "missing lane head":
          bucket.objects.delete(laneKey);
          break;
        case "another operation's marker":
          bucket.seed(
            laneKey,
            await encodeSyncPublication({
              ...head,
              pending: {
                operationId: alternateOperationId,
                nextSequence: allocated.reservation.sequence,
              },
            }),
            epochNow - 5_000,
          );
          break;
        case "wrong sequence marker":
          bucket.seed(
            laneKey,
            await encodeSyncPublication({
              ...head,
              committedSequence: syncSequenceSchema.parse(
                "00000000000000000001",
              ),
              committedAtEpochMs: 10,
              pending: {
                operationId,
                nextSequence: syncEventSequenceSchema.parse(
                  "00000000000000000002",
                ),
              },
            }),
            epochNow - 5_000,
          );
          break;
        case "wrong committed clock marker":
          bucket.seed(
            laneKey,
            await encodeSyncPublication({
              ...head,
              committedAtEpochMs: 101,
              pending: {
                operationId,
                nextSequence: allocated.reservation.sequence,
              },
            }),
            epochNow - 5_000,
          );
          break;
      }

      const journalKey = syncOperationKey(vaultId, operationId);
      bucket.seed(
        journalKey,
        await encodeSyncPublication(allocated),
        epochNow - 5_000,
      );
      expect(
        await publication.replaceJournal(journalRead.observation, allocated),
      ).toEqual({ kind: expected });
    },
  );

  it("resolves journal allocation CAS as exact target, unchanged prior, conflict, or unavailable", async () => {
    await seedMarker();
    const head = await initialLaneHead();
    const headBytes = await encodeSyncPublication(head);
    bucket.seed(
      syncFeedLaneHeadKey(vaultId, head.lane),
      headBytes,
      epochNow - 5_000,
    );
    const priorLaneRead = await publication.readLaneHead(vaultId, head.lane);
    expect(priorLaneRead.kind).toBe("observed");
    if (priorLaneRead.kind !== "observed") return;
    const unallocated = await unallocatedJournal(
      head,
      operationId,
      priorLaneRead.observation,
    );
    expect(await publication.createJournal(unallocated)).toEqual({
      kind: "confirmed",
    });
    const source = await publication.readJournal(vaultId, operationId);
    const laneRead = await publication.readLaneHead(vaultId, head.lane);
    expect(source.kind).toBe("observed");
    expect(laneRead.kind).toBe("observed");
    if (source.kind !== "observed" || laneRead.kind !== "observed") return;
    const marker: SyncLaneHeadRecord = {
      ...head,
      pending: {
        operationId,
        nextSequence: syncEventSequenceSchema.parse("00000000000000000001"),
      },
    };
    expect(
      await publication.replaceLaneHead(laneRead.observation, marker),
    ).toEqual({
      kind: "confirmed",
    });
    const allocated = await allocatedJournal(unallocated, head);
    const journalKey = syncOperationKey(vaultId, operationId);
    bucket.nullPutKeys.add(journalKey);
    epochNow += 1_100;

    const uncertain = await publication.replaceJournal(
      source.observation,
      allocated,
    );
    expect(uncertain.kind).toBe("effect_unknown");
    bucket.unavailableAfterPut.delete(journalKey);

    const unchanged = await publication.replaceJournal(
      source.observation,
      allocated,
      uncertain.kind === "effect_unknown" &&
        uncertain.retryAfterEpochMs !== undefined
        ? { retryAfterEpochMs: uncertain.retryAfterEpochMs }
        : undefined,
    );
    expect(unchanged).toMatchObject({ kind: "throttled" });
    const writesBeforeRetry = bucket.puts.filter(
      (put) => put.key === journalKey,
    ).length;
    epochNow += 1_100;
    expect(
      await publication.replaceJournal(
        source.observation,
        allocated,
        uncertain.kind === "effect_unknown" &&
          uncertain.retryAfterEpochMs !== undefined
          ? { retryAfterEpochMs: uncertain.retryAfterEpochMs }
          : undefined,
      ),
    ).toEqual({ kind: "confirmed" });
    const retryPut = bucket.puts.filter((put) => put.key === journalKey).at(-1);
    expect(retryPut?.options.onlyIf).toEqual({
      etagMatches: source.observation.observed.etag,
    });
    expect(bucket.puts.filter((put) => put.key === journalKey)).toHaveLength(
      writesBeforeRetry + 1,
    );

    const conflicting = await unallocatedJournal(
      head,
      operationId,
      priorLaneRead.observation,
      "conflicting same-ID request",
    );
    bucket.seed(
      journalKey,
      await encodeSyncPublication(conflicting),
      epochNow - 5_000,
    );
    expect(
      await publication.replaceJournal(source.observation, allocated),
    ).toEqual({ kind: "refused" });
    bucket.unavailableKeys.add(journalKey);
    expect(
      await publication.replaceJournal(source.observation, allocated),
    ).toEqual({ kind: "effect_unknown" });
  });

  it("create-only replays journals and events with exact canonical read-back bytes", async () => {
    await seedMarker();
    const record = await unallocatedJournal(await initialLaneHead());
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
    const record = await unallocatedJournal(
      await initialLaneHead(),
      operationId,
      undefined,
      "x".repeat(4_096),
    );
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
    const head = await initialLaneHead();
    const original = await unallocatedJournal(head);
    expect(await publication.createJournal(original)).toEqual({
      kind: "confirmed",
    });
    const observed = await publication.readJournal(vaultId, operationId);
    expect(observed.kind).toBe("observed");
    if (observed.kind !== "observed") return;
    epochNow += 1_100;
    const changedRequest = await unallocatedJournal(
      head,
      operationId,
      undefined,
      "# A different operation body",
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
      epochNow = 10_000;
      bucket = new MemoryBucket(() => epochNow);
      publication = syncR2Publication(
        syncR2ObjectStore(bucket, () => epochNow),
      );
      await seedMarker();
      await persistAllocatedJournal(record);
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

  it("enforces independent 1,100-ms journal and lane-head retry floors", async () => {
    await seedMarker();
    const laneHead = await initialLaneHead();
    const record = await unallocatedJournal(laneHead);
    expect(await publication.createJournal(record)).toEqual({
      kind: "confirmed",
    });
    expect(await publication.createLaneHead(laneHead)).toEqual({
      kind: "confirmed",
    });

    const laneHeadRead = await publication.readLaneHead(vaultId, laneHead.lane);
    expect(laneHeadRead.kind).toBe("observed");
    if (laneHeadRead.kind !== "observed") return;
    const rebasedJournal = await unallocatedJournal(
      laneHead,
      operationId,
      laneHeadRead.observation,
    );
    const journalRead = await publication.readJournal(vaultId, operationId);
    expect(journalRead.kind).toBe("observed");
    if (journalRead.kind !== "observed") return;

    const journalCooldown = await publication.replaceJournal(
      journalRead.observation,
      rebasedJournal,
    );
    const headCooldown = await publication.replaceLaneHead(
      laneHeadRead.observation,
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
      await publication.replaceJournal(
        cooledJournal.observation,
        rebasedJournal,
        { retryAfterEpochMs: 11_100 },
      ),
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

  it("refuses pending journal progress after the exact commit phase", async () => {
    await seedMarker();
    const phase = await journal(undefined, "commit_journal");
    const journalKey = syncOperationKey(vaultId, operationId);
    await persistAllocatedJournal(phase);
    const staleRead = await publication.readJournal(vaultId, operationId);
    expect(staleRead.kind).toBe("observed");
    if (staleRead.kind !== "observed") return;

    epochNow += 1_100;
    bucket.seed(
      journalKey,
      staleRead.observation.observed.bytes,
      epochNow - 1_200,
    );
    const rewind = await journal(
      "# Exact\r\nUnicode 🌐 and NUL \u0000",
      "immutable_create",
    );
    const journalWritesBeforeRewind = bucket.puts.filter(
      (put) => put.key === journalKey,
    ).length;

    expect(
      await publication.replaceJournal(staleRead.observation, rewind),
    ).toEqual({ kind: "refused" });
    expect(bucket.puts.filter((put) => put.key === journalKey)).toHaveLength(
      journalWritesBeforeRewind,
    );
  });

  it.each([
    { journalOperationId: operationId, status: "committed" },
    { journalOperationId: alternateOperationId, status: "aborted" },
  ] as const)(
    "refreshes the exact journal-phase ETag only for a valid $status terminal target",
    async ({ journalOperationId, status }) => {
      await seedMarker();
      const phase = await journal(
        undefined,
        "commit_journal",
        journalOperationId,
      );
      const journalKey = syncOperationKey(vaultId, journalOperationId);
      await persistAllocatedJournal(phase);
      const staleRead = await publication.readJournal(
        vaultId,
        journalOperationId,
      );
      expect(staleRead.kind).toBe("observed");
      if (staleRead.kind !== "observed") return;

      epochNow += 1_100;
      const current = bucket.seed(
        journalKey,
        staleRead.observation.observed.bytes,
        epochNow - 1_200,
      );
      const terminal = await settledJournal(phase, status);
      expect(
        await publication.replaceJournal(staleRead.observation, terminal),
      ).toEqual({ kind: "confirmed" });
      expect(bucket.puts.at(-1)?.options.onlyIf).toEqual({
        etagMatches: current.etag,
      });
      expect(bucket.puts.at(-1)?.options.onlyIf).not.toEqual({
        etagMatches: staleRead.observation.observed.etag,
      });

      const putsBeforeReplay = bucket.puts.filter(
        (put) => put.key === journalKey,
      ).length;
      expect(
        await publication.replaceJournal(staleRead.observation, terminal),
      ).toEqual({ kind: "confirmed" });
      expect(bucket.puts.filter((put) => put.key === journalKey)).toHaveLength(
        putsBeforeReplay,
      );
    },
  );

  it("refuses a terminal journal transition after its typed phase diverges", async () => {
    await seedMarker();
    const phase = await journal(undefined, "commit_journal");
    const journalKey = syncOperationKey(vaultId, operationId);
    await persistAllocatedJournal(phase);
    const staleRead = await publication.readJournal(vaultId, operationId);
    expect(staleRead.kind).toBe("observed");
    if (staleRead.kind !== "observed") return;

    const divergentPhase = {
      ...phase,
      stepEvidence: {
        ...phase.stepEvidence,
        retryAfterEpochMs: epochNow + 2_000,
      },
    };
    bucket.seed(
      journalKey,
      await encodeSyncPublication(divergentPhase),
      epochNow - 1_200,
    );
    const terminal = await settledJournal(phase, "committed");
    const journalWritesBeforeRefusal = bucket.puts.filter(
      (put) => put.key === journalKey,
    ).length;
    expect(
      await publication.replaceJournal(staleRead.observation, terminal),
    ).toEqual({ kind: "refused" });
    expect(bucket.puts.filter((put) => put.key === journalKey)).toHaveLength(
      journalWritesBeforeRefusal,
    );
  });

  it("returns a retry floor after 429 and preserves uncertainty when timeout read-back is unavailable", async () => {
    await seedMarker();
    const rateLimitedJournal = await unallocatedJournal(
      await initialLaneHead(),
    );
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

    const timeoutJournal = await unallocatedJournal(
      await initialLaneHead(),
      alternateOperationId,
      undefined,
      "# timeout case",
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
    expect(
      await markerUnavailable.createJournal(
        await unallocatedJournal(await initialLaneHead()),
      ),
    ).toEqual({
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
      await writeFailurePublication.createJournal(
        await unallocatedJournal(await initialLaneHead()),
      ),
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
    const record = await unallocatedJournal(await initialLaneHead());
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

    expect(
      await publication.createLaneHead({
        ...head,
        // @ts-expect-error A lane-head create cannot accept a journal record.
        kind: "journal",
        status: "committed",
        allocationState: "allocated",
      }),
    ).toEqual({ kind: "refused" });
    expect(
      await publication.createLaneHead({
        ...head,
        // @ts-expect-error A lane-head create cannot accept a feed event.
        kind: "changed",
        sequence: syncEventSequenceSchema.parse("00000000000000000001"),
      }),
    ).toEqual({ kind: "refused" });
    expect(
      await publication.createLaneHead({
        ...head,
        committedAtEpochMs: -1,
      }),
    ).toEqual({ kind: "refused" });
    expect(
      await publication.createLaneHead({
        ...head,
        // @ts-expect-error Invalid schema version is rejected by the strict record codec.
        schemaVersion: 2,
      }),
    ).toEqual({ kind: "refused" });
    expect(
      await publication.replaceLaneHead(observed.observation, {
        ...head,
        pending: {
          // @ts-expect-error Invalid marker identity is rejected before any R2 write.
          operationId: "not-an-operation-id",
          nextSequence: syncEventSequenceSchema.parse("00000000000000000001"),
        },
      }),
    ).toEqual({ kind: "refused" });

    const validJournal = await unallocatedJournal(
      head,
      operationId,
      observed.observation,
    );
    expect(await publication.createJournal(validJournal)).toEqual({
      kind: "confirmed",
    });
    const journalRead = await publication.readJournal(vaultId, operationId);
    expect(journalRead.kind).toBe("observed");
    if (journalRead.kind !== "observed") return;
    const allocation = await allocatedJournal(validJournal, head);
    const committed = await settledJournal(allocation, "committed");
    expect(
      await publication.replaceJournal(journalRead.observation, committed),
    ).toEqual({ kind: "refused" });
  });

  it("refuses unallocated CAS observations whose retained bytes are not exact", async () => {
    await seedMarker();
    const head = await initialLaneHead();
    const laneKey = syncFeedLaneHeadKey(vaultId, head.lane);
    bucket.seed(laneKey, await encodeSyncPublication(head), epochNow - 5_000);
    const laneRead = await publication.readLaneHead(vaultId, head.lane);
    expect(laneRead.kind).toBe("observed");
    if (laneRead.kind !== "observed") return;
    const original = await unallocatedJournal(
      head,
      operationId,
      laneRead.observation,
    );
    expect(await publication.createJournal(original)).toEqual({
      kind: "confirmed",
    });
    const journalRead = await publication.readJournal(vaultId, operationId);
    expect(journalRead.kind).toBe("observed");
    if (
      journalRead.kind !== "observed" ||
      journalRead.observation.value.status !== "pending" ||
      journalRead.observation.value.allocationState !== "unallocated"
    ) {
      return;
    }
    const raised = {
      ...original,
      laneObservation: {
        ...original.laneObservation,
        retryAfterEpochMs: epochNow + 1_000,
      },
    };
    const forgedObservation = {
      ...journalRead.observation,
      observed: {
        ...journalRead.observation.observed,
        bytes: encoder.encode("different journal bytes"),
      },
    };
    expect(await publication.replaceJournal(forgedObservation, raised)).toEqual(
      { kind: "refused" },
    );
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
    expect(
      await publication.createJournal(
        await unallocatedJournal(await initialLaneHead()),
      ),
    ).toEqual({
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
