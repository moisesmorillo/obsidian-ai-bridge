import { createContentSha256, encodeBase64Url } from "@obsidian-ai-bridge/core";
import {
  syncFeedEventKey,
  syncFeedLaneForPath,
  syncFeedLaneHeadKey,
  syncHeadKey,
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
  SyncEventOutcomeIntent,
  SyncFeedEventRecord,
  SyncHeadRefusalReceiptRecord,
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
import { encodeSyncRecord } from "@worker/infrastructure/sync/sync-record.codec";
import type { SyncHeadRecord } from "@worker/infrastructure/sync/sync-record.types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const vaultId = syncVaultIdSchema.parse("11111111-1111-4111-8111-111111111111");
const alternateVaultId = syncVaultIdSchema.parse(
  "88888888-8888-4888-8888-888888888888",
);
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

/** Narrows strictly observed journals to durable terminal outcomes for retry-floor tests.
 * @param record Validated journal candidate read from the publication adapter.
 * @returns Whether the record is an allocated committed or aborted journal.
 */
function isTerminalJournal(
  record: SyncJournalRecord,
): record is Extract<SyncJournalRecord, { status: "committed" | "aborted" }> {
  return record.status !== "pending" && record.allocationState === "allocated";
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
    schemaVersion: 2,
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
    stepEvidence:
      step === "commit_journal"
        ? {
            step,
            key: targetKey,
            precondition: { kind: "journal_phase", status: "pending" },
            retryAfterEpochMs: null,
          }
        : {
            step,
            key: targetKey,
            precondition: { kind: "absent" },
            retryAfterEpochMs: null,
            attempt: { state: "ready", generation: 0 },
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
      attempt: { state: "ready", generation: 0 },
    },
  };
}

function nextJournalStep(
  record: SyncAllocatedPendingJournalRecord,
  outcomeIntent: SyncEventOutcomeIntent,
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
      committedAtEpochMs: record.reservation.previousCommittedAtEpochMs + 1,
      outcomeIntent,
      precondition: { kind: "absent" },
      retryAfterEpochMs: null,
      attempt: { state: "ready", generation: 0 },
    },
  };
}

async function settledJournal(
  pending: SyncAllocatedPendingJournalRecord,
  status: "committed" | "aborted",
): Promise<Extract<SyncJournalRecord, { status: "committed" | "aborted" }>> {
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
    attempt: { state: "ready", generation: 0 },
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
    schemaVersion: 2,
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
    schemaVersion: 2,
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
    schemaVersion: 2,
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
      attempt: { state: "ready", generation: 0 },
    },
  };
}

describe("marker-gated private sync publication persistence", () => {
  it("exposes exact marker-gated read and create-only persistence for refusal receipts", () => {
    expect("readHeadRefusalReceipt" in publication).toBe(true);
    expect("createHeadRefusalReceipt" in publication).toBe(true);
  });

  it("keeps receipt reads marker-gated when a vault is unprovisioned", async () => {
    expect(
      await publication.readHeadRefusalReceipt(vaultId, operationId),
    ).toEqual({ kind: "unavailable" });
    expect(bucket.puts).toHaveLength(0);
  });

  it("admits only the canonical Worker-private head-refusal key family", () => {
    const receiptKey = `sync/v1/vaults/${vaultId}/operations/${operationId}.head-refusal.json`;
    expect(createSyncR2Key(receiptKey, vaultId)).toBe(receiptKey);
    expect(createSyncR2Key(receiptKey, alternateVaultId)).toBeUndefined();
    expect(
      createSyncR2Key(
        `sync/v1/vaults/${vaultId}/operations/${operationId}.head-refusal.json/extra`,
        vaultId,
      ),
    ).toBeUndefined();
  });

  it("creates and settles a refusal receipt only with its exact head, lane, and journal evidence", async () => {
    await seedMarker();
    const initial = await journal();
    await persistAllocatedJournal(initial);
    const created = await publication.readJournal(vaultId, operationId);
    if (created.kind !== "observed")
      throw new Error("Missing allocated journal.");
    const createdJournal = created.observation.value;
    if (
      createdJournal.status !== "pending" ||
      createdJournal.allocationState !== "allocated" ||
      createdJournal.stepEvidence.step !== "immutable_create"
    ) {
      throw new Error("Expected allocated immutable step.");
    }
    epochNow += 1_100;
    const firstClaim = {
      ...createdJournal,
      stepEvidence: {
        ...createdJournal.stepEvidence,
        attempt: {
          state: "attempting" as const,
          claimId: alternateOperationId,
          generation: 1,
          claimedAtEpochMs: epochNow,
        },
      },
    };
    expect(
      await publication.replaceJournal(created.observation, firstClaim),
    ).toEqual({ kind: "confirmed" });
    epochNow += 1_100;
    const claimed = await publication.readJournal(vaultId, operationId);
    if (claimed.kind !== "observed") throw new Error("Missing first claim.");
    const claimedJournal = claimed.observation.value;
    if (
      claimedJournal.status !== "pending" ||
      claimedJournal.allocationState !== "allocated" ||
      claimedJournal.stepEvidence.step !== "immutable_create"
    ) {
      throw new Error("Expected first immutable claim.");
    }
    const headKey = syncHeadKey(vaultId, path);
    const headReady = {
      ...claimedJournal,
      stepEvidence: {
        step: "write_head" as const,
        key: headKey,
        precondition: { kind: "absent" as const },
        retryAfterEpochMs: null,
        attempt: { state: "ready" as const, generation: 0 as const },
      },
    };
    expect(
      await publication.replaceJournal(claimed.observation, headReady),
    ).toEqual({ kind: "confirmed" });
    epochNow += 1_100;
    const ready = await publication.readJournal(vaultId, operationId);
    if (ready.kind !== "observed") throw new Error("Missing ready head step.");
    const readyJournal = ready.observation.value;
    if (
      readyJournal.status !== "pending" ||
      readyJournal.allocationState !== "allocated" ||
      readyJournal.stepEvidence.step !== "write_head"
    ) {
      throw new Error("Expected ready write-head step.");
    }
    const headClaimed = {
      ...readyJournal,
      stepEvidence: {
        ...readyJournal.stepEvidence,
        attempt: {
          state: "attempting" as const,
          claimId: alternateOperationId,
          generation: 1,
          claimedAtEpochMs: epochNow,
        },
      },
    };
    expect(
      await publication.replaceJournal(ready.observation, headClaimed),
    ).toEqual({ kind: "confirmed" });

    const request = initial.request;
    if (request.kind !== "create") throw new Error("Expected create fixture.");
    const target = {
      schemaVersion: 1 as const,
      protocolMajor: 1 as const,
      vaultId,
      kind: "live" as const,
      path,
      revision,
      parent: request.parent,
      contentSha256: request.contentSha256,
      byteSize: encoder.encode(request.content).byteLength,
      mediaType: request.mediaType,
      operationId,
      origin,
    };
    const targetBytes = await encodeSyncRecord({
      kind: "head",
      record: target,
    });
    const competitor = {
      ...target,
      revision: parentRevision,
      parent: { kind: "never_seen" as const },
      operationId: alternateOperationId,
      contentSha256: request.contentSha256,
      byteSize: 10,
    };
    const competitorBytes = await encodeSyncRecord({
      kind: "head",
      record: competitor,
    });
    const competingGeneration = bucket.seed(headKey, competitorBytes, epochNow);
    const digestInput = targetBytes.slice();
    const targetDigest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput.buffer)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const targetDigestValue = createContentSha256(targetDigest);
    if (targetDigestValue === undefined)
      throw new Error("Invalid target digest.");
    const receipt: SyncHeadRefusalReceiptRecord = {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      operationId,
      claimId: alternateOperationId,
      generation: 1,
      headKey,
      headTargetSha256: targetDigestValue,
      headPrecondition: { kind: "absent" },
      lane: headReady.reservation.lane,
      sequence: headReady.reservation.sequence,
      refusalSource: "preflight_no_dispatch",
      competingHead: {
        etag: competingGeneration.etag,
        bytes: encodeBase64Url(competitorBytes),
        uploadedAtEpochMs: competingGeneration.uploaded.getTime(),
      },
    };
    const refusal = {
      kind: "refused" as const,
      noEffectProvenance: "preflight_no_dispatch" as const,
    };
    const receiptKey = `sync/v1/vaults/${vaultId}/operations/${operationId}.head-refusal.json`;
    const markerKey = syncVaultMarkerKey(vaultId);
    const marker = bucket.objects.get(markerKey);
    if (!marker) throw new Error("Missing owned marker");
    const putsBeforeMarkerLoss = bucket.puts.length;
    bucket.unavailableKeys.add(markerKey);
    expect(
      await publication.createHeadRefusalReceipt(receipt, target, refusal),
    ).toEqual({ kind: "effect_unknown" });
    bucket.unavailableKeys.delete(markerKey);
    bucket.objects.delete(markerKey);
    expect(
      await publication.createHeadRefusalReceipt(receipt, target, refusal),
    ).toEqual({ kind: "refused" });
    bucket.objects.set(markerKey, marker);
    expect(bucket.puts).toHaveLength(putsBeforeMarkerLoss);
    expect(bucket.objects.has(receiptKey)).toBe(false);
    for (const key of [
      syncOperationKey(vaultId, operationId),
      syncFeedLaneHeadKey(vaultId, receipt.lane),
      headKey,
    ]) {
      const exact = bucket.objects.get(key);
      if (!exact) throw new Error("Missing exact receipt preflight fixture.");
      bucket.objects.delete(key);
      expect(
        await publication.createHeadRefusalReceipt(receipt, target, refusal),
      ).toEqual({ kind: "effect_unknown" });
      bucket.objects.set(key, exact);
      bucket.unavailableKeys.add(key);
      expect(
        await publication.createHeadRefusalReceipt(receipt, target, refusal),
      ).toEqual({ kind: "effect_unknown" });
      bucket.unavailableKeys.delete(key);
    }
    const exactHeadBeforeRefusal = bucket.objects.get(headKey);
    if (!exactHeadBeforeRefusal)
      throw new Error("Missing exact competing head.");
    bucket.seed(headKey, competitorBytes, epochNow);
    expect(
      await publication.createHeadRefusalReceipt(receipt, target, refusal),
    ).toEqual({ kind: "effect_unknown" });
    bucket.objects.set(headKey, exactHeadBeforeRefusal);
    expect(
      await publication.createHeadRefusalReceipt(
        { ...receipt, claimId: operationId },
        target,
        refusal,
      ),
    ).toEqual({ kind: "effect_unknown" });
    const ownHead = bucket.seed(headKey, targetBytes, epochNow);
    expect(
      await publication.createHeadRefusalReceipt(
        {
          ...receipt,
          competingHead: {
            etag: ownHead.etag,
            uploadedAtEpochMs: ownHead.uploaded.getTime(),
            bytes: encodeBase64Url(targetBytes),
          },
        },
        target,
        refusal,
      ),
    ).toEqual({ kind: "effect_unknown" });
    bucket.objects.set(headKey, exactHeadBeforeRefusal);
    expect(
      await publication.createHeadRefusalReceipt(
        receipt,
        { ...target, revision: parentRevision },
        refusal,
      ),
    ).toEqual({ kind: "refused" });
    expect(
      await publication.createHeadRefusalReceipt(
        {
          ...receipt,
          competingHead: { ...receipt.competingHead, bytes: "AQ" },
        },
        target,
        refusal,
      ),
    ).toEqual({ kind: "refused" });
    expect(bucket.puts.filter((put) => put.key === receiptKey)).toHaveLength(0);
    const baseObjects = syncR2ObjectStore(bucket, () => epochNow);
    const headReadFails = syncR2Publication({
      ...baseObjects,
      read: async (key, limit) => {
        if (key === headKey) throw new Error("Head GET capability unavailable");
        return baseObjects.read(key, limit);
      },
    });
    await expect(
      headReadFails.createHeadRefusalReceipt(receipt, target, refusal),
    ).resolves.toEqual({ kind: "effect_unknown" });
    const receiptWriteFails = syncR2Publication({
      ...baseObjects,
      create: async () => {
        throw new Error("Receipt PUT transport failed");
      },
    });
    expect(
      await receiptWriteFails.createHeadRefusalReceipt(
        receipt,
        target,
        refusal,
      ),
    ).toEqual({ kind: "effect_unknown" });
    const receiptReadFails = syncR2Publication({
      ...baseObjects,
      read: async (key, limit) => {
        if (key === receiptKey) throw new Error("Receipt GET transport failed");
        return baseObjects.read(key, limit);
      },
    });
    expect(
      await receiptReadFails.readHeadRefusalReceipt(vaultId, operationId),
    ).toEqual({ kind: "unavailable" });
    bucket.seed(receiptKey, encoder.encode("{"), epochNow);
    expect(
      await publication.readHeadRefusalReceipt(vaultId, operationId),
    ).toEqual({ kind: "unavailable" });
    bucket.objects.delete(receiptKey);
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    const targetDigestFailure = vi
      .spyOn(crypto.subtle, "digest")
      .mockImplementationOnce(realDigest)
      .mockRejectedValueOnce(new Error("Target digest capability unavailable"));
    try {
      await expect(
        publication.createHeadRefusalReceipt(receipt, target, refusal),
      ).resolves.toEqual({ kind: "effect_unknown" });
      expect(bucket.puts.filter((put) => put.key === receiptKey)).toHaveLength(
        0,
      );
    } finally {
      targetDigestFailure.mockRestore();
    }
    expect(
      await publication.createHeadRefusalReceipt(receipt, target, refusal),
    ).toEqual({ kind: "confirmed" });
    const readback = await publication.readHeadRefusalReceipt(
      vaultId,
      operationId,
    );
    expect(readback.kind).toBe("observed");
    if (readback.kind !== "observed") return;
    expect(readback.observation.value).toEqual(receipt);
    expect(bucket.puts.filter((put) => put.key === receiptKey)).toHaveLength(1);
    expect(
      await publication.createHeadRefusalReceipt(receipt, target, refusal),
    ).toEqual({ kind: "confirmed" });
    expect(bucket.puts.filter((put) => put.key === receiptKey)).toHaveLength(1);
    expect(
      await publication.createHeadRefusalReceipt(
        { ...receipt, refusalSource: "conditional_null" },
        target,
        refusal,
      ),
    ).toEqual({ kind: "refused" });
    expect(bucket.puts.filter((put) => put.key === receiptKey)).toHaveLength(1);

    const current = await publication.readJournal(vaultId, operationId);
    if (current.kind !== "observed")
      throw new Error("Missing claimed head journal.");
    const abortStep: SyncJournalRecord = {
      ...headClaimed,
      stepEvidence: {
        step: "create_event",
        key: syncFeedEventKey(vaultId, receipt.lane, receipt.sequence),
        outcomeIntent: "aborted",
        precondition: { kind: "absent" },
        retryAfterEpochMs: null,
        attempt: { state: "ready", generation: 0 },
        committedAtEpochMs: epochNow,
      },
    };
    const journalKey = syncOperationKey(vaultId, operationId);
    const journalPuts = bucket.puts.filter(
      (put) => put.key === journalKey,
    ).length;
    expect(
      await publication.replaceJournalFromHeadRefusalReceipt(
        current.observation,
        receipt,
        { ...target, revision: parentRevision },
        abortStep,
      ),
    ).toEqual({ kind: "refused" });
    expect(
      await publication.replaceJournalFromHeadRefusalReceipt(
        current.observation,
        receipt,
        target,
        {
          ...abortStep,
          request: { ...abortStep.request, origin: alternateOrigin },
        },
      ),
    ).toEqual({ kind: "refused" });
    await expect(
      headReadFails.replaceJournalFromHeadRefusalReceipt(
        current.observation,
        receipt,
        target,
        abortStep,
      ),
    ).resolves.toEqual({ kind: "effect_unknown" });
    expect(bucket.puts.filter((put) => put.key === journalKey)).toHaveLength(
      journalPuts,
    );
    const settlementDigestFailure = vi
      .spyOn(crypto.subtle, "digest")
      .mockImplementationOnce(realDigest)
      .mockRejectedValueOnce(
        new Error("Settlement digest capability unavailable"),
      );
    try {
      await expect(
        publication.replaceJournalFromHeadRefusalReceipt(
          current.observation,
          receipt,
          target,
          abortStep,
        ),
      ).resolves.toEqual({ kind: "effect_unknown" });
      expect(bucket.puts.filter((put) => put.key === journalKey)).toHaveLength(
        journalPuts,
      );
    } finally {
      settlementDigestFailure.mockRestore();
    }
    const exactReceipt = bucket.objects.get(receiptKey);
    if (!exactReceipt)
      throw new Error("Missing exact persisted refusal receipt.");
    bucket.objects.delete(receiptKey);
    expect(
      await publication.replaceJournalFromHeadRefusalReceipt(
        current.observation,
        receipt,
        target,
        abortStep,
      ),
    ).toEqual({ kind: "effect_unknown" });
    bucket.objects.set(receiptKey, exactReceipt);

    const laneKey = syncFeedLaneHeadKey(vaultId, receipt.lane);
    const exactLane = bucket.objects.get(laneKey);
    if (!exactLane) throw new Error("Missing exact reserved lane.");
    bucket.objects.delete(laneKey);
    expect(
      await publication.replaceJournalFromHeadRefusalReceipt(
        current.observation,
        receipt,
        target,
        abortStep,
      ),
    ).toEqual({ kind: "effect_unknown" });
    bucket.objects.set(laneKey, exactLane);

    const exactHead = bucket.objects.get(headKey);
    if (!exactHead) throw new Error("Missing exact competing head.");
    bucket.objects.delete(headKey);
    expect(
      await publication.replaceJournalFromHeadRefusalReceipt(
        current.observation,
        receipt,
        target,
        abortStep,
      ),
    ).toEqual({ kind: "effect_unknown" });
    bucket.objects.set(headKey, exactHead);
    for (const key of [receiptKey, laneKey, headKey]) {
      bucket.unavailableKeys.add(key);
      expect(
        await publication.replaceJournalFromHeadRefusalReceipt(
          current.observation,
          receipt,
          target,
          abortStep,
        ),
      ).toEqual({ kind: "effect_unknown" });
      bucket.unavailableKeys.delete(key);
    }
    const laneRead = await publication.readLaneHead(vaultId, receipt.lane);
    if (laneRead.kind !== "observed")
      throw new Error("Missing reserved lane record.");
    bucket.seed(
      laneKey,
      await encodeSyncPublication({
        ...laneRead.observation.value,
        pending: {
          operationId: alternateOperationId,
          nextSequence: receipt.sequence,
        },
      }),
      epochNow,
    );
    expect(
      await publication.replaceJournalFromHeadRefusalReceipt(
        current.observation,
        receipt,
        target,
        abortStep,
      ),
    ).toEqual({ kind: "effect_unknown" });
    bucket.objects.set(laneKey, exactLane);
    expect(bucket.puts.filter((put) => put.key === journalKey)).toHaveLength(
      journalPuts,
    );
    expect(
      await publication.replaceJournalFromHeadRefusalReceipt(
        current.observation,
        receipt,
        target,
        abortStep,
      ),
    ).toEqual({ kind: "throttled", retryAfterEpochMs: epochNow + 1_100 });
    expect(bucket.puts.filter((put) => put.key === journalKey)).toHaveLength(
      journalPuts,
    );
    epochNow += 1_100;
    expect(
      await publication.replaceJournalFromHeadRefusalReceipt(
        current.observation,
        receipt,
        target,
        abortStep,
      ),
    ).toEqual({ kind: "confirmed" });
    const settled = await publication.readJournal(vaultId, operationId);
    expect(settled.kind).toBe("observed");
    if (settled.kind === "observed")
      expect(settled.observation.value).toEqual(abortStep);
  });

  it.each(["update", "tombstone"] as const)(
    "binds a %s refusal receipt to the original observed parent and exact intended head",
    async (action) => {
      await seedMarker();
      const initial =
        action === "update"
          ? await updateJournalRecord(operationId)
          : await tombstoneJournalRecord(operationId);
      const request = initial.request;
      if (request.kind === "create")
        throw new Error("Expected exact revision parent");
      const prior: SyncHeadRecord = {
        schemaVersion: 1,
        protocolMajor: 1,
        vaultId,
        kind: "live",
        path,
        revision: parentRevision,
        parent: { kind: "never_seen" },
        contentSha256: request.contentSha256,
        byteSize: initial.payload?.byteSize ?? 18,
        mediaType: "text/markdown",
        operationId: alternateOperationId,
        origin,
      };
      const headKey = syncHeadKey(vaultId, path);
      const priorBytes = await encodeSyncRecord({
        kind: "head",
        record: prior,
      });
      const priorGeneration = bucket.seed(
        headKey,
        priorBytes,
        epochNow - 5_000,
      );
      const precondition = {
        kind: "observed" as const,
        etag: priorGeneration.etag,
        bytes: encodeBase64Url(priorBytes),
        uploadedAtEpochMs: priorGeneration.uploaded.getTime(),
      };
      const claimed: SyncAllocatedPendingJournalRecord = {
        ...initial,
        stepEvidence: {
          step: "write_head",
          key: headKey,
          precondition,
          retryAfterEpochMs: null,
          attempt: {
            state: "attempting",
            claimId: alternateOperationId,
            generation: 1,
            claimedAtEpochMs: epochNow - 2_000,
          },
        },
      };
      bucket.seed(
        syncOperationKey(vaultId, operationId),
        await encodeSyncPublication(claimed),
        epochNow - 2_000,
      );
      const lane: SyncLaneHeadRecord = {
        schemaVersion: 1,
        protocolMajor: 1,
        vaultId,
        kind: "laneHead",
        lane: initial.reservation.lane,
        committedSequence: syncSequenceSchema.parse("00000000000000000001"),
        committedAtEpochMs: initial.reservation.previousCommittedAtEpochMs,
        pending: { operationId, nextSequence: initial.reservation.sequence },
      };
      bucket.seed(
        syncFeedLaneHeadKey(vaultId, lane.lane),
        await encodeSyncPublication(lane),
        epochNow - 2_000,
      );
      const target: SyncHeadRecord = {
        ...prior,
        kind: action === "tombstone" ? "tombstone" : "live",
        revision,
        parent: request.parent,
        operationId,
        origin: request.origin,
      };
      const competitor: SyncHeadRecord = {
        ...prior,
        revision: syncRevisionSchema.parse(
          "99999999-9999-4999-8999-999999999999",
        ),
      };
      const competitorBytes = await encodeSyncRecord({
        kind: "head",
        record: competitor,
      });
      const competing = bucket.seed(headKey, competitorBytes, epochNow - 1_500);
      const digest = async (head: SyncHeadRecord) => {
        const bytes = await encodeSyncRecord({ kind: "head", record: head });
        const input = bytes.slice();
        const value = createContentSha256(
          Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", input.buffer)),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join(""),
        );
        if (!value) throw new Error("Expected target digest");
        return value;
      };
      const receipt: SyncHeadRefusalReceiptRecord = {
        schemaVersion: 1,
        protocolMajor: 1,
        vaultId,
        operationId,
        claimId: alternateOperationId,
        generation: 1,
        headKey,
        headTargetSha256: await digest(target),
        headPrecondition: precondition,
        lane: lane.lane,
        sequence: initial.reservation.sequence,
        refusalSource: "conditional_null",
        competingHead: {
          etag: competing.etag,
          bytes: encodeBase64Url(competitorBytes),
          uploadedAtEpochMs: competing.uploaded.getTime(),
        },
      };
      const noEffect = {
        kind: "refused" as const,
        noEffectProvenance: "conditional_null" as const,
      };
      const writes = bucket.puts.length;
      const substitutions: SyncHeadRecord[] = [
        { ...target, origin: alternateOrigin },
        {
          ...target,
          parent: { kind: "revision", revision: competitor.revision },
        },
        action === "tombstone"
          ? { ...target, kind: "live" }
          : { ...target, byteSize: target.byteSize + 1 },
      ];
      for (const substituted of substitutions) {
        expect(
          await publication.createHeadRefusalReceipt(
            { ...receipt, headTargetSha256: await digest(substituted) },
            substituted,
            noEffect,
          ),
        ).toEqual({ kind: "effect_unknown" });
      }
      expect(bucket.puts).toHaveLength(writes);
      expect(
        await publication.createHeadRefusalReceipt(receipt, target, noEffect),
      ).toEqual({ kind: "confirmed" });
      const observed = await publication.readJournal(vaultId, operationId);
      if (observed.kind !== "observed")
        throw new Error("Expected claimed head journal");
      const abort: SyncAllocatedPendingJournalRecord = {
        ...claimed,
        stepEvidence: {
          step: "create_event",
          key: syncFeedEventKey(
            vaultId,
            lane.lane,
            initial.reservation.sequence,
          ),
          outcomeIntent: "aborted",
          precondition: { kind: "absent" },
          retryAfterEpochMs: null,
          attempt: { state: "ready", generation: 0 },
          committedAtEpochMs: epochNow,
        },
      };
      expect(
        await publication.replaceJournalFromHeadRefusalReceipt(
          observed.observation,
          receipt,
          target,
          abort,
        ),
      ).toEqual({ kind: "confirmed" });
      expect(await publication.readJournal(vaultId, operationId)).toMatchObject(
        {
          kind: "observed",
          observation: {
            value: {
              status: "pending",
              stepEvidence: { step: "create_event", outcomeIntent: "aborted" },
            },
          },
        },
      );
      expect(
        await publication.readEvent(
          vaultId,
          lane.lane,
          initial.reservation.sequence,
        ),
      ).toEqual({ kind: "absent" });
    },
  );

  it.each(["committed", "aborted"] as const)(
    "keeps a %s terminal outcome immutable while fencing claim ownership and the fixed retry-wait floor",
    async (status) => {
      await seedMarker();
      const settled = await settledJournal(await journal(), status);
      if (settled.stepEvidence.step !== "commit_lane")
        throw new Error("Expected lane evidence");
      const key = syncOperationKey(vaultId, operationId);
      bucket.seed(key, await encodeSyncPublication(settled), epochNow - 5_000);
      const read = await publication.readJournal(vaultId, operationId);
      if (read.kind !== "observed")
        throw new Error("Expected terminal journal");
      const claimed = {
        ...settled,
        stepEvidence: {
          ...settled.stepEvidence,
          attempt: {
            state: "attempting" as const,
            generation: 1,
            claimId: alternateOperationId,
            claimedAtEpochMs: epochNow,
          },
        },
      };
      expect(
        await publication.replaceJournal(read.observation, claimed),
      ).toEqual({ kind: "confirmed" });
      epochNow += 1_100;
      const claimedRead = await publication.readJournal(vaultId, operationId);
      if (claimedRead.kind !== "observed")
        throw new Error("Expected claimed terminal journal");
      const raised = {
        ...claimed,
        stepEvidence: {
          ...claimed.stepEvidence,
          retryAfterEpochMs: epochNow + 1_100,
        },
      };
      expect(
        await publication.replaceJournal(claimedRead.observation, raised),
      ).toEqual({ kind: "confirmed" });
      epochNow += 1_100;
      const raisedRead = await publication.readJournal(vaultId, operationId);
      if (raisedRead.kind !== "observed")
        throw new Error("Expected preserved terminal claim");
      const writes = bucket.puts.length;
      expect(
        await publication.replaceJournal(raisedRead.observation, {
          ...raised,
          stepEvidence: {
            ...raised.stepEvidence,
            attempt: { ...raised.stepEvidence.attempt, claimId: operationId },
          },
        }),
      ).toEqual({ kind: "refused" });
      expect(bucket.puts).toHaveLength(writes);
      const floor = epochNow + 1_100;
      const waiting = {
        ...raised,
        stepEvidence: {
          ...raised.stepEvidence,
          retryAfterEpochMs: floor,
          attempt: {
            state: "retry_wait" as const,
            generation: 1,
            claimId: alternateOperationId,
            observedAtEpochMs: epochNow,
            retryAfterEpochMs: floor,
          },
        },
      };
      expect(
        await publication.replaceJournal(raisedRead.observation, waiting),
      ).toEqual({ kind: "confirmed" });
      epochNow = floor;
      const waitingRead = await publication.readJournal(vaultId, operationId);
      if (waitingRead.kind !== "observed")
        throw new Error("Expected fixed retry-wait authority");
      const waitingWrites = bucket.puts.length;
      expect(
        await publication.replaceJournal(waitingRead.observation, {
          ...waiting,
          stepEvidence: {
            ...waiting.stepEvidence,
            retryAfterEpochMs: floor + 1_100,
            attempt: {
              ...waiting.stepEvidence.attempt,
              retryAfterEpochMs: floor + 1_100,
            },
          },
        }),
      ).toEqual({ kind: "refused" });
      const nextClaim = {
        ...waiting,
        stepEvidence: {
          ...waiting.stepEvidence,
          attempt: {
            state: "attempting" as const,
            generation: 2,
            claimId: operationId,
            claimedAtEpochMs: floor,
          },
        },
      };
      expect(
        await publication.replaceJournal(waitingRead.observation, {
          ...nextClaim,
          stepEvidence: {
            ...nextClaim.stepEvidence,
            attempt: {
              ...nextClaim.stepEvidence.attempt,
              claimId: alternateOperationId,
            },
          },
        }),
      ).toEqual({ kind: "refused" });
      expect(bucket.puts).toHaveLength(waitingWrites);
      expect(
        await publication.replaceJournal(waitingRead.observation, nextClaim),
      ).toEqual({ kind: "confirmed" });
      expect(await publication.readJournal(vaultId, operationId)).toMatchObject(
        {
          kind: "observed",
          observation: {
            value: {
              status,
              request: settled.request,
              position: settled.position,
              committedAtEpochMs: settled.committedAtEpochMs,
              stepEvidence: {
                step: "commit_lane",
                retryAfterEpochMs: floor,
                attempt: {
                  state: "attempting",
                  generation: 2,
                  claimId: operationId,
                },
              },
            },
          },
        },
      );
      expect(
        bucket.puts.every(
          ({ key }) => key === syncOperationKey(vaultId, operationId),
        ),
      ).toBe(true);
    },
  );

  it("does not let generic journal replacement abort a claimed write-head step", async () => {
    await seedMarker();
    const initial = await journal();
    if (initial.stepEvidence.step !== "immutable_create") return;
    const headReady: SyncAllocatedPendingJournalRecord = {
      ...initial,
      stepEvidence: {
        step: "write_head",
        key: syncHeadKey(vaultId, path),
        precondition: { kind: "absent" },
        retryAfterEpochMs: null,
        attempt: { state: "ready", generation: 0 },
      },
    };
    if (headReady.stepEvidence.step !== "write_head") return;
    const lane = await initialLaneHead();
    const reservedLane: SyncLaneHeadRecord = {
      ...lane,
      pending: {
        operationId,
        nextSequence: headReady.reservation.sequence,
      },
    };
    bucket.seed(
      syncFeedLaneHeadKey(vaultId, lane.lane),
      await encodeSyncPublication(reservedLane),
      epochNow - 5_000,
    );
    bucket.seed(
      syncOperationKey(vaultId, operationId),
      await encodeSyncPublication(headReady),
      epochNow - 5_000,
    );

    const ready = await publication.readJournal(vaultId, operationId);
    expect(ready.kind).toBe("observed");
    if (ready.kind !== "observed") return;
    const claim: SyncAllocatedPendingJournalRecord = {
      ...headReady,
      stepEvidence: {
        ...headReady.stepEvidence,
        attempt: {
          state: "attempting",
          claimId: alternateOperationId,
          generation: 1,
          claimedAtEpochMs: epochNow,
        },
      },
    };
    expect(await publication.replaceJournal(ready.observation, claim)).toEqual({
      kind: "confirmed",
    });
    const claimed = await publication.readJournal(vaultId, operationId);
    expect(claimed.kind).toBe("observed");
    if (claimed.kind !== "observed") return;
    epochNow += 1_100;
    const abort = nextJournalStep(claim, "aborted");
    const writesBeforeAbort = bucket.puts.filter(
      (put) => put.key === syncOperationKey(vaultId, operationId),
    ).length;

    expect(
      await publication.replaceJournal(claimed.observation, abort),
    ).toEqual({ kind: "refused" });
    expect(
      bucket.puts.filter(
        (put) => put.key === syncOperationKey(vaultId, operationId),
      ),
    ).toHaveLength(writesBeforeAbort);
    expect(await publication.readJournal(vaultId, operationId)).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          stepEvidence: {
            step: "write_head",
            attempt: { state: "attempting", generation: 1 },
          },
        },
      },
    });
  });

  it("requires exact live proof for a ready-head stale-abort shortcut", async () => {
    await seedMarker();
    const initial = await journal();
    if (initial.stepEvidence.step !== "immutable_create") return;
    const headReady: SyncAllocatedPendingJournalRecord = {
      ...initial,
      stepEvidence: {
        step: "write_head",
        key: syncHeadKey(vaultId, path),
        precondition: { kind: "absent" },
        retryAfterEpochMs: null,
        attempt: { state: "ready", generation: 0 },
      },
    };
    if (headReady.stepEvidence.step !== "write_head") return;
    const lane = await initialLaneHead();
    const reservedLane: SyncLaneHeadRecord = {
      ...lane,
      pending: { operationId, nextSequence: headReady.reservation.sequence },
    };
    bucket.seed(
      syncFeedLaneHeadKey(vaultId, lane.lane),
      await encodeSyncPublication(reservedLane),
      epochNow - 5_000,
    );
    bucket.seed(
      syncOperationKey(vaultId, operationId),
      await encodeSyncPublication(initial),
      epochNow - 5_000,
    );
    const initialObservation = await publication.readJournal(
      vaultId,
      operationId,
    );
    if (initialObservation.kind !== "observed")
      throw new Error("Expected historical immutable-step observation");
    bucket.seed(
      syncOperationKey(vaultId, operationId),
      await encodeSyncPublication(headReady),
      epochNow - 5_000,
    );
    const competitor: SyncHeadRecord = {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      kind: "live",
      path,
      revision: parentRevision,
      parent: { kind: "never_seen" },
      contentSha256: initial.request.contentSha256,
      byteSize: initial.payload?.byteSize ?? 0,
      mediaType: "text/markdown",
      operationId: alternateOperationId,
      origin: alternateOrigin,
    };
    const headKey = createSyncR2Key(syncHeadKey(vaultId, path), vaultId);
    if (headKey === undefined) return;
    const competitorBytes = await encodeSyncRecord({
      kind: "head",
      record: competitor,
    });
    const competitorGeneration = bucket.seed(
      headKey,
      competitorBytes,
      epochNow - 5_000,
    );
    const competitorObservation: SyncRecordObservation<SyncHeadRecord> = {
      value: competitor,
      observed: {
        key: headKey,
        etag: competitorGeneration.etag,
        uploaded: competitorGeneration.uploaded,
        bytes: competitorBytes,
      },
    };
    const ready = await publication.readJournal(vaultId, operationId);
    expect(ready.kind).toBe("observed");
    if (ready.kind !== "observed") return;
    const abort = nextJournalStep(headReady, "aborted");
    expect(
      await publication.replaceJournalFromReadyHeadCasAbort(
        initialObservation.observation,
        competitorObservation,
        abort,
      ),
    ).toEqual({ kind: "refused" });
    expect(await publication.replaceJournal(ready.observation, abort)).toEqual({
      kind: "refused",
    });
    const writesBeforeShortcut = bucket.puts.filter(
      (put) => put.key === syncOperationKey(vaultId, operationId),
    ).length;
    const changedCurrent: SyncHeadRecord = {
      ...competitor,
      revision: initial.request.revision,
    };
    bucket.seed(
      headKey,
      await encodeSyncRecord({ kind: "head", record: changedCurrent }),
      epochNow,
    );
    expect(
      await publication.replaceJournalFromReadyHeadCasAbort(
        ready.observation,
        competitorObservation,
        abort,
      ),
    ).toEqual({ kind: "refused" });
    expect(
      bucket.puts.filter(
        (put) => put.key === syncOperationKey(vaultId, operationId),
      ),
    ).toHaveLength(writesBeforeShortcut);

    const restoredCompetitor = bucket.seed(headKey, competitorBytes, epochNow);
    const currentCompetitorObservation: SyncRecordObservation<SyncHeadRecord> =
      {
        value: competitor,
        observed: {
          key: headKey,
          etag: restoredCompetitor.etag,
          uploaded: restoredCompetitor.uploaded,
          bytes: competitorBytes,
        },
      };
    const shortcut = () =>
      publication.replaceJournalFromReadyHeadCasAbort(
        ready.observation,
        currentCompetitorObservation,
        abort,
      );
    const baseObjects = syncR2ObjectStore(bucket, () => epochNow);
    const headUnavailable = syncR2Publication({
      ...baseObjects,
      read: async (key, limit) => {
        if (key === headKey)
          throw new Error("Ready-abort head capability rejected");
        return baseObjects.read(key, limit);
      },
    });
    await expect(
      headUnavailable.replaceJournalFromReadyHeadCasAbort(
        ready.observation,
        currentCompetitorObservation,
        abort,
      ),
    ).resolves.toEqual({ kind: "effect_unknown" });
    const markerKey = syncVaultMarkerKey(vaultId);
    const marker = bucket.objects.get(markerKey);
    if (marker === undefined) throw new Error("Expected live namespace marker");
    for (const failure of ["unavailable", "absent"] as const) {
      let markerReads = 0;
      const lateNamespaceLoss = syncR2Publication({
        ...baseObjects,
        read: async (key, limit) => {
          if (key === markerKey && ++markerReads === 3) {
            if (failure === "absent") bucket.objects.delete(markerKey);
            else bucket.unavailableKeys.add(markerKey);
          }
          return baseObjects.read(key, limit);
        },
      });
      try {
        expect(
          await lateNamespaceLoss.replaceJournalFromReadyHeadCasAbort(
            ready.observation,
            currentCompetitorObservation,
            abort,
          ),
        ).toEqual({
          kind: failure === "absent" ? "refused" : "effect_unknown",
        });
        expect(markerReads).toBe(3);
      } finally {
        bucket.objects.set(markerKey, marker);
        bucket.unavailableKeys.delete(markerKey);
      }
    }
    const digestFailure = vi
      .spyOn(crypto.subtle, "digest")
      .mockRejectedValueOnce(new Error("Ready-abort claim digest unavailable"));
    try {
      expect(await shortcut()).toEqual({ kind: "refused" });
    } finally {
      digestFailure.mockRestore();
    }
    for (const [key, absentResult] of [
      [syncOperationKey(vaultId, operationId), "refused"],
      [syncFeedLaneHeadKey(vaultId, lane.lane), "effect_unknown"],
      [headKey, "refused"],
    ] as const) {
      const exact = bucket.objects.get(key);
      if (!exact) throw new Error("Missing exact shortcut preflight evidence.");
      bucket.objects.delete(key);
      expect(await shortcut()).toEqual({ kind: absentResult });
      bucket.objects.set(key, exact);
      bucket.unavailableKeys.add(key);
      expect(await shortcut()).toEqual({ kind: "effect_unknown" });
      bucket.unavailableKeys.delete(key);
    }
    expect(
      bucket.puts.filter(
        (put) => put.key === syncOperationKey(vaultId, operationId),
      ),
    ).toHaveLength(writesBeforeShortcut);
    expect(await shortcut()).toEqual({ kind: "confirmed" });
    expect(
      bucket.puts.filter(
        (put) => put.key === syncOperationKey(vaultId, operationId),
      ),
    ).toHaveLength(writesBeforeShortcut + 1);
    const freshPublication = syncR2Publication(
      syncR2ObjectStore(bucket, () => epochNow),
    );
    expect(
      await freshPublication.readJournal(vaultId, operationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          stepEvidence: {
            step: "create_event",
            outcomeIntent: "aborted",
            attempt: { state: "ready", generation: 0 },
          },
        },
      },
    });
  });

  it("authorizes the unclaimed stale-event shortcut without letting its witness change journal identity", async () => {
    await seedMarker();
    const initial = await journal();
    await persistAllocatedJournal(initial);
    const ready = await publication.readJournal(vaultId, operationId);
    expect(ready.kind).toBe("observed");
    if (ready.kind !== "observed") return;
    const readyJournal = ready.observation.value;
    if (
      readyJournal.status !== "pending" ||
      readyJournal.allocationState !== "allocated" ||
      readyJournal.stepEvidence.step !== "immutable_create"
    ) {
      return;
    }
    const shortcut = nextJournalStep(readyJournal, "aborted");
    if (shortcut.stepEvidence.step !== "create_event") return;
    const eventKey = syncFeedEventKey(
      vaultId,
      readyJournal.reservation.lane,
      readyJournal.reservation.sequence,
    );
    const invalidTransitions: SyncAllocatedPendingJournalRecord[] = [
      {
        ...readyJournal,
        stepEvidence: {
          step: "write_head",
          key: syncHeadKey(vaultId, path),
          precondition: { kind: "absent" },
          retryAfterEpochMs: null,
          attempt: { state: "ready", generation: 0 },
        },
      },
      {
        ...readyJournal,
        stepEvidence: {
          step: "commit_journal",
          key: syncOperationKey(vaultId, operationId),
          precondition: { kind: "journal_phase", status: "pending" },
          retryAfterEpochMs: null,
        },
      },
      {
        ...shortcut,
        stepEvidence: { ...shortcut.stepEvidence, outcomeIntent: "changed" },
      },
      {
        ...shortcut,
        stepEvidence: {
          ...shortcut.stepEvidence,
          key: syncFeedEventKey(
            vaultId,
            readyJournal.reservation.lane,
            syncEventSequenceSchema.parse("00000000000000000002"),
          ),
        },
      },
      {
        ...shortcut,
        request: { ...shortcut.request, origin: alternateOrigin },
      },
      {
        ...shortcut,
        reservation: {
          ...shortcut.reservation,
          sequence: syncEventSequenceSchema.parse("00000000000000000002"),
        },
      },
      {
        ...shortcut,
        stepEvidence: {
          ...shortcut.stepEvidence,
          precondition: {
            kind: "observed",
            etag: "unrelated-generation",
            bytes: "AA",
            uploadedAtEpochMs: epochNow - 5_000,
          },
        },
      },
      {
        ...shortcut,
        stepEvidence: {
          ...shortcut.stepEvidence,
          committedAtEpochMs:
            readyJournal.reservation.previousCommittedAtEpochMs,
        },
      },
    ];
    const journalKey = syncOperationKey(vaultId, operationId);
    const writesBeforeInvalid = bucket.puts.filter(
      (put) => put.key === journalKey,
    ).length;
    for (const invalid of invalidTransitions) {
      expect(
        await publication.replaceJournal(ready.observation, invalid),
      ).toEqual({ kind: "refused" });
    }
    expect(bucket.puts.filter((put) => put.key === journalKey)).toHaveLength(
      writesBeforeInvalid,
    );
    epochNow += 1_100;

    expect(
      await publication.replaceJournal(ready.observation, {
        ...shortcut,
        stepEvidence: {
          ...shortcut.stepEvidence,
          key: eventKey,
          committedAtEpochMs: epochNow,
        },
      }),
    ).toEqual({ kind: "confirmed" });
    const restartedPublication = syncR2Publication(
      syncR2ObjectStore(bucket, () => epochNow),
    );
    const persisted = await restartedPublication.readJournal(
      vaultId,
      operationId,
    );
    expect(persisted).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          stepEvidence: {
            step: "create_event",
            outcomeIntent: "aborted",
            key: eventKey,
            committedAtEpochMs: epochNow,
            attempt: { state: "ready", generation: 0 },
          },
        },
      },
    });
    if (
      persisted.kind !== "observed" ||
      persisted.observation.value.status !== "pending" ||
      persisted.observation.value.allocationState !== "allocated" ||
      persisted.observation.value.stepEvidence.step !== "create_event"
    ) {
      return;
    }
    epochNow += 1_100;
    const journalWritesBeforeFlip = bucket.puts.filter(
      (put) => put.key === syncOperationKey(vaultId, operationId),
    ).length;
    const flippedIntent: SyncAllocatedPendingJournalRecord = {
      ...persisted.observation.value,
      stepEvidence: {
        ...persisted.observation.value.stepEvidence,
        outcomeIntent: "changed",
        attempt: {
          state: "attempting",
          claimId: alternateOperationId,
          generation: 1,
          claimedAtEpochMs: epochNow,
        },
      },
    };
    expect(
      await restartedPublication.replaceJournal(
        persisted.observation,
        flippedIntent,
      ),
    ).toEqual({ kind: "refused" });
    expect(
      bucket.puts.filter(
        (put) => put.key === syncOperationKey(vaultId, operationId),
      ),
    ).toHaveLength(journalWritesBeforeFlip);
    expect(
      await restartedPublication.readJournal(vaultId, operationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          stepEvidence: {
            step: "create_event",
            outcomeIntent: "aborted",
            attempt: { state: "ready", generation: 0 },
          },
        },
      },
    });
    const prior = persisted.observation.value;
    if (prior.stepEvidence.step !== "create_event")
      throw new Error("Expected aborted event step.");
    const witness: SyncFeedEventRecord = {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      kind: "aborted",
      lane: prior.reservation.lane,
      sequence: prior.reservation.sequence,
      operationId,
      reason: "stale_revision",
      committedAtEpochMs: prior.stepEvidence.committedAtEpochMs,
    };
    bucket.seed(eventKey, await encodeSyncPublication(witness), epochNow);
    const commit: SyncAllocatedPendingJournalRecord = {
      ...prior,
      stepEvidence: {
        step: "commit_journal",
        key: journalKey,
        precondition: { kind: "journal_phase", status: "pending" },
        retryAfterEpochMs: null,
      },
    };
    for (const changed of [
      { ...commit, request: { ...commit.request, origin: alternateOrigin } },
      {
        ...commit,
        reservation: {
          ...commit.reservation,
          sequence: syncEventSequenceSchema.parse("00000000000000000002"),
        },
      },
    ]) {
      expect(
        await restartedPublication.replaceJournal(
          persisted.observation,
          changed,
        ),
      ).toEqual({ kind: "refused" });
    }
    expect(bucket.puts.filter((put) => put.key === journalKey)).toHaveLength(
      journalWritesBeforeFlip,
    );
    expect(
      await restartedPublication.replaceJournal(persisted.observation, commit),
    ).toEqual({ kind: "confirmed" });
  });

  it("allows only monotonic claims and retry waits for an unchanged target tuple", async () => {
    await seedMarker();
    const initial = await journal();
    await persistAllocatedJournal(initial);
    const ready = await publication.readJournal(vaultId, operationId);
    expect(ready.kind).toBe("observed");
    if (ready.kind !== "observed") return;
    const readyJournal = ready.observation.value;
    if (
      readyJournal.status !== "pending" ||
      readyJournal.allocationState !== "allocated" ||
      readyJournal.stepEvidence.step === "commit_journal"
    ) {
      return;
    }

    const invalidGeneration: SyncAllocatedPendingJournalRecord = {
      ...readyJournal,
      stepEvidence: {
        ...readyJournal.stepEvidence,
        attempt: {
          state: "attempting",
          claimId: alternateOperationId,
          generation: 2,
          claimedAtEpochMs: epochNow,
        },
      },
    };
    epochNow += 1_100;
    const writesBeforeInvalid = bucket.puts.filter(
      (put) => put.key === syncOperationKey(vaultId, operationId),
    ).length;
    expect(
      await publication.replaceJournal(ready.observation, invalidGeneration),
    ).toEqual({ kind: "refused" });
    expect(
      bucket.puts.filter(
        (put) => put.key === syncOperationKey(vaultId, operationId),
      ),
    ).toHaveLength(writesBeforeInvalid);

    const claim: SyncAllocatedPendingJournalRecord = {
      ...readyJournal,
      stepEvidence: {
        ...readyJournal.stepEvidence,
        attempt: {
          state: "attempting",
          claimId: alternateOperationId,
          generation: 1,
          claimedAtEpochMs: epochNow,
        },
      },
    };
    expect(await publication.replaceJournal(ready.observation, claim)).toEqual({
      kind: "confirmed",
    });
    const claimed = await publication.readJournal(vaultId, operationId);
    expect(claimed.kind).toBe("observed");
    if (claimed.kind !== "observed") return;
    const claimedJournal = claimed.observation.value;
    if (
      claimedJournal.status !== "pending" ||
      claimedJournal.allocationState !== "allocated" ||
      claimedJournal.stepEvidence.step === "commit_journal" ||
      claimedJournal.stepEvidence.attempt.state !== "attempting"
    ) {
      return;
    }

    const sameClaimAgain: SyncAllocatedPendingJournalRecord = {
      ...claimedJournal,
      stepEvidence: {
        ...claimedJournal.stepEvidence,
        attempt: {
          state: "attempting",
          claimId: claimedJournal.stepEvidence.attempt.claimId,
          generation: 2,
          claimedAtEpochMs:
            claimedJournal.stepEvidence.attempt.claimedAtEpochMs,
        },
      },
    };
    epochNow += 1_100;
    expect(
      await publication.replaceJournal(claimed.observation, sameClaimAgain),
    ).toEqual({ kind: "refused" });

    const observedAtEpochMs = epochNow;
    const retryAfterEpochMs = observedAtEpochMs + 1_100;
    const retryWait: SyncAllocatedPendingJournalRecord = {
      ...claimedJournal,
      stepEvidence: {
        ...claimedJournal.stepEvidence,
        retryAfterEpochMs,
        attempt: {
          state: "retry_wait",
          claimId: alternateOperationId,
          generation: 1,
          observedAtEpochMs,
          retryAfterEpochMs,
        },
      },
    };
    expect(
      await publication.replaceJournal(claimed.observation, retryWait),
    ).toEqual({ kind: "confirmed" });
    const waiting = await publication.readJournal(vaultId, operationId);
    expect(waiting.kind).toBe("observed");
    if (waiting.kind !== "observed") return;
    const waitingJournal = waiting.observation.value;
    if (
      waitingJournal.status !== "pending" ||
      waitingJournal.allocationState !== "allocated" ||
      waitingJournal.stepEvidence.step === "commit_journal" ||
      waitingJournal.stepEvidence.attempt.state !== "retry_wait"
    ) {
      return;
    }

    epochNow = Math.max(epochNow + 1_100, retryAfterEpochMs);
    const nextClaim: SyncAllocatedPendingJournalRecord = {
      ...waitingJournal,
      stepEvidence: {
        ...waitingJournal.stepEvidence,
        attempt: {
          state: "attempting",
          claimId: operationId,
          generation: 2,
          claimedAtEpochMs: epochNow,
        },
      },
    };
    const raisedFloorClaim: SyncAllocatedPendingJournalRecord = {
      ...nextClaim,
      stepEvidence: {
        ...nextClaim.stepEvidence,
        retryAfterEpochMs: retryAfterEpochMs + 1_100,
      },
    };
    expect(
      await publication.replaceJournal(waiting.observation, raisedFloorClaim),
    ).toEqual({ kind: "refused" });
    expect(
      await publication.replaceJournal(waiting.observation, nextClaim),
    ).toEqual({ kind: "confirmed" });
  });

  it("keeps terminal outcome and original lane precondition fixed across claims", async () => {
    await seedMarker();
    const phase = await journal(undefined, "commit_journal");
    await persistAllocatedJournal(phase);
    const pending = await publication.readJournal(vaultId, operationId);
    expect(pending.kind).toBe("observed");
    if (pending.kind !== "observed") return;
    epochNow += 1_100;
    const terminal = await settledJournal(phase, "committed");
    expect(
      await publication.replaceJournal(pending.observation, terminal),
    ).toEqual({ kind: "confirmed" });
    const terminalRead = await publication.readJournal(vaultId, operationId);
    expect(terminalRead.kind).toBe("observed");
    if (
      terminalRead.kind !== "observed" ||
      !isTerminalJournal(terminalRead.observation.value)
    ) {
      return;
    }
    if (terminalRead.observation.value.status !== "committed")
      throw new Error("Expected immutable committed outcome");
    const writesBeforeChangedOutcome = bucket.puts.length;
    expect(
      await publication.replaceJournal(terminalRead.observation, {
        ...terminalRead.observation.value,
        revision: parentRevision,
      }),
    ).toEqual({ kind: "refused" });
    expect(bucket.puts).toHaveLength(writesBeforeChangedOutcome);
    expect(await publication.readJournal(vaultId, operationId)).toMatchObject({
      kind: "observed",
      observation: { value: { status: "committed", revision } },
    });
    epochNow += 1_100;
    if (terminalRead.observation.value.stepEvidence.step !== "commit_lane") {
      return;
    }
    const claim: Extract<
      SyncJournalRecord,
      { status: "committed" | "aborted" }
    > = {
      ...terminalRead.observation.value,
      stepEvidence: {
        ...terminalRead.observation.value.stepEvidence,
        attempt: {
          state: "attempting",
          claimId: alternateOperationId,
          generation: 1,
          claimedAtEpochMs: epochNow,
        },
      },
    };
    expect(
      await publication.replaceJournal(terminalRead.observation, claim),
    ).toEqual({ kind: "confirmed" });
    const claimed = await publication.readJournal(vaultId, operationId);
    expect(claimed.kind).toBe("observed");
    if (
      claimed.kind !== "observed" ||
      !isTerminalJournal(claimed.observation.value) ||
      claimed.observation.value.stepEvidence.step !== "commit_lane" ||
      claimed.observation.value.stepEvidence.attempt.state !== "attempting"
    ) {
      return;
    }
    if (
      claimed.observation.value.stepEvidence.precondition.kind !== "observed"
    ) {
      return;
    }
    const changedPrecondition: Extract<
      SyncJournalRecord,
      { status: "committed" | "aborted" }
    > = {
      ...claimed.observation.value,
      stepEvidence: {
        ...claimed.observation.value.stepEvidence,
        precondition: {
          ...claimed.observation.value.stepEvidence.precondition,
          etag: "a-refreshed-lane-etag",
        },
        retryAfterEpochMs: epochNow + 1_100,
        attempt: {
          state: "retry_wait",
          claimId: alternateOperationId,
          generation: 1,
          observedAtEpochMs: epochNow,
          retryAfterEpochMs: epochNow + 1_100,
        },
      },
    };
    epochNow += 1_100;
    expect(
      await publication.replaceJournal(
        claimed.observation,
        changedPrecondition,
      ),
    ).toEqual({ kind: "refused" });
  });

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
      schemaVersion: 2,
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
        attempt: { state: "ready", generation: 0 },
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

    const noEffect = await publication.replaceJournal(
      source.observation,
      allocated,
    );
    expect(noEffect).toMatchObject({
      kind: "effect_unknown",
      noEffectProvenance: "conditional_null",
    });
    if (
      noEffect.kind !== "effect_unknown" ||
      noEffect.retryAfterEpochMs === undefined
    ) {
      return;
    }
    bucket.unavailableAfterPut.delete(journalKey);
    const retryContext = { retryAfterEpochMs: noEffect.retryAfterEpochMs };
    const writesBeforeRetry = bucket.puts.filter(
      (put) => put.key === journalKey,
    ).length;
    expect(
      await publication.replaceJournal(
        source.observation,
        allocated,
        retryContext,
      ),
    ).toMatchObject({ kind: "throttled" });
    epochNow += 1_100;
    expect(
      await publication.replaceJournal(
        source.observation,
        allocated,
        retryContext,
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
      const pendingJournal = observed.observation.value;
      if (
        pendingJournal.status !== "pending" ||
        pendingJournal.allocationState !== "allocated" ||
        pendingJournal.stepEvidence.step === "commit_journal"
      ) {
        return;
      }
      epochNow += 1_100;
      const claim: SyncAllocatedPendingJournalRecord = {
        ...pendingJournal,
        stepEvidence: {
          ...pendingJournal.stepEvidence,
          attempt: {
            state: "attempting",
            claimId: operationId,
            generation: 1,
            claimedAtEpochMs: epochNow,
          },
        },
      };
      expect(
        await publication.replaceJournal(observed.observation, claim),
      ).toEqual({ kind: "confirmed" });
      const claimed = await publication.readJournal(
        vaultId,
        record.operationId,
      );
      expect(claimed.kind).toBe("observed");
      if (claimed.kind !== "observed") return;
      const claimedJournal = claimed.observation.value;
      if (
        claimedJournal.status !== "pending" ||
        claimedJournal.allocationState !== "allocated" ||
        claimedJournal.stepEvidence.step === "commit_journal"
      ) {
        return;
      }
      epochNow += 1_100;
      expect(
        await publication.replaceJournal(
          claimed.observation,
          nextJournalStep(claimedJournal, "changed"),
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

  it.each([
    { journalOperationId: operationId, status: "committed" },
    { journalOperationId: alternateOperationId, status: "aborted" },
  ] as const)(
    "allows only a monotonic retry-floor update on a $status lane-commit journal",
    async ({ journalOperationId, status }) => {
      await seedMarker();
      const phase = await journal(
        undefined,
        "commit_journal",
        journalOperationId,
      );
      await persistAllocatedJournal(phase);
      const pending = await publication.readJournal(
        vaultId,
        journalOperationId,
      );
      expect(pending.kind).toBe("observed");
      if (pending.kind !== "observed") return;
      epochNow += 1_100;
      const terminal = await settledJournal(phase, status);
      expect(
        await publication.replaceJournal(pending.observation, terminal),
      ).toEqual({ kind: "confirmed" });
      epochNow += 1_100;

      const committed = await publication.readJournal(
        vaultId,
        journalOperationId,
      );
      expect(committed.kind).toBe("observed");
      if (committed.kind !== "observed") return;
      if (!isTerminalJournal(committed.observation.value)) return;
      const retryAfterEpochMs = epochNow + 2_000;
      const raised = {
        ...committed.observation.value,
        stepEvidence: {
          ...committed.observation.value.stepEvidence,
          retryAfterEpochMs,
        },
      };
      expect(
        await publication.replaceJournal(committed.observation, raised),
      ).toEqual({ kind: "confirmed" });

      const freshPublication = syncR2Publication(
        syncR2ObjectStore(bucket, () => epochNow),
      );
      const persisted = await freshPublication.readJournal(
        vaultId,
        journalOperationId,
      );
      expect(persisted.kind).toBe("observed");
      if (persisted.kind !== "observed") return;
      if (!isTerminalJournal(persisted.observation.value)) return;
      expect(persisted.observation.value.stepEvidence.retryAfterEpochMs).toBe(
        retryAfterEpochMs,
      );
      const regressed = {
        ...persisted.observation.value,
        stepEvidence: {
          ...persisted.observation.value.stepEvidence,
          retryAfterEpochMs: retryAfterEpochMs - 1,
        },
      };
      epochNow += 1_100;
      expect(
        await freshPublication.replaceJournal(persisted.observation, regressed),
      ).toEqual({ kind: "refused" });
      const changedOutcome = {
        ...persisted.observation.value,
        committedAtEpochMs: persisted.observation.value.committedAtEpochMs + 1,
        stepEvidence: {
          ...persisted.observation.value.stepEvidence,
          retryAfterEpochMs: retryAfterEpochMs + 2_000,
        },
      };
      expect(
        await freshPublication.replaceJournal(
          persisted.observation,
          changedOutcome,
        ),
      ).toEqual({ kind: "refused" });
    },
  );

  it("resolves an uncertain terminal floor CAS across a fresh publication facade", async () => {
    await seedMarker();
    const phase = await journal(undefined, "commit_journal");
    await persistAllocatedJournal(phase);
    const pending = await publication.readJournal(vaultId, operationId);
    expect(pending.kind).toBe("observed");
    if (pending.kind !== "observed") return;
    epochNow += 1_100;
    const terminal = await settledJournal(phase, "committed");
    expect(
      await publication.replaceJournal(pending.observation, terminal),
    ).toEqual({ kind: "confirmed" });
    epochNow += 1_100;

    const committed = await publication.readJournal(vaultId, operationId);
    expect(committed.kind).toBe("observed");
    if (committed.kind !== "observed") return;
    if (!isTerminalJournal(committed.observation.value)) return;
    const raised = {
      ...committed.observation.value,
      stepEvidence: {
        ...committed.observation.value.stepEvidence,
        retryAfterEpochMs: epochNow + 2_000,
      },
    };
    bucket.failure = new Error("R2 response lost");
    bucket.failReadback = true;
    expect(
      await publication.replaceJournal(committed.observation, raised),
    ).toMatchObject({ kind: "effect_unknown" });
    bucket.failure = undefined;
    bucket.failReadback = false;
    epochNow += 1_100;

    const freshPublication = syncR2Publication(
      syncR2ObjectStore(bucket, () => epochNow),
    );
    const exactPrior = await freshPublication.readJournal(vaultId, operationId);
    expect(exactPrior.kind).toBe("observed");
    if (exactPrior.kind !== "observed") return;
    if (!isTerminalJournal(exactPrior.observation.value)) return;
    expect(exactPrior.observation.value.status).toBe("committed");
    expect(
      await freshPublication.replaceJournal(exactPrior.observation, raised),
    ).toEqual({ kind: "confirmed" });
    const settled = await freshPublication.readJournal(vaultId, operationId);
    expect(settled.kind).toBe("observed");
    if (settled.kind !== "observed") return;
    if (!isTerminalJournal(settled.observation.value)) return;
    expect(settled.observation.value.stepEvidence.retryAfterEpochMs).toBe(
      raised.stepEvidence.retryAfterEpochMs,
    );
  });

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
