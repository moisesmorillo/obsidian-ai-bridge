import type { SyncMutationPolicyErrorCode } from "@core/sync/sync-mutation-policy";
import type { SyncStore } from "@core/sync/sync-store.port";
import type {
  SyncMutationRequest,
  SyncMutationResult,
  SyncStoreFailure,
} from "@core/sync/sync-store.types";
import { encodeBase64Url } from "@obsidian-ai-bridge/core";
import {
  syncContentKey,
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
  syncDeviceIdSchema,
  syncEventSequenceSchema,
  syncNotePathSchema,
  syncOperationIdSchema,
  syncRevisionSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type {
  R2ConditionalBucketPort,
  R2ConditionalObjectMetadata,
  R2ConditionalPutOptions,
  R2ConditionalStoredObject,
} from "@worker/infrastructure/r2.types";
import {
  encodeSyncHeadRefusalReceipt,
  encodeSyncPublication,
} from "@worker/infrastructure/sync/sync-publication.codec";
import type {
  SyncAllocatedPendingJournalRecord,
  SyncFeedEventRecord,
  SyncJournalRecord,
  SyncLaneHeadRecord,
  SyncUnallocatedPendingJournalRecord,
} from "@worker/infrastructure/sync/sync-publication.types";
import { SYNC_R2_INVOCATION_CALL_LIMIT } from "@worker/infrastructure/sync/sync-r2.constants";
import type { SyncR2WriteResult } from "@worker/infrastructure/sync/sync-r2.types";
import { syncHeadRefusalReceiptKey } from "@worker/infrastructure/sync/sync-r2-key";
import {
  createSyncR2MutationInvocationFactory,
  syncR2Mutation,
} from "@worker/infrastructure/sync/sync-r2-mutation";
import {
  eventMatchesRequest,
  mutationRejection,
  recoveryForRequest,
  sameCurrentAndHead,
  sameTerminalOutcome,
  tombstoneVersionForRequest,
  validateMutationInput,
  versionForRequest,
  writeFailure,
} from "@worker/infrastructure/sync/sync-r2-mutation.helpers";
import type { SyncR2MutationInvocationCapabilities } from "@worker/infrastructure/sync/sync-r2-mutation.types";
import { syncR2ObjectStore } from "@worker/infrastructure/sync/sync-r2-object";
import type { SyncR2Publication } from "@worker/infrastructure/sync/sync-r2-publication";
import { syncR2Publication } from "@worker/infrastructure/sync/sync-r2-publication";
import { syncR2Records } from "@worker/infrastructure/sync/sync-r2-records";
import { encodeSyncRecord } from "@worker/infrastructure/sync/sync-record.codec";
import type {
  SyncBodyRecord,
  SyncHeadRecord,
  SyncRecoveryMetadata,
} from "@worker/infrastructure/sync/sync-record.types";
import { sha256Content } from "@worker/storage/storage-crypto";
import { describe, expect, it, vi } from "vitest";

const vaultId = syncVaultIdSchema.parse("11111111-1111-4111-8111-111111111111");
const path = syncNotePathSchema.parse("notes/exact.md");
const operationId = syncOperationIdSchema.parse(
  "22222222-2222-4222-8222-222222222222",
);
const updatedRevision = syncRevisionSchema.parse(
  "77777777-7777-4777-8777-777777777777",
);
const revision = syncRevisionSchema.parse(
  "44444444-4444-4444-8444-444444444444",
);
const tombstoneRevision = syncRevisionSchema.parse(
  "66666666-6666-4666-8666-666666666666",
);
const recoveryOperationId = syncOperationIdSchema.parse(
  "33333333-3333-4333-8333-333333333333",
);
const competingOperationId = syncOperationIdSchema.parse(
  "88888888-8888-4888-8888-888888888888",
);
const origin = syncDeviceIdSchema.parse("55555555-5555-4555-8555-555555555555");
const alternateOrigin = syncDeviceIdSchema.parse(
  "77777777-7777-4777-8777-777777777777",
);
const encoder = new TextEncoder();
const FIRST_EVENT_SEQUENCE = syncEventSequenceSchema.parse(
  "00000000000000000001",
);

class MemoryObject implements R2ConditionalStoredObject {
  readonly size: number;
  readonly customMetadata = {};

  constructor(
    readonly key: string,
    private readonly bytes: Uint8Array,
    readonly etag: string,
    readonly uploaded: Date,
  ) {
    this.size = bytes.byteLength;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.slice().buffer;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.bytes);
  }
}

type MemoryBucketPutPhase = "create" | "replace";

interface MemoryBucketPutHook {
  readonly key: string;
  readonly phase: MemoryBucketPutPhase;
  readonly beforePut: () => Promise<void>;
}

interface MemoryBucketPutAttempt {
  readonly key: string;
  readonly phase: MemoryBucketPutPhase;
  readonly bytes: Uint8Array;
  readonly etagMatches: string | undefined;
  readonly ifNoneMatch: string | undefined;
}

interface MemoryBucketAfterPutHook {
  readonly key: string;
  readonly phase: MemoryBucketPutPhase;
  readonly afterPut: () => Promise<void>;
}

interface MemoryBucketLostResponse {
  readonly key: string;
  readonly phase: MemoryBucketPutPhase;
  readonly unavailableReads: 0 | 1 | 2;
}

interface MemoryBucketGetBarrier {
  readonly key: string;
  readonly parties: number;
  arrivals: number;
  readonly released: Promise<void>;
  readonly release: () => void;
}

class MemoryBucket implements R2ConditionalBucketPort {
  readonly objects = new Map<string, MemoryObject>();
  readonly puts: string[] = [];
  readonly failedGets: string[] = [];
  readonly corruptedGets: string[] = [];
  readonly putAttempts: MemoryBucketPutAttempt[] = [];
  readonly appliedThenLostResponses: MemoryBucketPutAttempt[] = [];
  readonly gets: string[] = [];
  private etagSequence = 0;
  private nextGetHook:
    | { readonly key: string; readonly afterGet: () => void }
    | undefined;
  private nextPutHook: MemoryBucketPutHook | undefined;
  private nextAfterPutHook: MemoryBucketAfterPutHook | undefined;
  private nextLostResponse: MemoryBucketLostResponse | undefined;
  private nextGetBarrier: MemoryBucketGetBarrier | undefined;
  private unavailableGets = new Map<string, number>();
  private unavailableGetOrdinal: number | undefined;
  private corruptGetOrdinal: number | undefined;
  private losePutOrdinal: number | undefined;

  constructor(private readonly epochNow: () => number) {}

  beforeNextPut(
    key: string,
    phase: MemoryBucketPutPhase,
    beforePut: () => Promise<void>,
  ): void {
    this.nextPutHook = { key, phase, beforePut };
  }

  afterNextPut(
    key: string,
    phase: MemoryBucketPutPhase,
    afterPut: () => Promise<void>,
  ): void {
    this.nextAfterPutHook = { key, phase, afterPut };
  }

  applyThenLoseResponse(
    key: string,
    phase: MemoryBucketPutPhase,
    unavailableReads: 0 | 1 | 2 = 1,
  ): void {
    this.nextLostResponse = { key, phase, unavailableReads };
  }

  loseOnPutCall(ordinal: number): void {
    this.losePutOrdinal = ordinal;
  }

  barrierNextGets(key: string, parties: number): void {
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (release === undefined)
      throw new Error("GET barrier did not initialize.");
    this.nextGetBarrier = {
      key,
      parties,
      arrivals: 0,
      released,
      release,
    };
  }

  failNextGets(key: string, count: number): void {
    this.unavailableGets.set(key, count);
  }

  failOnGetCall(ordinal: number): void {
    this.unavailableGetOrdinal = ordinal;
  }

  corruptOnGetCall(ordinal: number): void {
    this.corruptGetOrdinal = ordinal;
  }

  afterNextGet(key: string, afterGet: () => void): void {
    this.nextGetHook = { key, afterGet };
  }

  async get(key: string): Promise<R2ConditionalStoredObject | null> {
    const barrier = this.nextGetBarrier;
    if (barrier?.key === key) {
      barrier.arrivals += 1;
      if (barrier.arrivals === barrier.parties) {
        this.nextGetBarrier = undefined;
        barrier.release();
      }
      await barrier.released;
    }
    this.gets.push(key);
    if (this.gets.length === this.unavailableGetOrdinal) {
      this.unavailableGetOrdinal = undefined;
      this.failNextGets(key, 1);
    }
    const failuresRemaining = this.unavailableGets.get(key) ?? 0;
    if (failuresRemaining > 0) {
      this.failedGets.push(key);
      if (failuresRemaining === 1) this.unavailableGets.delete(key);
      else this.unavailableGets.set(key, failuresRemaining - 1);
      throw new Error("Simulated unavailable exact read.");
    }
    const object = this.objects.get(key) ?? null;
    if (object !== null && this.gets.length === this.corruptGetOrdinal) {
      this.corruptGetOrdinal = undefined;
      this.corruptedGets.push(key);
      return new MemoryObject(
        key,
        encoder.encode("{corrupt"),
        object.etag,
        object.uploaded,
      );
    }
    if (this.nextGetHook?.key === key) {
      const hook = this.nextGetHook;
      this.nextGetHook = undefined;
      hook.afterGet();
    }
    return object;
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
    this.puts.push(key);
    const phase = options.onlyIf instanceof Headers ? "create" : "replace";
    const bytes =
      typeof content === "string" ? encoder.encode(content) : content.slice();
    const attempt: MemoryBucketPutAttempt = {
      key,
      phase,
      bytes,
      etagMatches:
        options.onlyIf instanceof Headers
          ? undefined
          : options.onlyIf.etagMatches,
      ifNoneMatch:
        options.onlyIf instanceof Headers
          ? (options.onlyIf.get("If-None-Match") ?? undefined)
          : undefined,
    };
    this.putAttempts.push(attempt);
    const loseResponse =
      this.putAttempts.length === this.losePutOrdinal
        ? { key, phase, unavailableReads: 1 as const }
        : this.nextLostResponse?.key === key &&
            this.nextLostResponse.phase === phase
          ? this.nextLostResponse
          : undefined;
    if (this.putAttempts.length === this.losePutOrdinal)
      this.losePutOrdinal = undefined;
    if (loseResponse !== undefined) this.nextLostResponse = undefined;
    if (this.nextPutHook?.key === key && this.nextPutHook.phase === phase) {
      const hook = this.nextPutHook;
      this.nextPutHook = undefined;
      await hook.beforePut();
    }
    const previous = this.objects.get(key);
    const accepted =
      options.onlyIf instanceof Headers
        ? previous === undefined && options.onlyIf.get("If-None-Match") === "*"
        : previous?.etag === options.onlyIf.etagMatches;
    if (!accepted) return null;
    const object = new MemoryObject(
      key,
      bytes,
      `etag-${++this.etagSequence}`,
      new Date(this.epochNow()),
    );
    this.objects.set(key, object);
    if (
      this.nextAfterPutHook?.key === key &&
      this.nextAfterPutHook.phase === phase
    ) {
      const hook = this.nextAfterPutHook;
      this.nextAfterPutHook = undefined;
      await hook.afterPut();
    }
    if (loseResponse !== undefined) {
      this.appliedThenLostResponses.push(attempt);
      this.failNextGets(key, loseResponse.unavailableReads);
      throw new Error("Simulated lost response after applying original PUT.");
    }
    return object;
  }

  seed(key: string, bytes: Uint8Array, uploadedAtEpochMs: number): void {
    this.objects.set(
      key,
      new MemoryObject(
        key,
        bytes,
        `etag-${++this.etagSequence}`,
        new Date(uploadedAtEpochMs),
      ),
    );
  }
}

async function setup() {
  let now = 20_000;
  const bucket = new MemoryBucket(() => now);
  const marker = {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
  };
  bucket.seed(
    syncVaultMarkerKey(vaultId),
    encoder.encode(JSON.stringify(marker)),
    now - 5_000,
  );
  const objects = syncR2ObjectStore(bucket, () => now);
  const records = syncR2Records(objects);
  const publication = syncR2Publication(objects);
  const lane = await syncFeedLaneForPath(path);
  return {
    bucket,
    lane,
    publication,
    records,
    now: () => now,
    setNow(value: number) {
      now = value;
    },
  };
}

function createStore(fixture: Awaited<ReturnType<typeof setup>>) {
  return syncR2Mutation(
    fixture.records,
    createSyncR2MutationInvocationFactory(fixture.bucket, fixture.now),
    fixture.now,
  );
}

function createMeasuredStore(fixture: Awaited<ReturnType<typeof setup>>) {
  const createInvocation = createSyncR2MutationInvocationFactory(
    fixture.bucket,
    fixture.now,
  );
  const invocations: SyncR2MutationInvocationCapabilities[] = [];
  const store = syncR2Mutation(
    fixture.records,
    () => {
      const invocation = createInvocation();
      invocations.push(invocation);
      return invocation;
    },
    fixture.now,
  );
  return { store, invocations };
}

function expectInvocationCallsToMatchBucket(
  fixture: Awaited<ReturnType<typeof setup>>,
  invocations: readonly SyncR2MutationInvocationCapabilities[],
  bucketCallsBefore: number,
): void {
  const actualBucketCalls =
    fixture.bucket.gets.length + fixture.bucket.puts.length - bucketCallsBefore;
  const budgetedCalls = invocations.reduce(
    (total, invocation) => total + invocation.callBudget.actualCalls,
    0,
  );
  expect(budgetedCalls).toBe(actualBucketCalls);
  expect(invocations.length).toBeGreaterThan(0);
  expect(
    invocations.every(
      ({ callBudget }) =>
        callBudget.actualCalls > 0 &&
        callBudget.actualCalls <= SYNC_R2_INVOCATION_CALL_LIMIT,
    ),
  ).toBe(true);
}

async function createMutationRequest(
  content: string,
): Promise<Extract<SyncMutationRequest, { readonly kind: "create" }>> {
  return {
    kind: "create",
    vaultId,
    path,
    operationId,
    revision,
    parent: { kind: "never_seen" },
    contentSha256: await sha256Content(content),
    content,
    mediaType: "text/markdown",
    origin,
  };
}

async function prepareCreateHeadRace(
  fixture: Awaited<ReturnType<typeof setup>>,
): Promise<{
  readonly request: Extract<SyncMutationRequest, { readonly kind: "create" }>;
  readonly competingHead: SyncHeadRecord;
}> {
  const content = "Valid competing create head";
  const bytes = encoder.encode(content);
  const competingHead: SyncHeadRecord = {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    kind: "live",
    path,
    revision: tombstoneRevision,
    parent: { kind: "never_seen" },
    contentSha256: await sha256Content(content),
    byteSize: bytes.byteLength,
    mediaType: "text/markdown",
    operationId: competingOperationId,
    origin: alternateOrigin,
  };
  const body: Extract<SyncBodyRecord, { readonly kind: "contentBody" }> = {
    kind: "contentBody",
    vaultId,
    revision: tombstoneRevision,
    bytes,
    byteSize: bytes.byteLength,
    contentSha256: competingHead.contentSha256,
  };
  expect(await fixture.records.createContent(body)).toEqual({
    kind: "confirmed",
  });
  expect(await fixture.records.createVersion(competingHead)).toEqual({
    kind: "confirmed",
  });
  return {
    request: await createMutationRequest("Requested create head"),
    competingHead,
  };
}

function unallocatedJournalForRequest(
  request: SyncMutationRequest,
  lane: number,
  precondition: SyncUnallocatedPendingJournalRecord["laneObservation"]["precondition"],
): SyncUnallocatedPendingJournalRecord {
  return {
    schemaVersion: 2,
    protocolMajor: 1,
    vaultId: request.vaultId,
    kind: "journal",
    status: "pending",
    operationId: request.operationId,
    request,
    payload:
      request.kind === "tombstone"
        ? null
        : { byteSize: encoder.encode(request.content).byteLength },
    allocationState: "unallocated",
    lane,
    laneObservation: {
      key: syncFeedLaneHeadKey(request.vaultId, lane),
      precondition,
      retryAfterEpochMs: null,
    },
  };
}

async function seedEmptyLaneHead(
  fixture: Awaited<ReturnType<typeof setup>>,
): Promise<void> {
  const initial: SyncLaneHeadRecord = {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    kind: "laneHead",
    lane: fixture.lane,
    committedSequence: syncSequenceSchema.parse("0".repeat(20)),
    committedAtEpochMs: 0,
  };
  expect(await fixture.publication.createLaneHead(initial)).toEqual({
    kind: "confirmed",
  });
  fixture.setNow(fixture.now() + 1_100);
}

async function seedCreateEventStep(
  fixture: Awaited<ReturnType<typeof setup>>,
  request: Extract<SyncMutationRequest, { readonly kind: "create" }>,
  committedAtEpochMs = fixture.now(),
): Promise<void> {
  await seedLiveHead(fixture, request.content);
  const sequence = FIRST_EVENT_SEQUENCE;
  const laneHead: SyncLaneHeadRecord = {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId: request.vaultId,
    kind: "laneHead",
    lane: fixture.lane,
    committedSequence: syncSequenceSchema.parse("0".repeat(20)),
    committedAtEpochMs: 0,
    pending: { operationId: request.operationId, nextSequence: sequence },
  };
  fixture.bucket.seed(
    syncFeedLaneHeadKey(request.vaultId, fixture.lane),
    encoder.encode(JSON.stringify(laneHead)),
    fixture.now() - 5_000,
  );
  const journal: SyncAllocatedPendingJournalRecord = {
    schemaVersion: 2,
    protocolMajor: 1,
    vaultId: request.vaultId,
    kind: "journal",
    status: "pending",
    operationId: request.operationId,
    request,
    payload: { byteSize: encoder.encode(request.content).byteLength },
    allocationState: "allocated",
    reservation: {
      lane: fixture.lane,
      sequence,
      previousCommittedAtEpochMs: 0,
    },
    stepEvidence: {
      step: "create_event",
      key: syncFeedEventKey(request.vaultId, fixture.lane, sequence),
      committedAtEpochMs,
      outcomeIntent: "changed",
      precondition: { kind: "absent" },
      retryAfterEpochMs: null,
      attempt: { state: "ready", generation: 0 },
    },
  };
  fixture.bucket.seed(
    syncOperationKey(request.vaultId, request.operationId),
    await encodeSyncPublication(journal),
    fixture.now() - 5_000,
  );
}

async function seedLiveHead(
  fixture: Awaited<ReturnType<typeof setup>>,
  content: string,
): Promise<void> {
  const contentSha256 = await sha256Content(content);
  const bytes = encoder.encode(content);
  const body: Extract<SyncBodyRecord, { readonly kind: "contentBody" }> = {
    kind: "contentBody",
    vaultId,
    revision,
    bytes,
    byteSize: bytes.byteLength,
    contentSha256,
  };
  const version: SyncHeadRecord = {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    kind: "live",
    path,
    revision,
    parent: { kind: "never_seen" },
    contentSha256,
    byteSize: bytes.byteLength,
    mediaType: "text/markdown",
    operationId,
    origin,
  };
  expect(await fixture.records.createContent(body)).toEqual({
    kind: "confirmed",
  });
  expect(await fixture.records.createVersion(version)).toEqual({
    kind: "confirmed",
  });
  expect(await fixture.records.createHead(version)).toEqual({
    kind: "confirmed",
  });
}

async function seedTombstone(
  fixture: Awaited<ReturnType<typeof setup>>,
  content: string,
): Promise<void> {
  await seedLiveHead(fixture, content);
  const contentSha256 = await sha256Content(content);
  const bytes = encoder.encode(content);
  const recoveryBody: Extract<
    SyncBodyRecord,
    { readonly kind: "recoveryBody" }
  > = {
    kind: "recoveryBody",
    vaultId,
    operationId: recoveryOperationId,
    bytes,
    byteSize: bytes.byteLength,
    contentSha256,
  };
  const recovery: SyncRecoveryMetadata = {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    path,
    operationId: recoveryOperationId,
    sourceRevision: revision,
    contentSha256,
    byteSize: bytes.byteLength,
    mediaType: "text/markdown",
    origin,
  };
  const tombstone: SyncHeadRecord = {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    kind: "tombstone",
    path,
    revision: tombstoneRevision,
    parent: { kind: "revision", revision },
    contentSha256,
    byteSize: bytes.byteLength,
    mediaType: "text/markdown",
    operationId: recoveryOperationId,
    origin,
  };
  expect(await fixture.records.createRecoveryBody(recoveryBody)).toEqual({
    kind: "confirmed",
  });
  expect(await fixture.records.createRecovery(recovery)).toEqual({
    kind: "confirmed",
  });
  expect(await fixture.records.createVersion(tombstone)).toEqual({
    kind: "confirmed",
  });
  fixture.setNow(fixture.now() + 1_100);
  const current = await fixture.records.readHead(vaultId, path);
  expect(current.kind).toBe("observed");
  if (current.kind !== "observed") return;
  expect(
    await fixture.records.replaceHead(current.observation, tombstone),
  ).toEqual({
    kind: "confirmed",
  });
}

async function prepareCurrentHeadCasScenario(
  fixture: Awaited<ReturnType<typeof setup>>,
): Promise<{
  readonly request: Extract<SyncMutationRequest, { readonly kind: "update" }>;
  readonly competingHead: SyncHeadRecord;
  readonly competingEvent: SyncFeedEventRecord;
}> {
  await seedLiveHead(fixture, "Original exact parent");
  const competingContent = "Concurrent current head";
  const competingBytes = encoder.encode(competingContent);
  const competingHead: SyncHeadRecord = {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    kind: "live",
    path,
    revision: tombstoneRevision,
    parent: { kind: "revision", revision },
    contentSha256: await sha256Content(competingContent),
    byteSize: competingBytes.byteLength,
    mediaType: "text/markdown",
    operationId: competingOperationId,
    origin: alternateOrigin,
  };
  const competingBody: Extract<
    SyncBodyRecord,
    { readonly kind: "contentBody" }
  > = {
    kind: "contentBody",
    vaultId,
    revision: tombstoneRevision,
    bytes: competingBytes,
    byteSize: competingBytes.byteLength,
    contentSha256: competingHead.contentSha256,
  };
  expect(await fixture.records.createContent(competingBody)).toEqual({
    kind: "confirmed",
  });
  expect(await fixture.records.createVersion(competingHead)).toEqual({
    kind: "confirmed",
  });
  const requestedContent = "Requested update";
  return {
    request: {
      kind: "update",
      vaultId,
      path,
      operationId: recoveryOperationId,
      revision: updatedRevision,
      parent: { kind: "revision", revision },
      contentSha256: await sha256Content(requestedContent),
      content: requestedContent,
      mediaType: "text/markdown",
      origin,
    },
    competingHead,
    competingEvent: {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      kind: "changed",
      lane: fixture.lane,
      sequence: syncEventSequenceSchema.parse("00000000000000000001"),
      path,
      result: { kind: "live", revision: tombstoneRevision },
      operationId: competingOperationId,
      origin: alternateOrigin,
      committedAtEpochMs: 1,
    },
  };
}

function retryWaitAfterHeadClaim(
  journal: SyncAllocatedPendingJournalRecord,
  observedAtEpochMs: number,
): SyncAllocatedPendingJournalRecord {
  if (
    journal.status !== "pending" ||
    journal.stepEvidence.step !== "write_head" ||
    journal.stepEvidence.attempt.state !== "attempting"
  ) {
    throw new Error("Only an attempting head claim can enter retry_wait.");
  }
  const retryAfterEpochMs = observedAtEpochMs + 1_100;
  return {
    ...journal,
    stepEvidence: {
      ...journal.stepEvidence,
      retryAfterEpochMs,
      attempt: {
        state: "retry_wait",
        claimId: journal.stepEvidence.attempt.claimId,
        generation: journal.stepEvidence.attempt.generation,
        observedAtEpochMs,
        retryAfterEpochMs,
      },
    },
  };
}

function hasVersionRead(
  store: object,
): store is Pick<SyncStore, "readVersion"> {
  return "readVersion" in store && typeof store.readVersion === "function";
}

function hasRecoveryRead(
  store: object,
): store is Pick<SyncStore, "readRecovery"> {
  return "readRecovery" in store && typeof store.readRecovery === "function";
}

function hasMutation(
  store: object,
): store is Pick<SyncStore, "mutate" | "resumeOperation"> {
  return (
    "mutate" in store &&
    typeof store.mutate === "function" &&
    "resumeOperation" in store &&
    typeof store.resumeOperation === "function"
  );
}

async function settleMutation(
  store: Pick<SyncStore, "mutate" | "resumeOperation">,
  fixture: Awaited<ReturnType<typeof setup>>,
  request: SyncMutationRequest,
): Promise<SyncMutationResult> {
  let result = await store.mutate(request);
  let retries = 0;
  while (
    result.kind === "error" &&
    (result.code === "operation_pending" || result.code === "effect_unknown") &&
    retries < 80
  ) {
    const retryAfter =
      "retryAfterEpochMs" in result ? result.retryAfterEpochMs : undefined;
    fixture.setNow(Math.max(fixture.now() + 1_100, retryAfter ?? 0));
    result = await store.resumeOperation({
      vaultId: request.vaultId,
      operationId: request.operationId,
    });
    retries += 1;
  }
  return result;
}

async function settleResume(
  store: Pick<SyncStore, "resumeOperation">,
  fixture: Awaited<ReturnType<typeof setup>>,
  request: SyncMutationRequest,
): Promise<SyncMutationResult> {
  let result = await store.resumeOperation({
    vaultId: request.vaultId,
    operationId: request.operationId,
  });
  let retries = 0;
  while (
    result.kind === "error" &&
    (result.code === "operation_pending" || result.code === "effect_unknown") &&
    retries < 80
  ) {
    const retryAfter =
      "retryAfterEpochMs" in result ? result.retryAfterEpochMs : undefined;
    fixture.setNow(Math.max(fixture.now() + 1_100, retryAfter ?? 0));
    result = await store.resumeOperation({
      vaultId: request.vaultId,
      operationId: request.operationId,
    });
    retries += 1;
  }
  return result;
}

async function persistStaleParentShortcut(
  fixture: Awaited<ReturnType<typeof setup>>,
  request: SyncMutationRequest,
): Promise<SyncAllocatedPendingJournalRecord> {
  let result = await createStore(fixture).mutate(request);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const journal = await fixture.publication.readJournal(
      request.vaultId,
      request.operationId,
    );
    if (
      journal.kind === "observed" &&
      journal.observation.value.status === "pending" &&
      journal.observation.value.allocationState === "allocated" &&
      journal.observation.value.stepEvidence.step === "create_event" &&
      journal.observation.value.stepEvidence.attempt.state === "ready"
    ) {
      return journal.observation.value;
    }
    const retryAfter =
      result.kind === "error" && "retryAfterEpochMs" in result
        ? result.retryAfterEpochMs
        : 0;
    fixture.setNow(Math.max(fixture.now() + 1_100, retryAfter));
    result = await createStore(fixture).resumeOperation({
      vaultId: request.vaultId,
      operationId: request.operationId,
    });
  }
  throw new Error(
    "Stale parent did not persist an unclaimed abort-event step.",
  );
}

async function advanceHeadWriteCooldown(
  fixture: Awaited<ReturnType<typeof setup>>,
  request: SyncMutationRequest,
): Promise<void> {
  const journal = await fixture.publication.readJournal(
    request.vaultId,
    request.operationId,
  );
  if (
    journal.kind !== "observed" ||
    journal.observation.value.status !== "pending" ||
    journal.observation.value.allocationState !== "allocated" ||
    journal.observation.value.stepEvidence.step !== "write_head"
  ) {
    throw new Error("Mutation must be at its allocated head-write step.");
  }
  const evidence = journal.observation.value.stepEvidence;
  const preconditionFloor =
    evidence.precondition.kind === "observed"
      ? evidence.precondition.uploadedAtEpochMs + 1_100
      : 0;
  fixture.setNow(
    Math.max(
      fixture.now(),
      journal.observation.observed.uploaded.getTime() + 1_100,
      preconditionFloor,
      evidence.retryAfterEpochMs ?? 0,
    ),
  );
}

async function advanceToHeadWrite(
  store: Pick<SyncStore, "mutate" | "resumeOperation">,
  fixture: Awaited<ReturnType<typeof setup>>,
  request: SyncMutationRequest,
): Promise<SyncMutationResult> {
  let result = await store.mutate(request);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const journal = await fixture.publication.readJournal(
      request.vaultId,
      request.operationId,
    );
    if (
      journal.kind === "observed" &&
      journal.observation.value.status === "pending" &&
      journal.observation.value.allocationState === "allocated" &&
      journal.observation.value.stepEvidence.step === "write_head"
    ) {
      return result;
    }
    const retryAfter =
      result.kind === "error" && "retryAfterEpochMs" in result
        ? result.retryAfterEpochMs
        : 0;
    fixture.setNow(Math.max(fixture.now() + 1_100, retryAfter));
    result = await store.resumeOperation({
      vaultId: request.vaultId,
      operationId: request.operationId,
    });
  }
  throw new Error(
    "Mutation did not reach its persisted exact head-write phase.",
  );
}

async function advanceToJournalCommit(
  store: Pick<SyncStore, "mutate" | "resumeOperation">,
  fixture: Awaited<ReturnType<typeof setup>>,
  request: SyncMutationRequest,
): Promise<void> {
  let result = await store.mutate(request);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const journal = await fixture.publication.readJournal(
      request.vaultId,
      request.operationId,
    );
    if (
      journal.kind === "observed" &&
      journal.observation.value.status === "pending" &&
      journal.observation.value.allocationState === "allocated" &&
      journal.observation.value.stepEvidence.step === "commit_journal"
    ) {
      return;
    }
    const retryAfter =
      result.kind === "error" && "retryAfterEpochMs" in result
        ? result.retryAfterEpochMs
        : 0;
    fixture.setNow(Math.max(fixture.now() + 1_100, retryAfter));
    result = await store.resumeOperation({
      vaultId: request.vaultId,
      operationId: request.operationId,
    });
  }
  throw new Error("Mutation did not reach its persisted journal-commit phase.");
}

async function advanceToTerminalLaneCommit(
  store: Pick<SyncStore, "mutate" | "resumeOperation">,
  fixture: Awaited<ReturnType<typeof setup>>,
  request: SyncMutationRequest,
): Promise<void> {
  let result = await store.mutate(request);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const journal = await fixture.publication.readJournal(
      request.vaultId,
      request.operationId,
    );
    if (
      journal.kind === "observed" &&
      journal.observation.value.status !== "pending" &&
      journal.observation.value.stepEvidence.step === "commit_lane"
    ) {
      return;
    }
    const retryAfter =
      result.kind === "error" && "retryAfterEpochMs" in result
        ? result.retryAfterEpochMs
        : 0;
    fixture.setNow(Math.max(fixture.now() + 1_100, retryAfter));
    result = await store.resumeOperation({
      vaultId: request.vaultId,
      operationId: request.operationId,
    });
  }
  throw new Error("Mutation did not reach its persisted terminal lane phase.");
}

async function resumeUntil(
  store: Pick<SyncStore, "mutate" | "resumeOperation">,
  fixture: Awaited<ReturnType<typeof setup>>,
  request: SyncMutationRequest,
  reachedBoundary: () => boolean,
): Promise<SyncMutationResult> {
  let result = await store.mutate(request);
  for (let attempt = 0; attempt < 40 && !reachedBoundary(); attempt += 1) {
    const retryAfter =
      result.kind === "error" && "retryAfterEpochMs" in result
        ? result.retryAfterEpochMs
        : 0;
    fixture.setNow(Math.max(fixture.now() + 1_100, retryAfter));
    result = await store.resumeOperation({
      vaultId: request.vaultId,
      operationId: request.operationId,
    });
  }
  if (!reachedBoundary()) {
    throw new Error("Mutation did not reach its injected storage boundary.");
  }
  return result;
}

async function advanceToWriteStep(
  store: Pick<SyncStore, "mutate" | "resumeOperation">,
  fixture: Awaited<ReturnType<typeof setup>>,
  request: SyncMutationRequest,
  step: "immutable_create" | "create_event",
): Promise<void> {
  let result = await store.mutate(request);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const journal = await fixture.publication.readJournal(
      request.vaultId,
      request.operationId,
    );
    if (
      journal.kind === "observed" &&
      journal.observation.value.status === "pending" &&
      journal.observation.value.allocationState === "allocated" &&
      journal.observation.value.stepEvidence.step === step
    ) {
      return;
    }
    const retryAfter =
      result.kind === "error" && "retryAfterEpochMs" in result
        ? result.retryAfterEpochMs
        : 0;
    fixture.setNow(Math.max(fixture.now() + 1_100, retryAfter));
    result = await store.resumeOperation({
      vaultId: request.vaultId,
      operationId: request.operationId,
    });
  }
  throw new Error(`Mutation did not reach its persisted ${step} phase.`);
}

describe("recoverable R2 sync mutations and exact reads", () => {
  it.each([
    "before_wait_cas",
    "during_wait_cas",
    "after_claim_cas",
    "after_claim_target_read",
    "unsafe_after_claim_cas",
    "late_event_commit",
  ] as const)(
    "does not reduce a locally known response floor when %s observes a peer's lower retry state",
    async (boundary) => {
      const fixture = await setup();
      const request = await createMutationRequest(
        `Known response floor ${boundary}`,
      );
      if (boundary === "late_event_commit")
        await seedCreateEventStep(fixture, request);
      else
        await advanceToWriteStep(
          createStore(fixture),
          fixture,
          request,
          "immutable_create",
        );
      fixture.setNow(fixture.now() + 1_100);
      const initialEpoch = fixture.now();
      const lateEpoch = initialEpoch + 10_000;
      const expectedFloor = lateEpoch + 1_100;
      const peerClock = () => initialEpoch + 1_100;
      const peer = syncR2Mutation(
        fixture.records,
        createSyncR2MutationInvocationFactory(fixture.bucket, peerClock),
        peerClock,
      );
      const journalKey = syncOperationKey(vaultId, operationId);
      const eventKey = syncFeedEventKey(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      );
      const targetKey =
        boundary === "late_event_commit"
          ? eventKey
          : syncContentKey(vaultId, revision);
      let raced = false;
      let claimResponseKnown = false;
      const racePeer = async () => {
        raced = true;
        fixture.setNow(lateEpoch);
        expect(
          await peer.resumeOperation({ vaultId, operationId }),
        ).toMatchObject({
          kind: "error",
          code: "operation_pending",
          operationId,
        });
      };
      const claimBoundary =
        boundary === "after_claim_cas" ||
        boundary === "after_claim_target_read" ||
        boundary === "unsafe_after_claim_cas";
      if (claimBoundary) {
        fixture.bucket.applyThenLoseResponse(journalKey, "replace", 1);
        fixture.bucket.afterNextPut(journalKey, "replace", async () =>
          fixture.setNow(
            boundary === "unsafe_after_claim_cas" ? Number.NaN : lateEpoch,
          ),
        );
      } else
        fixture.bucket.beforeNextPut(targetKey, "create", async () => {
          fixture.setNow(lateEpoch);
          throw new Error("Target response unavailable after delay");
        });
      const createInvocation = createSyncR2MutationInvocationFactory(
        fixture.bucket,
        fixture.now,
      );
      const store = syncR2Mutation(
        fixture.records,
        () => {
          const invocation = createInvocation();
          const records = invocation.records;
          const publication = invocation.publication;
          return {
            ...invocation,
            records: {
              ...records,
              readContentBody: async (vault, bodyRevision) => {
                const read = await records.readContentBody(vault, bodyRevision);
                if (
                  !raced &&
                  read.kind === "absent" &&
                  ((boundary === "before_wait_cas" &&
                    fixture.bucket.putAttempts.some(
                      ({ key }) => key === targetKey,
                    )) ||
                    (boundary === "after_claim_target_read" &&
                      claimResponseKnown))
                )
                  await racePeer();
                return read;
              },
            },
            publication: {
              ...publication,
              replaceJournal: async (observed, next, retryContext) => {
                if (
                  boundary === "during_wait_cas" &&
                  !raced &&
                  next.allocationState === "allocated" &&
                  next.stepEvidence.step === "immutable_create" &&
                  next.stepEvidence.attempt.state === "retry_wait"
                )
                  await racePeer();
                const result = await publication.replaceJournal(
                  observed,
                  next,
                  retryContext,
                );
                if (
                  claimBoundary &&
                  !raced &&
                  next.allocationState === "allocated" &&
                  next.stepEvidence.step === "immutable_create" &&
                  next.stepEvidence.attempt.state === "attempting" &&
                  result.kind === "effect_unknown"
                ) {
                  claimResponseKnown = true;
                  if (boundary !== "after_claim_target_read") await racePeer();
                }
                return result;
              },
              readEvent: async (vault, lane, sequence) => {
                const read = await publication.readEvent(vault, lane, sequence);
                if (
                  boundary === "late_event_commit" &&
                  !raced &&
                  read.kind === "absent"
                ) {
                  const sent = fixture.bucket.putAttempts.find(
                    ({ key }) => key === eventKey,
                  );
                  if (sent !== undefined) {
                    fixture.bucket.seed(eventKey, sent.bytes, lateEpoch);
                    await racePeer();
                  }
                }
                return read;
              },
            },
          };
        },
        fixture.now,
      );
      const response = await store.resumeOperation({ vaultId, operationId });
      expect(raced).toBe(true);
      expect(response).toEqual(
        boundary === "unsafe_after_claim_cas"
          ? { kind: "error", code: "effect_unknown", operationId }
          : {
              kind: "error",
              code: "operation_pending",
              operationId,
              retryAfterEpochMs: expectedFloor,
            },
      );
      const observed = await fixture.publication.readJournal(
        vaultId,
        operationId,
      );
      expect(observed).toMatchObject({
        kind: "observed",
        observation: {
          value: {
            status: "pending",
            stepEvidence:
              boundary === "late_event_commit"
                ? { step: "commit_journal" }
                : {
                    step: "immutable_create",
                    retryAfterEpochMs: initialEpoch + 2_200,
                    attempt: { state: "retry_wait" },
                  },
          },
        },
      });
      if (boundary !== "late_event_commit")
        expect(fixture.bucket.objects.has(targetKey)).toBe(false);
      const puts = fixture.bucket.putAttempts.length;
      fixture.setNow(expectedFloor - 1);
      expect(
        await createStore(fixture).resumeOperation({ vaultId, operationId }),
      ).toMatchObject({
        kind: "error",
        code: "operation_pending",
        operationId,
        retryAfterEpochMs: expectedFloor,
      });
      expect(fixture.bucket.putAttempts).toHaveLength(puts);
      fixture.setNow(expectedFloor);
      expect(
        await settleResume(createStore(fixture), fixture, request),
      ).toMatchObject({ kind: "committed", operationId, revision });
    },
  );

  it.each([
    ["reservation", "throttled", "response"],
    ["reservation", "effect_unknown", "response"],
    ["terminal", "throttled", "response"],
    ["terminal", "effect_unknown", "response"],
    ["terminal", "effect_unknown", "observation"],
  ] as const)(
    "does not use an unsafe %s lane %s %s floor as a retry deadline or floor-CAS authority",
    async (phase, kind, source) => {
      const fixture = await setup();
      const request = await createMutationRequest(
        `Unsafe lane floor ${phase} ${kind}`,
      );
      if (phase === "terminal")
        await advanceToTerminalLaneCommit(
          createStore(fixture),
          fixture,
          request,
        );
      else {
        expect(
          await fixture.publication.createLaneHead({
            kind: "laneHead",
            schemaVersion: 1,
            protocolMajor: 1,
            vaultId,
            lane: fixture.lane,
            committedSequence: syncSequenceSchema.parse("00000000000000000000"),
            committedAtEpochMs: 0,
          }),
        ).toEqual({ kind: "confirmed" });
        const lane = await fixture.publication.readLaneHead(
          vaultId,
          fixture.lane,
        );
        if (lane.kind !== "observed")
          throw new Error("Expected initial lane generation");
        expect(
          await fixture.publication.createJournal(
            unallocatedJournalForRequest(request, fixture.lane, {
              kind: "observed",
              etag: lane.observation.observed.etag,
              uploadedAtEpochMs: lane.observation.observed.uploaded.getTime(),
              bytes: encodeBase64Url(lane.observation.observed.bytes),
            }),
          ),
        ).toEqual({ kind: "confirmed" });
      }
      fixture.setNow(fixture.now() + 2_200);
      const epoch = fixture.now();
      let before = await fixture.publication.readJournal(vaultId, operationId);
      const journalKey = syncOperationKey(vaultId, operationId);
      const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
      let journalPuts = fixture.bucket.putAttempts.filter(
        ({ key }) => key === journalKey,
      ).length;
      let attempted = false;
      let restored = false;
      fixture.bucket.beforeNextPut(laneKey, "replace", async () => {
        before = await fixture.publication.readJournal(vaultId, operationId);
        journalPuts = fixture.bucket.putAttempts.filter(
          ({ key }) => key === journalKey,
        ).length;
        attempted = true;
        fixture.setNow(source === "response" ? -1_101 : epoch);
        throw new Error(
          kind === "throttled"
            ? "R2 rate limit 429"
            : "Uncertain lane PUT response",
        );
      });
      const createInvocation = createSyncR2MutationInvocationFactory(
        fixture.bucket,
        fixture.now,
      );
      const store = syncR2Mutation(
        fixture.records,
        () => {
          const invocation = createInvocation();
          const publication = invocation.publication;
          return {
            ...invocation,
            publication: {
              ...publication,
              readLaneHead: async (vault, lane) => {
                const read = await publication.readLaneHead(vault, lane);
                if (attempted && !restored) {
                  restored = true;
                  fixture.setNow(
                    source === "response" ? epoch + 2_200 : -1_101,
                  );
                }
                return read;
              },
            },
          };
        },
        fixture.now,
      );
      expect(await store.resumeOperation({ vaultId, operationId })).toEqual({
        kind: "error",
        code: "effect_unknown",
        operationId,
      });
      expect(attempted).toBe(true);
      expect(restored).toBe(true);
      fixture.setNow(epoch + 2_200);
      expect(
        fixture.bucket.putAttempts.filter(({ key }) => key === journalKey),
      ).toHaveLength(journalPuts);
      expect(
        await fixture.publication.readJournal(vaultId, operationId),
      ).toEqual(before);
      expect(
        await settleResume(createStore(fixture), fixture, request),
      ).toMatchObject({ kind: "committed", operationId, revision });
    },
  );

  it.each(["throttled", "effect_unknown"] as const)(
    "does not CAS a retry journal when a negative %s floor is followed by a restored valid observation clock",
    async (kind) => {
      const fixture = await setup();
      const request = await createMutationRequest(
        `Negative response floor ${kind}`,
      );
      await advanceToWriteStep(
        createStore(fixture),
        fixture,
        request,
        "immutable_create",
      );
      fixture.setNow(fixture.now() + 1_100);
      const claimEpoch = fixture.now();
      const bodyKey = syncContentKey(vaultId, revision);
      const journalKey = syncOperationKey(vaultId, operationId);
      fixture.bucket.beforeNextPut(bodyKey, "create", async () => {
        fixture.setNow(-1_101);
        throw new Error(
          kind === "throttled" ? "R2 rate limit 429" : "Uncertain R2 response",
        );
      });
      let restored = false;
      const createInvocation = createSyncR2MutationInvocationFactory(
        fixture.bucket,
        fixture.now,
      );
      const store = syncR2Mutation(
        fixture.records,
        () => {
          const invocation = createInvocation();
          const records = invocation.records;
          return {
            ...invocation,
            records: {
              ...records,
              readContentBody: async (vault, bodyRevision) => {
                const read = await records.readContentBody(vault, bodyRevision);
                if (
                  !restored &&
                  read.kind === "absent" &&
                  fixture.bucket.putAttempts.some(({ key }) => key === bodyKey)
                ) {
                  restored = true;
                  fixture.setNow(claimEpoch + 2_200);
                }
                return read;
              },
            },
          };
        },
        fixture.now,
      );
      const journalPuts = fixture.bucket.putAttempts.filter(
        ({ key }) => key === journalKey,
      ).length;
      expect(await store.resumeOperation({ vaultId, operationId })).toEqual({
        kind: "error",
        code: "effect_unknown",
        operationId,
      });
      expect(restored).toBe(true);
      expect(
        fixture.bucket.putAttempts.filter(({ key }) => key === journalKey),
      ).toHaveLength(journalPuts + 1);
      expect(
        await fixture.publication.readJournal(vaultId, operationId),
      ).toMatchObject({
        kind: "observed",
        observation: {
          value: {
            stepEvidence: {
              step: "immutable_create",
              retryAfterEpochMs: null,
              attempt: {
                state: "attempting",
                generation: 1,
                claimedAtEpochMs: claimEpoch,
              },
            },
            request,
          },
        },
      });
      expect(fixture.bucket.objects.has(bodyKey)).toBe(false);
      expect(
        await settleResume(createStore(fixture), fixture, request),
      ).toMatchObject({ kind: "committed", operationId, revision });
      expect(
        fixture.bucket.putAttempts.filter(({ key }) => key === bodyKey),
      ).toHaveLength(2);
    },
  );

  it.each(["journal_read", "unsafe_clock"] as const)(
    "leaves the original target claim unresolved when retry-wait reconciliation loses %s after a failed PUT",
    async (failure) => {
      const fixture = await setup();
      const request = await createMutationRequest(
        `Retry wait reconciliation ${failure}`,
      );
      await advanceToWriteStep(
        createStore(fixture),
        fixture,
        request,
        "immutable_create",
      );
      fixture.setNow(fixture.now() + 1_100);
      const claimEpoch = fixture.now();
      const bodyKey = syncContentKey(vaultId, revision);
      fixture.bucket.beforeNextPut(bodyKey, "create", async () => {
        if (failure === "unsafe_clock") fixture.setNow(Number.NaN);
        throw new Error("Uncertain immutable target response");
      });
      let armed = false;
      const createInvocation = createSyncR2MutationInvocationFactory(
        fixture.bucket,
        fixture.now,
      );
      const store = syncR2Mutation(
        fixture.records,
        () => {
          const invocation = createInvocation();
          const records = invocation.records;
          return {
            ...invocation,
            records: {
              ...records,
              readContentBody: async (vault, bodyRevision) => {
                const read = await records.readContentBody(vault, bodyRevision);
                if (
                  !armed &&
                  read.kind === "absent" &&
                  fixture.bucket.putAttempts.some(({ key }) => key === bodyKey)
                ) {
                  armed = true;
                  if (failure === "journal_read")
                    fixture.bucket.failNextGets(
                      syncOperationKey(vaultId, operationId),
                      1,
                    );
                }
                return read;
              },
            },
          };
        },
        fixture.now,
      );
      expect(await store.resumeOperation({ vaultId, operationId })).toEqual(
        failure === "journal_read"
          ? {
              kind: "error",
              code: "effect_unknown",
              operationId,
              retryAfterEpochMs: claimEpoch + 1_100,
            }
          : { kind: "error", code: "effect_unknown", operationId },
      );
      expect(armed).toBe(true);
      fixture.setNow(claimEpoch + 1_100);
      expect(
        await fixture.publication.readJournal(vaultId, operationId),
      ).toMatchObject({
        kind: "observed",
        observation: {
          value: {
            stepEvidence: {
              step: "immutable_create",
              retryAfterEpochMs: null,
              attempt: {
                state: "attempting",
                generation: 1,
                claimedAtEpochMs: claimEpoch,
              },
            },
            request,
          },
        },
      });
      expect(fixture.bucket.objects.has(bodyKey)).toBe(false);
      expect(
        fixture.bucket.putAttempts.filter(({ key }) => key === bodyKey),
      ).toHaveLength(1);
      expect(
        await settleResume(createStore(fixture), fixture, request),
      ).toMatchObject({ kind: "committed", operationId, revision });
      expect(
        fixture.bucket.putAttempts.filter(({ key }) => key === bodyKey),
      ).toHaveLength(2);
    },
  );

  it("cannot advance the journal after an acknowledged event PUT when expected-event digest capability fails during read-back", async () => {
    const fixture = await setup();
    const request = await createMutationRequest(
      "Event read-back expected digest",
    );
    await seedCreateEventStep(fixture, request);
    fixture.setNow(fixture.now() + 1_100);
    const createInvocation = createSyncR2MutationInvocationFactory(
      fixture.bucket,
      fixture.now,
    );
    const digest = vi.spyOn(crypto.subtle, "digest");
    let armed = false;
    const store = syncR2Mutation(
      fixture.records,
      () => {
        const invocation = createInvocation();
        const publication = invocation.publication;
        return {
          ...invocation,
          publication: {
            ...publication,
            readEvent: async (vault, lane, sequence) => {
              const read = await publication.readEvent(vault, lane, sequence);
              if (!armed && read.kind === "observed") {
                armed = true;
                digest.mockRejectedValueOnce(
                  new Error("Expected event digest unavailable"),
                );
              }
              return read;
            },
          },
        };
      },
      fixture.now,
    );
    try {
      expect(await store.resumeOperation({ vaultId, operationId })).toEqual({
        kind: "error",
        code: "effect_unknown",
        operationId,
      });
      expect(armed).toBe(true);
    } finally {
      digest.mockRestore();
    }
    expect(
      await fixture.publication.readJournal(vaultId, operationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          stepEvidence: {
            step: "create_event",
            outcomeIntent: "changed",
            attempt: { state: "attempting", generation: 1 },
          },
        },
      },
    });
    const eventKey = syncFeedEventKey(
      vaultId,
      fixture.lane,
      FIRST_EVENT_SEQUENCE,
    );
    const exactEvent = await fixture.publication.readEvent(
      vaultId,
      fixture.lane,
      FIRST_EVENT_SEQUENCE,
    );
    expect(exactEvent).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          kind: "changed",
          operationId,
          result: { kind: "live", revision },
        },
      },
    });
    expect(
      await settleResume(createStore(fixture), fixture, request),
    ).toMatchObject({ kind: "committed", operationId, revision });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      ),
    ).toEqual(exactEvent);
    expect(
      fixture.bucket.putAttempts.filter(({ key }) => key === eventKey),
    ).toHaveLength(1);
  });

  it("does not overwrite a peer's later event intent with an older resumer's proposal after the head was written", async () => {
    const fixture = await setup();
    const request = await createMutationRequest("Peer fixed event clock");
    await advanceToHeadWrite(createStore(fixture), fixture, request);
    await advanceHeadWriteCooldown(fixture, request);
    const originalEpoch = fixture.now();
    const originalClock = () => originalEpoch;
    const createInvocation = createSyncR2MutationInvocationFactory(
      fixture.bucket,
      originalClock,
    );
    let raced = false;
    const store = syncR2Mutation(
      fixture.records,
      () => {
        const invocation = createInvocation();
        const original = invocation.records;
        return {
          ...invocation,
          records: {
            ...original,
            readHead: async (vault, notePath) => {
              const result = await original.readHead(vault, notePath);
              if (
                !raced &&
                result.kind === "observed" &&
                result.observation.value.operationId === operationId
              ) {
                raced = true;
                fixture.setNow(originalEpoch + 1_100);
                expect(
                  await createStore(fixture).resumeOperation({
                    vaultId,
                    operationId,
                  }),
                ).toEqual({
                  kind: "error",
                  code: "operation_pending",
                  operationId,
                });
              }
              return result;
            },
          },
        };
      },
      originalClock,
    );
    expect(await store.resumeOperation({ vaultId, operationId })).toEqual({
      kind: "error",
      code: "operation_pending",
      operationId,
    });
    expect(raced).toBe(true);
    const peerTime = originalEpoch + 1_100;
    expect(
      await fixture.publication.readJournal(vaultId, operationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          stepEvidence: {
            step: "create_event",
            outcomeIntent: "changed",
            committedAtEpochMs: peerTime,
          },
          request,
        },
      },
    });
    const eventKey = syncFeedEventKey(
      vaultId,
      fixture.lane,
      FIRST_EVENT_SEQUENCE,
    );
    expect(fixture.bucket.objects.has(eventKey)).toBe(false);
    expect(
      await settleResume(createStore(fixture), fixture, request),
    ).toMatchObject({ kind: "committed", operationId, revision });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      ),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          kind: "changed",
          committedAtEpochMs: peerTime,
          operationId,
          result: { kind: "live", revision },
        },
      },
    });
    expect(
      fixture.bucket.putAttempts.filter(
        ({ key }) => key === syncHeadKey(vaultId, path),
      ),
    ).toHaveLength(1);
    expect(
      fixture.bucket.putAttempts.filter(({ key }) => key === eventKey),
    ).toHaveLength(1);
  });

  it.each(["content", "event"] as const)(
    "withholds advancement when digesting the expected %s loses its capability after an exact target read",
    async (target) => {
      const fixture = await setup();
      const request = await createMutationRequest(`Expected ${target} proof`);
      const step = target === "content" ? "immutable_create" : "create_event";
      if (target === "content")
        await advanceToWriteStep(createStore(fixture), fixture, request, step);
      else await seedCreateEventStep(fixture, request);
      fixture.setNow(fixture.now() + 1_100);
      expect(
        await createStore(fixture).resumeOperation({ vaultId, operationId }),
      ).toMatchObject({ kind: "error", code: "operation_pending" });
      const retained = await fixture.publication.readJournal(
        vaultId,
        operationId,
      );
      if (retained.kind !== "observed")
        throw new Error("Expected pending target claim");
      expect(retained.observation.value).toMatchObject({
        status: "pending",
        stepEvidence: { step, attempt: { state: "attempting", generation: 1 } },
      });
      const key =
        target === "content"
          ? syncContentKey(vaultId, revision)
          : syncFeedEventKey(vaultId, fixture.lane, FIRST_EVENT_SEQUENCE);
      expect(fixture.bucket.objects.has(key)).toBe(true);
      const createInvocation = createSyncR2MutationInvocationFactory(
        fixture.bucket,
        fixture.now,
      );
      const digest = vi.spyOn(crypto.subtle, "digest");
      let armed = false;
      const store = syncR2Mutation(
        fixture.records,
        () => {
          const invocation = createInvocation();
          const records = invocation.records;
          const publication = invocation.publication;
          return {
            ...invocation,
            records: {
              ...records,
              readContentBody: async (vault, bodyRevision) => {
                const read = await records.readContentBody(vault, bodyRevision);
                if (target === "content" && read.kind === "observed") {
                  armed = true;
                  digest.mockRejectedValueOnce(
                    new Error("Expected content digest unavailable"),
                  );
                }
                return read;
              },
            },
            publication: {
              ...publication,
              readEvent: async (vault, lane, sequence) => {
                const read = await publication.readEvent(vault, lane, sequence);
                if (target === "event" && read.kind === "observed") {
                  armed = true;
                  digest.mockRejectedValueOnce(
                    new Error("Expected event lane digest unavailable"),
                  );
                }
                return read;
              },
            },
          };
        },
        fixture.now,
      );
      const puts = fixture.bucket.putAttempts.length;
      try {
        expect(await store.resumeOperation({ vaultId, operationId })).toEqual({
          kind: "error",
          code: "effect_unknown",
          operationId,
        });
        expect(armed).toBe(true);
        expect(fixture.bucket.putAttempts).toHaveLength(puts);
      } finally {
        digest.mockRestore();
      }
      expect(
        await fixture.publication.readJournal(vaultId, operationId),
      ).toEqual(retained);
      expect(
        await settleResume(createStore(fixture), fixture, request),
      ).toMatchObject({ kind: "committed", operationId, revision });
      expect(
        fixture.bucket.putAttempts.filter(
          ({ key: written }) => written === key,
        ),
      ).toHaveLength(1);
    },
  );

  it.each(["before_journal", "unallocated_journal"] as const)(
    "preserves the initial-lane throttle floor at %s without claiming a mutation target",
    async (stage) => {
      const fixture = await setup();
      const request = await createMutationRequest(`Lane admission ${stage}`);
      if (stage === "unallocated_journal")
        expect(
          await fixture.publication.createJournal(
            unallocatedJournalForRequest(request, fixture.lane, {
              kind: "absent",
            }),
          ),
        ).toEqual({ kind: "confirmed" });
      const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
      fixture.bucket.beforeNextPut(laneKey, "create", async () => {
        throw new Error("429 R2 rate limit");
      });
      const floor = fixture.now() + 1_100;
      const result =
        stage === "before_journal"
          ? await createStore(fixture).mutate(request)
          : await createStore(fixture).resumeOperation({
              vaultId,
              operationId,
            });
      expect(result).toEqual(
        stage === "before_journal"
          ? {
              kind: "error",
              code: "storage_throttled",
              retryAfterEpochMs: floor,
            }
          : {
              kind: "error",
              code: "operation_pending",
              operationId,
              retryAfterEpochMs: floor,
            },
      );
      expect(fixture.bucket.objects.has(laneKey)).toBe(false);
      expect(
        fixture.bucket.objects.has(syncContentKey(vaultId, revision)),
      ).toBe(false);
      expect(fixture.bucket.objects.has(syncHeadKey(vaultId, path))).toBe(
        false,
      );
      expect(
        fixture.bucket.putAttempts.filter(({ key }) => key === laneKey),
      ).toHaveLength(1);
      const journal = await fixture.publication.readJournal(
        vaultId,
        operationId,
      );
      expect(journal).toMatchObject(
        stage === "before_journal"
          ? { kind: "absent" }
          : {
              kind: "observed",
              observation: {
                value: {
                  status: "pending",
                  allocationState: "unallocated",
                  request,
                },
              },
            },
      );
      fixture.setNow(floor);
      expect(
        await settleMutation(createStore(fixture), fixture, request),
      ).toMatchObject({ kind: "committed", operationId, revision });
    },
  );

  it("retains the original absent lane observation while the newly created journal is too young to reobserve the initialized lane", async () => {
    const fixture = await setup();
    const request = await createMutationRequest(
      "Journal cooldown before lane reobservation",
    );
    expect(
      await fixture.publication.createJournal(
        unallocatedJournalForRequest(request, fixture.lane, { kind: "absent" }),
      ),
    ).toEqual({ kind: "confirmed" });
    const journalKey = syncOperationKey(vaultId, operationId);
    const floor = fixture.now() + 1_100;
    expect(
      await createStore(fixture).resumeOperation({ vaultId, operationId }),
    ).toEqual({
      kind: "error",
      code: "operation_pending",
      operationId,
      retryAfterEpochMs: floor,
    });
    expect(
      fixture.bucket.putAttempts.filter(({ key }) => key === journalKey),
    ).toHaveLength(1);
    expect(
      await fixture.publication.readJournal(vaultId, operationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "unallocated",
          laneObservation: { precondition: { kind: "absent" } },
          request,
        },
      },
    });
    expect(
      await fixture.publication.readLaneHead(vaultId, fixture.lane),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          committedSequence: syncSequenceSchema.parse("0".repeat(20)),
          committedAtEpochMs: 0,
        },
      },
    });
    expect(fixture.bucket.objects.has(syncHeadKey(vaultId, path))).toBe(false);
    fixture.setNow(floor);
    expect(
      await settleResume(createStore(fixture), fixture, request),
    ).toMatchObject({ kind: "committed", operationId, revision });
  });

  it("retains a successfully written head claim when the clock becomes invalid before recording the event intent", async () => {
    const fixture = await setup();
    const request = await createMutationRequest(
      "Clock failure after exact head write",
    );
    await advanceToHeadWrite(createStore(fixture), fixture, request);
    await advanceHeadWriteCooldown(fixture, request);
    const validEpoch = fixture.now();
    const createInvocation = createSyncR2MutationInvocationFactory(
      fixture.bucket,
      fixture.now,
    );
    let invalidated = false;
    const store = syncR2Mutation(
      fixture.records,
      () => {
        const invocation = createInvocation();
        const original = invocation.records;
        return {
          ...invocation,
          records: {
            ...original,
            readHead: async (vault, notePath) => {
              const result = await original.readHead(vault, notePath);
              if (
                result.kind === "observed" &&
                result.observation.value.operationId === operationId
              ) {
                invalidated = true;
                fixture.setNow(-1);
              }
              return result;
            },
          },
        };
      },
      fixture.now,
    );
    expect(await store.resumeOperation({ vaultId, operationId })).toEqual({
      kind: "error",
      code: "invalid_input",
    });
    expect(invalidated).toBe(true);
    fixture.setNow(validEpoch + 1_100);
    expect(
      await fixture.publication.readJournal(vaultId, operationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          stepEvidence: {
            step: "write_head",
            attempt: { state: "attempting", generation: 1 },
          },
        },
      },
    });
    expect(
      fixture.bucket.objects.has(
        syncFeedEventKey(vaultId, fixture.lane, FIRST_EVENT_SEQUENCE),
      ),
    ).toBe(false);
    expect(
      await settleResume(createStore(fixture), fixture, request),
    ).toMatchObject({ kind: "committed", operationId, revision });
    expect(
      fixture.bucket.putAttempts.filter(
        ({ key }) => key === syncHeadKey(vaultId, path),
      ),
    ).toHaveLength(1);
  });

  it.each(["current", "version", "recovery"] as const)(
    "maps a rejected %s repository capability to a typed exact-read failure without changing durable state",
    async (query) => {
      const fixture = await setup();
      if (query === "recovery")
        await seedTombstone(fixture, "Exact retained source");
      else await seedLiveHead(fixture, "Exact retained source");
      const dispatch = (
        store: Pick<SyncStore, "readCurrent" | "readVersion" | "readRecovery">,
      ) => {
        switch (query) {
          case "current":
            return store.readCurrent({ vaultId, path });
          case "version":
            return store.readVersion({ vaultId, revision });
          case "recovery":
            return store.readRecovery({
              vaultId,
              operationId: recoveryOperationId,
            });
        }
      };
      const baseline = await dispatch(createStore(fixture));
      expect(baseline).toMatchObject({
        kind: query === "current" ? "live" : "present",
      });
      const failing = syncR2Mutation(
        {
          ...fixture.records,
          readHead:
            query === "current"
              ? async () => {
                  throw new Error("Head capability rejected");
                }
              : (vault, notePath) => fixture.records.readHead(vault, notePath),
          readVersion:
            query === "version"
              ? async () => {
                  throw new Error("Version capability rejected");
                }
              : (vault, sourceRevision) =>
                  fixture.records.readVersion(vault, sourceRevision),
          readRecovery:
            query === "recovery"
              ? async () => {
                  throw new Error("Recovery capability rejected");
                }
              : (vault, id) => fixture.records.readRecovery(vault, id),
        },
        createSyncR2MutationInvocationFactory(fixture.bucket, fixture.now),
        fixture.now,
      );
      const puts = fixture.bucket.putAttempts.length;
      await expect(dispatch(failing)).resolves.toEqual({
        kind: "error",
        code: "storage_unavailable",
      });
      expect(fixture.bucket.putAttempts).toHaveLength(puts);
      expect(await dispatch(createStore(fixture))).toEqual(baseline);
    },
  );

  it("does not dispatch an event when encoding the reread claim authority loses its digest capability", async () => {
    const fixture = await setup();
    const request = await createMutationRequest(
      "Digest failure at claim fence",
    );
    await seedCreateEventStep(fixture, request);
    const createInvocation = createSyncR2MutationInvocationFactory(
      fixture.bucket,
      fixture.now,
    );
    const digest = vi.spyOn(crypto.subtle, "digest");
    let reads = 0;
    const store = syncR2Mutation(
      fixture.records,
      () => {
        const invocation = createInvocation();
        const original = invocation.publication;
        return {
          ...invocation,
          publication: {
            ...original,
            readJournal: async (vault, id) => {
              const result = await original.readJournal(vault, id);
              reads += 1;
              if (reads === 2 && result.kind === "observed")
                digest.mockRejectedValueOnce(
                  new Error("Exact claim digest unavailable"),
                );
              return result;
            },
          },
        };
      },
      fixture.now,
    );
    const puts = fixture.bucket.putAttempts.length;
    try {
      expect(await store.resumeOperation({ vaultId, operationId })).toEqual({
        kind: "error",
        code: "effect_unknown",
        operationId,
      });
      expect(reads).toBe(2);
      expect(fixture.bucket.putAttempts).toHaveLength(puts);
    } finally {
      digest.mockRestore();
    }
    expect(
      await settleResume(createStore(fixture), fixture, request),
    ).toMatchObject({ kind: "committed", operationId, revision });
    expect(
      fixture.bucket.putAttempts.filter(
        ({ key }) =>
          key === syncFeedEventKey(vaultId, fixture.lane, FIRST_EVENT_SEQUENCE),
      ),
    ).toHaveLength(1);
  });

  it("does not admit the losing request when a different same-ID request creates its journal after the absence observation", async () => {
    const fixture = await setup();
    const request = await createMutationRequest("Losing request");
    const peer = await createMutationRequest("Winning same-ID request");
    const createInvocation = createSyncR2MutationInvocationFactory(
      fixture.bucket,
      fixture.now,
    );
    let raced = false;
    const store = syncR2Mutation(
      fixture.records,
      () => {
        const invocation = createInvocation();
        const original = invocation.publication;
        return {
          ...invocation,
          publication: {
            ...original,
            createJournal: async (initial, retryContext) => {
              if (
                initial.status !== "pending" ||
                initial.allocationState !== "unallocated"
              )
                throw new Error("Expected unallocated request");
              raced = true;
              expect(
                await original.createJournal({
                  ...initial,
                  request: peer,
                  payload: {
                    byteSize: encoder.encode(peer.content).byteLength,
                  },
                }),
              ).toEqual({ kind: "confirmed" });
              return original.createJournal(initial, retryContext);
            },
          },
        };
      },
      fixture.now,
    );
    expect(await store.mutate(request)).toEqual({
      kind: "error",
      code: "operation_id_reused",
    });
    expect(raced).toBe(true);
    const stored = await fixture.publication.readJournal(vaultId, operationId);
    expect(stored).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          request: peer,
          status: "pending",
          allocationState: "unallocated",
        },
      },
    });
    expect(
      fixture.bucket.putAttempts.filter(
        ({ key }) => key === syncOperationKey(vaultId, operationId),
      ),
    ).toHaveLength(1);
    expect(fixture.bucket.objects.has(syncHeadKey(vaultId, path))).toBe(false);
    expect(
      await settleMutation(createStore(fixture), fixture, peer),
    ).toMatchObject({ kind: "committed", operationId, revision });
    expect(
      await createStore(fixture).readVersion({ vaultId, revision }),
    ).toMatchObject({ kind: "present", version: { content: peer.content } });
    expect(await createStore(fixture).mutate(request)).toEqual({
      kind: "error",
      code: "operation_id_reused",
    });
  });

  it("does not treat a missing originally observed parent head as create authority or stale-abort proof", async () => {
    const fixture = await setup();
    await seedLiveHead(fixture, "Retained original parent");
    const create = await createMutationRequest("Updated body");
    const request: SyncMutationRequest = {
      ...create,
      kind: "update",
      operationId: competingOperationId,
      revision: tombstoneRevision,
      parent: { kind: "revision", revision },
    };
    await advanceToHeadWrite(createStore(fixture), fixture, request);
    const headKey = syncHeadKey(vaultId, path);
    const retained = fixture.bucket.objects.get(headKey);
    if (retained === undefined)
      throw new Error("Expected exact original parent head");
    const puts = fixture.bucket.putAttempts.length;
    fixture.bucket.objects.delete(headKey);
    expect(
      await createStore(fixture).resumeOperation({
        vaultId,
        operationId: competingOperationId,
      }),
    ).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId: competingOperationId,
    });
    expect(fixture.bucket.putAttempts).toHaveLength(puts);
    expect(
      await fixture.publication.readJournal(vaultId, competingOperationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          stepEvidence: {
            step: "write_head",
            attempt: { state: "ready", generation: 0 },
          },
        },
      },
    });
    fixture.bucket.objects.set(headKey, retained);
    expect(
      await settleResume(createStore(fixture), fixture, request),
    ).toMatchObject({
      kind: "committed",
      operationId: competingOperationId,
      revision: tombstoneRevision,
    });
  });

  it("requires a verified live source rather than synthesizing tombstone or recovery metadata from a live request", async () => {
    const fixture = await setup();
    const request = await createMutationRequest("Strict source provenance");
    await seedCreateEventStep(fixture, request);
    const read = await fixture.publication.readJournal(vaultId, operationId);
    const source = await fixture.records.readVersion(vaultId, revision);
    if (
      read.kind !== "observed" ||
      read.observation.value.status !== "pending" ||
      read.observation.value.allocationState !== "allocated" ||
      source.kind !== "observed" ||
      source.observation.value.kind !== "live"
    ) {
      throw new Error("Expected validated request and source");
    }
    const journal = read.observation.value;
    const liveSource = source.observation.value;
    expect(() => tombstoneVersionForRequest(journal, liveSource)).toThrow(
      TypeError,
    );
    expect(() => recoveryForRequest(journal, liveSource)).toThrow(TypeError);
    const tombstone: SyncAllocatedPendingJournalRecord = {
      ...journal,
      payload: null,
      request: {
        kind: "tombstone",
        vaultId,
        path,
        operationId,
        revision: tombstoneRevision,
        parent: { kind: "revision", revision },
        contentSha256: request.contentSha256,
        origin: alternateOrigin,
      },
    };
    expect(() => versionForRequest(tombstone)).toThrow(TypeError);
    expect(
      tombstoneVersionForRequest(tombstone, source.observation.value),
    ).toMatchObject({
      kind: "tombstone",
      revision: tombstoneRevision,
      parent: { kind: "revision", revision },
      origin: alternateOrigin,
      byteSize: encoder.encode(request.content).byteLength,
      contentSha256: request.contentSha256,
    });
    expect(
      recoveryForRequest(tombstone, source.observation.value),
    ).toMatchObject({
      sourceRevision: revision,
      operationId,
      origin,
      contentSha256: request.contentSha256,
      byteSize: encoder.encode(request.content).byteLength,
    });
  });

  it("rejects an abort event as evidence for a still-unclaimed immutable step and rejects absence as a head match", async () => {
    const fixture = await setup();
    const request = await createMutationRequest("No unclaimed abort authority");
    await advanceToWriteStep(
      createStore(fixture),
      fixture,
      request,
      "immutable_create",
    );
    const read = await fixture.publication.readJournal(vaultId, operationId);
    if (
      read.kind !== "observed" ||
      read.observation.value.status !== "pending" ||
      read.observation.value.allocationState !== "allocated"
    ) {
      throw new Error("Expected allocated immutable step");
    }
    const journal = read.observation.value;
    const abort: SyncFeedEventRecord = {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      kind: "aborted",
      lane: fixture.lane,
      sequence: journal.reservation.sequence,
      operationId,
      reason: "stale_revision",
      committedAtEpochMs: fixture.now(),
    };
    expect(eventMatchesRequest(journal, abort)).toBe(false);
    expect(
      sameCurrentAndHead({ kind: "never_seen" }, versionForRequest(journal)),
    ).toBe(false);
  });

  it("requires exact terminal outcome identity and permits only the retry floor to differ", async () => {
    const fixture = await setup();
    const request = await createMutationRequest("Frozen terminal outcome");
    await advanceToTerminalLaneCommit(createStore(fixture), fixture, request);
    const read = await fixture.publication.readJournal(vaultId, operationId);
    if (
      read.kind !== "observed" ||
      read.observation.value.status !== "committed"
    )
      throw new Error("Expected committed journal");
    const left = read.observation.value;
    expect(
      sameTerminalOutcome(left, {
        ...left,
        committedAtEpochMs: left.committedAtEpochMs + 1,
      }),
    ).toBe(false);
    expect(
      sameTerminalOutcome(left, {
        ...left,
        request: { ...left.request, origin: alternateOrigin },
      }),
    ).toBe(false);
    expect(
      sameTerminalOutcome(left, {
        ...left,
        stepEvidence: {
          ...left.stepEvidence,
          retryAfterEpochMs: fixture.now() + 10_000,
        },
      }),
    ).toBe(true);
  });
  it.each([
    "admission",
    "existing_replay",
    "created_replay",
    "head_policy",
  ] as const)(
    "fails closed on a digest capability rejection during %s policy evaluation",
    async (stage) => {
      const fixture = await setup();
      const request = await createMutationRequest(`Digest capability ${stage}`);
      if (stage === "existing_replay")
        await seedCreateEventStep(fixture, request);
      if (stage === "head_policy") {
        await advanceToHeadWrite(createStore(fixture), fixture, request);
        fixture.setNow(fixture.now() + 1_100);
      }
      const createInvocation = createSyncR2MutationInvocationFactory(
        fixture.bucket,
        fixture.now,
      );
      const digest = vi.spyOn(crypto.subtle, "digest");
      let armed = false;
      const arm = () => {
        if (armed) return;
        armed = true;
        digest.mockRejectedValueOnce(
          new Error("Digest capability unavailable"),
        );
      };
      const store = syncR2Mutation(
        fixture.records,
        () => {
          const invocation = createInvocation();
          const originalRecords = invocation.records;
          const originalPublication = invocation.publication;
          return {
            ...invocation,
            records: {
              ...originalRecords,
              readHead: async (vault, path) => {
                const result = await originalRecords.readHead(vault, path);
                if (stage === "admission" || stage === "head_policy") arm();
                return result;
              },
            },
            publication: {
              ...originalPublication,
              readJournal: async (vault, id) => {
                const result = await originalPublication.readJournal(vault, id);
                if (
                  (stage === "existing_replay" || stage === "created_replay") &&
                  result.kind === "observed"
                )
                  arm();
                return result;
              },
            },
          };
        },
        fixture.now,
      );
      const writes = fixture.bucket.putAttempts.length;
      try {
        const result =
          stage === "head_policy"
            ? await store.resumeOperation({ vaultId, operationId })
            : await store.mutate(request);
        expect(result).toEqual(
          stage === "head_policy"
            ? { kind: "error", code: "effect_unknown", operationId }
            : { kind: "error", code: "storage_unavailable" },
        );
        expect(armed).toBe(true);
        if (stage !== "created_replay")
          expect(fixture.bucket.putAttempts).toHaveLength(writes);
        expect(
          fixture.bucket.objects.has(
            syncFeedEventKey(vaultId, fixture.lane, FIRST_EVENT_SEQUENCE),
          ),
        ).toBe(false);
      } finally {
        digest.mockRestore();
      }
      expect(
        await settleMutation(createStore(fixture), fixture, request),
      ).toMatchObject({ kind: "committed", operationId, revision });
    },
  );
  it("creates a fresh budget for each concurrent mutate and resume invocation", async () => {
    const fixture = await setup();
    const measured = createMeasuredStore(fixture);
    const firstRequest = await createMutationRequest("Independent budget one");
    const secondRequest: Extract<
      SyncMutationRequest,
      { readonly kind: "create" }
    > = {
      ...firstRequest,
      path: syncNotePathSchema.parse("notes/independent.md"),
      operationId: syncOperationIdSchema.parse(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ),
      revision: syncRevisionSchema.parse(
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ),
      content: "Independent budget two",
      contentSha256: await sha256Content("Independent budget two"),
    };
    const bucketCallsBefore =
      fixture.bucket.gets.length + fixture.bucket.puts.length;

    await Promise.all([
      measured.store.mutate(firstRequest),
      measured.store.mutate(secondRequest),
    ]);
    await measured.store.resumeOperation({
      vaultId: firstRequest.vaultId,
      operationId: firstRequest.operationId,
    });

    expect(measured.invocations).toHaveLength(3);
    expect(
      new Set(measured.invocations.map(({ callBudget }) => callBudget)).size,
    ).toBe(3);
    expectInvocationCallsToMatchBucket(
      fixture,
      measured.invocations,
      bucketCallsBefore,
    );
  });

  it("fails closed without a sixty-fifth bucket call when the mutation budget is exhausted", async () => {
    const fixture = await setup();
    const invocation = createSyncR2MutationInvocationFactory(
      fixture.bucket,
      fixture.now,
    )();
    for (let read = 0; read < SYNC_R2_INVOCATION_CALL_LIMIT / 2; read += 1) {
      expect(await invocation.records.readHead(vaultId, path)).toEqual({
        kind: "absent",
      });
    }
    expect(invocation.callBudget.actualCalls).toBe(
      SYNC_R2_INVOCATION_CALL_LIMIT,
    );
    const store = syncR2Mutation(
      fixture.records,
      () => invocation,
      fixture.now,
    );
    const request = await createMutationRequest("No call after exhaustion");
    const bucketCallsBefore =
      fixture.bucket.gets.length + fixture.bucket.puts.length;

    expect(await store.mutate(request)).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId,
    });
    expect(fixture.bucket.gets.length + fixture.bucket.puts.length).toBe(
      bucketCallsBefore,
    );
    expect(fixture.bucket.puts).toEqual([]);
  });

  it("counts an unavailable PUT read-back without losing the lane reservation", async () => {
    const fixture = await setup();
    const request = await createMutationRequest("Counted failed read-back");
    await advanceToWriteStep(
      createStore(fixture),
      fixture,
      request,
      "immutable_create",
    );
    const journal = await fixture.publication.readJournal(vaultId, operationId);
    expect(journal.kind).toBe("observed");
    if (journal.kind !== "observed") return;
    fixture.setNow(journal.observation.observed.uploaded.getTime() + 1_100);
    const contentKey = syncContentKey(vaultId, revision);
    const contentReadsBefore = fixture.bucket.gets.filter(
      (key) => key === contentKey,
    ).length;
    fixture.bucket.applyThenLoseResponse(contentKey, "create", 2);
    const measured = createMeasuredStore(fixture);
    const bucketCallsBefore =
      fixture.bucket.gets.length + fixture.bucket.puts.length;

    expect(
      await measured.store.resumeOperation({ vaultId, operationId }),
    ).toMatchObject({
      kind: "error",
      code: "effect_unknown",
      operationId,
    });

    expectInvocationCallsToMatchBucket(
      fixture,
      measured.invocations,
      bucketCallsBefore,
    );
    expect(
      fixture.bucket.gets.filter((key) => key === contentKey).length -
        contentReadsBefore,
    ).toBeGreaterThanOrEqual(2);
    expect(
      fixture.bucket.failedGets.filter((key) => key === contentKey),
    ).toHaveLength(2);
    expect(
      await fixture.publication.readLaneHead(vaultId, fixture.lane),
    ).toMatchObject({
      kind: "observed",
      observation: { value: { pending: { operationId } } },
    });
  });

  it("keeps an allocated lane reserved when a resume exhausts its invocation budget", async () => {
    const fixture = await setup();
    const request = await createMutationRequest("Exhausted allocated resume");
    await advanceToWriteStep(
      createStore(fixture),
      fixture,
      request,
      "immutable_create",
    );
    const createInvocation = createSyncR2MutationInvocationFactory(
      fixture.bucket,
      fixture.now,
    );
    const invocations: SyncR2MutationInvocationCapabilities[] = [];
    const measuredStore = syncR2Mutation(
      fixture.records,
      () => {
        const invocation = createInvocation();
        const publication: SyncR2Publication = {
          ...invocation.publication,
          async readJournal(vault, operation) {
            for (
              let call = 0;
              call < SYNC_R2_INVOCATION_CALL_LIMIT / 2;
              call += 1
            ) {
              await invocation.records.readHead(vaultId, path);
            }
            return invocation.publication.readJournal(vault, operation);
          },
        };
        const scoped = { ...invocation, publication };
        invocations.push(scoped);
        return scoped;
      },
      fixture.now,
    );
    const bucketCallsBefore =
      fixture.bucket.gets.length + fixture.bucket.puts.length;

    expect(
      await measuredStore.resumeOperation({
        vaultId: request.vaultId,
        operationId: request.operationId,
      }),
    ).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId: request.operationId,
    });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.callBudget.actualCalls).toBe(
      SYNC_R2_INVOCATION_CALL_LIMIT,
    );
    expect(fixture.bucket.gets.length + fixture.bucket.puts.length).toBe(
      bucketCallsBefore + SYNC_R2_INVOCATION_CALL_LIMIT,
    );
    expect(
      await fixture.publication.readLaneHead(vaultId, fixture.lane),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: { pending: { operationId: request.operationId } },
      },
    });
  });

  it("counts marker, conditional PUT, and read-back calls within a full live mutation", async () => {
    const fixture = await setup();
    const measured = createMeasuredStore(fixture);
    const request = await createMutationRequest("Counted live mutation");
    const contentKey = syncContentKey(vaultId, revision);
    const bucketCallsBefore =
      fixture.bucket.gets.length + fixture.bucket.puts.length;

    expect(
      await settleMutation(measured.store, fixture, request),
    ).toMatchObject({
      kind: "committed",
      revision,
      operationId,
    });

    expectInvocationCallsToMatchBucket(
      fixture,
      measured.invocations,
      bucketCallsBefore,
    );
    expect(
      fixture.bucket.gets.filter((key) => key === syncVaultMarkerKey(vaultId)),
    ).not.toHaveLength(0);
    expect(fixture.bucket.puts).toContain(contentKey);
    expect(
      fixture.bucket.gets.filter((key) => key === contentKey).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      fixture.bucket.putAttempts.filter(
        (attempt) => attempt.key === contentKey,
      ),
    ).toHaveLength(1);
  });

  it("distinguishes a verified never-seen current head from storage failure", async () => {
    const loaded = await import(
      "@worker/infrastructure/sync/sync-r2-mutation"
    ).catch(() => undefined);
    expect(loaded?.syncR2Mutation).toBeTypeOf("function");
    if (loaded === undefined) return;

    const fixture = await setup();
    const store = loaded.syncR2Mutation(
      fixture.records,
      createSyncR2MutationInvocationFactory(fixture.bucket, fixture.now),
      fixture.now,
    );

    expect(await store.readCurrent({ vaultId, path })).toEqual({
      kind: "never_seen",
    });
    fixture.bucket.failNextGets(syncHeadKey(vaultId, path), 1);
    expect(await store.readCurrent({ vaultId, path })).toEqual({
      kind: "error",
      code: "storage_unavailable",
    });
  });

  it("reads the exact current revision and immutable live bytes", async () => {
    const loaded = await import("@worker/infrastructure/sync/sync-r2-mutation");
    const fixture = await setup();
    const store = loaded.syncR2Mutation(
      fixture.records,
      createSyncR2MutationInvocationFactory(fixture.bucket, fixture.now),
      fixture.now,
    );
    const content = "# Exact\\r\\nUnicode 🌐";
    await seedLiveHead(fixture, content);

    expect(await store.readCurrent({ vaultId, path })).toEqual({
      kind: "live",
      revision,
      parent: { kind: "never_seen" },
      contentSha256: await sha256Content(content),
      byteSize: encoder.encode(content).byteLength,
      mediaType: "text/markdown",
      operationId,
      origin,
    });
    expect(hasVersionRead(store)).toBe(true);
    if (!hasVersionRead(store)) return;
    expect(await store.readVersion({ vaultId, revision })).toEqual({
      kind: "present",
      version: {
        kind: "live",
        vaultId,
        path,
        revision,
        parent: { kind: "never_seen" },
        contentSha256: await sha256Content(content),
        byteSize: encoder.encode(content).byteLength,
        mediaType: "text/markdown",
        content,
        operationId,
        origin,
      },
    });
  });

  it("publishes a create only after the immutable head, event, journal, and lane commit", async () => {
    const loaded = await import("@worker/infrastructure/sync/sync-r2-mutation");
    const fixture = await setup();
    const store = loaded.syncR2Mutation(
      fixture.records,
      createSyncR2MutationInvocationFactory(fixture.bucket, fixture.now),
      fixture.now,
    );
    expect(hasMutation(store)).toBe(true);
    if (!hasMutation(store)) return;

    const content = "# Durable create 🌐";
    const request: SyncMutationRequest = {
      kind: "create",
      vaultId,
      path,
      operationId,
      revision,
      parent: { kind: "never_seen" },
      contentSha256: await sha256Content(content),
      content,
      mediaType: "text/markdown",
      origin,
    };
    const result = await settleMutation(store, fixture, request);

    expect(result).toEqual({
      kind: "committed",
      revision,
      operationId,
      position: { lane: fixture.lane, sequence: "00000000000000000001" },
    });
    const journal = await fixture.publication.readJournal(vaultId, operationId);
    expect(journal.kind).toBe("observed");
    if (journal.kind !== "observed") return;
    expect(journal.observation.value.status).toBe("committed");
    const event = await fixture.publication.readEvent(
      vaultId,
      fixture.lane,
      syncEventSequenceSchema.parse("00000000000000000001"),
    );
    expect(event.kind).toBe("observed");
    if (event.kind !== "observed") return;
    expect(event.observation.value).toMatchObject({
      kind: "changed",
      operationId,
      lane: fixture.lane,
      sequence: "00000000000000000001",
      path,
      result: { kind: "live", revision },
      origin,
    });
    const lane = await fixture.publication.readLaneHead(vaultId, fixture.lane);
    expect(lane.kind).toBe("observed");
    if (lane.kind !== "observed") return;
    expect(lane.observation.value.committedSequence).toBe(
      "00000000000000000001",
    );
    expect(lane.observation.value.pending).toBeUndefined();
    expect(await store.readCurrent({ vaultId, path })).toMatchObject({
      kind: "live",
      revision,
      operationId,
    });
  });

  it("resumes an incomplete create through a fresh R2 facade", async () => {
    const fixture = await setup();
    const firstStore = createStore(fixture);
    const content = "Cross-facade recovery";
    const request: SyncMutationRequest = {
      kind: "create",
      vaultId,
      path,
      operationId,
      revision,
      parent: { kind: "never_seen" },
      contentSha256: await sha256Content(content),
      content,
      mediaType: "text/markdown",
      origin,
    };
    expect(await firstStore.mutate(request)).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId,
    });

    const recovered = await settleResume(
      createStore(fixture),
      fixture,
      request,
    );
    expect(recovered).toEqual({
      kind: "committed",
      revision,
      operationId,
      position: { lane: fixture.lane, sequence: "00000000000000000001" },
    });
  });

  it("replays committed operations exactly and rejects changed operation identities", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const content = "Stable identity";
    const request: SyncMutationRequest = {
      kind: "create",
      vaultId,
      path,
      operationId,
      revision,
      parent: { kind: "never_seen" },
      contentSha256: await sha256Content(content),
      content,
      mediaType: "text/markdown",
      origin,
    };
    const committed = await settleMutation(store, fixture, request);
    expect(committed.kind).toBe("committed");
    const writesAfterCommit = fixture.bucket.puts.length;

    expect(await store.mutate(request)).toEqual(committed);
    const reused = {
      ...request,
      content: `${content}!`,
      contentSha256: await sha256Content(`${content}!`),
    };
    expect(await store.mutate(reused)).toEqual({
      kind: "error",
      code: "operation_id_reused",
    });
    expect(fixture.bucket.puts).toHaveLength(writesAfterCommit);
  });

  it("serializes same-lane creates and publishes the losing parent as stale", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const requests: SyncMutationRequest[] = await Promise.all(
      [operationId, recoveryOperationId].map(async (id, index) => {
        const content = `Concurrent ${index}`;
        return {
          kind: "create",
          vaultId,
          path,
          operationId: id,
          revision: index === 0 ? revision : updatedRevision,
          parent: { kind: "never_seen" },
          contentSha256: await sha256Content(content),
          content,
          mediaType: "text/markdown",
          origin,
        };
      }),
    );
    await Promise.all(requests.map((request) => store.mutate(request)));
    const lane = await fixture.publication.readLaneHead(vaultId, fixture.lane);
    const owner =
      lane.kind === "observed"
        ? lane.observation.value.pending?.operationId
        : undefined;
    const winner =
      requests.find((request) => request.operationId === owner) ?? requests[0];
    if (winner === undefined) return;
    const loser = requests.find(
      (request) => request.operationId !== winner.operationId,
    );
    expect(loser).toBeDefined();
    if (loser === undefined) return;

    const winnerResult = await settleMutation(store, fixture, winner);
    const loserResult = await settleMutation(store, fixture, loser);
    expect(winnerResult).toMatchObject({
      kind: "committed",
      operationId: winner.operationId,
    });
    expect(loserResult).toEqual({ kind: "error", code: "stale_revision" });
    const finalLane = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(finalLane.kind).toBe("observed");
    if (finalLane.kind !== "observed") return;
    expect(finalLane.observation.value.committedSequence).toBe(
      "00000000000000000002",
    );
    expect(finalLane.observation.value.pending).toBeUndefined();
  });

  it("recovers a ready head through a no-effect stale abort before event publication", async () => {
    const fixture = await setup();
    const scenario = await prepareCurrentHeadCasScenario(fixture);
    await advanceToHeadWrite(createStore(fixture), fixture, scenario.request);
    const originalHead = await fixture.records.readHead(vaultId, path);
    expect(originalHead.kind).toBe("observed");
    if (originalHead.kind !== "observed") return;
    const headKey = syncHeadKey(vaultId, path);
    const headWritesBeforeCompetitor = fixture.bucket.putAttempts.filter(
      (attempt) => attempt.key === headKey,
    ).length;
    await advanceHeadWriteCooldown(fixture, scenario.request);
    expect(
      await fixture.records.replaceHead(
        originalHead.observation,
        scenario.competingHead,
      ),
    ).toEqual({ kind: "confirmed" });

    const recovered = await createStore(fixture).resumeOperation({
      vaultId,
      operationId: scenario.request.operationId,
    });
    expect(recovered).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId: scenario.request.operationId,
    });
    const journal = await fixture.publication.readJournal(
      vaultId,
      scenario.request.operationId,
    );
    expect(journal).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: {
            step: "create_event",
            outcomeIntent: "aborted",
            attempt: { state: "ready", generation: 0 },
          },
        },
      },
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      ),
    ).toEqual({ kind: "absent" });
    expect(
      fixture.bucket.putAttempts.filter((attempt) => attempt.key === headKey),
    ).toHaveLength(headWritesBeforeCompetitor + 1);
    expect(
      await fixture.publication.readHeadRefusalReceipt(
        vaultId,
        scenario.request.operationId,
      ),
    ).toEqual({ kind: "absent" });

    expect(
      await settleResume(createStore(fixture), fixture, scenario.request),
    ).toEqual({ kind: "error", code: "stale_revision" });
    expect(
      fixture.bucket.putAttempts.filter((attempt) => attempt.key === headKey),
    ).toHaveLength(headWritesBeforeCompetitor + 1);
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      ),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          kind: "aborted",
          operationId: scenario.request.operationId,
          reason: "stale_revision",
        },
      },
    });
  });

  it("keeps a ready-head abort blocked when its stale competitor changes to the requested parent", async () => {
    const fixture = await setup();
    const scenario = await prepareCurrentHeadCasScenario(fixture);
    await advanceToHeadWrite(createStore(fixture), fixture, scenario.request);
    const originalHead = await fixture.records.readHead(vaultId, path);
    expect(originalHead.kind).toBe("observed");
    if (originalHead.kind !== "observed") return;
    await advanceHeadWriteCooldown(fixture, scenario.request);
    expect(
      await fixture.records.replaceHead(
        originalHead.observation,
        scenario.competingHead,
      ),
    ).toEqual({ kind: "confirmed" });
    expect(
      await createStore(fixture).resumeOperation({
        vaultId,
        operationId: scenario.request.operationId,
      }),
    ).toMatchObject({ kind: "error", code: "operation_pending" });

    const competitor = await fixture.records.readHead(vaultId, path);
    expect(competitor.kind).toBe("observed");
    if (competitor.kind !== "observed") return;
    fixture.setNow(
      Math.max(
        fixture.now(),
        competitor.observation.observed.uploaded.getTime() + 1_100,
      ),
    );
    expect(
      await fixture.records.replaceHead(
        competitor.observation,
        originalHead.observation.value,
      ),
    ).toEqual({ kind: "confirmed" });
    const eventKey = syncFeedEventKey(
      vaultId,
      fixture.lane,
      FIRST_EVENT_SEQUENCE,
    );
    const eventWritesBeforeRecovery = fixture.bucket.putAttempts.filter(
      (attempt) => attempt.key === eventKey,
    ).length;

    expect(
      await createStore(fixture).resumeOperation({
        vaultId,
        operationId: scenario.request.operationId,
      }),
    ).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId: scenario.request.operationId,
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      ),
    ).toEqual({ kind: "absent" });
    expect(
      fixture.bucket.putAttempts.filter((attempt) => attempt.key === eventKey),
    ).toHaveLength(eventWritesBeforeRecovery);
    expect(
      await fixture.publication.readJournal(
        vaultId,
        scenario.request.operationId,
      ),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          stepEvidence: {
            step: "create_event",
            outcomeIntent: "aborted",
            attempt: { state: "ready", generation: 0 },
          },
        },
      },
    });
  });

  it("restarts from an unclaimed stale-parent shortcut and publishes only its abort event", async () => {
    const fixture = await setup();
    const initialContent = "Current generation";
    await seedLiveHead(fixture, initialContent);
    const changedContent = "Stale replacement";
    const request: SyncMutationRequest = {
      kind: "update",
      vaultId,
      path,
      operationId: recoveryOperationId,
      revision: updatedRevision,
      parent: { kind: "revision", revision: tombstoneRevision },
      contentSha256: await sha256Content(changedContent),
      content: changedContent,
      mediaType: "text/markdown",
      origin,
    };
    const targetContentKey = syncContentKey(vaultId, updatedRevision);
    const targetVersionKey = syncVersionKey(vaultId, updatedRevision);
    const currentHeadKey = syncHeadKey(vaultId, path);
    const originalHeadWrites = fixture.bucket.puts.filter(
      (key) => key === currentHeadKey,
    ).length;

    const shortcut = await persistStaleParentShortcut(fixture, request);
    expect(shortcut.stepEvidence).toMatchObject({
      step: "create_event",
      outcomeIntent: "aborted",
      committedAtEpochMs: expect.any(Number),
      attempt: { state: "ready", generation: 0 },
    });
    if (shortcut.stepEvidence.step !== "create_event") return;
    expect(shortcut.stepEvidence.committedAtEpochMs).toBeGreaterThan(
      shortcut.reservation.previousCommittedAtEpochMs,
    );
    const eventKey = syncFeedEventKey(
      vaultId,
      shortcut.reservation.lane,
      shortcut.reservation.sequence,
    );
    expect(
      await fixture.publication.readEvent(
        vaultId,
        shortcut.reservation.lane,
        shortcut.reservation.sequence,
      ),
    ).toEqual({ kind: "absent" });
    expect(fixture.bucket.puts).not.toContain(targetContentKey);
    expect(fixture.bucket.puts).not.toContain(targetVersionKey);
    expect(
      fixture.bucket.puts.filter((key) => key === currentHeadKey),
    ).toHaveLength(originalHeadWrites);

    const result = await settleResume(createStore(fixture), fixture, request);

    expect(result).toEqual({ kind: "error", code: "stale_revision" });
    expect(
      await createStore(fixture).readCurrent({ vaultId, path }),
    ).toMatchObject({
      kind: "live",
      revision,
      operationId,
    });
    const event = await fixture.publication.readEvent(
      vaultId,
      fixture.lane,
      shortcut.reservation.sequence,
    );
    expect(event.kind).toBe("observed");
    if (event.kind !== "observed") return;
    expect(event.observation.value).toMatchObject({
      kind: "aborted",
      operationId: recoveryOperationId,
      reason: "stale_revision",
      committedAtEpochMs: shortcut.stepEvidence.committedAtEpochMs,
    });
    const terminal = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(terminal).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "aborted",
          reason: "stale_revision",
          committedAtEpochMs: shortcut.stepEvidence.committedAtEpochMs,
          position: {
            lane: shortcut.reservation.lane,
            sequence: shortcut.reservation.sequence,
          },
        },
      },
    });
    const lane = await fixture.publication.readLaneHead(
      vaultId,
      shortcut.reservation.lane,
    );
    expect(lane).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          committedSequence: shortcut.reservation.sequence,
          committedAtEpochMs: shortcut.stepEvidence.committedAtEpochMs,
        },
      },
    });
    if (lane.kind !== "observed") return;
    expect(lane.observation.value.pending).toBeUndefined();
    expect(fixture.bucket.puts).not.toContain(targetContentKey);
    expect(fixture.bucket.puts).not.toContain(targetVersionKey);
    expect(
      fixture.bucket.puts.filter((key) => key === currentHeadKey),
    ).toHaveLength(originalHeadWrites);
    expect(fixture.bucket.puts.filter((key) => key === eventKey)).toHaveLength(
      1,
    );
  });

  it("keeps an exact pre-existing abort unknown after its now-valid owned head appears", async () => {
    const fixture = await setup();
    await seedLiveHead(fixture, "Current generation");
    const content = "Stale replacement now visible as current";
    const request: SyncMutationRequest = {
      kind: "update",
      vaultId,
      path,
      operationId: recoveryOperationId,
      revision: updatedRevision,
      parent: { kind: "revision", revision: tombstoneRevision },
      contentSha256: await sha256Content(content),
      content,
      mediaType: "text/markdown",
      origin,
    };
    const shortcut = await persistStaleParentShortcut(fixture, request);
    expect(shortcut.stepEvidence).toMatchObject({ outcomeIntent: "aborted" });
    if (shortcut.stepEvidence.step !== "create_event") return;

    const bytes = encoder.encode(content);
    const ownHead: SyncHeadRecord = {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      kind: "live",
      path,
      revision: updatedRevision,
      parent: request.parent,
      contentSha256: request.contentSha256,
      byteSize: bytes.byteLength,
      mediaType: "text/markdown",
      operationId: recoveryOperationId,
      origin,
    };
    const ownBody: Extract<SyncBodyRecord, { readonly kind: "contentBody" }> = {
      kind: "contentBody",
      vaultId,
      revision: updatedRevision,
      bytes,
      byteSize: bytes.byteLength,
      contentSha256: request.contentSha256,
    };
    fixture.bucket.seed(
      syncContentKey(vaultId, updatedRevision),
      await encodeSyncRecord({ kind: "contentBody", record: ownBody }),
      fixture.now(),
    );
    fixture.bucket.seed(
      syncVersionKey(vaultId, updatedRevision),
      await encodeSyncRecord({ kind: "version", record: ownHead }),
      fixture.now(),
    );
    fixture.bucket.seed(
      syncHeadKey(vaultId, path),
      await encodeSyncRecord({ kind: "head", record: ownHead }),
      fixture.now(),
    );
    expect(
      await fixture.records.readContent(vaultId, updatedRevision),
    ).toMatchObject({ kind: "observed", observation: { value: ownBody } });
    expect(
      await fixture.records.readVersion(vaultId, updatedRevision),
    ).toMatchObject({ kind: "observed", observation: { value: ownHead } });
    expect(await fixture.records.readHead(vaultId, path)).toMatchObject({
      kind: "observed",
      observation: { value: ownHead },
    });

    const eventKey = syncFeedEventKey(
      vaultId,
      shortcut.reservation.lane,
      shortcut.reservation.sequence,
    );
    const exactAbortedEvent: SyncFeedEventRecord = {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      kind: "aborted",
      lane: shortcut.reservation.lane,
      sequence: shortcut.reservation.sequence,
      operationId: recoveryOperationId,
      reason: "stale_revision",
      committedAtEpochMs: shortcut.stepEvidence.committedAtEpochMs,
    };
    fixture.bucket.seed(
      eventKey,
      await encodeSyncPublication(exactAbortedEvent),
      fixture.now(),
    );

    expect(
      await createStore(fixture).resumeOperation({
        vaultId,
        operationId: recoveryOperationId,
      }),
    ).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId: recoveryOperationId,
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        shortcut.reservation.lane,
        shortcut.reservation.sequence,
      ),
    ).toMatchObject({
      kind: "observed",
      observation: { value: exactAbortedEvent },
    });
    expect(
      await fixture.publication.readJournal(vaultId, recoveryOperationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: {
            step: "create_event",
            outcomeIntent: "aborted",
            attempt: { state: "ready", generation: 0 },
          },
        },
      },
    });
    const lane = await fixture.publication.readLaneHead(
      vaultId,
      shortcut.reservation.lane,
    );
    expect(lane).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          pending: {
            operationId: recoveryOperationId,
            nextSequence: shortcut.reservation.sequence,
          },
        },
      },
    });
    expect(fixture.bucket.puts.filter((key) => key === eventKey)).toHaveLength(
      0,
    );
  });

  it("keeps a colliding event unknown after a stale-parent shortcut restart", async () => {
    const fixture = await setup();
    await seedLiveHead(fixture, "Current generation");
    const content = "Stale replacement with collision";
    const request: SyncMutationRequest = {
      kind: "update",
      vaultId,
      path,
      operationId: recoveryOperationId,
      revision: updatedRevision,
      parent: { kind: "revision", revision: tombstoneRevision },
      contentSha256: await sha256Content(content),
      content,
      mediaType: "text/markdown",
      origin,
    };
    const shortcut = await persistStaleParentShortcut(fixture, request);
    if (shortcut.stepEvidence.step !== "create_event") return;
    const eventKey = syncFeedEventKey(
      vaultId,
      shortcut.reservation.lane,
      shortcut.reservation.sequence,
    );
    fixture.bucket.seed(
      eventKey,
      await encodeSyncPublication({
        schemaVersion: 1,
        protocolMajor: 1,
        vaultId,
        kind: "aborted",
        lane: shortcut.reservation.lane,
        sequence: shortcut.reservation.sequence,
        operationId: recoveryOperationId,
        reason: "stale_revision",
        committedAtEpochMs: shortcut.stepEvidence.committedAtEpochMs + 1,
      }),
      fixture.now() - 5_000,
    );

    expect(
      await createStore(fixture).resumeOperation({
        vaultId,
        operationId: recoveryOperationId,
      }),
    ).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId: recoveryOperationId,
    });
    const persisted = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(persisted).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          stepEvidence: {
            step: "create_event",
            outcomeIntent: "aborted",
            committedAtEpochMs: shortcut.stepEvidence.committedAtEpochMs,
            attempt: { state: "ready", generation: 0 },
          },
        },
      },
    });
    expect(fixture.bucket.puts.filter((key) => key === eventKey)).toHaveLength(
      0,
    );
  });

  it("commits tombstones only after preserving exact source recovery bytes", async () => {
    const fixture = await setup();
    const content = "Exact tombstone source 🌐";
    await seedLiveHead(fixture, content);
    const measured = createMeasuredStore(fixture);
    const store = measured.store;
    const bucketCallsBefore =
      fixture.bucket.gets.length + fixture.bucket.puts.length;
    const request: SyncMutationRequest = {
      kind: "tombstone",
      vaultId,
      path,
      operationId: recoveryOperationId,
      revision: tombstoneRevision,
      parent: { kind: "revision", revision },
      contentSha256: await sha256Content(content),
      origin: alternateOrigin,
    };

    const result = await settleMutation(store, fixture, request);
    expect(result).toMatchObject({
      kind: "committed",
      revision: tombstoneRevision,
    });
    expectInvocationCallsToMatchBucket(
      fixture,
      measured.invocations,
      bucketCallsBefore,
    );
    expect(
      fixture.bucket.gets.filter((key) => key === syncVaultMarkerKey(vaultId)),
    ).not.toHaveLength(0);
    expect(
      fixture.bucket.gets.filter(
        (key) => key === syncContentKey(vaultId, revision),
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(await store.readCurrent({ vaultId, path })).toMatchObject({
      kind: "tombstone",
      revision: tombstoneRevision,
      operationId: recoveryOperationId,
      origin: alternateOrigin,
    });
    expect(hasRecoveryRead(store)).toBe(true);
    if (!hasRecoveryRead(store)) return;
    expect(
      await store.readRecovery({ vaultId, operationId: recoveryOperationId }),
    ).toMatchObject({
      kind: "present",
      recovery: {
        sourceRevision: revision,
        contentSha256: await sha256Content(content),
        byteSize: encoder.encode(content).byteLength,
        content,
        origin,
      },
    });
  });

  it("keeps a losing lane CAS unallocated and resumes the same ID after release", async () => {
    const fixture = await setup();
    await seedEmptyLaneHead(fixture);
    const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
    let releaseBlockedPut: (() => void) | undefined;
    let signalBlockedPut: (() => void) | undefined;
    const blockedPut = new Promise<void>((resolve) => {
      releaseBlockedPut = resolve;
    });
    const reachedBlockedPut = new Promise<void>((resolve) => {
      signalBlockedPut = resolve;
    });
    fixture.bucket.beforeNextPut(laneKey, "replace", async () => {
      signalBlockedPut?.();
      await blockedPut;
    });

    const loserRequest: SyncMutationRequest = {
      kind: "create",
      vaultId,
      path,
      operationId: recoveryOperationId,
      revision: updatedRevision,
      parent: { kind: "never_seen" },
      contentSha256: await sha256Content("Lane loser"),
      content: "Lane loser",
      mediaType: "text/markdown",
      origin,
    };
    const winnerRequest: SyncMutationRequest = {
      kind: "create",
      vaultId,
      path,
      operationId,
      revision,
      parent: { kind: "never_seen" },
      contentSha256: await sha256Content("Lane winner"),
      content: "Lane winner",
      mediaType: "text/markdown",
      origin,
    };
    const loserStore = createStore(fixture);
    const loserFirst = await loserStore.mutate(loserRequest);
    expect(loserFirst).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId: recoveryOperationId,
    });
    if (loserFirst.kind !== "error" || !("retryAfterEpochMs" in loserFirst)) {
      return;
    }
    fixture.setNow(loserFirst.retryAfterEpochMs);
    const blockedLoserAttempt = loserStore.resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });
    await reachedBlockedPut;

    try {
      const winnerStore = createStore(fixture);
      const winnerFirst = await winnerStore.mutate(winnerRequest);
      expect(winnerFirst).toMatchObject({
        kind: "error",
        code: "operation_pending",
        operationId,
      });
      if (
        winnerFirst.kind !== "error" ||
        !("retryAfterEpochMs" in winnerFirst)
      ) {
        return;
      }
      fixture.setNow(winnerFirst.retryAfterEpochMs);
      expect(
        await winnerStore.resumeOperation({ vaultId, operationId }),
      ).toMatchObject({
        kind: "error",
        code: "operation_pending",
        operationId,
      });
    } finally {
      releaseBlockedPut?.();
    }

    expect(await blockedLoserAttempt).toEqual({
      kind: "error",
      code: "operation_pending",
      operationId: recoveryOperationId,
    });
    const loserJournal = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(loserJournal.kind).toBe("observed");
    if (loserJournal.kind !== "observed") return;
    expect(loserJournal.observation.value).toMatchObject({
      status: "pending",
      allocationState: "unallocated",
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({ kind: "absent" });
    expect(await createStore(fixture).readCurrent({ vaultId, path })).toEqual({
      kind: "never_seen",
    });
    const reservedLane = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(reservedLane.kind).toBe("observed");
    if (reservedLane.kind !== "observed") return;
    expect(reservedLane.observation.value.pending?.operationId).toBe(
      operationId,
    );

    expect(await createStore(fixture).mutate(loserRequest)).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId: recoveryOperationId,
    });
    expect(
      await settleResume(createStore(fixture), fixture, winnerRequest),
    ).toMatchObject({ kind: "committed", operationId });
    expect(
      await settleMutation(createStore(fixture), fixture, loserRequest),
    ).toEqual({ kind: "error", code: "stale_revision" });

    const firstEvent = await fixture.publication.readEvent(
      vaultId,
      fixture.lane,
      syncEventSequenceSchema.parse("00000000000000000001"),
    );
    const secondEvent = await fixture.publication.readEvent(
      vaultId,
      fixture.lane,
      syncEventSequenceSchema.parse("00000000000000000002"),
    );
    expect(firstEvent.kind).toBe("observed");
    if (firstEvent.kind !== "observed") return;
    expect(firstEvent.observation.value).toMatchObject({
      kind: "changed",
      operationId,
      result: { kind: "live", revision },
    });
    expect(secondEvent.kind).toBe("observed");
    if (secondEvent.kind !== "observed") return;
    expect(secondEvent.observation.value).toMatchObject({
      kind: "aborted",
      operationId: recoveryOperationId,
      reason: "stale_revision",
    });
    expect(
      fixture.bucket.puts.filter((key) => key === syncHeadKey(vaultId, path)),
    ).toHaveLength(1);
    expect(
      await createStore(fixture).readCurrent({ vaultId, path }),
    ).toMatchObject({
      kind: "live",
      revision,
      operationId,
    });
  });

  it("reconstructs an applied lane reservation after its response and read-back are lost", async () => {
    const fixture = await setup();
    await seedEmptyLaneHead(fixture);
    const store = createStore(fixture);
    const content = "Recovered lane reservation";
    const request: SyncMutationRequest = {
      kind: "create",
      vaultId,
      path,
      operationId: recoveryOperationId,
      revision: updatedRevision,
      parent: { kind: "never_seen" },
      contentSha256: await sha256Content(content),
      content,
      mediaType: "text/markdown",
      origin,
    };
    const initial = await store.mutate(request);
    expect(initial).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId: recoveryOperationId,
    });
    if (initial.kind !== "error" || !("retryAfterEpochMs" in initial)) {
      return;
    }

    const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
    fixture.setNow(initial.retryAfterEpochMs);
    const laneBeforeReservation = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(laneBeforeReservation.kind).toBe("observed");
    if (laneBeforeReservation.kind !== "observed") return;
    const originalLaneEtag = laneBeforeReservation.observation.observed.etag;
    fixture.bucket.applyThenLoseResponse(laneKey, "replace", 2);

    const interrupted = await store.resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });
    const reservationAttempts = fixture.bucket.putAttempts.filter(
      ({ key, phase }) => key === laneKey && phase === "replace",
    );
    expect(reservationAttempts).toHaveLength(1);
    const reservationAttempt = reservationAttempts[0];
    expect(reservationAttempt).toBeDefined();
    if (reservationAttempt === undefined) return;
    expect(reservationAttempt.etagMatches).toBe(originalLaneEtag);
    expect(
      fixture.bucket.appliedThenLostResponses.filter(
        ({ key, phase }) => key === laneKey && phase === "replace",
      ),
    ).toHaveLength(1);
    expect(interrupted).toMatchObject({
      kind: "error",
      code: "effect_unknown",
      operationId: recoveryOperationId,
    });
    if (interrupted.kind !== "error" || !("retryAfterEpochMs" in interrupted)) {
      return;
    }

    const crashJournal = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(crashJournal.kind).toBe("observed");
    if (crashJournal.kind !== "observed") return;
    expect(crashJournal.observation.value).toMatchObject({
      status: "pending",
      allocationState: "unallocated",
      operationId: recoveryOperationId,
      lane: fixture.lane,
      laneObservation: { retryAfterEpochMs: interrupted.retryAfterEpochMs },
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({ kind: "absent" });
    expect(await createStore(fixture).readCurrent({ vaultId, path })).toEqual({
      kind: "never_seen",
    });
    const reservedLane = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(reservedLane.kind).toBe("observed");
    if (reservedLane.kind !== "observed") return;
    expect(reservedLane.observation.value).toMatchObject({
      committedSequence: "00000000000000000000",
      committedAtEpochMs: 0,
      pending: {
        operationId: recoveryOperationId,
        nextSequence: "00000000000000000001",
      },
    });
    expect(reservedLane.observation.observed.bytes).toEqual(
      reservationAttempt.bytes,
    );

    fixture.setNow(interrupted.retryAfterEpochMs);
    expect(
      await createStore(fixture).resumeOperation({
        vaultId,
        operationId: recoveryOperationId,
      }),
    ).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId: recoveryOperationId,
    });
    const allocatedJournal = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(allocatedJournal.kind).toBe("observed");
    if (allocatedJournal.kind !== "observed") return;
    expect(allocatedJournal.observation.value).toMatchObject({
      status: "pending",
      allocationState: "allocated",
      reservation: {
        lane: fixture.lane,
        sequence: "00000000000000000001",
        previousCommittedAtEpochMs: 0,
      },
      stepEvidence: { step: "immutable_create" },
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({ kind: "absent" });
    expect(await createStore(fixture).readCurrent({ vaultId, path })).toEqual({
      kind: "never_seen",
    });

    expect(await settleResume(createStore(fixture), fixture, request)).toEqual({
      kind: "committed",
      revision: updatedRevision,
      operationId: recoveryOperationId,
      position: { lane: fixture.lane, sequence: "00000000000000000001" },
    });
    const finalEvent = await fixture.publication.readEvent(
      vaultId,
      fixture.lane,
      syncEventSequenceSchema.parse("00000000000000000001"),
    );
    expect(finalEvent.kind).toBe("observed");
    if (finalEvent.kind !== "observed") return;
    expect(finalEvent.observation.value).toMatchObject({
      kind: "changed",
      operationId: recoveryOperationId,
      sequence: "00000000000000000001",
      result: { kind: "live", revision: updatedRevision },
    });
    const committedLane = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(committedLane.kind).toBe("observed");
    if (committedLane.kind !== "observed") return;
    expect(committedLane.observation.value).toMatchObject({
      committedSequence: "00000000000000000001",
    });
    expect(committedLane.observation.value.pending).toBeUndefined();
  });

  it("serializes concurrent same-ID resumptions of their pending lane marker", async () => {
    const fixture = await setup();
    await seedEmptyLaneHead(fixture);
    const request = await createMutationRequest("Concurrent same-ID resume");
    const originalLane = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(originalLane.kind).toBe("observed");
    if (originalLane.kind !== "observed") return;

    const journal = unallocatedJournalForRequest(request, fixture.lane, {
      kind: "observed",
      etag: originalLane.observation.observed.etag,
      bytes: encodeBase64Url(originalLane.observation.observed.bytes),
      uploadedAtEpochMs: originalLane.observation.observed.uploaded.getTime(),
    });
    expect(await fixture.publication.createJournal(journal)).toEqual({
      kind: "confirmed",
    });

    fixture.setNow(fixture.now() + 1_100);
    expect(
      await fixture.publication.replaceLaneHead(originalLane.observation, {
        ...originalLane.observation.value,
        pending: {
          operationId,
          nextSequence: syncEventSequenceSchema.parse("00000000000000000001"),
        },
      }),
    ).toEqual({ kind: "confirmed" });
    fixture.setNow(fixture.now() + 1_100);

    const journalKey = syncOperationKey(vaultId, operationId);
    fixture.bucket.barrierNextGets(journalKey, 2);
    const resumers = [createStore(fixture), createStore(fixture)];
    const outcomes = await Promise.all(
      resumers.map((store) => store.resumeOperation({ vaultId, operationId })),
    );
    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.kind).toBe("error");
      if (outcome.kind !== "error") return;
      expect(["operation_pending", "effect_unknown"]).toContain(outcome.code);
    }

    const allocated = await fixture.publication.readJournal(
      vaultId,
      operationId,
    );
    expect(allocated.kind).toBe("observed");
    if (allocated.kind !== "observed") return;
    expect(allocated.observation.value).toMatchObject({
      status: "pending",
      allocationState: "allocated",
      reservation: {
        lane: fixture.lane,
        sequence: "00000000000000000001",
        previousCommittedAtEpochMs: 0,
      },
      stepEvidence: { step: "immutable_create" },
    });
    const pendingLane = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(pendingLane.kind).toBe("observed");
    if (pendingLane.kind !== "observed") return;
    expect(pendingLane.observation.value.pending).toEqual({
      operationId,
      nextSequence: "00000000000000000001",
    });
    expect(await createStore(fixture).readCurrent({ vaultId, path })).toEqual({
      kind: "never_seen",
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({ kind: "absent" });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000002"),
      ),
    ).toEqual({ kind: "absent" });

    expect(await settleResume(createStore(fixture), fixture, request)).toEqual({
      kind: "committed",
      revision,
      operationId,
      position: { lane: fixture.lane, sequence: "00000000000000000001" },
    });
    const terminalJournal = await fixture.publication.readJournal(
      vaultId,
      operationId,
    );
    expect(terminalJournal).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "committed",
          reservation: { sequence: "00000000000000000001" },
        },
      },
    });
    const event = await fixture.publication.readEvent(
      vaultId,
      fixture.lane,
      syncEventSequenceSchema.parse("00000000000000000001"),
    );
    expect(event).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          kind: "changed",
          operationId,
          sequence: "00000000000000000001",
          result: { kind: "live", revision },
        },
      },
    });
    expect(
      await createStore(fixture).readCurrent({ vaultId, path }),
    ).toMatchObject({ kind: "live", revision, operationId });
    const committedLane = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(committedLane).toMatchObject({
      kind: "observed",
      observation: {
        value: { committedSequence: "00000000000000000001" },
      },
    });
    if (committedLane.kind !== "observed") return;
    expect(committedLane.observation.value.pending).toBeUndefined();
    expect(
      fixture.bucket.puts.filter((key) => key === syncHeadKey(vaultId, path)),
    ).toHaveLength(1);
    expect(
      fixture.bucket.puts.filter(
        (key) =>
          key ===
          syncFeedEventKey(
            vaultId,
            fixture.lane,
            syncEventSequenceSchema.parse("00000000000000000001"),
          ),
      ),
    ).toHaveLength(1);
  });

  it.each(["journal", "lane"] as const)(
    "does not terminalize the %s with an invalid server clock",
    async (boundary) => {
      const fixture = await setup();
      const request = await createMutationRequest(`Terminal clock ${boundary}`);
      if (boundary === "journal")
        await advanceToJournalCommit(createStore(fixture), fixture, request);
      else
        await advanceToTerminalLaneCommit(
          createStore(fixture),
          fixture,
          request,
        );
      const before = await fixture.publication.readJournal(
        vaultId,
        operationId,
      );
      if (before.kind !== "observed")
        throw new Error("Expected terminalization boundary");
      const epoch = fixture.now();
      const writes = fixture.bucket.putAttempts.length;
      fixture.setNow(Number.NaN);
      expect(
        await createStore(fixture).resumeOperation({ vaultId, operationId }),
      ).toEqual({ kind: "error", code: "effect_unknown", operationId });
      expect(fixture.bucket.putAttempts).toHaveLength(writes);
      const after = await fixture.publication.readJournal(vaultId, operationId);
      if (after.kind !== "observed")
        throw new Error("Expected unchanged terminalization authority");
      expect(after.observation.observed.bytes).toEqual(
        before.observation.observed.bytes,
      );
      fixture.setNow(epoch + 1_100);
      expect(
        await settleResume(createStore(fixture), fixture, request),
      ).toMatchObject({ kind: "committed", operationId, revision });
    },
  );

  it("persists a delayed lane timeout's floor only after the terminal journal's own cooldown", async () => {
    const fixture = await setup();
    const request = await createMutationRequest("Delayed lane timeout");
    await advanceToTerminalLaneCommit(createStore(fixture), fixture, request);
    fixture.setNow(fixture.now() + 1_100);
    const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
    fixture.bucket.beforeNextPut(laneKey, "replace", async () => {
      fixture.setNow(fixture.now() + 1_100);
      throw new Error("Lane target still absent after delayed timeout");
    });
    const result = await createStore(fixture).resumeOperation({
      vaultId,
      operationId,
    });
    expect(result).toEqual({
      kind: "error",
      code: "operation_pending",
      operationId,
      retryAfterEpochMs: fixture.now() + 1_100,
    });
    const journal = await fixture.publication.readJournal(vaultId, operationId);
    expect(journal).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "committed",
          stepEvidence: {
            step: "commit_lane",
            retryAfterEpochMs: fixture.now() + 1_100,
          },
        },
      },
    });
    expect(
      await fixture.publication.readLaneHead(vaultId, fixture.lane),
    ).toMatchObject({
      kind: "observed",
      observation: { value: { pending: { operationId } } },
    });
    fixture.setNow(fixture.now() + 1_100);
    expect(
      await settleResume(createStore(fixture), fixture, request),
    ).toMatchObject({ kind: "committed", operationId, revision });
  });

  it("withholds completion when the released lane has the right sequence but the wrong exact clock", async () => {
    const fixture = await setup();
    const request = await createMutationRequest(
      "Mismatched terminal lane clock",
    );
    await advanceToTerminalLaneCommit(createStore(fixture), fixture, request);
    const journal = await fixture.publication.readJournal(vaultId, operationId);
    if (
      journal.kind !== "observed" ||
      journal.observation.value.status === "pending"
    )
      throw new Error("Expected terminal journal");
    const terminal = journal.observation.value;
    const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
    const committedLane: SyncLaneHeadRecord = {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      kind: "laneHead",
      lane: fixture.lane,
      committedSequence: terminal.reservation.sequence,
      committedAtEpochMs: terminal.committedAtEpochMs,
    };
    fixture.bucket.seed(
      laneKey,
      await encodeSyncPublication({
        ...committedLane,
        committedAtEpochMs: terminal.committedAtEpochMs + 1,
      }),
      fixture.now(),
    );
    const writes = fixture.bucket.putAttempts.length;
    expect(
      await createStore(fixture).resumeOperation({ vaultId, operationId }),
    ).toEqual({ kind: "error", code: "effect_unknown", operationId });
    expect(fixture.bucket.putAttempts).toHaveLength(writes);
    fixture.bucket.seed(
      laneKey,
      await encodeSyncPublication(committedLane),
      fixture.now(),
    );
    expect(
      await createStore(fixture).resumeOperation({ vaultId, operationId }),
    ).toMatchObject({ kind: "committed", operationId, revision });
    expect(fixture.bucket.putAttempts).toHaveLength(writes);
  });

  it("does not expose terminal success when the current head disappears during lane release read-back", async () => {
    const fixture = await setup();
    const request = await createMutationRequest(
      "Head lost during terminal readback",
    );
    await advanceToTerminalLaneCommit(createStore(fixture), fixture, request);
    fixture.setNow(fixture.now() + 1_100);
    const headKey = syncHeadKey(vaultId, path);
    const original = fixture.bucket.objects.get(headKey);
    if (!original) throw new Error("Expected complete current head");
    fixture.bucket.afterNextPut(
      syncFeedLaneHeadKey(vaultId, fixture.lane),
      "replace",
      async () => {
        fixture.bucket.objects.delete(headKey);
      },
    );
    expect(
      await createStore(fixture).resumeOperation({ vaultId, operationId }),
    ).toEqual({ kind: "error", code: "effect_unknown", operationId });
    expect(
      await fixture.publication.readLaneHead(vaultId, fixture.lane),
    ).toMatchObject({
      kind: "observed",
      observation: { value: { committedSequence: FIRST_EVENT_SEQUENCE } },
    });
    const writes = fixture.bucket.putAttempts.length;
    fixture.bucket.objects.set(headKey, original);
    expect(
      await createStore(fixture).resumeOperation({ vaultId, operationId }),
    ).toMatchObject({ kind: "committed", operationId, revision });
    expect(fixture.bucket.putAttempts).toHaveLength(writes);
  });

  it("withholds terminal success until an uncertain lane commit is exactly reread", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const content = "Verified terminal lane commit";
    const request: SyncMutationRequest = {
      kind: "create",
      vaultId,
      path,
      operationId,
      revision,
      parent: { kind: "never_seen" },
      contentSha256: await sha256Content(content),
      content,
      mediaType: "text/markdown",
      origin,
    };
    let result = await store.mutate(request);
    let terminalLaneCommitReady = false;
    for (
      let attempt = 0;
      attempt < 40 && !terminalLaneCommitReady;
      attempt += 1
    ) {
      const journal = await fixture.publication.readJournal(
        vaultId,
        operationId,
      );
      terminalLaneCommitReady =
        journal.kind === "observed" &&
        journal.observation.value.status !== "pending" &&
        journal.observation.value.stepEvidence.step === "commit_lane";
      if (terminalLaneCommitReady) break;

      const retryAfter =
        result.kind === "error" && "retryAfterEpochMs" in result
          ? result.retryAfterEpochMs
          : 0;
      fixture.setNow(Math.max(fixture.now() + 1_100, retryAfter));
      result = await store.resumeOperation({ vaultId, operationId });
    }
    expect(terminalLaneCommitReady).toBe(true);

    const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
    const laneBeforeCommit = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(laneBeforeCommit.kind).toBe("observed");
    if (laneBeforeCommit.kind !== "observed") return;
    expect(laneBeforeCommit.observation.value.pending?.operationId).toBe(
      operationId,
    );
    const laneCommitEtag = laneBeforeCommit.observation.observed.etag;
    const laneCommitAttemptsBefore = fixture.bucket.putAttempts.filter(
      ({ key, phase }) => key === laneKey && phase === "replace",
    ).length;
    fixture.bucket.applyThenLoseResponse(laneKey, "replace", 2);

    let uncertain: SyncMutationResult | undefined;
    for (
      let attempt = 0;
      attempt < 4 &&
      fixture.bucket.putAttempts.filter(
        ({ key, phase }) => key === laneKey && phase === "replace",
      ).length === laneCommitAttemptsBefore;
      attempt += 1
    ) {
      const retryAfter =
        result.kind === "error" && "retryAfterEpochMs" in result
          ? result.retryAfterEpochMs
          : 0;
      fixture.setNow(Math.max(fixture.now() + 1_100, retryAfter));
      uncertain = await store.resumeOperation({ vaultId, operationId });
      result = uncertain;
    }
    const laneCommitAttempts = fixture.bucket.putAttempts.filter(
      ({ key, phase }) => key === laneKey && phase === "replace",
    );
    expect(laneCommitAttempts).toHaveLength(laneCommitAttemptsBefore + 1);
    const laneCommitAttempt = laneCommitAttempts[laneCommitAttemptsBefore];
    expect(laneCommitAttempt).toBeDefined();
    if (laneCommitAttempt === undefined) return;
    expect(laneCommitAttempt.etagMatches).toBe(laneCommitEtag);
    expect(
      fixture.bucket.appliedThenLostResponses.filter(
        ({ key, phase }) => key === laneKey && phase === "replace",
      ),
    ).toHaveLength(1);
    expect(uncertain).toMatchObject({
      kind: "error",
      code: "effect_unknown",
      operationId,
    });
    if (uncertain?.kind !== "error" || !("retryAfterEpochMs" in uncertain)) {
      return;
    }

    const terminalJournal = await fixture.publication.readJournal(
      vaultId,
      operationId,
    );
    expect(terminalJournal.kind).toBe("observed");
    if (terminalJournal.kind !== "observed") return;
    const terminal = terminalJournal.observation.value;
    expect(terminal).toMatchObject({
      status: "committed",
      revision,
      stepEvidence: { step: "commit_lane" },
    });
    if (terminal.status !== "committed") return;
    const terminalEvent = await fixture.publication.readEvent(
      vaultId,
      fixture.lane,
      syncEventSequenceSchema.parse("00000000000000000001"),
    );
    expect(terminalEvent.kind).toBe("observed");
    if (terminalEvent.kind !== "observed") return;
    expect(terminalEvent.observation.value).toMatchObject({
      kind: "changed",
      operationId,
      sequence: "00000000000000000001",
      result: { kind: "live", revision },
    });
    expect(
      await createStore(fixture).readCurrent({ vaultId, path }),
    ).toMatchObject({
      kind: "live",
      revision,
      operationId,
    });
    const committedLane = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(committedLane.kind).toBe("observed");
    if (committedLane.kind !== "observed") return;
    expect(committedLane.observation.value).toMatchObject({
      committedSequence: "00000000000000000001",
      committedAtEpochMs: terminal.committedAtEpochMs,
    });
    expect(committedLane.observation.value.pending).toBeUndefined();
    expect(committedLane.observation.observed.bytes).toEqual(
      laneCommitAttempt.bytes,
    );

    fixture.setNow(uncertain.retryAfterEpochMs);
    const measuredRecovery = createMeasuredStore(fixture);
    const recoveryCallsBefore =
      fixture.bucket.gets.length + fixture.bucket.puts.length;
    expect(
      await measuredRecovery.store.resumeOperation({ vaultId, operationId }),
    ).toEqual({
      kind: "committed",
      revision,
      operationId,
      position: { lane: fixture.lane, sequence: "00000000000000000001" },
    });
    expectInvocationCallsToMatchBucket(
      fixture,
      measuredRecovery.invocations,
      recoveryCallsBefore,
    );
  });

  it.each(["cooldown", "lost_cas_response"] as const)(
    "recovers a verified head-refusal receipt through %s without another head PUT",
    async (boundary) => {
      const fixture = await setup();
      const scenario = await prepareCurrentHeadCasScenario(fixture);
      await advanceToHeadWrite(createStore(fixture), fixture, scenario.request);
      await advanceHeadWriteCooldown(fixture, scenario.request);
      const headKey = syncHeadKey(vaultId, path);
      fixture.bucket.beforeNextPut(headKey, "replace", async () => {
        const current = await fixture.records.readHead(vaultId, path);
        if (current.kind !== "observed")
          throw new Error("Expected original parent generation");
        expect(
          await fixture.records.replaceHead(
            current.observation,
            scenario.competingHead,
          ),
        ).toEqual({ kind: "confirmed" });
      });
      expect(
        await createStore(fixture).resumeOperation({
          vaultId,
          operationId: recoveryOperationId,
        }),
      ).toMatchObject({
        kind: "error",
        code: "operation_pending",
        operationId: recoveryOperationId,
      });
      const journalKey = syncOperationKey(vaultId, recoveryOperationId);
      const claimed = await fixture.publication.readJournal(
        vaultId,
        recoveryOperationId,
      );
      if (
        claimed.kind !== "observed" ||
        claimed.observation.value.status !== "pending" ||
        claimed.observation.value.allocationState !== "allocated"
      )
        throw new Error("Expected exact claimed head journal");
      const floor = claimed.observation.observed.uploaded.getTime() + 1_100;
      const puts = fixture.bucket.putAttempts.length;
      if (boundary === "cooldown") {
        for (const offset of [0, 10]) {
          fixture.setNow(floor - 1_100 + offset);
          expect(
            await createStore(fixture).resumeOperation({
              vaultId,
              operationId: recoveryOperationId,
            }),
          ).toEqual({
            kind: "error",
            code: "operation_pending",
            operationId: recoveryOperationId,
            retryAfterEpochMs: floor,
          });
          expect(fixture.bucket.putAttempts).toHaveLength(puts);
        }
      }
      fixture.setNow(floor);
      if (boundary === "lost_cas_response")
        fixture.bucket.applyThenLoseResponse(journalKey, "replace", 1);
      expect(
        await createStore(fixture).resumeOperation({
          vaultId,
          operationId: recoveryOperationId,
        }),
      ).toEqual({
        kind: "error",
        code: "operation_pending",
        operationId: recoveryOperationId,
      });
      expect(
        await fixture.publication.readJournal(vaultId, recoveryOperationId),
      ).toMatchObject({
        kind: "observed",
        observation: {
          value: {
            status: "pending",
            stepEvidence: {
              step: "create_event",
              outcomeIntent: "aborted",
              committedAtEpochMs: floor,
            },
          },
        },
      });
      expect(
        fixture.bucket.putAttempts.filter(
          ({ key, phase }) => key === journalKey && phase === "replace",
        ),
      ).toHaveLength(
        fixture.bucket.putAttempts
          .slice(0, puts)
          .filter(({ key, phase }) => key === journalKey && phase === "replace")
          .length + 1,
      );
      const headPuts = fixture.bucket.putAttempts.filter(
        ({ key }) => key === headKey,
      ).length;
      expect(
        await settleResume(createStore(fixture), fixture, scenario.request),
      ).toEqual({ kind: "error", code: "stale_revision" });
      expect(
        fixture.bucket.putAttempts.filter(({ key }) => key === headKey),
      ).toHaveLength(headPuts);
      expect(
        await fixture.publication.readJournal(vaultId, recoveryOperationId),
      ).toMatchObject({
        kind: "observed",
        observation: {
          value: { status: "aborted", request: scenario.request },
        },
      });
      expect(await fixture.records.readHead(vaultId, path)).toMatchObject({
        kind: "observed",
        observation: { value: scenario.competingHead },
      });
    },
  );

  it.each(["authority_digest", "target_digest", "receipt_timeout"] as const)(
    "does not reinterpret %s failure after a refused head CAS as permission to publish an abort",
    async (failure) => {
      const fixture = await setup();
      const scenario = await prepareCurrentHeadCasScenario(fixture);
      await advanceToHeadWrite(createStore(fixture), fixture, scenario.request);
      await advanceHeadWriteCooldown(fixture, scenario.request);
      const headKey = syncHeadKey(vaultId, path);
      const receiptKey = syncHeadRefusalReceiptKey(
        vaultId,
        recoveryOperationId,
      );
      let consumed = false;
      let armed = false;
      let authorityDigestReads = 0;
      fixture.bucket.beforeNextPut(headKey, "replace", async () => {
        const current = await fixture.records.readHead(vaultId, path);
        if (current.kind !== "observed")
          throw new Error("Expected retained original head");
        expect(
          await fixture.records.replaceHead(
            current.observation,
            scenario.competingHead,
          ),
        ).toEqual({ kind: "confirmed" });
        if (failure === "receipt_timeout")
          fixture.bucket.beforeNextPut(receiptKey, "create", async () => {
            consumed = true;
            throw new Error("Receipt PUT response unavailable");
          });
      });
      const realDigest = crypto.subtle.digest.bind(crypto.subtle);
      const digest = vi
        .spyOn(crypto.subtle, "digest")
        .mockImplementation((algorithm, input) => {
          const text = new TextDecoder().decode(input);
          if (armed && text === scenario.request.content)
            authorityDigestReads += 1;
          const selected =
            failure === "authority_digest"
              ? authorityDigestReads === 2
              : failure === "target_digest" &&
                text.includes('"kind":"live"') &&
                text.includes(`"operationId":"${recoveryOperationId}"`);
          if (selected && !consumed) {
            consumed = true;
            return Promise.reject(
              new Error("Receipt proof digest unavailable"),
            );
          }
          return realDigest(algorithm, input);
        });
      const createInvocation = createSyncR2MutationInvocationFactory(
        fixture.bucket,
        fixture.now,
      );
      const store = syncR2Mutation(
        fixture.records,
        () => {
          const invocation = createInvocation();
          const original = invocation.records;
          return {
            ...invocation,
            records: {
              ...original,
              readHead: async (vault, notePath) => {
                const result = await original.readHead(vault, notePath);
                if (
                  result.kind === "observed" &&
                  result.observation.value.revision ===
                    scenario.competingHead.revision
                )
                  armed = true;
                return result;
              },
            },
          };
        },
        fixture.now,
      );
      try {
        const result = await store.resumeOperation({
          vaultId,
          operationId: recoveryOperationId,
        });
        expect(result).toEqual({
          kind: "error",
          code: "effect_unknown",
          operationId: recoveryOperationId,
          ...(failure === "receipt_timeout"
            ? { retryAfterEpochMs: fixture.now() + 1_100 }
            : {}),
        });
        expect(consumed).toBe(true);
        if (failure === "authority_digest") expect(armed).toBe(true);
      } finally {
        digest.mockRestore();
      }
      expect(
        await fixture.publication.readHeadRefusalReceipt(
          vaultId,
          recoveryOperationId,
        ),
      ).toEqual({ kind: "absent" });
      const journal = await fixture.publication.readJournal(
        vaultId,
        recoveryOperationId,
      );
      if (
        journal.kind !== "observed" ||
        journal.observation.value.status !== "pending" ||
        journal.observation.value.allocationState !== "allocated"
      )
        throw new Error("Expected retained claimed head step");
      expect(journal.observation.value.stepEvidence).toMatchObject({
        step: "write_head",
        attempt: { state: "attempting", generation: 1 },
      });
      expect(
        fixture.bucket.objects.has(
          syncFeedEventKey(
            vaultId,
            journal.observation.value.reservation.lane,
            journal.observation.value.reservation.sequence,
          ),
        ),
      ).toBe(false);
      const puts = fixture.bucket.putAttempts.length;
      fixture.setNow(fixture.now() + 2_200);
      expect(
        await createStore(fixture).resumeOperation({
          vaultId,
          operationId: recoveryOperationId,
        }),
      ).toEqual({
        kind: "error",
        code: "effect_unknown",
        operationId: recoveryOperationId,
      });
      expect(fixture.bucket.putAttempts).toHaveLength(puts);
      expect(await fixture.records.readHead(vaultId, path)).toMatchObject({
        kind: "observed",
        observation: { value: scenario.competingHead },
      });
    },
  );

  it.each([
    "unreadable receipt",
    "changed receipt claim",
    "journal changed after resume snapshot",
    "journal unavailable after receipt read",
    "head absent after receipt read",
    "unsafe clock after receipt read",
    "unapplied refusal CAS",
    "unacknowledged refusal CAS with unreadable readback",
  ] as const)(
    "keeps the lane blocked when %s evidence prevents refusal recovery",
    async (uncertainty) => {
      const fixture = await setup();
      const scenario = await prepareCurrentHeadCasScenario(fixture);
      await advanceToHeadWrite(createStore(fixture), fixture, scenario.request);
      await advanceHeadWriteCooldown(fixture, scenario.request);
      const headKey = syncHeadKey(vaultId, path);
      fixture.bucket.beforeNextPut(headKey, "replace", async () => {
        const current = await fixture.records.readHead(vaultId, path);
        if (current.kind !== "observed") {
          throw new Error("The exact current parent must still be readable.");
        }
        expect(
          await fixture.records.replaceHead(
            current.observation,
            scenario.competingHead,
          ),
        ).toEqual({ kind: "confirmed" });
      });

      expect(
        await createStore(fixture).resumeOperation({
          vaultId,
          operationId: recoveryOperationId,
        }),
      ).toMatchObject({
        kind: "error",
        code: "operation_pending",
        operationId: recoveryOperationId,
      });
      const claimed = await fixture.publication.readJournal(
        vaultId,
        recoveryOperationId,
      );
      if (
        claimed.kind !== "observed" ||
        claimed.observation.value.status !== "pending" ||
        claimed.observation.value.allocationState !== "allocated" ||
        claimed.observation.value.stepEvidence.step !== "write_head" ||
        claimed.observation.value.stepEvidence.attempt.state !== "attempting" ||
        claimed.observation.value.stepEvidence.attempt.generation !== 1
      ) {
        throw new Error("Expected the persisted first head-write claim.");
      }
      const receipt = await fixture.publication.readHeadRefusalReceipt(
        vaultId,
        recoveryOperationId,
      );
      if (receipt.kind !== "observed") {
        throw new Error("Expected the exact first-claim refusal receipt.");
      }

      const receiptKey = syncHeadRefusalReceiptKey(
        vaultId,
        recoveryOperationId,
      );
      fixture.setNow(
        Math.max(
          fixture.now(),
          claimed.observation.observed.uploaded.getTime() + 1_100,
        ),
      );
      if (uncertainty === "unreadable receipt") {
        fixture.bucket.failNextGets(receiptKey, 1);
      }
      if (uncertainty === "changed receipt claim") {
        const receiptRecord = receipt.observation.value;
        const changedReceipt = {
          ...receiptRecord,
          claimId:
            receiptRecord.claimId === operationId
              ? competingOperationId
              : operationId,
        };
        fixture.bucket.seed(
          receiptKey,
          await encodeSyncHeadRefusalReceipt(changedReceipt),
          fixture.now(),
        );
      }
      if (uncertainty === "journal changed after resume snapshot") {
        const changedJournal = retryWaitAfterHeadClaim(
          claimed.observation.value,
          fixture.now(),
        );
        const changedJournalBytes = await encodeSyncPublication(changedJournal);
        fixture.bucket.afterNextGet(
          syncOperationKey(vaultId, recoveryOperationId),
          () =>
            fixture.bucket.seed(
              syncOperationKey(vaultId, recoveryOperationId),
              changedJournalBytes,
              fixture.now(),
            ),
        );
      }

      const journalKey = syncOperationKey(vaultId, recoveryOperationId);
      const recoveryEpoch = fixture.now();
      const exactCompetitor = fixture.bucket.objects.get(headKey);
      if (!exactCompetitor) throw new Error("Expected refusal competitor");
      if (uncertainty === "journal unavailable after receipt read") {
        fixture.bucket.afterNextGet(receiptKey, () => {
          fixture.bucket.failNextGets(journalKey, 1);
        });
      }
      if (uncertainty === "head absent after receipt read") {
        fixture.bucket.afterNextGet(receiptKey, () => {
          fixture.bucket.objects.delete(headKey);
        });
      }
      if (uncertainty === "unsafe clock after receipt read") {
        fixture.bucket.afterNextGet(receiptKey, () => {
          fixture.setNow(Number.NaN);
        });
      }
      if (uncertainty === "unapplied refusal CAS") {
        fixture.bucket.beforeNextPut(journalKey, "replace", async () => {
          throw new Error("Refusal CAS transport failed before effect");
        });
      }
      if (
        uncertainty === "unacknowledged refusal CAS with unreadable readback"
      ) {
        fixture.bucket.applyThenLoseResponse(journalKey, "replace", 2);
      }
      const headWritesBeforeRecovery = fixture.bucket.putAttempts.filter(
        (attempt) => attempt.key === headKey,
      ).length;
      const eventKey = syncFeedEventKey(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      );
      const eventWritesBeforeRecovery = fixture.bucket.putAttempts.filter(
        (attempt) => attempt.key === eventKey,
      ).length;
      expect(
        await createStore(fixture).resumeOperation({
          vaultId,
          operationId: recoveryOperationId,
        }),
      ).toMatchObject({
        kind: "error",
        code: "effect_unknown",
        operationId: recoveryOperationId,
      });
      expect(
        fixture.bucket.putAttempts.filter((attempt) => attempt.key === headKey),
      ).toHaveLength(headWritesBeforeRecovery);
      expect(
        fixture.bucket.putAttempts.filter(
          (attempt) => attempt.key === eventKey,
        ),
      ).toHaveLength(eventWritesBeforeRecovery);
      expect(
        await fixture.publication.readEvent(
          vaultId,
          fixture.lane,
          FIRST_EVENT_SEQUENCE,
        ),
      ).toEqual({ kind: "absent" });
      expect(
        await fixture.publication.readLaneHead(vaultId, fixture.lane),
      ).toMatchObject({
        kind: "observed",
        observation: {
          value: { pending: { operationId: recoveryOperationId } },
        },
      });
      if (
        uncertainty !== "changed receipt claim" &&
        uncertainty !== "journal changed after resume snapshot"
      ) {
        fixture.setNow(recoveryEpoch + 1_100);
        fixture.bucket.objects.set(headKey, exactCompetitor);
        expect(
          await settleResume(createStore(fixture), fixture, scenario.request),
        ).toEqual({ kind: "error", code: "stale_revision" });
        expect(
          await fixture.publication.readJournal(vaultId, recoveryOperationId),
        ).toMatchObject({
          kind: "observed",
          observation: { value: { status: "aborted" } },
        });
        expect(
          await fixture.publication.readEvent(
            vaultId,
            fixture.lane,
            FIRST_EVENT_SEQUENCE,
          ),
        ).toMatchObject({
          kind: "observed",
          observation: {
            value: { kind: "aborted", operationId: recoveryOperationId },
          },
        });
      }
    },
  );

  it.each([
    "changed event",
    "missing current head",
    "foreign pending lane",
  ] as const)(
    "does not release a terminal lane when %s evidence disagrees",
    async (uncertainty) => {
      const fixture = await setup();
      const request = await createMutationRequest(
        `Terminal evidence ${uncertainty}`,
      );
      await advanceToTerminalLaneCommit(createStore(fixture), fixture, request);
      const journal = await fixture.publication.readJournal(
        vaultId,
        request.operationId,
      );
      if (
        journal.kind !== "observed" ||
        journal.observation.value.status === "pending" ||
        journal.observation.value.stepEvidence.step !== "commit_lane"
      ) {
        throw new Error("Expected a persisted terminal lane-commit journal.");
      }
      const terminal = journal.observation.value;
      if (uncertainty === "changed event") {
        const eventKey = syncFeedEventKey(
          vaultId,
          fixture.lane,
          terminal.reservation.sequence,
        );
        const event = await fixture.publication.readEvent(
          vaultId,
          fixture.lane,
          terminal.reservation.sequence,
        );
        if (
          event.kind !== "observed" ||
          event.observation.value.kind !== "changed"
        ) {
          throw new Error("Expected the exact changed-event witness.");
        }
        fixture.bucket.seed(
          eventKey,
          await encodeSyncPublication({
            ...event.observation.value,
            result: { kind: "live", revision: updatedRevision },
          }),
          fixture.now(),
        );
      }
      if (uncertainty === "missing current head") {
        fixture.bucket.objects.delete(syncHeadKey(vaultId, path));
      }
      if (uncertainty === "foreign pending lane") {
        const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
        const lane = await fixture.publication.readLaneHead(
          vaultId,
          fixture.lane,
        );
        if (lane.kind !== "observed") {
          throw new Error(
            "Expected the terminal operation's lane reservation.",
          );
        }
        fixture.bucket.seed(
          laneKey,
          await encodeSyncPublication({
            ...lane.observation.value,
            pending: {
              operationId: competingOperationId,
              nextSequence: terminal.reservation.sequence,
            },
          }),
          fixture.now(),
        );
      }

      const bucketPutsBeforeRecovery = fixture.bucket.putAttempts.length;
      expect(
        await createStore(fixture).resumeOperation({
          vaultId,
          operationId: request.operationId,
        }),
      ).toMatchObject({
        kind: "error",
        code: "effect_unknown",
        operationId: request.operationId,
      });
      expect(fixture.bucket.putAttempts).toHaveLength(bucketPutsBeforeRecovery);
      expect(
        await fixture.publication.readJournal(vaultId, request.operationId),
      ).toMatchObject({
        kind: "observed",
        observation: {
          value: {
            status: terminal.status,
            stepEvidence: { step: "commit_lane" },
          },
        },
      });
      expect(
        await fixture.publication.readLaneHead(vaultId, fixture.lane),
      ).toMatchObject({
        kind: "observed",
        observation: {
          value: {
            pending: {
              operationId:
                uncertainty === "foreign pending lane"
                  ? competingOperationId
                  : request.operationId,
            },
          },
        },
      });
    },
  );

  it("recovers a generation-one conditional-null receipt before a later abort event invocation", async () => {
    const fixture = await setup();
    const scenario = await prepareCurrentHeadCasScenario(fixture);
    const store = createStore(fixture);
    await advanceToHeadWrite(store, fixture, scenario.request);
    await advanceHeadWriteCooldown(fixture, scenario.request);
    let competingHeadWrite: SyncR2WriteResult | undefined;
    const headKey = syncHeadKey(vaultId, path);
    const headWritesBefore = fixture.bucket.putAttempts.filter(
      (attempt) => attempt.key === headKey,
    ).length;
    fixture.bucket.applyThenLoseResponse(
      syncHeadRefusalReceiptKey(vaultId, recoveryOperationId),
      "create",
      0,
    );
    fixture.bucket.beforeNextPut(headKey, "replace", async () => {
      const current = await fixture.records.readHead(vaultId, path);
      if (current.kind !== "observed") {
        throw new Error("The exact current parent must still be readable.");
      }
      competingHeadWrite = await fixture.records.replaceHead(
        current.observation,
        scenario.competingHead,
      );
      fixture.bucket.failNextGets(headKey, 1);
    });

    const refused = await createStore(fixture).resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });
    expect(competingHeadWrite).toEqual({ kind: "confirmed" });
    expect(refused).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId: recoveryOperationId,
    });
    const receipt = await fixture.publication.readHeadRefusalReceipt(
      vaultId,
      recoveryOperationId,
    );
    expect(receipt).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          refusalSource: "conditional_null",
          generation: 1,
          operationId: recoveryOperationId,
          headKey,
        },
      },
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      ),
    ).toEqual({ kind: "absent" });
    const headAttemptsAfterRefusal = fixture.bucket.putAttempts.filter(
      (attempt) => attempt.key === headKey,
    );
    expect(headAttemptsAfterRefusal).toHaveLength(headWritesBefore + 2);
    expect(
      fixture.bucket.putAttempts.filter(
        (attempt) =>
          attempt.key ===
          syncHeadRefusalReceiptKey(vaultId, recoveryOperationId),
      ),
    ).toHaveLength(1);
    expect(
      fixture.bucket.appliedThenLostResponses.filter(
        (attempt) =>
          attempt.key ===
          syncHeadRefusalReceiptKey(vaultId, recoveryOperationId),
      ),
    ).toHaveLength(1);

    const claimedJournal = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(claimedJournal.kind).toBe("observed");
    if (claimedJournal.kind !== "observed") return;
    expect(claimedJournal.observation.value).toMatchObject({
      status: "pending",
      allocationState: "allocated",
      stepEvidence: {
        step: "write_head",
        attempt: { state: "attempting", generation: 1 },
      },
    });
    const claim = claimedJournal.observation.value;
    if (
      claim.status !== "pending" ||
      claim.allocationState !== "allocated" ||
      claim.stepEvidence.step !== "write_head" ||
      claim.stepEvidence.attempt.state !== "attempting"
    ) {
      return;
    }
    if (receipt.kind !== "observed") return;
    expect(receipt.observation.value.claimId).toBe(
      claim.stepEvidence.attempt.claimId,
    );

    fixture.setNow(
      claimedJournal.observation.observed.uploaded.getTime() + 1_100,
    );
    const recovery = await createStore(fixture).resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });
    expect(recovery).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId: recoveryOperationId,
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      ),
    ).toEqual({ kind: "absent" });
    const eventStep = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(eventStep).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: {
            step: "create_event",
            outcomeIntent: "aborted",
            attempt: { state: "ready", generation: 0 },
          },
        },
      },
    });
    expect(
      fixture.bucket.putAttempts.filter(
        (attempt) =>
          attempt.key ===
          syncFeedEventKey(vaultId, fixture.lane, FIRST_EVENT_SEQUENCE),
      ),
    ).toHaveLength(0);
    if (eventStep.kind !== "observed") return;
    fixture.setNow(eventStep.observation.observed.uploaded.getTime() + 1_100);

    expect(
      await settleResume(createStore(fixture), fixture, scenario.request),
    ).toEqual({ kind: "error", code: "stale_revision" });
    const event = await fixture.publication.readEvent(
      vaultId,
      fixture.lane,
      FIRST_EVENT_SEQUENCE,
    );
    expect(event).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          kind: "aborted",
          operationId: recoveryOperationId,
          reason: "stale_revision",
        },
      },
    });
    expect(
      fixture.bucket.putAttempts.filter((attempt) => attempt.key === headKey),
    ).toHaveLength(headWritesBefore + 2);
    const journal = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(journal).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "aborted",
          request: { parent: { kind: "revision", revision } },
        },
      },
    });
    expect(
      await createStore(fixture).readCurrent({ vaultId, path }),
    ).toMatchObject({
      kind: "live",
      revision: tombstoneRevision,
      operationId: competingOperationId,
      origin: alternateOrigin,
    });
    const lane = await fixture.publication.readLaneHead(vaultId, fixture.lane);
    expect(lane).toMatchObject({
      kind: "observed",
      observation: { value: { committedSequence: FIRST_EVENT_SEQUENCE } },
    });
    if (lane.kind === "observed") {
      expect(lane.observation.value.pending).toBeUndefined();
    }
  });

  it("keeps a throttled refusal receipt unknown without publishing an abort event", async () => {
    const fixture = await setup();
    const scenario = await prepareCurrentHeadCasScenario(fixture);
    await advanceToHeadWrite(createStore(fixture), fixture, scenario.request);
    await advanceHeadWriteCooldown(fixture, scenario.request);
    const headKey = syncHeadKey(vaultId, path);
    const receiptKey = syncHeadRefusalReceiptKey(vaultId, recoveryOperationId);
    let competingHeadWrite: SyncR2WriteResult | undefined;
    fixture.bucket.beforeNextPut(headKey, "replace", async () => {
      const current = await fixture.records.readHead(vaultId, path);
      if (current.kind !== "observed") {
        throw new Error("The exact current parent must still be readable.");
      }
      competingHeadWrite = await fixture.records.replaceHead(
        current.observation,
        scenario.competingHead,
      );
      fixture.bucket.beforeNextPut(receiptKey, "create", async () => {
        throw Object.assign(new Error("Too many requests"), { status: 429 });
      });
    });

    const result = await createStore(fixture).resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });
    expect(competingHeadWrite).toEqual({ kind: "confirmed" });
    expect(result).toMatchObject({
      kind: "error",
      code: "effect_unknown",
      operationId: recoveryOperationId,
    });
    expect(
      fixture.bucket.putAttempts.filter(
        (attempt) => attempt.key === receiptKey,
      ),
    ).toHaveLength(1);
    expect(
      await fixture.publication.readHeadRefusalReceipt(
        vaultId,
        recoveryOperationId,
      ),
    ).toEqual({ kind: "absent" });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      ),
    ).toEqual({ kind: "absent" });
    const lane = await fixture.publication.readLaneHead(vaultId, fixture.lane);
    expect(lane).toMatchObject({
      kind: "observed",
      observation: { value: { pending: { operationId: recoveryOperationId } } },
    });
  });

  it("does not refresh the receipt journal ETag after a concurrent retry-wait transition", async () => {
    const fixture = await setup();
    const scenario = await prepareCurrentHeadCasScenario(fixture);
    await advanceToHeadWrite(createStore(fixture), fixture, scenario.request);
    await advanceHeadWriteCooldown(fixture, scenario.request);
    fixture.bucket.beforeNextPut(
      syncHeadKey(vaultId, path),
      "replace",
      async () => {
        const current = await fixture.records.readHead(vaultId, path);
        if (current.kind !== "observed") {
          throw new Error("The exact current parent must still be readable.");
        }
        expect(
          await fixture.records.replaceHead(
            current.observation,
            scenario.competingHead,
          ),
        ).toEqual({ kind: "confirmed" });
      },
    );
    expect(
      await createStore(fixture).resumeOperation({
        vaultId,
        operationId: recoveryOperationId,
      }),
    ).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId: recoveryOperationId,
    });
    const claim = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(claim.kind).toBe("observed");
    if (
      claim.kind !== "observed" ||
      claim.observation.value.status !== "pending" ||
      claim.observation.value.allocationState !== "allocated"
    ) {
      return;
    }
    const journalKey = syncOperationKey(vaultId, recoveryOperationId);
    const originalEtag = claim.observation.observed.etag;
    fixture.setNow(claim.observation.observed.uploaded.getTime() + 1_100);
    let competingJournalWrite: SyncR2WriteResult | undefined;
    fixture.bucket.beforeNextPut(journalKey, "replace", async () => {
      const current = await fixture.publication.readJournal(
        vaultId,
        recoveryOperationId,
      );
      if (
        current.kind !== "observed" ||
        current.observation.value.status !== "pending" ||
        current.observation.value.allocationState !== "allocated"
      ) {
        throw new Error("The exact claimed journal must still be readable.");
      }
      competingJournalWrite = await fixture.publication.replaceJournal(
        current.observation,
        retryWaitAfterHeadClaim(current.observation.value, fixture.now()),
      );
    });

    const result = await createStore(fixture).resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });
    expect(competingJournalWrite).toEqual({ kind: "confirmed" });
    expect(result).toMatchObject({
      kind: "error",
      code: "effect_unknown",
      operationId: recoveryOperationId,
    });
    const journalWrites = fixture.bucket.putAttempts.filter(
      (attempt) => attempt.key === journalKey,
    );
    expect(journalWrites.slice(-2)).toHaveLength(2);
    expect(
      journalWrites.slice(-2).map((attempt) => attempt.etagMatches),
    ).toEqual([originalEtag, originalEtag]);
    expect(
      await fixture.publication.readJournal(vaultId, recoveryOperationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: {
            step: "write_head",
            attempt: { state: "retry_wait", generation: 1 },
          },
        },
      },
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      ),
    ).toEqual({ kind: "absent" });
  });

  it("does not adopt a refusal receipt after its exact competing head changes", async () => {
    const fixture = await setup();
    const scenario = await prepareCurrentHeadCasScenario(fixture);
    await advanceToHeadWrite(createStore(fixture), fixture, scenario.request);
    await advanceHeadWriteCooldown(fixture, scenario.request);
    fixture.bucket.beforeNextPut(
      syncHeadKey(vaultId, path),
      "replace",
      async () => {
        const current = await fixture.records.readHead(vaultId, path);
        if (current.kind !== "observed") {
          throw new Error("The exact current parent must still be readable.");
        }
        expect(
          await fixture.records.replaceHead(
            current.observation,
            scenario.competingHead,
          ),
        ).toEqual({ kind: "confirmed" });
      },
    );
    expect(
      await createStore(fixture).resumeOperation({
        vaultId,
        operationId: recoveryOperationId,
      }),
    ).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId: recoveryOperationId,
    });
    const claim = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(claim.kind).toBe("observed");
    if (claim.kind !== "observed") return;

    const laterContent = "A later stale competitor";
    const laterBytes = encoder.encode(laterContent);
    const laterOperationId = syncOperationIdSchema.parse(
      "99999999-9999-4999-8999-999999999998",
    );
    const laterRevision = syncRevisionSchema.parse(
      "99999999-9999-4999-8999-999999999999",
    );
    const laterHead: SyncHeadRecord = {
      ...scenario.competingHead,
      revision: laterRevision,
      parent: { kind: "revision", revision: tombstoneRevision },
      contentSha256: await sha256Content(laterContent),
      byteSize: laterBytes.byteLength,
      operationId: laterOperationId,
    };
    expect(
      await fixture.records.createContent({
        kind: "contentBody",
        vaultId,
        revision: laterRevision,
        bytes: laterBytes,
        byteSize: laterBytes.byteLength,
        contentSha256: laterHead.contentSha256,
      }),
    ).toEqual({ kind: "confirmed" });
    expect(await fixture.records.createVersion(laterHead)).toEqual({
      kind: "confirmed",
    });
    fixture.setNow(fixture.now() + 1_100);
    const current = await fixture.records.readHead(vaultId, path);
    expect(current.kind).toBe("observed");
    if (current.kind !== "observed") return;
    expect(
      await fixture.records.replaceHead(current.observation, laterHead),
    ).toEqual({
      kind: "confirmed",
    });
    fixture.setNow(claim.observation.observed.uploaded.getTime() + 1_100);

    expect(
      await createStore(fixture).resumeOperation({
        vaultId,
        operationId: recoveryOperationId,
      }),
    ).toMatchObject({
      kind: "error",
      code: "effect_unknown",
      operationId: recoveryOperationId,
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      ),
    ).toEqual({ kind: "absent" });
    expect(
      await fixture.publication.readJournal(vaultId, recoveryOperationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: {
            step: "write_head",
            attempt: { state: "attempting", generation: 1 },
          },
        },
      },
    });
  });

  it("does not create a receipt for a newer null head attempt after an older uncertain claim", async () => {
    const fixture = await setup();
    const scenario = await prepareCurrentHeadCasScenario(fixture);
    const request = scenario.request;
    await advanceToHeadWrite(createStore(fixture), fixture, request);
    await advanceHeadWriteCooldown(fixture, request);
    const headKey = syncHeadKey(vaultId, path);
    fixture.bucket.beforeNextPut(headKey, "replace", async () => {
      throw new Error("Simulated uncertain first head attempt.");
    });
    expect(
      await createStore(fixture).resumeOperation({
        vaultId,
        operationId: recoveryOperationId,
      }),
    ).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId: recoveryOperationId,
    });
    const firstClaim = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(firstClaim.kind).toBe("observed");
    if (firstClaim.kind !== "observed") return;
    fixture.setNow(firstClaim.observation.observed.uploaded.getTime() + 1_100);
    expect(
      await createStore(fixture).resumeOperation({
        vaultId,
        operationId: recoveryOperationId,
      }),
    ).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId: recoveryOperationId,
    });
    const retryWait = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(retryWait).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: {
            step: "write_head",
            attempt: { state: "retry_wait", generation: 1 },
          },
        },
      },
    });
    if (
      retryWait.kind !== "observed" ||
      retryWait.observation.value.status !== "pending" ||
      retryWait.observation.value.allocationState !== "allocated" ||
      retryWait.observation.value.stepEvidence.step !== "write_head" ||
      retryWait.observation.value.stepEvidence.attempt.state !== "retry_wait"
    ) {
      return;
    }
    fixture.setNow(
      Math.max(
        retryWait.observation.value.stepEvidence.attempt.retryAfterEpochMs,
        retryWait.observation.observed.uploaded.getTime() + 1_100,
      ),
    );
    let competingHeadWrite: SyncR2WriteResult | undefined;
    fixture.bucket.beforeNextPut(headKey, "replace", async () => {
      const current = await fixture.records.readHead(vaultId, path);
      if (current.kind !== "observed") {
        throw new Error("The exact current parent must still be readable.");
      }
      competingHeadWrite = await fixture.records.replaceHead(
        current.observation,
        scenario.competingHead,
      );
    });

    expect(
      await createStore(fixture).resumeOperation({
        vaultId,
        operationId: recoveryOperationId,
      }),
    ).toMatchObject({
      kind: "error",
      code: "effect_unknown",
      operationId: recoveryOperationId,
    });
    expect(competingHeadWrite).toEqual({ kind: "confirmed" });
    expect(
      await fixture.publication.readHeadRefusalReceipt(
        vaultId,
        recoveryOperationId,
      ),
    ).toEqual({ kind: "absent" });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      ),
    ).toEqual({ kind: "absent" });
  });

  it("keeps an event 429 in its claimed step across exactly two recovery invocations", async () => {
    const fixture = await setup();
    const scenario = await prepareCurrentHeadCasScenario(fixture);
    const request = scenario.request;
    await advanceToHeadWrite(createStore(fixture), fixture, request);
    await advanceHeadWriteCooldown(fixture, request);
    fixture.bucket.beforeNextPut(
      syncHeadKey(vaultId, path),
      "replace",
      async () => {
        const current = await fixture.records.readHead(vaultId, path);
        if (current.kind !== "observed") {
          throw new Error("The exact current parent must still be readable.");
        }
        expect(
          await fixture.records.replaceHead(
            current.observation,
            scenario.competingHead,
          ),
        ).toEqual({ kind: "confirmed" });
      },
    );
    const headRefusal = await createStore(fixture).resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });
    expect(headRefusal.kind).toBe("error");
    const claim = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(claim.kind).toBe("observed");
    if (claim.kind !== "observed") return;
    fixture.setNow(claim.observation.observed.uploaded.getTime() + 1_100);
    expect(
      await createStore(fixture).resumeOperation({
        vaultId,
        operationId: recoveryOperationId,
      }),
    ).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId: recoveryOperationId,
    });

    const sequence = FIRST_EVENT_SEQUENCE;
    const eventKey = syncFeedEventKey(vaultId, fixture.lane, sequence);
    const eventStep = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(eventStep).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: {
            step: "create_event",
            outcomeIntent: "aborted",
            attempt: { state: "ready", generation: 0 },
          },
        },
      },
    });
    if (eventStep.kind !== "observed") return;
    fixture.setNow(eventStep.observation.observed.uploaded.getTime() + 1_100);
    let eventRateLimited = false;
    fixture.bucket.beforeNextPut(eventKey, "create", async () => {
      eventRateLimited = true;
      throw Object.assign(new Error("Too many requests"), { status: 429 });
    });

    const firstEventInvocation = await createStore(fixture).resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });
    expect(eventRateLimited).toBe(true);
    expect(firstEventInvocation).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId: recoveryOperationId,
    });
    expect(
      await fixture.publication.readEvent(vaultId, fixture.lane, sequence),
    ).toEqual({ kind: "absent" });
    expect(fixture.bucket.puts.filter((key) => key === eventKey)).toHaveLength(
      1,
    );
    const attemptedEvent = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(attemptedEvent).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: {
            step: "create_event",
            outcomeIntent: "aborted",
            attempt: { state: "attempting", generation: 1 },
          },
        },
      },
    });
    if (attemptedEvent.kind !== "observed") return;
    fixture.setNow(
      attemptedEvent.observation.observed.uploaded.getTime() + 1_100,
    );

    const secondEventInvocation = await createStore(fixture).resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });
    expect(secondEventInvocation).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId: recoveryOperationId,
    });
    expect(
      await fixture.publication.readEvent(vaultId, fixture.lane, sequence),
    ).toEqual({ kind: "absent" });
    expect(fixture.bucket.puts.filter((key) => key === eventKey)).toHaveLength(
      1,
    );
    const retryWait = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(retryWait).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: {
            step: "create_event",
            outcomeIntent: "aborted",
            attempt: { state: "retry_wait", generation: 1 },
          },
        },
      },
    });
    const lane = await fixture.publication.readLaneHead(vaultId, fixture.lane);
    expect(lane).toMatchObject({
      kind: "observed",
      observation: { value: { pending: { operationId: recoveryOperationId } } },
    });
  });

  it("keeps a lost current-head response unknown without a durable abort witness", async () => {
    const fixture = await setup();
    const scenario = await prepareCurrentHeadCasScenario(fixture);
    const store = createStore(fixture);
    await advanceToHeadWrite(store, fixture, scenario.request);
    const deferred = await store.resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });
    expect(deferred).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId: recoveryOperationId,
    });
    if (deferred.kind !== "error" || !("retryAfterEpochMs" in deferred)) {
      return;
    }

    let competingHeadWrite: SyncR2WriteResult | undefined;
    fixture.setNow(deferred.retryAfterEpochMs);
    fixture.bucket.beforeNextPut(
      syncHeadKey(vaultId, path),
      "replace",
      async () => {
        const current = await fixture.records.readHead(vaultId, path);
        if (current.kind !== "observed") {
          throw new Error("The exact current parent must still be readable.");
        }
        competingHeadWrite = await fixture.records.replaceHead(
          current.observation,
          scenario.competingHead,
        );
        throw new Error("Simulated lost conditional PUT response.");
      },
    );

    const result = await store.resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });

    expect(competingHeadWrite).toEqual({ kind: "confirmed" });
    expect(result).toMatchObject({
      kind: "error",
      code: "effect_unknown",
      operationId: recoveryOperationId,
    });
    expect(
      await fixture.publication.readHeadRefusalReceipt(
        vaultId,
        recoveryOperationId,
      ),
    ).toEqual({ kind: "absent" });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({ kind: "absent" });
    expect(
      await createStore(fixture).readCurrent({ vaultId, path }),
    ).toMatchObject({
      kind: "live",
      revision: tombstoneRevision,
      operationId: competingOperationId,
    });
    const lane = await fixture.publication.readLaneHead(vaultId, fixture.lane);
    expect(lane.kind).toBe("observed");
    if (lane.kind !== "observed") return;
    expect(lane.observation.value.pending?.operationId).toBe(
      recoveryOperationId,
    );
  });

  it("does not replace a colliding event after receipt recovery", async () => {
    const fixture = await setup();
    const scenario = await prepareCurrentHeadCasScenario(fixture);
    await advanceToHeadWrite(createStore(fixture), fixture, scenario.request);
    await advanceHeadWriteCooldown(fixture, scenario.request);
    fixture.bucket.beforeNextPut(
      syncHeadKey(vaultId, path),
      "replace",
      async () => {
        const current = await fixture.records.readHead(vaultId, path);
        if (current.kind !== "observed") {
          throw new Error("The exact current parent must still be readable.");
        }
        expect(
          await fixture.records.replaceHead(
            current.observation,
            scenario.competingHead,
          ),
        ).toEqual({ kind: "confirmed" });
      },
    );
    const headRefusal = await createStore(fixture).resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });
    expect(headRefusal).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId: recoveryOperationId,
    });
    const claim = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(claim.kind).toBe("observed");
    if (claim.kind !== "observed") return;
    fixture.setNow(claim.observation.observed.uploaded.getTime() + 1_100);
    expect(
      await createStore(fixture).resumeOperation({
        vaultId,
        operationId: recoveryOperationId,
      }),
    ).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId: recoveryOperationId,
    });
    expect(
      await fixture.publication.createEvent(scenario.competingEvent),
    ).toEqual({ kind: "confirmed" });

    const result = await createStore(fixture).resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });
    expect(result).toMatchObject({
      kind: "error",
      code: "effect_unknown",
      operationId: recoveryOperationId,
    });
    const event = await fixture.publication.readEvent(
      vaultId,
      fixture.lane,
      FIRST_EVENT_SEQUENCE,
    );
    expect(event).toMatchObject({
      kind: "observed",
      observation: { value: scenario.competingEvent },
    });
    const lane = await fixture.publication.readLaneHead(vaultId, fixture.lane);
    expect(lane.kind).toBe("observed");
    if (lane.kind !== "observed") return;
    expect(lane.observation.value.pending?.operationId).toBe(
      recoveryOperationId,
    );
  });

  it("reads a tombstone only with exact retained recovery bytes", async () => {
    const loaded = await import("@worker/infrastructure/sync/sync-r2-mutation");
    const fixture = await setup();
    const store = loaded.syncR2Mutation(
      fixture.records,
      createSyncR2MutationInvocationFactory(fixture.bucket, fixture.now),
      fixture.now,
    );
    const content = "Exact archived parent 🌐";
    await seedTombstone(fixture, content);

    expect(await store.readCurrent({ vaultId, path })).toMatchObject({
      kind: "tombstone",
      revision: tombstoneRevision,
      parent: { kind: "revision", revision },
      operationId: recoveryOperationId,
    });
    expect(hasRecoveryRead(store)).toBe(true);
    if (!hasRecoveryRead(store)) return;
    expect(
      await store.readRecovery({ vaultId, operationId: recoveryOperationId }),
    ).toEqual({
      kind: "present",
      recovery: {
        vaultId,
        path,
        operationId: recoveryOperationId,
        sourceRevision: revision,
        contentSha256: await sha256Content(content),
        byteSize: encoder.encode(content).byteLength,
        mediaType: "text/markdown",
        content,
        origin,
      },
    });
  });

  it("keeps a colliding immutable event unknown without adopting or replacing it", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const content = "Exact requested event body";
    const request: SyncMutationRequest = {
      kind: "create",
      vaultId,
      path,
      operationId,
      revision,
      parent: { kind: "never_seen" },
      contentSha256: await sha256Content(content),
      content,
      mediaType: "text/markdown",
      origin,
    };
    const sequence = FIRST_EVENT_SEQUENCE;
    const eventKey = syncFeedEventKey(vaultId, fixture.lane, sequence);
    await seedCreateEventStep(fixture, request);
    let conflictingEvent: SyncFeedEventRecord | undefined;
    let conflictingCreate: SyncR2WriteResult | undefined;
    fixture.bucket.beforeNextPut(eventKey, "create", async () => {
      conflictingEvent = {
        schemaVersion: 1,
        protocolMajor: 1,
        vaultId,
        kind: "changed",
        lane: fixture.lane,
        sequence,
        path,
        result: { kind: "live", revision: tombstoneRevision },
        operationId: competingOperationId,
        origin: alternateOrigin,
        committedAtEpochMs: fixture.now(),
      };
      conflictingCreate =
        await fixture.publication.createEvent(conflictingEvent);
    });

    const result = await store.resumeOperation({ vaultId, operationId });

    expect(conflictingCreate).toEqual({ kind: "confirmed" });
    expect(result).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId,
    });
    expect(
      await fixture.publication.readEvent(vaultId, fixture.lane, sequence),
    ).toMatchObject({
      kind: "observed",
      observation: { value: conflictingEvent },
    });
    const journal = await fixture.publication.readJournal(vaultId, operationId);
    expect(journal).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: { step: "create_event" },
        },
      },
    });
    expect(await store.readCurrent({ vaultId, path })).toMatchObject({
      kind: "live",
      revision,
      operationId,
    });
    const lane = await fixture.publication.readLaneHead(vaultId, fixture.lane);
    expect(lane).toMatchObject({
      kind: "observed",
      observation: {
        value: { pending: { operationId, nextSequence: sequence } },
      },
    });
    expect(fixture.bucket.puts.filter((key) => key === eventKey)).toHaveLength(
      2,
    );
  });

  it("replays the exact request after an uncommitted journal-create throttle", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const content = "Journal create after throttle";
    const request = await createMutationRequest(content);
    const journalKey = syncOperationKey(vaultId, operationId);
    const retryAfterEpochMs = fixture.now() + 1_100;
    let journalCreateThrottled = false;
    fixture.bucket.beforeNextPut(journalKey, "create", async () => {
      journalCreateThrottled = true;
      throw Object.assign(new Error("Too Many Requests"), { status: 429 });
    });

    const first = await store.mutate(request);
    expect(journalCreateThrottled).toBe(true);
    expect(first).toEqual({
      kind: "error",
      code: "storage_throttled",
      retryAfterEpochMs,
    });
    expect(await fixture.publication.readJournal(vaultId, operationId)).toEqual(
      { kind: "absent" },
    );
    const initialLane = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(initialLane).toMatchObject({
      kind: "observed",
      observation: {
        value: { committedSequence: "00000000000000000000" },
      },
    });
    if (initialLane.kind !== "observed") return;
    expect(initialLane.observation.value.pending).toBeUndefined();
    expect(await fixture.records.readHead(vaultId, path)).toEqual({
      kind: "absent",
    });
    expect(
      fixture.bucket.puts.filter((key) => key === journalKey),
    ).toHaveLength(1);

    fixture.setNow(retryAfterEpochMs);
    const committed = await settleMutation(
      createStore(fixture),
      fixture,
      request,
    );
    expect(committed).toEqual({
      kind: "committed",
      revision,
      operationId,
      position: { lane: fixture.lane, sequence: "00000000000000000001" },
    });
    expect(
      await fixture.publication.readJournal(vaultId, operationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "committed",
          request,
          reservation: {
            lane: fixture.lane,
            sequence: "00000000000000000001",
          },
        },
      },
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: { kind: "changed", operationId, result: { revision } },
      },
    });
    expect(
      await createStore(fixture).readCurrent({ vaultId, path }),
    ).toMatchObject({
      kind: "live",
      revision,
      operationId,
    });
  });

  it("resumes exact mutation state after initial lane creation is applied but unreadable", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const content = "Recover initial lane head";
    const request = await createMutationRequest(content);
    const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
    fixture.bucket.applyThenLoseResponse(laneKey, "create", 2);

    const first = await store.mutate(request);
    const laneCreateAttempts = fixture.bucket.putAttempts.filter(
      ({ key, phase }) => key === laneKey && phase === "create",
    );
    expect(laneCreateAttempts).toHaveLength(1);
    const laneCreateAttempt = laneCreateAttempts[0];
    expect(laneCreateAttempt).toBeDefined();
    if (laneCreateAttempt === undefined) return;
    expect(laneCreateAttempt.ifNoneMatch).toBe("*");
    expect(
      fixture.bucket.appliedThenLostResponses.filter(
        ({ key, phase }) => key === laneKey && phase === "create",
      ),
    ).toHaveLength(1);
    expect(first).toMatchObject({
      kind: "error",
      code: "effect_unknown",
      operationId,
      retryAfterEpochMs: fixture.now() + 1_100,
    });
    expect(await fixture.publication.readJournal(vaultId, operationId)).toEqual(
      { kind: "absent" },
    );
    expect(await fixture.records.readHead(vaultId, path)).toEqual({
      kind: "absent",
    });
    const laneAfterUncertainCreate = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(laneAfterUncertainCreate).toMatchObject({
      kind: "observed",
      observation: {
        value: { committedSequence: "00000000000000000000" },
      },
    });
    if (laneAfterUncertainCreate.kind !== "observed") return;
    expect(laneAfterUncertainCreate.observation.observed.bytes).toEqual(
      laneCreateAttempt.bytes,
    );
    expect(laneAfterUncertainCreate.observation.value.pending).toBeUndefined();

    if (first.kind !== "error" || !("retryAfterEpochMs" in first)) {
      throw new Error(
        "The uncertain lane create must include its safe retry time.",
      );
    }
    fixture.setNow(first.retryAfterEpochMs);
    const committed = await settleMutation(
      createStore(fixture),
      fixture,
      request,
    );
    expect(committed).toEqual({
      kind: "committed",
      revision,
      operationId,
      position: { lane: fixture.lane, sequence: "00000000000000000001" },
    });
    expect(
      await fixture.publication.readJournal(vaultId, operationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: { status: "committed", request, allocationState: "allocated" },
      },
    });
    expect(
      await fixture.publication.readLaneHead(vaultId, fixture.lane),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: { committedSequence: "00000000000000000001" },
      },
    });
  });

  it("recovers journal cooldown and throttled terminal lane commit across facades", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const content = "Terminal journal and lane cooldown";
    const request = await createMutationRequest(content);
    const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
    await advanceToJournalCommit(store, fixture, request);

    const pendingJournal = await fixture.publication.readJournal(
      vaultId,
      operationId,
    );
    expect(pendingJournal.kind).toBe("observed");
    if (pendingJournal.kind !== "observed") return;
    expect(pendingJournal.observation.value).toMatchObject({
      status: "pending",
      allocationState: "allocated",
      stepEvidence: { step: "commit_journal" },
    });
    const lanePutsAtJournalCommit = fixture.bucket.puts.filter(
      (key) => key === laneKey,
    ).length;

    const journalCooldown = await store.resumeOperation({
      vaultId,
      operationId,
    });
    expect(journalCooldown).toEqual({
      kind: "error",
      code: "operation_pending",
      operationId,
      retryAfterEpochMs:
        pendingJournal.observation.observed.uploaded.getTime() + 1_100,
    });
    expect(
      await fixture.publication.readJournal(vaultId, operationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          stepEvidence: { step: "commit_journal" },
        },
      },
    });
    expect(fixture.bucket.puts.filter((key) => key === laneKey)).toHaveLength(
      lanePutsAtJournalCommit,
    );

    if (
      journalCooldown.kind !== "error" ||
      !("retryAfterEpochMs" in journalCooldown)
    ) {
      throw new Error("The journal transition must expose its cooldown floor.");
    }
    fixture.setNow(journalCooldown.retryAfterEpochMs);
    const terminalized = await createStore(fixture).resumeOperation({
      vaultId,
      operationId,
    });
    expect(terminalized).toMatchObject({
      kind: "error",
      code: "operation_pending",
    });
    const terminalJournal = await fixture.publication.readJournal(
      vaultId,
      operationId,
    );
    expect(terminalJournal).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "committed",
          stepEvidence: { step: "commit_lane" },
        },
      },
    });
    if (terminalJournal.kind !== "observed") return;
    if (terminalJournal.observation.value.status === "pending") {
      throw new Error("The exact terminal journal must be persisted first.");
    }
    const terminalRetry =
      terminalJournal.observation.value.stepEvidence.retryAfterEpochMs;
    if (terminalRetry !== null) {
      fixture.setNow(terminalRetry);
    }
    const laneJournalCooldown = await createStore(fixture).resumeOperation({
      vaultId,
      operationId,
    });
    expect(laneJournalCooldown).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId,
    });
    if (
      laneJournalCooldown.kind !== "error" ||
      !("retryAfterEpochMs" in laneJournalCooldown)
    ) {
      throw new Error(
        "The terminal journal cooldown must be reported to the caller.",
      );
    }
    fixture.setNow(laneJournalCooldown.retryAfterEpochMs);

    let laneCommitThrottled = false;
    fixture.bucket.beforeNextPut(laneKey, "replace", async () => {
      laneCommitThrottled = true;
      throw Object.assign(new Error("Too Many Requests"), { status: 429 });
    });
    const throttledCommit = await createStore(fixture).resumeOperation({
      vaultId,
      operationId,
    });
    expect(laneCommitThrottled).toBe(true);
    expect(throttledCommit).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId,
      retryAfterEpochMs: fixture.now() + 1_100,
    });
    expect(
      await fixture.publication.readJournal(vaultId, operationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "committed",
          stepEvidence: {
            step: "commit_lane",
            retryAfterEpochMs: fixture.now() + 1_100,
          },
        },
      },
    });
    expect(
      await fixture.publication.readLaneHead(vaultId, fixture.lane),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          committedSequence: "00000000000000000000",
          pending: { operationId },
        },
      },
    });

    const lanePutsAfterThrottle = fixture.bucket.puts.filter(
      (key) => key === laneKey,
    ).length;
    const earlyFreshResume = await createStore(fixture).resumeOperation({
      vaultId,
      operationId,
    });
    expect(earlyFreshResume).toEqual(throttledCommit);
    expect(fixture.bucket.puts.filter((key) => key === laneKey)).toHaveLength(
      lanePutsAfterThrottle,
    );

    if (
      throttledCommit.kind !== "error" ||
      !("retryAfterEpochMs" in throttledCommit)
    ) {
      throw new Error(
        "The lane retry floor must be preserved in terminal state.",
      );
    }
    fixture.setNow(throttledCommit.retryAfterEpochMs);
    const committed = await settleResume(
      createStore(fixture),
      fixture,
      request,
    );
    expect(committed).toEqual({
      kind: "committed",
      revision,
      operationId,
      position: { lane: fixture.lane, sequence: "00000000000000000001" },
    });
    expect(
      await createStore(fixture).readCurrent({ vaultId, path }),
    ).toMatchObject({
      kind: "live",
      revision,
      operationId,
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: { kind: "changed", operationId, result: { revision } },
      },
    });
    const committedLane = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(committedLane).toMatchObject({
      kind: "observed",
      observation: {
        value: { committedSequence: "00000000000000000001" },
      },
    });
    if (committedLane.kind !== "observed") return;
    expect(committedLane.observation.value.pending).toBeUndefined();
  });

  it("does not adopt exact immutable content that exists before any attempt claim", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const content = "Exact immutable replay bytes 🌐";
    const bytes = encoder.encode(content);
    const contentSha256 = await sha256Content(content);
    const body: Extract<SyncBodyRecord, { readonly kind: "contentBody" }> = {
      kind: "contentBody",
      vaultId,
      revision,
      bytes,
      byteSize: bytes.byteLength,
      contentSha256,
    };
    expect(await fixture.records.createContent(body)).toEqual({
      kind: "confirmed",
    });
    const contentKey = syncContentKey(vaultId, revision);
    const priorCreateCount = fixture.bucket.puts.filter(
      (key) => key === contentKey,
    ).length;
    const request: SyncMutationRequest = {
      kind: "create",
      vaultId,
      path,
      operationId,
      revision,
      parent: { kind: "never_seen" },
      contentSha256,
      content,
      mediaType: "text/markdown",
      origin,
    };

    await advanceToWriteStep(store, fixture, request, "immutable_create");
    expect(await store.resumeOperation({ vaultId, operationId })).toMatchObject(
      {
        kind: "error",
        code: "effect_unknown",
        operationId,
      },
    );
    expect(
      fixture.bucket.puts.filter((key) => key === contentKey),
    ).toHaveLength(priorCreateCount);
    expect(await store.readCurrent({ vaultId, path })).toEqual({
      kind: "never_seen",
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      ),
    ).toEqual({ kind: "absent" });
  });

  it("keeps a conflicting immutable body untouched and the mutation unpublished", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const conflictingContent = "Different pre-existing revision bytes";
    const bytes = encoder.encode(conflictingContent);
    const conflictingBody: Extract<
      SyncBodyRecord,
      { readonly kind: "contentBody" }
    > = {
      kind: "contentBody",
      vaultId,
      revision,
      bytes,
      byteSize: bytes.byteLength,
      contentSha256: await sha256Content(conflictingContent),
    };
    expect(await fixture.records.createContent(conflictingBody)).toEqual({
      kind: "confirmed",
    });
    const contentKey = syncContentKey(vaultId, revision);
    const requestContent = "Requested immutable revision bytes";
    const request: SyncMutationRequest = {
      kind: "create",
      vaultId,
      path,
      operationId,
      revision,
      parent: { kind: "never_seen" },
      contentSha256: await sha256Content(requestContent),
      content: requestContent,
      mediaType: "text/markdown",
      origin,
    };

    await advanceToWriteStep(store, fixture, request, "immutable_create");
    expect(await store.resumeOperation({ vaultId, operationId })).toMatchObject(
      {
        kind: "error",
        code: "effect_unknown",
        operationId,
      },
    );
    expect(await fixture.bucket.objects.get(contentKey)?.text()).toBe(
      conflictingContent,
    );
    expect(await store.readCurrent({ vaultId, path })).toEqual({
      kind: "never_seen",
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({ kind: "absent" });
    const journal = await fixture.publication.readJournal(vaultId, operationId);
    expect(journal).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: { step: "immutable_create", key: contentKey },
        },
      },
    });
  });

  it.each([Number.NaN, 8_640_000_000_000_001, Number.MAX_SAFE_INTEGER])(
    "refuses an unsafe clock %s before an immutable target claim or PUT",
    async (unsafeTime) => {
      const fixture = await setup();
      const request = await createMutationRequest(
        "Clock-fenced immutable revision",
      );
      await advanceToWriteStep(
        createStore(fixture),
        fixture,
        request,
        "immutable_create",
      );
      const key = syncContentKey(vaultId, revision);
      const journalKey = syncOperationKey(vaultId, operationId);
      const writesBefore = fixture.bucket.putAttempts.filter(
        (attempt) => attempt.key === key,
      ).length;
      const journalWritesBefore = fixture.bucket.putAttempts.filter(
        (attempt) => attempt.key === journalKey,
      ).length;
      const safeTime = fixture.now();
      fixture.setNow(unsafeTime);
      const result = await createStore(fixture).resumeOperation({
        vaultId,
        operationId,
      });
      expect(result.kind).toBe("error");
      expect(
        fixture.bucket.putAttempts.filter((attempt) => attempt.key === key),
      ).toHaveLength(writesBefore);
      expect(
        fixture.bucket.putAttempts.filter(
          (attempt) => attempt.key === journalKey,
        ),
      ).toHaveLength(journalWritesBefore);
      fixture.setNow(safeTime);
      expect(
        await fixture.publication.readJournal(vaultId, operationId),
      ).toMatchObject({
        kind: "observed",
        observation: {
          value: {
            status: "pending",
            allocationState: "allocated",
            stepEvidence: {
              step: "immutable_create",
              attempt: { state: "ready" },
            },
          },
        },
      });
    },
  );

  it("claims an immutable create before writing and keeps its retry floor fixed across stores", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const content = "Claimed immutable create";
    const contentKey = syncContentKey(vaultId, revision);
    const request: SyncMutationRequest = {
      kind: "create",
      vaultId,
      path,
      operationId,
      revision,
      parent: { kind: "never_seen" },
      contentSha256: await sha256Content(content),
      content,
      mediaType: "text/markdown",
      origin,
    };
    await advanceToWriteStep(store, fixture, request, "immutable_create");
    const readyJournal = await fixture.publication.readJournal(
      vaultId,
      operationId,
    );
    expect(readyJournal.kind).toBe("observed");
    if (readyJournal.kind !== "observed") return;
    fixture.setNow(
      Math.max(
        fixture.now(),
        readyJournal.observation.observed.uploaded.getTime() + 1_100,
      ),
    );
    const claimTime = fixture.now();
    fixture.bucket.beforeNextPut(contentKey, "create", async () => {
      throw new Error("Simulated timeout before immutable PUT.");
    });

    const interrupted = await store.resumeOperation({ vaultId, operationId });
    const immutablePuts = fixture.bucket.putAttempts.filter(
      ({ key, phase }) => key === contentKey && phase === "create",
    );
    expect(immutablePuts).toHaveLength(1);
    const claimed = await fixture.publication.readJournal(vaultId, operationId);
    expect(claimed).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: {
            step: "immutable_create",
            attempt: { state: "attempting", generation: 1 },
          },
        },
      },
    });
    if (
      claimed.kind !== "observed" ||
      claimed.observation.value.status !== "pending" ||
      claimed.observation.value.allocationState !== "allocated" ||
      claimed.observation.value.stepEvidence.step === "commit_journal" ||
      claimed.observation.value.stepEvidence.attempt.state !== "attempting"
    ) {
      return;
    }
    const firstClaim = claimed.observation.value.stepEvidence.attempt;
    expect(firstClaim.claimedAtEpochMs).toBe(claimTime);
    expect(interrupted).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId,
      retryAfterEpochMs: claimTime + 1_100,
    });

    fixture.setNow(claimTime + 400);
    const early = await createStore(fixture).resumeOperation({
      vaultId,
      operationId,
    });
    expect(early).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId,
    });
    expect(
      fixture.bucket.putAttempts.filter(
        ({ key, phase }) => key === contentKey && phase === "create",
      ),
    ).toHaveLength(1);

    fixture.setNow(claimTime + 1_100);
    await createStore(fixture).resumeOperation({ vaultId, operationId });
    const retryWaiting = await fixture.publication.readJournal(
      vaultId,
      operationId,
    );
    expect(retryWaiting).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          stepEvidence: {
            step: "immutable_create",
            attempt: { state: "retry_wait", generation: 1 },
          },
        },
      },
    });
    if (
      retryWaiting.kind !== "observed" ||
      retryWaiting.observation.value.status !== "pending" ||
      retryWaiting.observation.value.allocationState !== "allocated" ||
      retryWaiting.observation.value.stepEvidence.step === "commit_journal" ||
      retryWaiting.observation.value.stepEvidence.attempt.state !== "retry_wait"
    ) {
      return;
    }
    const fixedFloor =
      retryWaiting.observation.value.stepEvidence.attempt.retryAfterEpochMs;
    expect(fixedFloor).toBe(claimTime + 2_200);
    fixture.setNow(fixedFloor - 100);
    expect(
      await createStore(fixture).resumeOperation({ vaultId, operationId }),
    ).toMatchObject({
      kind: "error",
      code: "operation_pending",
      retryAfterEpochMs: fixedFloor,
    });
    expect(
      fixture.bucket.putAttempts.filter(
        ({ key, phase }) => key === contentKey && phase === "create",
      ),
    ).toHaveLength(1);

    fixture.setNow(fixedFloor);
    await createStore(fixture).resumeOperation({ vaultId, operationId });
    const retried = await fixture.publication.readJournal(vaultId, operationId);
    expect(retried).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          stepEvidence: {
            step: "immutable_create",
            attempt: { state: "attempting", generation: 2 },
          },
        },
      },
    });
    expect(
      fixture.bucket.putAttempts.filter(
        ({ key, phase }) => key === contentKey && phase === "create",
      ),
    ).toHaveLength(2);
  });

  it("defers a throttled immutable create until its persisted retry floor", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const content = "Rate-limited immutable bytes";
    const contentKey = syncContentKey(vaultId, revision);
    const request: SyncMutationRequest = {
      kind: "create",
      vaultId,
      path,
      operationId,
      revision,
      parent: { kind: "never_seen" },
      contentSha256: await sha256Content(content),
      content,
      mediaType: "text/markdown",
      origin,
    };
    let wasThrottled = false;
    fixture.bucket.beforeNextPut(contentKey, "create", async () => {
      wasThrottled = true;
      throw Object.assign(new Error("Too many requests"), { status: 429 });
    });

    const throttled = await resumeUntil(
      store,
      fixture,
      request,
      () => wasThrottled,
    );
    expect(throttled).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId,
    });
    if (throttled.kind !== "error" || !("retryAfterEpochMs" in throttled)) {
      return;
    }
    expect(throttled.retryAfterEpochMs).toBeGreaterThan(fixture.now());
    const attemptsAfterThrottle = fixture.bucket.puts.filter(
      (key) => key === contentKey,
    ).length;
    expect(
      await createStore(fixture).resumeOperation({ vaultId, operationId }),
    ).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId,
    });
    expect(
      fixture.bucket.puts.filter((key) => key === contentKey),
    ).toHaveLength(attemptsAfterThrottle);

    fixture.setNow(throttled.retryAfterEpochMs);
    await advanceToHeadWrite(createStore(fixture), fixture, request);
    expect(
      fixture.bucket.puts.filter((key) => key === contentKey),
    ).toHaveLength(attemptsAfterThrottle + 1);
    expect(await createStore(fixture).readCurrent({ vaultId, path })).toEqual({
      kind: "never_seen",
    });
  });

  it("recovers an immutable create applied before its response and read-back are lost", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const content = "Applied immutable create 🌐";
    const bytes = encoder.encode(content);
    const contentSha256 = await sha256Content(content);
    const contentKey = syncContentKey(vaultId, revision);
    const request: SyncMutationRequest = {
      kind: "create",
      vaultId,
      path,
      operationId,
      revision,
      parent: { kind: "never_seen" },
      contentSha256,
      content,
      mediaType: "text/markdown",
      origin,
    };
    fixture.bucket.applyThenLoseResponse(contentKey, "create", 2);

    const interrupted = await resumeUntil(store, fixture, request, () =>
      fixture.bucket.appliedThenLostResponses.some(
        ({ key, phase }) => key === contentKey && phase === "create",
      ),
    );
    const contentAttempts = fixture.bucket.putAttempts.filter(
      ({ key, phase }) => key === contentKey && phase === "create",
    );
    expect(contentAttempts).toHaveLength(1);
    const contentAttempt = contentAttempts[0];
    expect(contentAttempt).toBeDefined();
    if (contentAttempt === undefined) return;
    expect(contentAttempt.bytes).toEqual(bytes);
    const storedContent = fixture.bucket.objects.get(contentKey);
    expect(storedContent).toBeDefined();
    if (storedContent === undefined) return;
    expect(new Uint8Array(await storedContent.arrayBuffer())).toEqual(
      contentAttempt.bytes,
    );
    expect(interrupted).toMatchObject({
      kind: "error",
      code: "effect_unknown",
      operationId,
    });
    if (interrupted.kind !== "error" || !("retryAfterEpochMs" in interrupted)) {
      return;
    }
    expect(await fixture.bucket.objects.get(contentKey)?.text()).toBe(content);
    expect(await store.readCurrent({ vaultId, path })).toEqual({
      kind: "never_seen",
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({ kind: "absent" });
    const interruptedJournal = await fixture.publication.readJournal(
      vaultId,
      operationId,
    );
    expect(interruptedJournal).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: { step: "immutable_create", key: contentKey },
        },
      },
    });

    const writesBeforeResume = fixture.bucket.puts.filter(
      (key) => key === contentKey,
    ).length;
    fixture.setNow(interrupted.retryAfterEpochMs);
    await advanceToHeadWrite(createStore(fixture), fixture, request);
    expect(
      fixture.bucket.puts.filter((key) => key === contentKey),
    ).toHaveLength(writesBeforeResume);
    expect(await createStore(fixture).readCurrent({ vaultId, path })).toEqual({
      kind: "never_seen",
    });
  });

  it("resumes an applied feed-event create after exact read-back was unavailable", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const content = "Feed event uncertainty";
    const sequence = syncEventSequenceSchema.parse("00000000000000000001");
    const eventKey = syncFeedEventKey(vaultId, fixture.lane, sequence);
    const request: SyncMutationRequest = {
      kind: "create",
      vaultId,
      path,
      operationId,
      revision,
      parent: { kind: "never_seen" },
      contentSha256: await sha256Content(content),
      content,
      mediaType: "text/markdown",
      origin,
    };
    const fixedCommitTime = fixture.now();
    await seedCreateEventStep(fixture, request, fixedCommitTime);
    fixture.setNow(fixedCommitTime + 500);
    fixture.bucket.applyThenLoseResponse(eventKey, "create", 2);

    const interrupted = await store.resumeOperation({ vaultId, operationId });
    expect(
      fixture.bucket.appliedThenLostResponses.some(
        ({ key, phase }) => key === eventKey && phase === "create",
      ),
    ).toBe(true);
    const eventAttempts = fixture.bucket.putAttempts.filter(
      ({ key, phase }) => key === eventKey && phase === "create",
    );
    expect(eventAttempts).toHaveLength(1);
    const eventAttempt = eventAttempts[0];
    expect(eventAttempt).toBeDefined();
    if (eventAttempt === undefined) return;
    expect(eventAttempt.ifNoneMatch).toBe("*");
    const storedEvent = fixture.bucket.objects.get(eventKey);
    expect(storedEvent).toBeDefined();
    if (storedEvent === undefined) return;
    expect(new Uint8Array(await storedEvent.arrayBuffer())).toEqual(
      eventAttempt.bytes,
    );
    expect(interrupted).toMatchObject({
      kind: "error",
      code: "effect_unknown",
      operationId,
    });
    if (interrupted.kind !== "error" || !("retryAfterEpochMs" in interrupted)) {
      return;
    }
    expect(
      await fixture.publication.readEvent(vaultId, fixture.lane, sequence),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          kind: "changed",
          vaultId,
          lane: fixture.lane,
          sequence,
          path,
          result: { kind: "live", revision },
          operationId,
          origin,
          committedAtEpochMs: fixedCommitTime,
        },
      },
    });
    const blockedJournal = await fixture.publication.readJournal(
      vaultId,
      operationId,
    );
    expect(blockedJournal).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: {
            step: "create_event",
            outcomeIntent: "changed",
            committedAtEpochMs: fixedCommitTime,
          },
        },
      },
    });
    expect(await store.readCurrent({ vaultId, path })).toMatchObject({
      kind: "live",
      revision,
      operationId,
    });
    const blockedLane = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(blockedLane).toMatchObject({
      kind: "observed",
      observation: {
        value: { pending: { operationId, nextSequence: sequence } },
      },
    });
    const eventWrites = fixture.bucket.puts.filter((key) => key === eventKey);
    expect(eventWrites).toHaveLength(1);

    fixture.setNow(interrupted.retryAfterEpochMs);
    await advanceToTerminalLaneCommit(createStore(fixture), fixture, request);
    const terminal = await fixture.publication.readJournal(
      vaultId,
      operationId,
    );
    expect(terminal).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "committed",
          committedAtEpochMs: fixedCommitTime,
          stepEvidence: { step: "commit_lane" },
        },
      },
    });
    expect(fixture.bucket.puts.filter((key) => key === eventKey)).toHaveLength(
      eventWrites.length,
    );
  });

  it("dispatches one feed event when same-ID resumers race for its claim", async () => {
    const fixture = await setup();
    const content = "Concurrent event claim";
    const request = await createMutationRequest(content);
    await seedCreateEventStep(fixture, request);
    const eventKey = syncFeedEventKey(
      vaultId,
      fixture.lane,
      FIRST_EVENT_SEQUENCE,
    );
    fixture.bucket.barrierNextGets(syncOperationKey(vaultId, operationId), 2);

    await Promise.all([
      createStore(fixture).resumeOperation({ vaultId, operationId }),
      createStore(fixture).resumeOperation({ vaultId, operationId }),
    ]);

    expect(
      fixture.bucket.putAttempts.filter(
        ({ key, phase }) => key === eventKey && phase === "create",
      ),
    ).toHaveLength(1);
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      ),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          kind: "changed",
          operationId,
          committedAtEpochMs: fixture.now(),
        },
      },
    });
  });

  it("dispatches after exact own-claim read-back when the claim response is lost", async () => {
    const fixture = await setup();
    const content = "Claim response lost";
    const request = await createMutationRequest(content);
    await seedCreateEventStep(fixture, request);
    const journalKey = syncOperationKey(vaultId, operationId);
    const eventKey = syncFeedEventKey(
      vaultId,
      fixture.lane,
      FIRST_EVENT_SEQUENCE,
    );
    fixture.bucket.applyThenLoseResponse(journalKey, "replace", 1);

    const result = await createStore(fixture).resumeOperation({
      vaultId,
      operationId,
    });

    expect(result).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId,
    });
    expect(
      fixture.bucket.appliedThenLostResponses.some(
        ({ key, phase }) => key === journalKey && phase === "replace",
      ),
    ).toBe(true);
    expect(
      fixture.bucket.putAttempts.filter(
        ({ key, phase }) => key === eventKey && phase === "create",
      ),
    ).toHaveLength(1);
  });

  it("keeps an absent feed event in retry_wait after a lost floor-CAS response", async () => {
    const fixture = await setup();
    const content = "Event retry floor response lost";
    const request = await createMutationRequest(content);
    await seedCreateEventStep(fixture, request);
    const journalKey = syncOperationKey(vaultId, operationId);
    const eventKey = syncFeedEventKey(
      vaultId,
      fixture.lane,
      FIRST_EVENT_SEQUENCE,
    );
    fixture.bucket.beforeNextPut(eventKey, "create", async () => {
      fixture.bucket.applyThenLoseResponse(journalKey, "replace", 1);
      throw new Error("Simulated no-effect event timeout.");
    });

    const first = await createStore(fixture).resumeOperation({
      vaultId,
      operationId,
    });
    expect(first).toMatchObject({ kind: "error", code: "operation_pending" });
    expect(fixture.bucket.objects.has(eventKey)).toBe(false);
    if (first.kind !== "error" || !("retryAfterEpochMs" in first)) return;

    fixture.setNow(first.retryAfterEpochMs);
    const persistedFloor = await createStore(fixture).resumeOperation({
      vaultId,
      operationId,
    });
    expect(persistedFloor).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId,
    });
    expect(
      fixture.bucket.appliedThenLostResponses.some(
        ({ key, phase }) => key === journalKey && phase === "replace",
      ),
    ).toBe(true);
    const retryJournal = await fixture.publication.readJournal(
      vaultId,
      operationId,
    );
    expect(retryJournal).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          stepEvidence: {
            step: "create_event",
            attempt: { state: "retry_wait", generation: 1 },
          },
        },
      },
    });
    if (
      retryJournal.kind !== "observed" ||
      retryJournal.observation.value.status !== "pending" ||
      retryJournal.observation.value.allocationState !== "allocated" ||
      retryJournal.observation.value.stepEvidence.step !== "create_event" ||
      retryJournal.observation.value.stepEvidence.attempt.state !== "retry_wait"
    ) {
      return;
    }
    const retryAfterEpochMs =
      retryJournal.observation.value.stepEvidence.attempt.retryAfterEpochMs;
    expect(retryAfterEpochMs).toBe(first.retryAfterEpochMs + 1_100);

    fixture.setNow(retryAfterEpochMs - 100);
    expect(
      await createStore(fixture).resumeOperation({ vaultId, operationId }),
    ).toMatchObject({
      kind: "error",
      code: "operation_pending",
      retryAfterEpochMs,
    });
    expect(
      fixture.bucket.putAttempts.filter(({ key }) => key === eventKey),
    ).toHaveLength(1);
  });

  it.each([
    "refused",
    "throttled",
    "effect_unknown",
    "applied_unknown",
  ] as const)(
    "retains the event retry floor across a %s retry-wait CAS without dispatch",
    async (certainty) => {
      const fixture = await setup();
      const request = await createMutationRequest(
        `Retry-wait CAS ${certainty}`,
      );
      await seedCreateEventStep(fixture, request);
      const journalKey = syncOperationKey(vaultId, operationId);
      const eventKey = syncFeedEventKey(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      );
      fixture.bucket.beforeNextPut(eventKey, "create", async () => {
        throw new Error("Event target remained absent after timeout");
      });
      const first = await createStore(fixture).resumeOperation({
        vaultId,
        operationId,
      });
      if (first.kind !== "error" || !("retryAfterEpochMs" in first)) {
        throw new Error("Expected fixed no-effect observation floor");
      }
      fixture.setNow(first.retryAfterEpochMs);
      const observedAt = fixture.now();
      const mandatoryFloor = observedAt + 1_100;
      const remoteFloor = mandatoryFloor + 5_000;
      const createInvocation = createSyncR2MutationInvocationFactory(
        fixture.bucket,
        fixture.now,
      );
      let replacementAttempted = false;
      const store = syncR2Mutation(
        fixture.records,
        () => {
          const invocation = createInvocation();
          const original = invocation.publication;
          return {
            ...invocation,
            publication: {
              ...original,
              replaceJournal: async (observed, next, context) => {
                if (
                  next.allocationState !== "allocated" ||
                  next.stepEvidence.step !== "create_event" ||
                  next.stepEvidence.attempt.state !== "retry_wait"
                ) {
                  return original.replaceJournal(observed, next, context);
                }
                replacementAttempted = true;
                if (certainty === "applied_unknown") {
                  expect(
                    await original.replaceJournal(observed, next, context),
                  ).toEqual({ kind: "confirmed" });
                  return {
                    kind: "effect_unknown",
                    retryAfterEpochMs: remoteFloor,
                  };
                }
                if (certainty === "refused") return { kind: "refused" };
                if (certainty === "throttled")
                  return { kind: "throttled", retryAfterEpochMs: remoteFloor };
                return {
                  kind: "effect_unknown",
                  retryAfterEpochMs: remoteFloor,
                };
              },
              readJournal: async (vault, id) => {
                if (replacementAttempted && certainty !== "refused")
                  return { kind: "unavailable" };
                return original.readJournal(vault, id);
              },
            },
          };
        },
        fixture.now,
      );
      expect(await store.resumeOperation({ vaultId, operationId })).toEqual({
        kind: "error",
        code:
          certainty === "throttled" || certainty === "refused"
            ? "operation_pending"
            : "effect_unknown",
        operationId,
        retryAfterEpochMs:
          certainty === "refused" ? mandatoryFloor : remoteFloor,
      });
      expect(replacementAttempted).toBe(true);
      expect(
        fixture.bucket.putAttempts.filter(({ key }) => key === eventKey),
      ).toHaveLength(1);
      expect(fixture.bucket.objects.has(eventKey)).toBe(false);
      const persisted = await fixture.publication.readJournal(
        vaultId,
        operationId,
      );
      expect(persisted).toMatchObject({
        kind: "observed",
        observation: {
          value: {
            status: "pending",
            stepEvidence: {
              step: "create_event",
              attempt: {
                state:
                  certainty === "applied_unknown" ? "retry_wait" : "attempting",
                generation: 1,
              },
            },
          },
        },
      });
      fixture.setNow(remoteFloor);
      expect(
        await settleResume(createStore(fixture), fixture, request),
      ).toMatchObject({ kind: "committed", operationId, revision });
      const terminal = await fixture.publication.readJournal(
        vaultId,
        operationId,
      );
      expect(terminal).toMatchObject({
        kind: "observed",
        observation: { value: { status: "committed" } },
      });
      expect(
        fixture.bucket.putAttempts.filter(({ key }) => key === eventKey),
      ).toHaveLength(2);
      expect(
        fixture.bucket.gets.filter((key) => key === journalKey).length,
      ).toBeGreaterThan(0);
    },
  );

  it.each(["exact", "divergent", "unavailable"] as const)(
    "rechecks a late %s event after confirming a fresh retry claim",
    async (lateEvidence) => {
      const fixture = await setup();
      const request = await createMutationRequest(`Late event ${lateEvidence}`);
      const committedAtEpochMs = fixture.now();
      await seedCreateEventStep(fixture, request, committedAtEpochMs);
      const journalKey = syncOperationKey(vaultId, operationId);
      const eventKey = syncFeedEventKey(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      );
      fixture.bucket.beforeNextPut(eventKey, "create", async () => {
        throw new Error("Event response lost without visible target");
      });
      const attempted = await createStore(fixture).resumeOperation({
        vaultId,
        operationId,
      });
      if (attempted.kind !== "error" || !("retryAfterEpochMs" in attempted))
        throw new Error("Expected claim cooldown");
      fixture.setNow(attempted.retryAfterEpochMs);
      const waiting = await createStore(fixture).resumeOperation({
        vaultId,
        operationId,
      });
      if (waiting.kind !== "error" || !("retryAfterEpochMs" in waiting))
        throw new Error("Expected retry-wait cooldown");
      fixture.setNow(waiting.retryAfterEpochMs);
      const event: SyncFeedEventRecord = {
        schemaVersion: 1,
        protocolMajor: 1,
        vaultId,
        kind: "changed",
        lane: fixture.lane,
        sequence: FIRST_EVENT_SEQUENCE,
        path,
        result: {
          kind: "live",
          revision: lateEvidence === "divergent" ? updatedRevision : revision,
        },
        operationId,
        origin,
        committedAtEpochMs,
      };
      const eventBytes = await encodeSyncPublication(event);
      fixture.bucket.afterNextPut(journalKey, "replace", async () => {
        if (lateEvidence === "unavailable")
          fixture.bucket.failNextGets(eventKey, 1);
        else fixture.bucket.seed(eventKey, eventBytes, fixture.now());
      });
      expect(
        await createStore(fixture).resumeOperation({ vaultId, operationId }),
      ).toMatchObject({
        kind: "error",
        code: lateEvidence === "exact" ? "operation_pending" : "effect_unknown",
        operationId,
      });
      expect(
        fixture.bucket.putAttempts.filter(({ key }) => key === eventKey),
      ).toHaveLength(1);
      if (lateEvidence === "exact") {
        expect(
          await settleResume(createStore(fixture), fixture, request),
        ).toMatchObject({ kind: "committed", operationId, revision });
        const preserved = await fixture.publication.readEvent(
          vaultId,
          fixture.lane,
          FIRST_EVENT_SEQUENCE,
        );
        if (preserved.kind !== "observed")
          throw new Error("Expected preserved event witness");
        expect(preserved.observation.observed.bytes).toEqual(eventBytes);
      } else {
        expect(
          await fixture.publication.readJournal(vaultId, operationId),
        ).toMatchObject({
          kind: "observed",
          observation: {
            value: {
              status: "pending",
              stepEvidence: {
                step: "create_event",
                attempt: { state: "attempting", generation: 2 },
              },
            },
          },
        });
      }
    },
  );

  it.each([
    "before_claim_changed",
    "saved_claim_unavailable",
    "last_claim_changed",
    "last_claim_unavailable",
  ] as const)(
    "withholds event dispatch when %s removes exact claim ownership",
    async (race) => {
      const fixture = await setup();
      const request = await createMutationRequest(`Claim fence ${race}`);
      await seedCreateEventStep(fixture, request);
      const eventKey = syncFeedEventKey(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      );
      const createInvocation = createSyncR2MutationInvocationFactory(
        fixture.bucket,
        fixture.now,
      );
      let claimConfirmed = false;
      let lateTargetRead = false;
      let initialRead = true;
      let faultConsumed = false;
      let peerFloor: number | undefined;
      const store = syncR2Mutation(
        fixture.records,
        () => {
          const invocation = createInvocation();
          const original = invocation.publication;
          return {
            ...invocation,
            publication: {
              ...original,
              replaceJournal: async (observed, next, context) => {
                const result = await original.replaceJournal(
                  observed,
                  next,
                  context,
                );
                if (
                  next.allocationState === "allocated" &&
                  next.stepEvidence.step === "create_event" &&
                  next.stepEvidence.attempt.state === "attempting" &&
                  result.kind === "confirmed"
                )
                  claimConfirmed = true;
                return result;
              },
              readJournal: async (vault, id) => {
                if (
                  !faultConsumed &&
                  ((race === "saved_claim_unavailable" && claimConfirmed) ||
                    (race === "last_claim_unavailable" && lateTargetRead))
                ) {
                  faultConsumed = true;
                  return { kind: "unavailable" };
                }
                const result = await original.readJournal(vault, id);
                if (initialRead) {
                  initialRead = false;
                  if (race === "before_claim_changed") {
                    if (
                      result.kind !== "observed" ||
                      result.observation.value.status !== "pending" ||
                      result.observation.value.allocationState !==
                        "allocated" ||
                      result.observation.value.stepEvidence.step !==
                        "create_event"
                    ) {
                      throw new Error("Expected ready event snapshot");
                    }
                    const pending = result.observation.value;
                    const evidence = result.observation.value.stepEvidence;
                    expect(
                      await original.replaceJournal(result.observation, {
                        ...pending,
                        stepEvidence: {
                          ...evidence,
                          attempt: {
                            state: "attempting",
                            claimId: competingOperationId,
                            generation: 1,
                            claimedAtEpochMs: fixture.now(),
                          },
                        },
                      }),
                    ).toEqual({ kind: "confirmed" });
                  }
                }
                return result;
              },
              readEvent: async (vault, lane, position) => {
                const result = await original.readEvent(vault, lane, position);
                if (claimConfirmed && !lateTargetRead) {
                  lateTargetRead = true;
                  if (race === "last_claim_changed") {
                    fixture.setNow(fixture.now() + 1_100);
                    const current = await original.readJournal(
                      vaultId,
                      operationId,
                    );
                    if (
                      current.kind !== "observed" ||
                      current.observation.value.status !== "pending" ||
                      current.observation.value.allocationState !==
                        "allocated" ||
                      current.observation.value.stepEvidence.step !==
                        "create_event" ||
                      current.observation.value.stepEvidence.attempt.state !==
                        "attempting"
                    )
                      throw new Error("Expected owned event claim");
                    const pending = current.observation.value;
                    const evidence = current.observation.value.stepEvidence;
                    const claim =
                      current.observation.value.stepEvidence.attempt;
                    peerFloor = fixture.now() + 1_100;
                    expect(
                      await original.replaceJournal(current.observation, {
                        ...pending,
                        stepEvidence: {
                          ...evidence,
                          retryAfterEpochMs: peerFloor,
                          attempt: {
                            state: "retry_wait",
                            claimId: claim.claimId,
                            generation: claim.generation,
                            observedAtEpochMs: fixture.now(),
                            retryAfterEpochMs: peerFloor,
                          },
                        },
                      }),
                    ).toEqual({ kind: "confirmed" });
                  }
                }
                return result;
              },
            },
          };
        },
        fixture.now,
      );
      const result = await store.resumeOperation({ vaultId, operationId });
      expect(result).toEqual(
        peerFloor !== undefined
          ? {
              kind: "error",
              code: "operation_pending",
              operationId,
              retryAfterEpochMs: peerFloor,
            }
          : {
              kind: "error",
              code:
                race === "before_claim_changed"
                  ? "operation_pending"
                  : "effect_unknown",
              operationId,
            },
      );
      expect(
        fixture.bucket.putAttempts.filter(({ key }) => key === eventKey),
      ).toHaveLength(0);
      expect(fixture.bucket.objects.has(eventKey)).toBe(false);
      if (race.endsWith("unavailable")) expect(faultConsumed).toBe(true);
      fixture.setNow(Math.max(fixture.now() + 1_100, peerFloor ?? 0));
      expect(
        await settleResume(createStore(fixture), fixture, request),
      ).toMatchObject({ kind: "committed", operationId, revision });
      expect(
        fixture.bucket.putAttempts.filter(({ key }) => key === eventKey),
      ).toHaveLength(1);
    },
  );

  it("preserves tombstone recovery bytes across an applied-body timeout", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const content = "Tombstone recovery survives interruption 🌐";
    await seedLiveHead(fixture, content);
    const contentBytes = encoder.encode(content);
    const contentSha256 = await sha256Content(content);
    const recoveryBodyKey = syncRecoveryKey(
      vaultId,
      recoveryOperationId,
      "content",
    );
    const request: SyncMutationRequest = {
      kind: "tombstone",
      vaultId,
      path,
      operationId: recoveryOperationId,
      revision: tombstoneRevision,
      parent: { kind: "revision", revision },
      contentSha256,
      origin: alternateOrigin,
    };
    fixture.bucket.applyThenLoseResponse(recoveryBodyKey, "create", 2);

    const interrupted = await resumeUntil(store, fixture, request, () =>
      fixture.bucket.appliedThenLostResponses.some(
        ({ key, phase }) => key === recoveryBodyKey && phase === "create",
      ),
    );
    const bodyAttempts = fixture.bucket.putAttempts.filter(
      ({ key, phase }) => key === recoveryBodyKey && phase === "create",
    );
    expect(bodyAttempts).toHaveLength(1);
    const bodyAttempt = bodyAttempts[0];
    expect(bodyAttempt).toBeDefined();
    if (bodyAttempt === undefined) return;
    expect(bodyAttempt.bytes).toEqual(contentBytes);
    const storedRecoveryBody = fixture.bucket.objects.get(recoveryBodyKey);
    expect(storedRecoveryBody).toBeDefined();
    if (storedRecoveryBody === undefined) return;
    expect(new Uint8Array(await storedRecoveryBody.arrayBuffer())).toEqual(
      bodyAttempt.bytes,
    );
    expect(interrupted).toMatchObject({
      kind: "error",
      code: "effect_unknown",
      operationId: recoveryOperationId,
    });
    if (interrupted.kind !== "error" || !("retryAfterEpochMs" in interrupted)) {
      return;
    }
    expect(await fixture.bucket.objects.get(recoveryBodyKey)?.text()).toBe(
      content,
    );
    expect(await store.readCurrent({ vaultId, path })).toMatchObject({
      kind: "live",
      revision,
      operationId,
    });
    expect(
      await store.readRecovery({ vaultId, operationId: recoveryOperationId }),
    ).toEqual({ kind: "error", code: "storage_unavailable" });
    expect(
      await fixture.records.readVersion(vaultId, tombstoneRevision),
    ).toEqual({ kind: "absent" });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({ kind: "absent" });

    fixture.setNow(interrupted.retryAfterEpochMs);
    await advanceToHeadWrite(createStore(fixture), fixture, request);
    expect(await store.readCurrent({ vaultId, path })).toMatchObject({
      kind: "live",
      revision,
      operationId,
    });
    expect(
      await store.readRecovery({ vaultId, operationId: recoveryOperationId }),
    ).toMatchObject({
      kind: "present",
      recovery: {
        sourceRevision: revision,
        contentSha256,
        byteSize: contentBytes.byteLength,
        content,
        origin,
      },
    });
    expect(
      await store.readVersion({ vaultId, revision: tombstoneRevision }),
    ).toMatchObject({
      kind: "present",
      version: {
        kind: "tombstone",
        revision: tombstoneRevision,
        parent: { kind: "revision", revision },
        contentSha256,
        byteSize: contentBytes.byteLength,
      },
    });
  });

  it("returns storage unavailable when immutable version body bytes cannot be read", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    await seedLiveHead(fixture, "Persisted version body");
    fixture.bucket.failNextGets(syncContentKey(vaultId, revision), 1);

    expect(await store.readVersion({ vaultId, revision })).toEqual({
      kind: "error",
      code: "storage_unavailable",
    });
  });

  it("returns storage unavailable when retained recovery body bytes cannot be read", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    await seedTombstone(fixture, "Retained recovery body");
    fixture.bucket.failNextGets(
      syncRecoveryKey(vaultId, recoveryOperationId, "content"),
      1,
    );

    expect(
      await store.readRecovery({ vaultId, operationId: recoveryOperationId }),
    ).toEqual({ kind: "error", code: "storage_unavailable" });
  });

  it("does not create a tombstone when its exact live parent body is unavailable", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const content = "Unreadable exact tombstone source";
    await seedLiveHead(fixture, content);
    fixture.bucket.failNextGets(syncContentKey(vaultId, revision), 1);
    const request: SyncMutationRequest = {
      kind: "tombstone",
      vaultId,
      path,
      operationId: recoveryOperationId,
      revision: tombstoneRevision,
      parent: { kind: "revision", revision },
      contentSha256: await sha256Content(content),
      origin: alternateOrigin,
    };

    expect(await store.mutate(request)).toEqual({
      kind: "error",
      code: "storage_unavailable",
    });
    expect(
      await fixture.publication.readJournal(vaultId, recoveryOperationId),
    ).toEqual({ kind: "absent" });
    expect(
      await fixture.publication.readLaneHead(vaultId, fixture.lane),
    ).toEqual({ kind: "absent" });
    expect(
      await fixture.records.readVersion(vaultId, tombstoneRevision),
    ).toEqual({ kind: "absent" });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({ kind: "absent" });
    expect(await store.readCurrent({ vaultId, path })).toMatchObject({
      kind: "live",
      revision,
      operationId,
    });
  });

  it.each(["event", "head"] as const)(
    "withholds terminal success while the committed %s read is unavailable",
    async (unavailableRecord) => {
      const fixture = await setup();
      const store = createStore(fixture);
      const content = `Terminal ${unavailableRecord} read boundary`;
      const sequence = syncEventSequenceSchema.parse("00000000000000000001");
      const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
      const unavailableKey =
        unavailableRecord === "event"
          ? syncFeedEventKey(vaultId, fixture.lane, sequence)
          : syncHeadKey(vaultId, path);
      const request: SyncMutationRequest = {
        kind: "create",
        vaultId,
        path,
        operationId,
        revision,
        parent: { kind: "never_seen" },
        contentSha256: await sha256Content(content),
        content,
        mediaType: "text/markdown",
        origin,
      };
      await advanceToTerminalLaneCommit(store, fixture, request);
      const terminalRead = await fixture.publication.readJournal(
        vaultId,
        operationId,
      );
      expect(terminalRead.kind).toBe("observed");
      if (terminalRead.kind !== "observed") return;
      const terminal = terminalRead.observation.value;
      if (terminal.status === "pending") return;
      const retryAfter = terminal.stepEvidence.retryAfterEpochMs;
      if (retryAfter !== null) {
        fixture.setNow(Math.max(fixture.now(), retryAfter));
      }

      let laneCommit: SyncR2WriteResult | undefined;
      fixture.bucket.beforeNextPut(laneKey, "replace", async () => {
        const [journal, lane] = await Promise.all([
          fixture.publication.readJournal(vaultId, operationId),
          fixture.publication.readLaneHead(vaultId, fixture.lane),
        ]);
        if (
          journal.kind !== "observed" ||
          journal.observation.value.status === "pending" ||
          journal.observation.value.stepEvidence.step !== "commit_lane" ||
          lane.kind !== "observed"
        ) {
          throw new Error("The exact terminal lane reservation is required.");
        }
        const { pending: _pending, ...prior } = lane.observation.value;
        laneCommit = await fixture.publication.replaceLaneHead(
          lane.observation,
          {
            ...prior,
            committedSequence: journal.observation.value.position.sequence,
            committedAtEpochMs: journal.observation.value.committedAtEpochMs,
          },
        );
        fixture.bucket.failNextGets(unavailableKey, 1);
        throw new Error("Simulated lost terminal lane-release response.");
      });

      const first = await resumeUntil(
        store,
        fixture,
        request,
        () => laneCommit !== undefined,
      );
      expect(laneCommit).toEqual({ kind: "confirmed" });
      expect(first).toMatchObject({
        kind: "error",
        code: "effect_unknown",
        operationId,
      });
      const committedJournal = await fixture.publication.readJournal(
        vaultId,
        operationId,
      );
      expect(committedJournal).toMatchObject({
        kind: "observed",
        observation: {
          value: {
            status: "committed",
            revision,
            stepEvidence: { step: "commit_lane" },
          },
        },
      });
      expect(
        await fixture.publication.readEvent(vaultId, fixture.lane, sequence),
      ).toMatchObject({
        kind: "observed",
        observation: {
          value: {
            kind: "changed",
            operationId,
            result: { kind: "live", revision },
          },
        },
      });
      expect(
        await createStore(fixture).readCurrent({ vaultId, path }),
      ).toMatchObject({
        kind: "live",
        revision,
        operationId,
      });
      const committedLane = await fixture.publication.readLaneHead(
        vaultId,
        fixture.lane,
      );
      expect(committedLane.kind).toBe("observed");
      if (committedLane.kind !== "observed") return;
      expect(committedLane.observation.value.committedSequence).toBe(sequence);
      expect(committedLane.observation.value.pending).toBeUndefined();
      expect(
        await createStore(fixture).resumeOperation({ vaultId, operationId }),
      ).toEqual({
        kind: "committed",
        revision,
        operationId,
        position: { lane: fixture.lane, sequence },
      });
    },
  );
});

describe("targeted mutation recovery boundaries", () => {
  it("recovers a create after each raw R2 GET becomes unavailable once, without premature success", async () => {
    const request = await createMutationRequest("Raw read-failure matrix");
    const baseline = await setup();
    expect(
      await settleMutation(createStore(baseline), baseline, request),
    ).toMatchObject({
      kind: "committed",
    });
    const totalGets = baseline.bucket.gets.length;
    expect(totalGets).toBeGreaterThan(20);
    expect(totalGets).toBeLessThan(400);
    for (const getOrdinal of Array.from(
      { length: totalGets },
      (_, index) => index + 1,
    )) {
      const fixture = await setup();
      fixture.bucket.failOnGetCall(getOrdinal);
      const store = createStore(fixture);
      const initial = await store.mutate(request);
      expect(initial.kind).toBe("error");
      const retryFloor =
        initial.kind === "error" && "retryAfterEpochMs" in initial
          ? initial.retryAfterEpochMs
          : 0;
      fixture.setNow(Math.max(fixture.now() + 1_100, retryFloor));
      const journalExists = fixture.bucket.objects.has(
        syncOperationKey(vaultId, operationId),
      );
      const result = journalExists
        ? await settleResume(store, fixture, request)
        : await settleMutation(store, fixture, request);
      expect(fixture.bucket.failedGets).toHaveLength(1);
      expect({ getOrdinal, kind: result.kind }).toEqual({
        getOrdinal,
        kind: "committed",
      });
      if (result.kind !== "committed") throw new Error("Create did not settle");
      expect(result).toMatchObject({
        revision,
        operationId,
        position: { lane: fixture.lane },
      });
      expect(
        await fixture.publication.readJournal(vaultId, operationId),
      ).toMatchObject({
        kind: "observed",
        observation: { value: { status: "committed" } },
      });
      expect(
        await fixture.publication.readEvent(
          vaultId,
          result.position.lane,
          result.position.sequence,
        ),
      ).toMatchObject({
        kind: "observed",
        observation: {
          value: {
            kind: "changed",
            operationId,
            result: { kind: "live", revision },
          },
        },
      });
    }
  }, 60_000);

  it("does not accept a corrupt R2 vault marker as mutation authority", async () => {
    const fixture = await setup();
    fixture.bucket.corruptOnGetCall(1);
    const store = createStore(fixture);
    const request = await createMutationRequest("Transiently corrupt marker");
    expect(await store.mutate(request)).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId,
    });
    expect(fixture.bucket.putAttempts).toHaveLength(0);
    fixture.setNow(fixture.now() + 1_100);
    expect(await settleMutation(store, fixture, request)).toMatchObject({
      kind: "committed",
      operationId,
      revision,
    });
  });

  it("reconciles each applied-but-unacknowledged R2 PUT without replacing another generation", async () => {
    const request = await createMutationRequest(
      "Lost conditional write matrix",
    );
    const baseline = await setup();
    expect(
      await settleMutation(createStore(baseline), baseline, request),
    ).toMatchObject({
      kind: "committed",
    });
    const totalPuts = baseline.bucket.putAttempts.length;
    expect(totalPuts).toBeGreaterThan(5);
    expect(totalPuts).toBeLessThan(80);
    for (const putOrdinal of Array.from(
      { length: totalPuts },
      (_, index) => index + 1,
    )) {
      const fixture = await setup();
      fixture.bucket.loseOnPutCall(putOrdinal);
      const store = createStore(fixture);
      const initial = await store.mutate(request);
      expect(initial.kind).toBe("error");
      const retryFloor =
        initial.kind === "error" && "retryAfterEpochMs" in initial
          ? initial.retryAfterEpochMs
          : 0;
      fixture.setNow(Math.max(fixture.now() + 1_100, retryFloor));
      const result = fixture.bucket.objects.has(
        syncOperationKey(vaultId, operationId),
      )
        ? await settleResume(store, fixture, request)
        : await settleMutation(store, fixture, request);
      expect(fixture.bucket.appliedThenLostResponses).toHaveLength(1);
      expect({ putOrdinal, kind: result.kind }).toEqual({
        putOrdinal,
        kind: "committed",
      });
      if (result.kind !== "committed")
        throw new Error("Lost write did not settle");
      expect(result).toMatchObject({
        revision,
        operationId,
        position: { lane: fixture.lane },
      });
      expect(
        await fixture.publication.readJournal(vaultId, operationId),
      ).toMatchObject({
        kind: "observed",
        observation: { value: { status: "committed" } },
      });
      expect(
        await fixture.publication.readEvent(
          vaultId,
          result.position.lane,
          result.position.sequence,
        ),
      ).toMatchObject({
        kind: "observed",
        observation: {
          value: {
            kind: "changed",
            operationId,
            result: { kind: "live", revision },
          },
        },
      });
    }
  }, 20_000);

  it("preserves exact tombstone recovery after every one-shot raw R2 GET failure", async () => {
    const content = "Faulted tombstone source 🌐";
    const request: SyncMutationRequest = {
      kind: "tombstone",
      vaultId,
      path,
      operationId: recoveryOperationId,
      revision: tombstoneRevision,
      parent: { kind: "revision", revision },
      contentSha256: await sha256Content(content),
      origin: alternateOrigin,
    };
    const baseline = await setup();
    await seedLiveHead(baseline, content);
    const baselineGets = baseline.bucket.gets.length;
    expect(
      await settleMutation(createStore(baseline), baseline, request),
    ).toMatchObject({
      kind: "committed",
      revision: tombstoneRevision,
    });
    const totalGets = baseline.bucket.gets.length - baselineGets;
    expect(totalGets).toBeGreaterThan(20);
    expect(totalGets).toBeLessThan(500);
    for (const getOrdinal of Array.from(
      { length: totalGets },
      (_, index) => index + 1,
    )) {
      const fixture = await setup();
      await seedLiveHead(fixture, content);
      fixture.bucket.failOnGetCall(fixture.bucket.gets.length + getOrdinal);
      const store = createStore(fixture);
      const initial = await store.mutate(request);
      expect(initial.kind).toBe("error");
      const retryFloor =
        initial.kind === "error" && "retryAfterEpochMs" in initial
          ? initial.retryAfterEpochMs
          : 0;
      fixture.setNow(Math.max(fixture.now() + 1_100, retryFloor));
      const result = fixture.bucket.objects.has(
        syncOperationKey(vaultId, recoveryOperationId),
      )
        ? await settleResume(store, fixture, request)
        : await settleMutation(store, fixture, request);
      expect(fixture.bucket.failedGets).toHaveLength(1);
      expect({ getOrdinal, kind: result.kind }).toEqual({
        getOrdinal,
        kind: "committed",
      });
      if (result.kind !== "committed")
        throw new Error("Tombstone did not settle");
      expect(result.revision).toBe(tombstoneRevision);
      expect(
        await fixture.publication.readJournal(vaultId, recoveryOperationId),
      ).toMatchObject({
        kind: "observed",
        observation: { value: { status: "committed" } },
      });
      expect(
        await fixture.publication.readEvent(
          vaultId,
          result.position.lane,
          result.position.sequence,
        ),
      ).toMatchObject({
        kind: "observed",
        observation: {
          value: {
            kind: "changed",
            operationId: recoveryOperationId,
            result: { kind: "tombstone", revision: tombstoneRevision },
          },
        },
      });
      expect(
        await store.readRecovery({ vaultId, operationId: recoveryOperationId }),
      ).toMatchObject({
        kind: "present",
        recovery: { content, sourceRevision: revision },
      });
    }
  }, 90_000);

  it("returns effect unknown when the initial journal lookup is unavailable", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const request = await createMutationRequest("Journal lookup failure");
    fixture.bucket.failNextGets(syncOperationKey(vaultId, operationId), 1);

    expect(await store.mutate(request)).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId,
    });
    expect(fixture.bucket.puts).toEqual([]);
    expect(await fixture.publication.readJournal(vaultId, operationId)).toEqual(
      { kind: "absent" },
    );
  });

  it("retains an unallocated journal when its lane read is unavailable and resumes it", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const request = await createMutationRequest("Unavailable lane read");
    const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
    fixture.bucket.beforeNextPut(
      syncOperationKey(vaultId, operationId),
      "create",
      async () => fixture.bucket.failNextGets(laneKey, 1),
    );

    expect(await store.mutate(request)).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId,
    });
    const pending = await fixture.publication.readJournal(vaultId, operationId);
    expect(pending.kind).toBe("observed");
    if (pending.kind !== "observed") return;
    expect(pending.observation.value).toMatchObject({
      status: "pending",
      allocationState: "unallocated",
    });
    expect(await store.readCurrent({ vaultId, path })).toEqual({
      kind: "never_seen",
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({ kind: "absent" });

    expect(await settleResume(store, fixture, request)).toEqual({
      kind: "committed",
      revision,
      operationId,
      position: { lane: fixture.lane, sequence: "00000000000000000001" },
    });
  });

  it("reobserves a production-validated absent lane before reserving its sequence", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const request = await createMutationRequest("Absent lane recovery");
    const initialJournal = unallocatedJournalForRequest(request, fixture.lane, {
      kind: "absent",
    });
    expect(await fixture.publication.createJournal(initialJournal)).toEqual({
      kind: "confirmed",
    });

    const first = await store.resumeOperation({ vaultId, operationId });
    expect(first).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId,
    });
    if (first.kind !== "error" || !("retryAfterEpochMs" in first)) return;
    const initialized = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(initialized.kind).toBe("observed");
    if (initialized.kind !== "observed") return;
    expect(initialized.observation.value.committedSequence).toBe(
      "00000000000000000000",
    );
    expect(initialized.observation.value.pending).toBeUndefined();
    expect(
      await fixture.publication.readJournal(vaultId, operationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          allocationState: "unallocated",
          laneObservation: { precondition: { kind: "absent" } },
        },
      },
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({ kind: "absent" });
    expect(await store.readCurrent({ vaultId, path })).toEqual({
      kind: "never_seen",
    });

    fixture.setNow(first.retryAfterEpochMs);
    const reobserved = await store.resumeOperation({ vaultId, operationId });
    expect(reobserved).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId,
    });
    const journalAfterReobservation = await fixture.publication.readJournal(
      vaultId,
      operationId,
    );
    const laneAfterReobservation = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(journalAfterReobservation.kind).toBe("observed");
    expect(laneAfterReobservation.kind).toBe("observed");
    if (
      journalAfterReobservation.kind !== "observed" ||
      laneAfterReobservation.kind !== "observed"
    ) {
      return;
    }
    expect(journalAfterReobservation.observation.value).toMatchObject({
      allocationState: "unallocated",
      laneObservation: {
        key: syncFeedLaneHeadKey(vaultId, fixture.lane),
        precondition: {
          kind: "observed",
          etag: laneAfterReobservation.observation.observed.etag,
          bytes: encodeBase64Url(
            laneAfterReobservation.observation.observed.bytes,
          ),
          uploadedAtEpochMs:
            laneAfterReobservation.observation.observed.uploaded.getTime(),
        },
      },
    });
    expect(laneAfterReobservation.observation.value.pending).toBeUndefined();
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({ kind: "absent" });

    const beforeReservation = await store.resumeOperation({
      vaultId,
      operationId,
    });
    expect(beforeReservation).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId,
    });
    if (
      beforeReservation.kind !== "error" ||
      !("retryAfterEpochMs" in beforeReservation)
    ) {
      return;
    }
    fixture.setNow(beforeReservation.retryAfterEpochMs);
    const reserved = await store.resumeOperation({ vaultId, operationId });
    expect(reserved).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId,
    });
    const ownMarker = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(ownMarker).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          committedSequence: "00000000000000000000",
          pending: {
            operationId,
            nextSequence: "00000000000000000001",
          },
        },
      },
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({ kind: "absent" });
    expect(await store.readCurrent({ vaultId, path })).toEqual({
      kind: "never_seen",
    });

    if (reserved.kind !== "error" || !("retryAfterEpochMs" in reserved)) {
      return;
    }
    fixture.setNow(reserved.retryAfterEpochMs);
    const allocated = await store.resumeOperation({ vaultId, operationId });
    expect(allocated).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId,
    });
    expect(
      await fixture.publication.readJournal(vaultId, operationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          allocationState: "allocated",
          reservation: {
            lane: fixture.lane,
            sequence: "00000000000000000001",
          },
        },
      },
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({ kind: "absent" });

    expect(await settleResume(store, fixture, request)).toEqual({
      kind: "committed",
      revision,
      operationId,
      position: { lane: fixture.lane, sequence: "00000000000000000001" },
    });
  });

  it("does not recreate a lane after its persisted observed precondition disappears", async () => {
    const fixture = await setup();
    await seedEmptyLaneHead(fixture);
    const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
    const lane = await fixture.publication.readLaneHead(vaultId, fixture.lane);
    expect(lane.kind).toBe("observed");
    if (lane.kind !== "observed") return;
    const request = await createMutationRequest("Disappeared observed lane");
    const initialJournal = unallocatedJournalForRequest(request, fixture.lane, {
      kind: "observed",
      etag: lane.observation.observed.etag,
      bytes: encodeBase64Url(lane.observation.observed.bytes),
      uploadedAtEpochMs: lane.observation.observed.uploaded.getTime(),
    });
    expect(await fixture.publication.createJournal(initialJournal)).toEqual({
      kind: "confirmed",
    });
    const laneWritesBeforeRemoval = fixture.bucket.puts.filter(
      (key) => key === laneKey,
    ).length;
    fixture.bucket.objects.delete(laneKey);

    expect(
      await createStore(fixture).resumeOperation({ vaultId, operationId }),
    ).toEqual({ kind: "error", code: "effect_unknown", operationId });
    expect(
      await fixture.publication.readLaneHead(vaultId, fixture.lane),
    ).toEqual({ kind: "absent" });
    expect(
      await fixture.publication.readJournal(vaultId, operationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "unallocated",
          laneObservation: { precondition: { kind: "observed" } },
        },
      },
    });
    expect(fixture.bucket.puts.filter((key) => key === laneKey)).toHaveLength(
      laneWritesBeforeRemoval,
    );
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({ kind: "absent" });
    expect(await createStore(fixture).readCurrent({ vaultId, path })).toEqual({
      kind: "never_seen",
    });
  });

  it("does not derive a sequence after another operation wins an absent lane", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const request = await createMutationRequest("Earlier absent observation");
    const journal = unallocatedJournalForRequest(request, fixture.lane, {
      kind: "absent",
    });
    expect(await fixture.publication.createJournal(journal)).toEqual({
      kind: "confirmed",
    });

    const winnerContent = "Committed after the absent observation";
    const winnerRequest: SyncMutationRequest = {
      kind: "create",
      vaultId,
      path,
      operationId: recoveryOperationId,
      revision: updatedRevision,
      parent: { kind: "never_seen" },
      contentSha256: await sha256Content(winnerContent),
      content: winnerContent,
      mediaType: "text/markdown",
      origin,
    };
    expect(await settleMutation(store, fixture, winnerRequest)).toMatchObject({
      kind: "committed",
      operationId: recoveryOperationId,
      revision: updatedRevision,
      position: { lane: fixture.lane, sequence: "00000000000000000001" },
    });
    const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
    const laneWritesAfterWinner = fixture.bucket.puts.filter(
      (key) => key === laneKey,
    ).length;

    expect(await store.resumeOperation({ vaultId, operationId })).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId,
    });
    expect(
      await fixture.publication.readJournal(vaultId, operationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "unallocated",
          laneObservation: { precondition: { kind: "absent" } },
        },
      },
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: { kind: "changed", operationId: recoveryOperationId },
      },
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000002"),
      ),
    ).toEqual({ kind: "absent" });
    expect(await store.readCurrent({ vaultId, path })).toMatchObject({
      kind: "live",
      revision: updatedRevision,
      operationId: recoveryOperationId,
    });
    expect(fixture.bucket.puts.filter((key) => key === laneKey)).toHaveLength(
      laneWritesAfterWinner,
    );
  });

  it("accepts only the exact requested head after a refused stale-parent CAS", async () => {
    const fixture = await setup();
    const scenario = await prepareCurrentHeadCasScenario(fixture);
    const store = createStore(fixture);
    const original = await fixture.records.readHead(vaultId, path);
    expect(original.kind).toBe("observed");
    if (original.kind !== "observed") return;
    const originalEtag = original.observation.observed.etag;
    await advanceToHeadWrite(store, fixture, scenario.request);
    const journalBefore = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(journalBefore.kind).toBe("observed");
    if (journalBefore.kind !== "observed") return;
    expect(journalBefore.observation.value).toMatchObject({
      status: "pending",
      allocationState: "allocated",
      stepEvidence: {
        step: "write_head",
        precondition: { kind: "observed", etag: originalEtag },
      },
    });
    const deferred = await store.resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });
    expect(deferred).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId: recoveryOperationId,
    });
    if (deferred.kind !== "error" || !("retryAfterEpochMs" in deferred)) {
      return;
    }
    fixture.setNow(deferred.retryAfterEpochMs);

    const targetVersion = await fixture.records.readVersion(
      vaultId,
      scenario.request.revision,
    );
    expect(targetVersion.kind).toBe("observed");
    if (targetVersion.kind !== "observed") return;
    const headKey = syncHeadKey(vaultId, path);
    fixture.bucket.applyThenLoseResponse(headKey, "replace");

    const first = await store.resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });
    const headAttempts = fixture.bucket.putAttempts.filter(
      ({ key, phase }) => key === headKey && phase === "replace",
    );
    expect(headAttempts).toHaveLength(1);
    const headAttempt = headAttempts[0];
    expect(headAttempt).toBeDefined();
    if (headAttempt === undefined) return;
    expect(headAttempt.etagMatches).toBe(originalEtag);
    const storedHead = fixture.bucket.objects.get(headKey);
    expect(storedHead).toBeDefined();
    if (storedHead === undefined) return;
    expect(new Uint8Array(await storedHead.arrayBuffer())).toEqual(
      headAttempt.bytes,
    );
    expect(
      fixture.bucket.appliedThenLostResponses.filter(
        ({ key, phase }) => key === headKey && phase === "replace",
      ),
    ).toHaveLength(1);
    expect(first).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId: recoveryOperationId,
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({ kind: "absent" });
    expect(
      await createStore(fixture).readCurrent({ vaultId, path }),
    ).toMatchObject({
      kind: "live",
      revision: updatedRevision,
      operationId: recoveryOperationId,
    });

    expect(
      await settleResume(createStore(fixture), fixture, scenario.request),
    ).toMatchObject({
      kind: "committed",
      revision: updatedRevision,
      operationId: recoveryOperationId,
    });
  });

  it("keeps a refused head CAS blocked when read-back proves only absence", async () => {
    const fixture = await setup();
    const scenario = await prepareCurrentHeadCasScenario(fixture);
    const store = createStore(fixture);
    const original = await fixture.records.readHead(vaultId, path);
    expect(original.kind).toBe("observed");
    if (original.kind !== "observed") return;
    const originalEtag = original.observation.observed.etag;
    await advanceToHeadWrite(store, fixture, scenario.request);
    const journalBefore = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(journalBefore.kind).toBe("observed");
    if (journalBefore.kind !== "observed") return;
    expect(journalBefore.observation.value).toMatchObject({
      allocationState: "allocated",
      stepEvidence: {
        step: "write_head",
        precondition: { kind: "observed", etag: originalEtag },
      },
    });
    const deferred = await store.resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });
    expect(deferred).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId: recoveryOperationId,
    });
    if (deferred.kind !== "error" || !("retryAfterEpochMs" in deferred)) {
      return;
    }
    fixture.setNow(deferred.retryAfterEpochMs);

    const headKey = syncHeadKey(vaultId, path);
    const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
    const headWritesBeforeCas = fixture.bucket.puts.filter(
      (key) => key === headKey,
    ).length;
    const laneWritesBeforeCas = fixture.bucket.puts.filter(
      (key) => key === laneKey,
    ).length;
    let competingHeadWrite: SyncR2WriteResult | undefined;
    fixture.bucket.beforeNextPut(headKey, "replace", async () => {
      const current = await fixture.records.readHead(vaultId, path);
      if (current.kind !== "observed") {
        throw new Error(
          "The original current-head condition must be readable.",
        );
      }
      expect(current.observation.observed.etag).toBe(originalEtag);
      competingHeadWrite = await fixture.records.replaceHead(
        current.observation,
        scenario.competingHead,
      );
      fixture.bucket.objects.delete(headKey);
    });

    const first = await store.resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });
    expect(competingHeadWrite).toEqual({ kind: "confirmed" });
    expect(first).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId: recoveryOperationId,
    });
    expect(await createStore(fixture).readCurrent({ vaultId, path })).toEqual({
      kind: "never_seen",
    });
    const blockedJournal = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(blockedJournal).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: {
            step: "write_head",
            precondition: { kind: "observed", etag: originalEtag },
          },
        },
      },
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({ kind: "absent" });
    const lane = await fixture.publication.readLaneHead(vaultId, fixture.lane);
    expect(lane).toMatchObject({
      kind: "observed",
      observation: {
        value: { pending: { operationId: recoveryOperationId } },
      },
    });
    expect(fixture.bucket.puts.filter((key) => key === headKey)).toHaveLength(
      headWritesBeforeCas + 2,
    );

    expect(
      await createStore(fixture).resumeOperation({
        vaultId,
        operationId: recoveryOperationId,
      }),
    ).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId: recoveryOperationId,
    });
    expect(fixture.bucket.puts.filter((key) => key === headKey)).toHaveLength(
      headWritesBeforeCas + 2,
    );
    expect(fixture.bucket.puts.filter((key) => key === laneKey)).toHaveLength(
      laneWritesBeforeCas,
    );
  });

  it("refuses sequence exhaustion without reserving a lane or publishing an event", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const maximum = syncSequenceSchema.parse("9".repeat(20));
    const exhaustedLane: SyncLaneHeadRecord = {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      kind: "laneHead",
      lane: fixture.lane,
      committedSequence: maximum,
      committedAtEpochMs: fixture.now() - 1_100,
    };
    fixture.bucket.seed(
      syncFeedLaneHeadKey(vaultId, fixture.lane),
      encoder.encode(JSON.stringify(exhaustedLane)),
      fixture.now(),
    );
    expect(
      await fixture.publication.readLaneHead(vaultId, fixture.lane),
    ).toMatchObject({
      kind: "observed",
      observation: { value: exhaustedLane },
    });
    const request = await createMutationRequest("Exhausted feed sequence");

    expect(await store.mutate(request)).toEqual({
      kind: "error",
      code: "sequence_exhausted",
    });
    const journal = await fixture.publication.readJournal(vaultId, operationId);
    expect(journal.kind).toBe("observed");
    if (journal.kind !== "observed") return;
    expect(journal.observation.value).toMatchObject({
      status: "pending",
      allocationState: "unallocated",
    });
    const lane = await fixture.publication.readLaneHead(vaultId, fixture.lane);
    expect(lane.kind).toBe("observed");
    if (lane.kind !== "observed") return;
    expect(lane.observation.value).toEqual(exhaustedLane);
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({ kind: "absent" });
    expect(await store.readCurrent({ vaultId, path })).toEqual({
      kind: "never_seen",
    });
  });

  it("rejects a current head whose immutable version provenance differs", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    await seedLiveHead(fixture, "Mismatched immutable provenance");
    const head = await fixture.records.readHead(vaultId, path);
    expect(head.kind).toBe("observed");
    if (head.kind !== "observed") return;
    fixture.bucket.seed(
      syncHeadKey(vaultId, path),
      encoder.encode(
        JSON.stringify({
          ...head.observation.value,
          operationId: recoveryOperationId,
        }),
      ),
      fixture.now(),
    );

    expect(await store.readCurrent({ vaultId, path })).toEqual({
      kind: "error",
      code: "storage_unavailable",
    });
  });

  it("rejects recovery metadata that names a different source origin", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    await seedTombstone(fixture, "Recovery provenance mismatch");
    const metadata = await fixture.records.readRecovery(
      vaultId,
      recoveryOperationId,
    );
    expect(metadata.kind).toBe("observed");
    if (metadata.kind !== "observed") return;
    fixture.bucket.seed(
      syncRecoveryKey(vaultId, recoveryOperationId, "metadata"),
      encoder.encode(
        JSON.stringify({
          ...metadata.observation.value,
          origin: alternateOrigin,
        }),
      ),
      fixture.now(),
    );

    expect(
      await store.readRecovery({ vaultId, operationId: recoveryOperationId }),
    ).toEqual({ kind: "error", code: "storage_unavailable" });
  });

  it("withholds terminal success when the released lane has unavailable event evidence", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const content = "Terminal event reread unavailable";
    const request: SyncMutationRequest = {
      kind: "create",
      vaultId,
      path,
      operationId,
      revision,
      parent: { kind: "never_seen" },
      contentSha256: await sha256Content(content),
      content,
      mediaType: "text/markdown",
      origin,
    };
    await advanceToTerminalLaneCommit(store, fixture, request);
    const terminal = await fixture.publication.readJournal(
      vaultId,
      operationId,
    );
    expect(terminal.kind).toBe("observed");
    if (terminal.kind !== "observed") return;
    expect(terminal.observation.value.status).not.toBe("pending");
    if (terminal.observation.value.status === "pending") return;
    expect(terminal.observation.value.stepEvidence.step).toBe("commit_lane");

    let verificationReadFailed = false;
    fixture.bucket.beforeNextPut(
      syncFeedLaneHeadKey(vaultId, fixture.lane),
      "replace",
      async () => {
        verificationReadFailed = true;
        fixture.bucket.failNextGets(
          syncFeedEventKey(
            vaultId,
            fixture.lane,
            syncEventSequenceSchema.parse("00000000000000000001"),
          ),
          1,
        );
      },
    );
    const first = await resumeUntil(
      store,
      fixture,
      request,
      () => verificationReadFailed,
    );

    expect(first).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId,
    });
    const lane = await fixture.publication.readLaneHead(vaultId, fixture.lane);
    expect(lane.kind).toBe("observed");
    if (lane.kind !== "observed") return;
    expect(lane.observation.value.committedSequence).toBe(
      "00000000000000000001",
    );
    expect(
      await createStore(fixture).resumeOperation({ vaultId, operationId }),
    ).toEqual({
      kind: "committed",
      revision,
      operationId,
      position: { lane: fixture.lane, sequence: "00000000000000000001" },
    });
  });

  it.each(["journal", "current-head"] as const)(
    "withholds terminal success when final %s evidence is unavailable",
    async (evidence) => {
      const fixture = await setup();
      const store = createStore(fixture);
      const request = await createMutationRequest(
        `Final ${evidence} evidence unavailable`,
      );
      await advanceToTerminalLaneCommit(store, fixture, request);
      const terminal = await fixture.publication.readJournal(
        vaultId,
        operationId,
      );
      expect(terminal.kind).toBe("observed");
      if (terminal.kind !== "observed") return;
      expect(terminal.observation.value.status).not.toBe("pending");
      if (terminal.observation.value.status === "pending") return;
      expect(terminal.observation.value.stepEvidence.step).toBe("commit_lane");
      const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
      const evidenceKey =
        evidence === "journal"
          ? syncOperationKey(vaultId, operationId)
          : syncHeadKey(vaultId, path);
      let verificationReadFailed = false;
      fixture.bucket.beforeNextPut(laneKey, "replace", async () => {
        verificationReadFailed = true;
        fixture.bucket.failNextGets(evidenceKey, 1);
      });

      const first = await resumeUntil(
        store,
        fixture,
        request,
        () => verificationReadFailed,
      );
      expect(verificationReadFailed).toBe(true);
      expect(first).toEqual({
        kind: "error",
        code: "effect_unknown",
        operationId,
      });
      expect(
        await fixture.publication.readEvent(
          vaultId,
          fixture.lane,
          syncEventSequenceSchema.parse("00000000000000000001"),
        ),
      ).toMatchObject({ kind: "observed" });
      expect(await store.readCurrent({ vaultId, path })).toMatchObject({
        kind: "live",
        revision,
        operationId,
      });
      const released = await fixture.publication.readLaneHead(
        vaultId,
        fixture.lane,
      );
      expect(released.kind).toBe("observed");
      if (released.kind !== "observed") return;
      expect(released.observation.value.committedSequence).toBe(
        "00000000000000000001",
      );
      expect(released.observation.value.pending).toBeUndefined();

      expect(await store.resumeOperation({ vaultId, operationId })).toEqual({
        kind: "committed",
        revision,
        operationId,
        position: { lane: fixture.lane, sequence: "00000000000000000001" },
      });
    },
  );
});

describe("sync R2 mutation result policy", () => {
  it("preserves the distinct core rejection and resumable-operation contexts", () => {
    const cases: readonly {
      readonly code: SyncMutationPolicyErrorCode;
      readonly expected: SyncStoreFailure;
    }[] = [
      {
        code: "invalid_input",
        expected: { kind: "error", code: "invalid_input" },
      },
      {
        code: "stale_revision",
        expected: { kind: "error", code: "stale_revision" },
      },
      {
        code: "operation_id_reused",
        expected: { kind: "error", code: "operation_id_reused" },
      },
      {
        code: "operation_pending",
        expected: { kind: "error", code: "operation_pending", operationId },
      },
      {
        code: "effect_unknown",
        expected: { kind: "error", code: "effect_unknown", operationId },
      },
    ];

    for (const { code, expected } of cases) {
      expect(mutationRejection(code, operationId)).toEqual(expected);
    }
  });

  it("maps refusal, throttling, and uncertain writes to conservative resumable results", () => {
    const cases: readonly {
      readonly write: SyncR2WriteResult;
      readonly expected: SyncMutationResult;
    }[] = [
      {
        write: { kind: "refused" },
        expected: { kind: "error", code: "operation_pending", operationId },
      },
      {
        write: { kind: "throttled", retryAfterEpochMs: 24_500 },
        expected: {
          kind: "error",
          code: "operation_pending",
          operationId,
          retryAfterEpochMs: 24_500,
        },
      },
      {
        write: { kind: "effect_unknown", retryAfterEpochMs: 24_700 },
        expected: {
          kind: "error",
          code: "effect_unknown",
          operationId,
          retryAfterEpochMs: 24_700,
        },
      },
    ];

    for (const { write, expected } of cases) {
      expect(writeFailure(operationId, write)).toEqual(expected);
    }
  });
});

describe("pre-journal mutation admission", () => {
  it("returns mutation_not_admitted when a competitor invalidates the saved lane observation", async () => {
    const fixture = await setup();
    await seedEmptyLaneHead(fixture);
    const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
    const initialLane = fixture.bucket.objects.get(laneKey);
    expect(initialLane).toBeDefined();
    if (initialLane === undefined) return;
    const initialLaneBytes = new Uint8Array(await initialLane.arrayBuffer());
    const competingLane: SyncLaneHeadRecord = {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      kind: "laneHead",
      lane: fixture.lane,
      committedSequence: syncSequenceSchema.parse("0".repeat(20)),
      committedAtEpochMs: 0,
      pending: {
        operationId: competingOperationId,
        nextSequence: FIRST_EVENT_SEQUENCE,
      },
    };
    const competingLaneBytes = await encodeSyncPublication(competingLane);
    fixture.bucket.afterNextGet(laneKey, () => {
      fixture.bucket.seed(laneKey, competingLaneBytes, fixture.now());
    });

    const request = await createMutationRequest("Wait for lane admission");
    const journalKey = syncOperationKey(vaultId, operationId);
    const eventPosition = FIRST_EVENT_SEQUENCE;
    const putsBeforeAdmission = fixture.bucket.puts.length;
    const store = createStore(fixture);

    expect(await store.mutate(request)).toEqual({
      kind: "error",
      code: "mutation_not_admitted",
      operationId,
    });
    expect(fixture.bucket.puts.slice(putsBeforeAdmission)).toEqual([]);
    expect(await fixture.publication.readJournal(vaultId, operationId)).toEqual(
      { kind: "absent" },
    );
    expect(await store.readCurrent({ vaultId, path })).toEqual({
      kind: "never_seen",
    });
    expect(
      await fixture.publication.readEvent(vaultId, fixture.lane, eventPosition),
    ).toEqual({ kind: "absent" });
    expect(
      await fixture.publication.readLaneHead(vaultId, fixture.lane),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: { pending: { operationId: competingOperationId } },
      },
    });
    expect(await store.resumeOperation({ vaultId, operationId })).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId,
    });
    expect(fixture.bucket.puts.slice(putsBeforeAdmission)).toEqual([]);

    fixture.bucket.seed(laneKey, initialLaneBytes, fixture.now() - 1_100);
    expect(
      await settleMutation(createStore(fixture), fixture, request),
    ).toEqual({
      kind: "committed",
      revision,
      operationId,
      position: { lane: fixture.lane, sequence: eventPosition },
    });
    const journal = await fixture.publication.readJournal(vaultId, operationId);
    expect(journal).toMatchObject({
      kind: "observed",
      observation: { value: { request, allocationState: "allocated" } },
    });
    expect(
      fixture.bucket.putAttempts.filter(
        ({ key, phase }) => key === journalKey && phase === "create",
      ),
    ).toHaveLength(1);
    expect(
      fixture.bucket.puts.filter((key) => key === syncHeadKey(vaultId, path)),
    ).toHaveLength(1);
    expect(
      fixture.bucket.puts.filter(
        (key) => key === syncFeedEventKey(vaultId, fixture.lane, eventPosition),
      ),
    ).toHaveLength(1);
  });

  it("keeps an unavailable journal read-back effect_unknown after a definite refusal", async () => {
    const fixture = await setup();
    const request = await createMutationRequest(
      "Unavailable admission read-back",
    );
    const journalKey = syncOperationKey(vaultId, operationId);
    let journalReads = 0;
    const createInvocation = createSyncR2MutationInvocationFactory(
      fixture.bucket,
      fixture.now,
    );
    const store = syncR2Mutation(
      fixture.records,
      () => {
        const invocation = createInvocation();
        const publication: SyncR2Publication = {
          ...invocation.publication,
          async readJournal() {
            journalReads += 1;
            return journalReads === 1
              ? { kind: "absent" }
              : { kind: "unavailable" };
          },
          async createJournal() {
            return { kind: "refused" };
          },
        };
        return { ...invocation, publication };
      },
      fixture.now,
    );

    expect(await store.mutate(request)).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId,
    });
    expect(journalReads).toBe(2);
    expect(fixture.bucket.puts.filter((key) => key === journalKey)).toEqual([]);
    expect(await fixture.publication.readJournal(vaultId, operationId)).toEqual(
      { kind: "absent" },
    );
  });

  it("joins an exact same-request journal found after the lane predicate refuses admission", async () => {
    const fixture = await setup();
    await seedEmptyLaneHead(fixture);
    const request = await createMutationRequest(
      "Join concurrent journal admission",
    );
    const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
    const originalLane = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(originalLane.kind).toBe("observed");
    if (originalLane.kind !== "observed") return;
    const competingLane: SyncLaneHeadRecord = {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      kind: "laneHead",
      lane: fixture.lane,
      committedSequence: syncSequenceSchema.parse("0".repeat(20)),
      committedAtEpochMs: 0,
      pending: {
        operationId: competingOperationId,
        nextSequence: FIRST_EVENT_SEQUENCE,
      },
    };
    const competingLaneBytes = await encodeSyncPublication(competingLane);
    const matchingJournal = unallocatedJournalForRequest(
      request,
      fixture.lane,
      {
        kind: "observed",
        etag: originalLane.observation.observed.etag,
        bytes: encodeBase64Url(originalLane.observation.observed.bytes),
        uploadedAtEpochMs: originalLane.observation.observed.uploaded.getTime(),
      },
    );
    const matchingJournalBytes = await encodeSyncPublication(matchingJournal);
    const journalKey = syncOperationKey(vaultId, operationId);
    fixture.bucket.afterNextGet(laneKey, () => {
      fixture.bucket.seed(laneKey, competingLaneBytes, fixture.now());
      fixture.bucket.afterNextGet(laneKey, () => {
        fixture.bucket.seed(journalKey, matchingJournalBytes, fixture.now());
      });
    });
    const putsBeforeAdmission = fixture.bucket.puts.length;

    expect(await createStore(fixture).mutate(request)).toEqual({
      kind: "error",
      code: "operation_pending",
      operationId,
    });
    expect(fixture.bucket.puts.slice(putsBeforeAdmission)).toEqual([]);
    expect(
      await fixture.publication.readJournal(vaultId, operationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: { request, allocationState: "unallocated" },
      },
    });
    expect(await fixture.records.readHead(vaultId, path)).toEqual({
      kind: "absent",
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      ),
    ).toEqual({ kind: "absent" });
  });

  it("lets the caller retry an absent timed-out journal via mutate after the returned floor", async () => {
    const fixture = await setup();
    await seedEmptyLaneHead(fixture);
    const request = await createMutationRequest("Caller-owned journal floor");
    const journalKey = syncOperationKey(vaultId, operationId);
    const retryFloor = fixture.now() + 1_100;
    fixture.bucket.beforeNextPut(journalKey, "create", async () => {
      throw new Error(
        "Simulated timeout before the journal create took effect.",
      );
    });

    const first = await createStore(fixture).mutate(request);
    expect(first).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId,
      retryAfterEpochMs: retryFloor,
    });
    expect(await fixture.publication.readJournal(vaultId, operationId)).toEqual(
      { kind: "absent" },
    );
    expect([...fixture.bucket.objects.keys()].sort()).toEqual(
      [
        syncVaultMarkerKey(vaultId),
        syncFeedLaneHeadKey(vaultId, fixture.lane),
      ].sort(),
    );
    expect(await fixture.records.readHead(vaultId, path)).toEqual({
      kind: "absent",
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      ),
    ).toEqual({ kind: "absent" });
    const laneAfterTimeout = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(laneAfterTimeout.kind).toBe("observed");
    if (laneAfterTimeout.kind !== "observed") return;
    expect(laneAfterTimeout.observation.value.pending).toBeUndefined();

    fixture.setNow(retryFloor);
    const replayStore = createStore(fixture);
    const admitted = await replayStore.mutate(request);
    const journalAttempts = fixture.bucket.putAttempts.filter(
      ({ key, phase }) => key === journalKey && phase === "create",
    );
    expect(journalAttempts).toHaveLength(2);
    expect(journalAttempts[0]?.bytes).toEqual(journalAttempts[1]?.bytes);
    expect(
      await fixture.publication.readJournal(vaultId, operationId),
    ).toMatchObject({
      kind: "observed",
      observation: { value: { request } },
    });
    const committed =
      admitted.kind === "committed"
        ? admitted
        : await settleResume(replayStore, fixture, request);
    expect(committed).toEqual({
      kind: "committed",
      revision,
      operationId,
      position: {
        lane: fixture.lane,
        sequence: FIRST_EVENT_SEQUENCE,
      },
    });
    expect(
      fixture.bucket.puts.filter((key) => key === syncHeadKey(vaultId, path)),
    ).toHaveLength(1);
    expect(
      fixture.bucket.puts.filter(
        (key) =>
          key === syncFeedEventKey(vaultId, fixture.lane, FIRST_EVENT_SEQUENCE),
      ),
    ).toHaveLength(1);
  });
});

describe("bounded mutation write uncertainty matrix", () => {
  it("does not apply simulated response loss when the original condition is refused", async () => {
    const fixture = await setup();
    await seedEmptyLaneHead(fixture);
    const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
    const existing = await fixture.bucket.get(laneKey);
    expect(existing).not.toBeNull();
    if (existing === null) return;
    const originalBytes = new Uint8Array(await existing.arrayBuffer());
    const attemptedBytes = encoder.encode("must not replace the lane");
    const writeOptions = {
      customMetadata: { format: "sync-v1" },
      httpMetadata: { contentType: "application/octet-stream" },
    } as const;

    fixture.bucket.applyThenLoseResponse(laneKey, "create");
    expect(
      await fixture.bucket.put(laneKey, attemptedBytes, {
        ...writeOptions,
        onlyIf: new Headers({ "If-None-Match": "*" }),
      }),
    ).toBeNull();
    fixture.bucket.applyThenLoseResponse(laneKey, "replace");
    expect(
      await fixture.bucket.put(laneKey, attemptedBytes, {
        ...writeOptions,
        onlyIf: { etagMatches: "stale-lane-generation" },
      }),
    ).toBeNull();

    expect(fixture.bucket.appliedThenLostResponses).toEqual([]);
    expect(
      fixture.bucket.putAttempts
        .slice(-2)
        .map(({ bytes, ifNoneMatch, etagMatches }) => ({
          bytes,
          ifNoneMatch,
          etagMatches,
        })),
    ).toEqual([
      {
        bytes: attemptedBytes,
        ifNoneMatch: "*",
        etagMatches: undefined,
      },
      {
        bytes: attemptedBytes,
        ifNoneMatch: undefined,
        etagMatches: "stale-lane-generation",
      },
    ]);
    expect(new Uint8Array(await existing.arrayBuffer())).toEqual(originalBytes);
    const unchanged = await fixture.bucket.get(laneKey);
    expect(unchanged).not.toBeNull();
    if (unchanged === null) return;
    expect(new Uint8Array(await unchanged.arrayBuffer())).toEqual(
      originalBytes,
    );
  });

  it("replays a validated journal after its create applied but response read-backs were lost", async () => {
    const fixture = await setup();
    await seedEmptyLaneHead(fixture);
    const store = createStore(fixture);
    const content = "Journal create certainty boundary";
    const request = await createMutationRequest(content);
    if (request.kind !== "create") {
      throw new Error("The fixture must create a live mutation request.");
    }
    const lane = await fixture.publication.readLaneHead(vaultId, fixture.lane);
    expect(lane.kind).toBe("observed");
    if (lane.kind !== "observed") return;
    const journalKey = syncOperationKey(vaultId, operationId);
    const originalLaneEtag = lane.observation.observed.etag;
    fixture.bucket.applyThenLoseResponse(journalKey, "create", 2);

    const uncertain = await store.mutate(request);
    expect(uncertain).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId,
      retryAfterEpochMs: fixture.now() + 1_100,
    });
    expect(await store.readCurrent({ vaultId, path })).toEqual({
      kind: "never_seen",
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({ kind: "absent" });
    const pending = await fixture.publication.readJournal(vaultId, operationId);
    expect(pending.kind).toBe("observed");
    if (pending.kind !== "observed") return;
    expect(pending.observation.value).toMatchObject({
      status: "pending",
      allocationState: "unallocated",
      operationId,
      request,
      laneObservation: {
        precondition: { kind: "observed", etag: originalLaneEtag },
      },
    });

    const journalAttempts = fixture.bucket.putAttempts.filter(
      ({ key, phase }) => key === journalKey && phase === "create",
    );
    expect(journalAttempts).toHaveLength(1);
    const journalAttempt = journalAttempts[0];
    expect(journalAttempt).toBeDefined();
    if (journalAttempt === undefined) return;
    expect(journalAttempt.ifNoneMatch).toBe("*");
    const storedJournal = fixture.bucket.objects.get(journalKey);
    expect(storedJournal).toBeDefined();
    if (storedJournal === undefined) return;
    expect(new Uint8Array(await storedJournal.arrayBuffer())).toEqual(
      journalAttempt.bytes,
    );
    expect(
      fixture.bucket.appliedThenLostResponses.filter(
        ({ key, phase }) => key === journalKey && phase === "create",
      ),
    ).toHaveLength(1);
    if (uncertain.kind !== "error" || !("retryAfterEpochMs" in uncertain)) {
      throw new Error("The uncertain create must expose its safe retry floor.");
    }
    fixture.setNow(uncertain.retryAfterEpochMs);
    expect(
      await settleMutation(createStore(fixture), fixture, request),
    ).toEqual({
      kind: "committed",
      revision,
      operationId,
      position: { lane: fixture.lane, sequence: "00000000000000000001" },
    });
    expect(
      fixture.bucket.putAttempts.filter(
        ({ key, phase }) => key === journalKey && phase === "create",
      ),
    ).toHaveLength(journalAttempts.length);

    const conflictingContent = "Different request with the same operation ID";
    const conflictingRequest: SyncMutationRequest = {
      ...request,
      content: conflictingContent,
      contentSha256: await sha256Content(conflictingContent),
    };
    expect(await createStore(fixture).mutate(conflictingRequest)).toEqual({
      kind: "error",
      code: "operation_id_reused",
    });
    expect(
      fixture.bucket.putAttempts.filter(
        ({ key, phase }) => key === journalKey && phase === "create",
      ),
    ).toHaveLength(journalAttempts.length);
  });

  it("retries an uncertain lane reservation with the journaled original ETag and persisted floor", async () => {
    const fixture = await setup();
    await seedEmptyLaneHead(fixture);
    const store = createStore(fixture);
    const request = await createMutationRequest("Same-ID lane retry");
    if (request.kind !== "create") {
      throw new Error("The fixture must create a live mutation request.");
    }
    const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
    const originalLane = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(originalLane.kind).toBe("observed");
    if (originalLane.kind !== "observed") return;
    const originalEtag = originalLane.observation.observed.etag;
    const journal = unallocatedJournalForRequest(request, fixture.lane, {
      kind: "observed",
      etag: originalEtag,
      bytes: encodeBase64Url(originalLane.observation.observed.bytes),
      uploadedAtEpochMs: originalLane.observation.observed.uploaded.getTime(),
    });
    expect(await fixture.publication.createJournal(journal)).toEqual({
      kind: "confirmed",
    });

    const journalCooldown = await store.resumeOperation({
      vaultId,
      operationId,
    });
    expect(journalCooldown).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId,
    });
    if (
      journalCooldown.kind !== "error" ||
      !("retryAfterEpochMs" in journalCooldown)
    ) {
      throw new Error(
        "The journal transition must expose its safe retry floor.",
      );
    }
    fixture.setNow(journalCooldown.retryAfterEpochMs);

    let reservationResponseLost = false;
    fixture.bucket.beforeNextPut(laneKey, "replace", async () => {
      reservationResponseLost = true;
      throw new Error("Simulated lane-reservation timeout before application.");
    });
    const uncertain = await store.resumeOperation({ vaultId, operationId });
    expect(reservationResponseLost).toBe(true);
    expect(uncertain).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId,
    });
    if (uncertain.kind !== "error" || !("retryAfterEpochMs" in uncertain)) {
      throw new Error("The uncertain CAS must persist its safe retry floor.");
    }
    const pendingJournal = await fixture.publication.readJournal(
      vaultId,
      operationId,
    );
    expect(pendingJournal.kind).toBe("observed");
    if (pendingJournal.kind !== "observed") return;
    expect(pendingJournal.observation.value).toMatchObject({
      status: "pending",
      allocationState: "unallocated",
      laneObservation: {
        precondition: { kind: "observed", etag: originalEtag },
        retryAfterEpochMs: uncertain.retryAfterEpochMs,
      },
    });
    const unchangedLane = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(unchangedLane.kind).toBe("observed");
    if (unchangedLane.kind !== "observed") return;
    expect(unchangedLane.observation.observed.etag).toBe(originalEtag);
    expect(unchangedLane.observation.value).toMatchObject({
      committedSequence: "00000000000000000000",
    });
    expect(unchangedLane.observation.value.pending).toBeUndefined();
    expect(
      fixture.bucket.putAttempts
        .filter(({ key, phase }) => key === laneKey && phase === "replace")
        .map(({ etagMatches }) => etagMatches),
    ).toEqual([originalEtag]);
    expect(await store.readCurrent({ vaultId, path })).toEqual({
      kind: "never_seen",
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({ kind: "absent" });

    const attemptsBeforeEarlyResume = fixture.bucket.putAttempts.filter(
      ({ key, phase }) => key === laneKey && phase === "replace",
    ).length;
    const early = await createStore(fixture).resumeOperation({
      vaultId,
      operationId,
    });
    expect(early).toEqual(uncertain);
    expect(
      fixture.bucket.putAttempts.filter(
        ({ key, phase }) => key === laneKey && phase === "replace",
      ),
    ).toHaveLength(attemptsBeforeEarlyResume);

    fixture.setNow(uncertain.retryAfterEpochMs);
    const resumed = await createStore(fixture).resumeOperation({
      vaultId,
      operationId,
    });
    expect(resumed).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId,
    });
    const exactCasAttempts = fixture.bucket.putAttempts.filter(
      ({ key, phase }) => key === laneKey && phase === "replace",
    );
    expect(exactCasAttempts.map(({ etagMatches }) => etagMatches)).toEqual([
      originalEtag,
      originalEtag,
    ]);
    const reservedLane = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(reservedLane.kind).toBe("observed");
    if (reservedLane.kind !== "observed") return;
    expect(reservedLane.observation.value).toMatchObject({
      committedSequence: "00000000000000000000",
      pending: {
        operationId,
        nextSequence: "00000000000000000001",
      },
    });
    expect(await createStore(fixture).readCurrent({ vaultId, path })).toEqual({
      kind: "never_seen",
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({ kind: "absent" });

    if (resumed.kind !== "error" || !("retryAfterEpochMs" in resumed)) {
      throw new Error("The confirmed reservation must remain resumable.");
    }
    fixture.setNow(resumed.retryAfterEpochMs);
    expect(await settleResume(createStore(fixture), fixture, request)).toEqual({
      kind: "committed",
      revision,
      operationId,
      position: { lane: fixture.lane, sequence: "00000000000000000001" },
    });
    expect(
      await createStore(fixture).readCurrent({ vaultId, path }),
    ).toMatchObject({
      kind: "live",
      revision,
      operationId,
    });
  });

  it("retains exact tombstone recovery metadata and source bytes after an applied-create timeout", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const content = "Recovery metadata timeout source 🌐";
    await seedLiveHead(fixture, content);
    const contentBytes = encoder.encode(content);
    const contentSha256 = await sha256Content(content);
    const request: SyncMutationRequest = {
      kind: "tombstone",
      vaultId,
      path,
      operationId: recoveryOperationId,
      revision: tombstoneRevision,
      parent: { kind: "revision", revision },
      contentSha256,
      origin: alternateOrigin,
    };
    const recoveryKey = syncRecoveryKey(
      vaultId,
      recoveryOperationId,
      "metadata",
    );
    const recoveryBodyKey = syncRecoveryKey(
      vaultId,
      recoveryOperationId,
      "content",
    );
    const metadata: SyncRecoveryMetadata = {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      path,
      operationId: recoveryOperationId,
      sourceRevision: revision,
      contentSha256,
      byteSize: contentBytes.byteLength,
      mediaType: "text/markdown",
      origin,
    };
    fixture.bucket.applyThenLoseResponse(recoveryKey, "create");

    const uncertain = await resumeUntil(store, fixture, request, () =>
      fixture.bucket.appliedThenLostResponses.some(
        ({ key, phase }) => key === recoveryKey && phase === "create",
      ),
    );
    const metadataAttempts = fixture.bucket.putAttempts.filter(
      ({ key, phase }) => key === recoveryKey && phase === "create",
    );
    expect(metadataAttempts).toHaveLength(1);
    const metadataAttempt = metadataAttempts[0];
    expect(metadataAttempt).toBeDefined();
    if (metadataAttempt === undefined) return;
    expect(metadataAttempt.ifNoneMatch).toBe("*");
    const storedMetadata = fixture.bucket.objects.get(recoveryKey);
    expect(storedMetadata).toBeDefined();
    if (storedMetadata === undefined) return;
    expect(new Uint8Array(await storedMetadata.arrayBuffer())).toEqual(
      metadataAttempt.bytes,
    );
    expect(uncertain).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId: recoveryOperationId,
    });
    if (uncertain.kind !== "error" || !("retryAfterEpochMs" in uncertain)) {
      throw new Error(
        "The uncertain metadata create must expose its retry floor.",
      );
    }
    expect(await fixture.bucket.objects.get(recoveryBodyKey)?.text()).toBe(
      content,
    );
    expect(await fixture.bucket.objects.get(recoveryKey)?.text()).toBe(
      JSON.stringify(metadata),
    );
    expect(await store.readCurrent({ vaultId, path })).toMatchObject({
      kind: "live",
      revision,
      operationId,
    });
    expect(
      await fixture.records.readVersion(vaultId, tombstoneRevision),
    ).toEqual({ kind: "absent" });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({ kind: "absent" });
    const blockedLane = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(blockedLane.kind).toBe("observed");
    if (blockedLane.kind !== "observed") return;
    expect(blockedLane.observation.value.pending?.operationId).toBe(
      recoveryOperationId,
    );
    expect(
      await store.readRecovery({ vaultId, operationId: recoveryOperationId }),
    ).toMatchObject({
      kind: "present",
      recovery: {
        path,
        operationId: recoveryOperationId,
        sourceRevision: revision,
        contentSha256,
        byteSize: contentBytes.byteLength,
        content,
        origin,
      },
    });
    const interruptedJournal = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(interruptedJournal).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: { step: "immutable_create", key: recoveryKey },
        },
      },
    });
    const metadataCreateAttempts = fixture.bucket.putAttempts.filter(
      ({ key, phase }) => key === recoveryKey && phase === "create",
    ).length;
    expect(metadataCreateAttempts).toBe(1);

    fixture.setNow(uncertain.retryAfterEpochMs);
    await advanceToHeadWrite(createStore(fixture), fixture, request);
    expect(
      fixture.bucket.putAttempts.filter(
        ({ key, phase }) => key === recoveryKey && phase === "create",
      ),
    ).toHaveLength(metadataCreateAttempts);
    expect(
      await createStore(fixture).readCurrent({ vaultId, path }),
    ).toMatchObject({
      kind: "live",
      revision,
      operationId,
    });
    expect(
      await createStore(fixture).readRecovery({
        vaultId,
        operationId: recoveryOperationId,
      }),
    ).toMatchObject({ kind: "present", recovery: { content, contentSha256 } });
    expect(
      await createStore(fixture).readVersion({
        vaultId,
        revision: tombstoneRevision,
      }),
    ).toMatchObject({
      kind: "present",
      version: {
        kind: "tombstone",
        revision: tombstoneRevision,
        parent: { kind: "revision", revision },
        contentSha256,
        byteSize: contentBytes.byteLength,
      },
    });
  });
});

describe("residual mutation recovery matrix", () => {
  it("reobserves a lane after its reserved CAS loses to a completed operation", async () => {
    const fixture = await setup();
    await seedEmptyLaneHead(fixture);
    const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
    const originalLane = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(originalLane.kind).toBe("observed");
    if (originalLane.kind !== "observed") return;

    const loserContent = "Lane generation loser";
    const loserRequest: SyncMutationRequest = {
      kind: "create",
      vaultId,
      path,
      operationId: recoveryOperationId,
      revision: updatedRevision,
      parent: { kind: "never_seen" },
      contentSha256: await sha256Content(loserContent),
      content: loserContent,
      mediaType: "text/markdown",
      origin,
    };
    const winnerRequest = await createMutationRequest("Lane generation winner");
    let winnerResult: SyncMutationResult | undefined;
    let losingAttempt: MemoryBucketPutAttempt | undefined;
    fixture.bucket.beforeNextPut(laneKey, "replace", async () => {
      losingAttempt = fixture.bucket.putAttempts
        .filter(
          (attempt) => attempt.key === laneKey && attempt.phase === "replace",
        )
        .at(-1);
      winnerResult = await settleMutation(
        createStore(fixture),
        fixture,
        winnerRequest,
      );
    });

    const loserStore = createStore(fixture);
    const first = await loserStore.mutate(loserRequest);
    expect(first).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId: recoveryOperationId,
    });
    if (first.kind !== "error" || !("retryAfterEpochMs" in first)) return;
    fixture.setNow(first.retryAfterEpochMs);

    const lostCas = await loserStore.resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });
    expect(winnerResult).toMatchObject({
      kind: "committed",
      operationId,
      position: { lane: fixture.lane, sequence: "00000000000000000001" },
    });
    expect(losingAttempt?.etagMatches).toBe(
      originalLane.observation.observed.etag,
    );
    expect(lostCas).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId: recoveryOperationId,
    });

    const winnerLane = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    const rebasedJournal = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(winnerLane.kind).toBe("observed");
    expect(rebasedJournal.kind).toBe("observed");
    if (winnerLane.kind !== "observed" || rebasedJournal.kind !== "observed") {
      return;
    }
    expect(winnerLane.observation.value.committedSequence).toBe(
      "00000000000000000001",
    );
    expect(winnerLane.observation.value.pending).toBeUndefined();
    expect(rebasedJournal.observation.value).toMatchObject({
      status: "pending",
      allocationState: "unallocated",
      operationId: recoveryOperationId,
      request: loserRequest,
      laneObservation: {
        key: laneKey,
        retryAfterEpochMs: null,
        precondition: {
          kind: "observed",
          etag: winnerLane.observation.observed.etag,
          bytes: encodeBase64Url(winnerLane.observation.observed.bytes),
        },
      },
    });
    if (rebasedJournal.observation.value.allocationState !== "unallocated") {
      return;
    }
    expect(
      rebasedJournal.observation.value.laneObservation.precondition,
    ).not.toEqual(
      expect.objectContaining({ etag: originalLane.observation.observed.etag }),
    );
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toMatchObject({
      kind: "observed",
      observation: { value: { kind: "changed", operationId } },
    });
    expect(await loserStore.readCurrent({ vaultId, path })).toMatchObject({
      kind: "live",
      revision,
      operationId,
    });

    expect(
      await settleResume(createStore(fixture), fixture, loserRequest),
    ).toEqual({ kind: "error", code: "stale_revision" });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000002"),
      ),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          kind: "aborted",
          operationId: recoveryOperationId,
          reason: "stale_revision",
        },
      },
    });
    const finalLane = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(finalLane).toMatchObject({
      kind: "observed",
      observation: {
        value: { committedSequence: "00000000000000000002" },
      },
    });
    if (finalLane.kind !== "observed") return;
    expect(finalLane.observation.value.pending).toBeUndefined();
  });

  it("keeps the original head predicate through an unavailable read and exact retry", async () => {
    const fixture = await setup();
    const originalContent = "Head before unavailable read";
    await seedLiveHead(fixture, originalContent);
    const nextContent = "Head after exact retry";
    const request: SyncMutationRequest = {
      kind: "update",
      vaultId,
      path,
      operationId: recoveryOperationId,
      revision: updatedRevision,
      parent: { kind: "revision", revision },
      contentSha256: await sha256Content(nextContent),
      content: nextContent,
      mediaType: "text/markdown",
      origin,
    };
    const store = createStore(fixture);
    await advanceToHeadWrite(store, fixture, request);

    const journalBefore = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    const currentBefore = await fixture.records.readHead(vaultId, path);
    expect(journalBefore.kind).toBe("observed");
    expect(currentBefore.kind).toBe("observed");
    if (
      journalBefore.kind !== "observed" ||
      currentBefore.kind !== "observed"
    ) {
      return;
    }
    const originalJournalBytes = journalBefore.observation.observed.bytes;
    const originalHeadEtag = currentBefore.observation.observed.etag;
    expect(journalBefore.observation.value).toMatchObject({
      status: "pending",
      allocationState: "allocated",
      stepEvidence: {
        step: "write_head",
        precondition: { kind: "observed", etag: originalHeadEtag },
      },
    });
    const headKey = syncHeadKey(vaultId, path);
    const headWritesBefore = fixture.bucket.putAttempts.filter(
      (attempt) => attempt.key === headKey,
    ).length;
    fixture.bucket.failNextGets(headKey, 1);

    expect(
      await store.resumeOperation({
        vaultId,
        operationId: recoveryOperationId,
      }),
    ).toMatchObject({
      kind: "error",
      code: "effect_unknown",
      operationId: recoveryOperationId,
    });
    expect(
      fixture.bucket.putAttempts.filter((attempt) => attempt.key === headKey),
    ).toHaveLength(headWritesBefore);
    const journalAfterFailure = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(journalAfterFailure).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          allocationState: "allocated",
          stepEvidence: {
            step: "write_head",
            precondition: { kind: "observed", etag: originalHeadEtag },
          },
        },
      },
    });
    if (journalAfterFailure.kind !== "observed") return;
    expect(journalAfterFailure.observation.observed.bytes).toEqual(
      originalJournalBytes,
    );
    expect(await store.readCurrent({ vaultId, path })).toMatchObject({
      kind: "live",
      revision,
      operationId,
    });

    expect(
      await settleResume(createStore(fixture), fixture, request),
    ).toMatchObject({
      kind: "committed",
      revision: updatedRevision,
      operationId: recoveryOperationId,
    });
    const mutationHeadWrites = fixture.bucket.putAttempts
      .filter((attempt) => attempt.key === headKey)
      .slice(headWritesBefore);
    expect(mutationHeadWrites).toHaveLength(1);
    expect(mutationHeadWrites[0]).toMatchObject({
      phase: "replace",
      etagMatches: originalHeadEtag,
    });
    expect(
      await createStore(fixture).readVersion({
        vaultId,
        revision: updatedRevision,
      }),
    ).toMatchObject({
      kind: "present",
      version: {
        kind: "live",
        revision: updatedRevision,
        operationId: recoveryOperationId,
        content: nextContent,
      },
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          kind: "changed",
          operationId: recoveryOperationId,
          result: { kind: "live", revision: updatedRevision },
        },
      },
    });
    const updatedContentKey = syncContentKey(vaultId, updatedRevision);
    fixture.bucket.failNextGets(updatedContentKey, 1);
    expect(
      await createStore(fixture).readVersion({
        vaultId,
        revision: updatedRevision,
      }),
    ).toEqual({ kind: "error", code: "storage_unavailable" });
    expect(
      await createStore(fixture).readVersion({
        vaultId,
        revision: updatedRevision,
      }),
    ).toMatchObject({
      kind: "present",
      version: { kind: "live", content: nextContent },
    });
  });

  it("resumes a tombstone after its immutable version applies without readable response", async () => {
    const fixture = await setup();
    const sourceContent = "Retained tombstone source bytes 🌐";
    await seedLiveHead(fixture, sourceContent);
    const request: SyncMutationRequest = {
      kind: "tombstone",
      vaultId,
      path,
      operationId: recoveryOperationId,
      revision: tombstoneRevision,
      parent: { kind: "revision", revision },
      contentSha256: await sha256Content(sourceContent),
      origin: alternateOrigin,
    };
    const store = createStore(fixture);
    const versionKey = syncVersionKey(vaultId, tombstoneRevision);
    fixture.bucket.applyThenLoseResponse(versionKey, "create", 2);

    const uncertain = await resumeUntil(store, fixture, request, () =>
      fixture.bucket.appliedThenLostResponses.some(
        ({ key, phase }) => key === versionKey && phase === "create",
      ),
    );
    expect(uncertain).toMatchObject({
      kind: "error",
      code: "effect_unknown",
      operationId: recoveryOperationId,
    });
    if (uncertain.kind !== "error" || !("retryAfterEpochMs" in uncertain))
      return;

    const versionAttempts = fixture.bucket.putAttempts.filter(
      ({ key, phase }) => key === versionKey && phase === "create",
    );
    expect(versionAttempts).toHaveLength(1);
    expect(versionAttempts[0]?.ifNoneMatch).toBe("*");
    const storedVersion = fixture.bucket.objects.get(versionKey);
    expect(storedVersion).toBeDefined();
    if (storedVersion === undefined) return;
    expect(new Uint8Array(await storedVersion.arrayBuffer())).toEqual(
      versionAttempts[0]?.bytes,
    );
    fixture.bucket.failNextGets(versionKey, 1);
    expect(
      await fixture.records.readVersion(vaultId, tombstoneRevision),
    ).toEqual({ kind: "unavailable" });
    expect(
      await fixture.records.readVersion(vaultId, tombstoneRevision),
    ).toMatchObject({
      kind: "observed",
      observation: { value: { kind: "tombstone" } },
    });
    expect(await store.readCurrent({ vaultId, path })).toMatchObject({
      kind: "live",
      revision,
      operationId,
    });
    expect(await store.readVersion({ vaultId, revision })).toMatchObject({
      kind: "present",
      version: { kind: "live", content: sourceContent },
    });
    expect(
      await fixture.publication.readJournal(vaultId, recoveryOperationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: { step: "immutable_create", key: versionKey },
        },
      },
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({ kind: "absent" });
    expect(
      await fixture.publication.readLaneHead(vaultId, fixture.lane),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          committedSequence: "00000000000000000000",
          pending: { operationId: recoveryOperationId },
        },
      },
    });
    expect(
      await store.readRecovery({ vaultId, operationId: recoveryOperationId }),
    ).toMatchObject({
      kind: "present",
      recovery: {
        path,
        content: sourceContent,
        contentSha256: request.contentSha256,
      },
    });

    fixture.setNow(uncertain.retryAfterEpochMs);
    await advanceToHeadWrite(createStore(fixture), fixture, request);
    expect(
      fixture.bucket.putAttempts.filter(
        ({ key, phase }) => key === versionKey && phase === "create",
      ),
    ).toHaveLength(1);
    expect(
      await createStore(fixture).readCurrent({ vaultId, path }),
    ).toMatchObject({
      kind: "live",
      revision,
      operationId,
    });
    expect(
      await createStore(fixture).readRecovery({
        vaultId,
        operationId: recoveryOperationId,
      }),
    ).toMatchObject({
      kind: "present",
      recovery: { sourceRevision: revision, content: sourceContent, origin },
    });
    fixture.bucket.failNextGets(syncVersionKey(vaultId, revision), 1);
    expect(
      await createStore(fixture).readRecovery({
        vaultId,
        operationId: recoveryOperationId,
      }),
    ).toEqual({ kind: "error", code: "storage_unavailable" });
    expect(
      await createStore(fixture).readRecovery({
        vaultId,
        operationId: recoveryOperationId,
      }),
    ).toMatchObject({
      kind: "present",
      recovery: { sourceRevision: revision, content: sourceContent, origin },
    });
  });

  it("withholds success after an applied terminal-journal CAS loses its read-back", async () => {
    const fixture = await setup();
    const request = await createMutationRequest(
      "Terminal journal read-back loss",
    );
    const store = createStore(fixture);
    await advanceToJournalCommit(store, fixture, request);

    const journalKey = syncOperationKey(vaultId, operationId);
    const journalBefore = await fixture.publication.readJournal(
      vaultId,
      operationId,
    );
    expect(journalBefore.kind).toBe("observed");
    if (journalBefore.kind !== "observed") return;
    expect(journalBefore.observation.value).toMatchObject({
      status: "pending",
      allocationState: "allocated",
      stepEvidence: { step: "commit_journal" },
    });
    const journalEtag = journalBefore.observation.observed.etag;
    const journalWritesBefore = fixture.bucket.putAttempts.filter(
      (attempt) => attempt.key === journalKey && attempt.phase === "replace",
    ).length;
    fixture.setNow(
      Math.max(
        fixture.now(),
        journalBefore.observation.observed.uploaded.getTime() + 1_100,
      ),
    );
    const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
    const laneWritesBefore = fixture.bucket.putAttempts.filter(
      (attempt) => attempt.key === laneKey && attempt.phase === "replace",
    ).length;
    fixture.bucket.applyThenLoseResponse(journalKey, "replace");

    const uncertain = await createStore(fixture).resumeOperation({
      vaultId,
      operationId,
    });
    expect(uncertain).toMatchObject({
      kind: "error",
      code: "effect_unknown",
      operationId,
    });
    const terminalWrite = fixture.bucket.putAttempts
      .filter(
        (attempt) => attempt.key === journalKey && attempt.phase === "replace",
      )
      .slice(journalWritesBefore);
    expect(terminalWrite).toHaveLength(1);
    expect(terminalWrite[0]?.etagMatches).toBe(journalEtag);

    const terminal = await fixture.publication.readJournal(
      vaultId,
      operationId,
    );
    expect(terminal.kind).toBe("observed");
    if (terminal.kind !== "observed") return;
    expect(terminal.observation.value).toMatchObject({
      status: "committed",
      stepEvidence: {
        step: "commit_lane",
        key: laneKey,
        precondition: { kind: "observed" },
      },
    });
    if (terminal.observation.value.status !== "committed") return;
    if (
      terminal.observation.value.stepEvidence.precondition.kind !== "observed"
    ) {
      return;
    }
    const terminalLaneEtag =
      terminal.observation.value.stepEvidence.precondition.etag;
    const event = await fixture.publication.readEvent(
      vaultId,
      fixture.lane,
      syncEventSequenceSchema.parse("00000000000000000001"),
    );
    expect(event).toMatchObject({
      kind: "observed",
      observation: { value: { kind: "changed", operationId } },
    });
    expect(
      await createStore(fixture).readCurrent({ vaultId, path }),
    ).toMatchObject({
      kind: "live",
      revision,
      operationId,
    });
    expect(
      await fixture.publication.readLaneHead(vaultId, fixture.lane),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          committedSequence: "00000000000000000000",
          pending: { operationId },
        },
      },
    });
    expect(
      fixture.bucket.putAttempts.filter(
        (attempt) => attempt.key === laneKey && attempt.phase === "replace",
      ),
    ).toHaveLength(laneWritesBefore);

    const freshStore = createStore(fixture);
    const firstResume = await freshStore.resumeOperation({
      vaultId,
      operationId,
    });
    expect(firstResume).toMatchObject({
      kind: "error",
      operationId,
    });
    expect(
      fixture.bucket.putAttempts.filter(
        (attempt) => attempt.key === laneKey && attempt.phase === "replace",
      ),
    ).toHaveLength(laneWritesBefore);
    fixture.bucket.applyThenLoseResponse(laneKey, "replace");
    expect(await settleResume(freshStore, fixture, request)).toEqual({
      kind: "committed",
      revision,
      operationId,
      position: { lane: fixture.lane, sequence: "00000000000000000001" },
    });
    const recoveredLaneWrites = fixture.bucket.putAttempts
      .filter(
        (attempt) => attempt.key === laneKey && attempt.phase === "replace",
      )
      .slice(laneWritesBefore);
    expect(recoveredLaneWrites).toHaveLength(1);
    expect(recoveredLaneWrites[0]?.etagMatches).toBe(terminalLaneEtag);
    expect(
      fixture.bucket.appliedThenLostResponses.filter(
        (attempt) => attempt.key === laneKey && attempt.phase === "replace",
      ),
    ).toHaveLength(1);
    const finalLane = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(finalLane).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          committedSequence: "00000000000000000001",
          committedAtEpochMs: terminal.observation.value.committedAtEpochMs,
        },
      },
    });
    if (finalLane.kind !== "observed") return;
    expect(finalLane.observation.value.pending).toBeUndefined();
  });

  it("retries an absent feed event only after its retry floor is persisted", async () => {
    const fixture = await setup();
    const request = await createMutationRequest("Throttled feed event");
    const store = createStore(fixture);
    const sequence = FIRST_EVENT_SEQUENCE;
    const eventKey = syncFeedEventKey(vaultId, fixture.lane, sequence);
    const fixedCommitTime = fixture.now();
    await seedCreateEventStep(fixture, request, fixedCommitTime);
    let eventWasThrottled = false;
    fixture.bucket.beforeNextPut(eventKey, "create", async () => {
      eventWasThrottled = true;
      throw Object.assign(new Error("Too many requests"), { status: 429 });
    });

    const deferred = await store.resumeOperation({ vaultId, operationId });
    expect(eventWasThrottled).toBe(true);
    expect(deferred).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId,
    });
    if (deferred.kind !== "error" || !("retryAfterEpochMs" in deferred)) return;

    const attemptsAfterThrottle = fixture.bucket.putAttempts.filter(
      ({ key, phase }) => key === eventKey && phase === "create",
    );
    expect(attemptsAfterThrottle).toHaveLength(1);
    expect(attemptsAfterThrottle[0]?.ifNoneMatch).toBe("*");
    expect(fixture.bucket.objects.has(eventKey)).toBe(false);
    expect(
      await fixture.publication.readJournal(vaultId, operationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: {
            step: "create_event",
            outcomeIntent: "changed",
            key: eventKey,
            committedAtEpochMs: fixedCommitTime,
            precondition: { kind: "absent" },
            retryAfterEpochMs: null,
            attempt: { state: "attempting", generation: 1 },
          },
        },
      },
    });
    expect(await store.readCurrent({ vaultId, path })).toMatchObject({
      kind: "live",
      revision,
      operationId,
    });
    expect(
      await fixture.publication.readLaneHead(vaultId, fixture.lane),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          committedSequence: "00000000000000000000",
          pending: {
            operationId,
            nextSequence: sequence,
          },
        },
      },
    });

    expect(
      await createStore(fixture).resumeOperation({ vaultId, operationId }),
    ).toMatchObject({
      kind: "error",
      code: "operation_pending",
      retryAfterEpochMs: deferred.retryAfterEpochMs,
    });
    expect(
      fixture.bucket.putAttempts.filter(
        ({ key, phase }) => key === eventKey && phase === "create",
      ),
    ).toHaveLength(1);

    fixture.setNow(deferred.retryAfterEpochMs);
    await createStore(fixture).resumeOperation({ vaultId, operationId });
    const retrying = await fixture.publication.readJournal(
      vaultId,
      operationId,
    );
    expect(retrying).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          stepEvidence: {
            step: "create_event",
            attempt: { state: "retry_wait", generation: 1 },
          },
        },
      },
    });
    if (
      retrying.kind !== "observed" ||
      retrying.observation.value.status !== "pending" ||
      retrying.observation.value.allocationState !== "allocated" ||
      retrying.observation.value.stepEvidence.step !== "create_event" ||
      retrying.observation.value.stepEvidence.attempt.state !== "retry_wait"
    ) {
      return;
    }
    const fixedFloor =
      retrying.observation.value.stepEvidence.attempt.retryAfterEpochMs;
    expect(fixedFloor).toBe(deferred.retryAfterEpochMs + 1_100);
    fixture.setNow(fixedFloor - 100);
    expect(
      await createStore(fixture).resumeOperation({ vaultId, operationId }),
    ).toMatchObject({
      kind: "error",
      code: "operation_pending",
      retryAfterEpochMs: fixedFloor,
    });
    expect(
      fixture.bucket.putAttempts.filter(
        ({ key, phase }) => key === eventKey && phase === "create",
      ),
    ).toHaveLength(1);

    fixture.setNow(fixedFloor);
    await createStore(fixture).resumeOperation({ vaultId, operationId });
    const eventAttempts = fixture.bucket.putAttempts.filter(
      ({ key, phase }) => key === eventKey && phase === "create",
    );
    expect(eventAttempts).toHaveLength(2);
    expect(eventAttempts.every(({ ifNoneMatch }) => ifNoneMatch === "*")).toBe(
      true,
    );
    expect(
      await fixture.publication.readEvent(vaultId, fixture.lane, sequence),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          kind: "changed",
          operationId,
          sequence,
          result: { kind: "live", revision },
          committedAtEpochMs: fixedCommitTime,
        },
      },
    });
  });
});

describe("untrusted mutation evidence boundaries", () => {
  it("rejects malformed public read identities before accessing R2", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const readsBefore = fixture.bucket.gets.length;
    const writesBefore = fixture.bucket.puts.length;

    expect(
      await store.readCurrent({
        vaultId: "invalid-vault" as typeof vaultId,
        path,
      }),
    ).toEqual({ kind: "error", code: "invalid_input" });
    expect(
      await store.readCurrent({ vaultId, path: "" as typeof path }),
    ).toEqual({ kind: "error", code: "invalid_input" });
    expect(
      await store.readVersion({ vaultId, revision: "bad" as typeof revision }),
    ).toEqual({
      kind: "error",
      code: "invalid_input",
    });
    expect(
      await store.readRecovery({
        vaultId,
        operationId: "invalid-operation" as typeof operationId,
      }),
    ).toEqual({ kind: "error", code: "invalid_input" });
    expect(fixture.bucket.gets).toHaveLength(readsBefore);
    expect(fixture.bucket.puts).toHaveLength(writesBefore);
  });

  it("rejects invalid resume identities and reports an absent journal as uncertain", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const readsBeforeValidation = fixture.bucket.gets.length;
    const writesBefore = fixture.bucket.puts.length;

    expect(
      await store.resumeOperation({
        vaultId: "invalid-vault" as typeof vaultId,
        operationId,
      }),
    ).toEqual({ kind: "error", code: "invalid_input" });
    expect(
      await store.resumeOperation({
        vaultId,
        operationId: "invalid-operation" as typeof operationId,
      }),
    ).toEqual({ kind: "error", code: "invalid_input" });
    expect(fixture.bucket.gets).toHaveLength(readsBeforeValidation);
    expect(await store.resumeOperation({ vaultId, operationId })).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId,
    });
    expect(fixture.bucket.puts).toHaveLength(writesBefore);
  });

  it("reports absent immutable version and recovery records without writing", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const writesBefore = fixture.bucket.puts.length;

    expect(await store.readVersion({ vaultId, revision })).toEqual({
      kind: "absent",
    });
    expect(await store.readRecovery({ vaultId, operationId })).toEqual({
      kind: "absent",
    });
    expect(fixture.bucket.puts).toHaveLength(writesBefore);
  });

  it("does not expose a persisted live body corrupted with invalid UTF-8", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    await seedLiveHead(fixture, "Valid immutable source");
    const contentKey = syncContentKey(vaultId, revision);
    const corruptBytes = new Uint8Array([0xff, 0xfe]);
    fixture.bucket.seed(contentKey, corruptBytes, fixture.now());
    const writesBeforeRead = fixture.bucket.puts.length;

    expect(await store.readVersion({ vaultId, revision })).toEqual({
      kind: "error",
      code: "storage_unavailable",
    });
    const storedBody = fixture.bucket.objects.get(contentKey);
    expect(storedBody).toBeDefined();
    if (storedBody === undefined) return;
    expect(new Uint8Array(await storedBody.arrayBuffer())).toEqual(
      corruptBytes,
    );
    expect(fixture.bucket.puts).toHaveLength(writesBeforeRead);
  });

  it("rejects same-size live bytes changed between exact reads", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    await seedLiveHead(fixture, "x".repeat(20));
    const contentKey = syncContentKey(vaultId, revision);
    fixture.bucket.afterNextGet(contentKey, () => {
      fixture.bucket.seed(
        contentKey,
        encoder.encode("y".repeat(20)),
        fixture.now(),
      );
    });
    const writesBeforeRead = fixture.bucket.puts.length;

    expect(await store.readVersion({ vaultId, revision })).toEqual({
      kind: "error",
      code: "storage_unavailable",
    });
    expect(await fixture.bucket.objects.get(contentKey)?.text()).toBe(
      "y".repeat(20),
    );
    expect(fixture.bucket.puts).toHaveLength(writesBeforeRead);
  });

  it("does not return recovery when its retained source changes between exact reads", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    await seedTombstone(fixture, "r".repeat(18));
    const sourceKey = syncContentKey(vaultId, revision);
    fixture.bucket.afterNextGet(sourceKey, () => {
      fixture.bucket.seed(
        sourceKey,
        encoder.encode("s".repeat(18)),
        fixture.now(),
      );
    });
    const writesBeforeRead = fixture.bucket.puts.length;

    expect(
      await store.readRecovery({ vaultId, operationId: recoveryOperationId }),
    ).toEqual({ kind: "error", code: "storage_unavailable" });
    expect(await fixture.bucket.objects.get(sourceKey)?.text()).toBe(
      "s".repeat(18),
    );
    expect(fixture.bucket.puts).toHaveLength(writesBeforeRead);
  });

  it("withholds recovery when its exact source version is absent", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    await seedTombstone(fixture, "Retained source version");
    const writesBeforeRead = fixture.bucket.puts.length;
    fixture.bucket.objects.delete(syncVersionKey(vaultId, revision));

    expect(
      await store.readRecovery({ vaultId, operationId: recoveryOperationId }),
    ).toEqual({ kind: "error", code: "storage_unavailable" });
    expect(fixture.bucket.puts).toHaveLength(writesBeforeRead);
  });

  it("distinguishes digest-invalid intent from a changed valid replay", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const request = await createMutationRequest("Exact caller bytes");
    const invalidRequest: SyncMutationRequest = {
      ...request,
      contentSha256: await sha256Content("Different bytes"),
    };

    expect(await store.mutate(invalidRequest)).toEqual({
      kind: "error",
      code: "invalid_input",
    });
    expect(fixture.bucket.puts).toEqual([]);
    expect(await fixture.publication.readJournal(vaultId, operationId)).toEqual(
      { kind: "absent" },
    );

    expect(await settleMutation(store, fixture, request)).toMatchObject({
      kind: "committed",
      operationId,
      revision,
    });
    const writesAfterCommit = fixture.bucket.puts.length;
    const changedReplay = await createMutationRequest("Different valid bytes");

    expect(await store.mutate(changedReplay)).toEqual({
      kind: "error",
      code: "operation_id_reused",
    });
    expect(fixture.bucket.puts).toHaveLength(writesAfterCommit);
  });

  it("retains a tombstone blocker when its exact source version disappears", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const content = "Retained source for tombstone";
    const contentSha256 = await sha256Content(content);
    await seedLiveHead(fixture, content);
    const request: SyncMutationRequest = {
      kind: "tombstone",
      vaultId,
      path,
      operationId: recoveryOperationId,
      revision: tombstoneRevision,
      parent: { kind: "revision", revision },
      contentSha256,
      origin: alternateOrigin,
    };
    await advanceToHeadWrite(store, fixture, request);

    const headKey = syncHeadKey(vaultId, path);
    const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
    const journalKey = syncOperationKey(vaultId, recoveryOperationId);
    const eventKey = syncFeedEventKey(
      vaultId,
      fixture.lane,
      syncEventSequenceSchema.parse("00000000000000000001"),
    );
    const journalBefore = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    const headBefore = fixture.bucket.objects.get(headKey);
    expect(journalBefore.kind).toBe("observed");
    expect(headBefore).toBeDefined();
    if (journalBefore.kind !== "observed" || headBefore === undefined) return;
    const headBytesBefore = new Uint8Array(await headBefore.arrayBuffer());
    const journalBytesBefore = journalBefore.observation.observed.bytes;
    const writesBefore = fixture.bucket.puts.length;

    // Model loss of an immutable R2 source after an otherwise real tombstone journal was persisted.
    fixture.bucket.objects.delete(syncVersionKey(vaultId, revision));

    expect(
      await store.resumeOperation({
        vaultId,
        operationId: recoveryOperationId,
      }),
    ).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId: recoveryOperationId,
    });
    const journalAfter = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    const laneAfter = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    const headAfter = fixture.bucket.objects.get(headKey);
    expect(journalAfter.kind).toBe("observed");
    expect(laneAfter).toMatchObject({
      kind: "observed",
      observation: {
        value: { pending: { operationId: recoveryOperationId } },
      },
    });
    expect(fixture.bucket.objects.has(eventKey)).toBe(false);
    expect(headAfter).toBeDefined();
    if (journalAfter.kind !== "observed" || headAfter === undefined) return;
    expect(journalAfter.observation.observed.bytes).toEqual(journalBytesBefore);
    expect(new Uint8Array(await headAfter.arrayBuffer())).toEqual(
      headBytesBefore,
    );
    expect(fixture.bucket.puts).toHaveLength(writesBefore);
    expect(fixture.bucket.objects.has(journalKey)).toBe(true);
    expect(fixture.bucket.objects.has(laneKey)).toBe(true);
  });

  it("does not return recovery content when its persisted R2 body is corrupt", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    await seedTombstone(fixture, "Exact retained recovery bytes");
    const bodyKey = syncRecoveryKey(vaultId, recoveryOperationId, "content");
    const corruptBytes = encoder.encode("not a sync recovery-body record");
    fixture.bucket.seed(bodyKey, corruptBytes, fixture.now());

    expect(
      await store.readRecovery({ vaultId, operationId: recoveryOperationId }),
    ).toEqual({ kind: "error", code: "storage_unavailable" });
    expect(await store.readCurrent({ vaultId, path })).toEqual({
      kind: "error",
      code: "storage_unavailable",
    });
    const storedBody = fixture.bucket.objects.get(bodyKey);
    expect(storedBody).toBeDefined();
    if (storedBody === undefined) return;
    expect(new Uint8Array(await storedBody.arrayBuffer())).toEqual(
      corruptBytes,
    );
  });

  it.each(["event", "head", "lane"] as const)(
    "withholds terminal success when persisted %s authority diverges",
    async (evidence) => {
      const fixture = await setup();
      const store = createStore(fixture);
      const request = await createMutationRequest(
        `Terminal ${evidence} divergence`,
      );
      await advanceToTerminalLaneCommit(store, fixture, request);

      const journalBefore = await fixture.publication.readJournal(
        vaultId,
        operationId,
      );
      const eventKey = syncFeedEventKey(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      );
      const eventBefore = await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      );
      expect(journalBefore.kind).toBe("observed");
      expect(eventBefore.kind).toBe("observed");
      if (
        journalBefore.kind !== "observed" ||
        journalBefore.observation.value.status === "pending" ||
        eventBefore.kind !== "observed"
      ) {
        return;
      }
      const journalBytesBefore = journalBefore.observation.observed.bytes;
      const eventBytesBefore = eventBefore.observation.observed.bytes;
      let divergentBytes: Uint8Array;

      if (evidence === "event") {
        const key = eventKey;
        divergentBytes = encoder.encode(
          JSON.stringify({
            ...eventBefore.observation.value,
            operationId: competingOperationId,
          }),
        );
        fixture.bucket.seed(key, divergentBytes, fixture.now());
      } else if (evidence === "head") {
        const headKey = syncHeadKey(vaultId, path);
        const currentHead = await fixture.records.readHead(vaultId, path);
        expect(currentHead.kind).toBe("observed");
        if (currentHead.kind !== "observed") return;
        divergentBytes = encoder.encode(
          JSON.stringify({
            ...currentHead.observation.value,
            operationId: competingOperationId,
          }),
        );
        fixture.bucket.seed(headKey, divergentBytes, fixture.now());
      } else {
        const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
        const lane = await fixture.publication.readLaneHead(
          vaultId,
          fixture.lane,
        );
        expect(lane.kind).toBe("observed");
        if (
          lane.kind !== "observed" ||
          lane.observation.value.pending === undefined
        ) {
          return;
        }
        divergentBytes = encoder.encode(
          JSON.stringify({
            ...lane.observation.value,
            pending: {
              ...lane.observation.value.pending,
              operationId: competingOperationId,
            },
          }),
        );
        fixture.bucket.seed(laneKey, divergentBytes, fixture.now());
      }

      const writesBefore = fixture.bucket.puts.length;
      expect(await store.resumeOperation({ vaultId, operationId })).toEqual({
        kind: "error",
        code: "effect_unknown",
        operationId,
      });
      const journalAfter = await fixture.publication.readJournal(
        vaultId,
        operationId,
      );
      const eventAfter = await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      );
      expect(journalAfter.kind).toBe("observed");
      expect(eventAfter.kind).toBe("observed");
      if (journalAfter.kind !== "observed" || eventAfter.kind !== "observed")
        return;
      expect(journalAfter.observation.observed.bytes).toEqual(
        journalBytesBefore,
      );
      expect(eventAfter.observation.observed.bytes).toEqual(
        evidence === "event" ? divergentBytes : eventBytesBefore,
      );
      if (evidence === "head") {
        const storedHead = fixture.bucket.objects.get(
          syncHeadKey(vaultId, path),
        );
        expect(storedHead).toBeDefined();
        if (storedHead === undefined) return;
        expect(new Uint8Array(await storedHead.arrayBuffer())).toEqual(
          divergentBytes,
        );
      }
      if (evidence === "lane") {
        const storedLane = fixture.bucket.objects.get(
          syncFeedLaneHeadKey(vaultId, fixture.lane),
        );
        expect(storedLane).toBeDefined();
        if (storedLane === undefined) return;
        expect(new Uint8Array(await storedLane.arrayBuffer())).toEqual(
          divergentBytes,
        );
      }
      expect(fixture.bucket.puts).toHaveLength(writesBefore);
    },
  );

  it("keeps an exact head CAS unknown when both refusal read-backs are unavailable", async () => {
    const fixture = await setup();
    const scenario = await prepareCurrentHeadCasScenario(fixture);
    const store = createStore(fixture);
    await advanceToHeadWrite(store, fixture, scenario.request);

    const headKey = syncHeadKey(vaultId, path);
    const laneKey = syncFeedLaneHeadKey(vaultId, fixture.lane);
    const originalHead = await fixture.records.readHead(vaultId, path);
    const journalBefore = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(originalHead.kind).toBe("observed");
    expect(journalBefore.kind).toBe("observed");
    if (originalHead.kind !== "observed" || journalBefore.kind !== "observed")
      return;
    const originalEtag = originalHead.observation.observed.etag;
    expect(journalBefore.observation.value).toMatchObject({
      stepEvidence: {
        step: "write_head",
        precondition: { kind: "observed", etag: originalEtag },
      },
    });
    const writesBefore = fixture.bucket.puts.length;
    const headCooldown =
      originalHead.observation.observed.uploaded.getTime() + 1_100;
    fixture.setNow(Math.max(fixture.now(), headCooldown));
    let journalBytesAtCas: Uint8Array | undefined;
    let competingWrite: SyncR2WriteResult | undefined;
    fixture.bucket.beforeNextPut(headKey, "replace", async () => {
      const journalAtCas = await fixture.publication.readJournal(
        vaultId,
        recoveryOperationId,
      );
      if (journalAtCas.kind === "observed") {
        journalBytesAtCas = journalAtCas.observation.observed.bytes;
      }
      const current = await fixture.records.readHead(vaultId, path);
      if (current.kind !== "observed") {
        throw new Error("The exact pre-race current head must be readable.");
      }
      expect(current.observation.observed.etag).toBe(originalEtag);
      competingWrite = await fixture.records.replaceHead(
        current.observation,
        scenario.competingHead,
      );
      fixture.bucket.failNextGets(headKey, 2);
    });

    expect(
      await resumeUntil(
        store,
        fixture,
        scenario.request,
        () => competingWrite !== undefined,
      ),
    ).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId: recoveryOperationId,
    });
    expect(competingWrite).toEqual({ kind: "confirmed" });
    const journalAfter = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    const laneAfter = await fixture.publication.readLaneHead(
      vaultId,
      fixture.lane,
    );
    expect(journalAfter.kind).toBe("observed");
    expect(laneAfter).toMatchObject({
      kind: "observed",
      observation: {
        value: { pending: { operationId: recoveryOperationId } },
      },
    });
    if (journalAfter.kind !== "observed") return;
    expect(journalBytesAtCas).toBeDefined();
    if (journalBytesAtCas === undefined) return;
    expect(journalAfter.observation.observed.bytes).toEqual(journalBytesAtCas);
    expect(
      fixture.bucket.objects.has(
        syncFeedEventKey(
          vaultId,
          fixture.lane,
          syncEventSequenceSchema.parse("00000000000000000001"),
        ),
      ),
    ).toBe(false);
    expect(fixture.bucket.puts.length).toBeGreaterThan(writesBefore);
    expect(
      fixture.bucket.putAttempts.filter(
        ({ key, phase, etagMatches }) =>
          key === headKey &&
          phase === "replace" &&
          etagMatches === originalEtag,
      ),
    ).toHaveLength(2);
    expect(fixture.bucket.objects.has(laneKey)).toBe(true);
  });
});

describe("head publication races", () => {
  it("keeps a stale operation pending when a competitor wins before write-head readiness", async () => {
    const fixture = await setup();
    const scenario = await prepareCurrentHeadCasScenario(fixture);
    const store = createStore(fixture);
    let competingHeadWrite: SyncR2WriteResult | undefined;
    const versionKey = syncVersionKey(vaultId, scenario.request.revision);
    fixture.bucket.afterNextPut(versionKey, "create", async () => {
      const current = await fixture.records.readHead(vaultId, path);
      if (current.kind !== "observed") {
        throw new Error("The exact original head must remain readable.");
      }
      expect(current.observation.value.revision).toBe(revision);
      fixture.setNow(
        Math.max(
          fixture.now(),
          current.observation.observed.uploaded.getTime() + 1_100,
        ),
      );
      competingHeadWrite = await fixture.records.replaceHead(
        current.observation,
        scenario.competingHead,
      );
    });
    const headKey = syncHeadKey(vaultId, path);
    const headWritesBefore = fixture.bucket.putAttempts.filter(
      (attempt) => attempt.key === headKey,
    ).length;

    const result = await settleMutation(store, fixture, scenario.request);

    expect(competingHeadWrite).toEqual({ kind: "confirmed" });
    expect(result).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId: recoveryOperationId,
    });
    expect(await store.readCurrent({ vaultId, path })).toMatchObject({
      kind: "live",
      revision: tombstoneRevision,
      operationId: competingOperationId,
    });
    expect(
      await store.readVersion({
        vaultId,
        revision: scenario.request.revision,
      }),
    ).toMatchObject({
      kind: "present",
      version: {
        kind: "live",
        revision: scenario.request.revision,
        operationId: recoveryOperationId,
        content: scenario.request.content,
      },
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toEqual({ kind: "absent" });
    expect(
      await fixture.publication.readJournal(vaultId, recoveryOperationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          stepEvidence: {
            step: "immutable_create",
            attempt: { state: "attempting", generation: 1 },
          },
        },
      },
    });
    const lane = await fixture.publication.readLaneHead(vaultId, fixture.lane);
    expect(lane).toMatchObject({
      kind: "observed",
      observation: {
        value: { pending: { operationId: recoveryOperationId } },
      },
    });
    expect(
      fixture.bucket.putAttempts.filter((attempt) => attempt.key === headKey),
    ).toHaveLength(headWritesBefore + 1);
  });

  it("recovers preflight no-dispatch only after persisting and rechecking its exact first claim", async () => {
    const fixture = await setup();
    const scenario = await prepareCreateHeadRace(fixture);
    const store = createStore(fixture);
    await advanceToHeadWrite(store, fixture, scenario.request);
    await advanceHeadWriteCooldown(fixture, scenario.request);
    const headKey = syncHeadKey(vaultId, path);
    const competingBytes = await encodeSyncRecord({
      kind: "head",
      record: scenario.competingHead,
    });
    fixture.bucket.afterNextGet(headKey, () => {
      fixture.bucket.afterNextGet(headKey, () => {
        fixture.bucket.seed(headKey, competingBytes, fixture.now());
      });
    });

    const measuredRefusal = createMeasuredStore(fixture);
    const refusalCallsBefore =
      fixture.bucket.gets.length + fixture.bucket.puts.length;
    const refusal = await measuredRefusal.store.resumeOperation({
      vaultId,
      operationId,
    });
    expectInvocationCallsToMatchBucket(
      fixture,
      measuredRefusal.invocations,
      refusalCallsBefore,
    );
    expect(
      fixture.bucket.puts.filter(
        (key) => key === syncHeadRefusalReceiptKey(vaultId, operationId),
      ),
    ).toHaveLength(1);
    expect(refusal).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId,
    });
    expect(
      fixture.bucket.putAttempts.filter((attempt) => attempt.key === headKey),
    ).toHaveLength(0);
    const receipt = await fixture.publication.readHeadRefusalReceipt(
      vaultId,
      operationId,
    );
    expect(receipt).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          operationId,
          refusalSource: "preflight_no_dispatch",
          generation: 1,
          headKey,
        },
      },
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      ),
    ).toEqual({ kind: "absent" });

    const claim = await fixture.publication.readJournal(vaultId, operationId);
    expect(claim.kind).toBe("observed");
    if (claim.kind !== "observed") return;
    const journalKey = syncOperationKey(vaultId, operationId);
    fixture.setNow(claim.observation.observed.uploaded.getTime() + 1_100);
    fixture.bucket.applyThenLoseResponse(journalKey, "replace", 0);
    const recovered = await createStore(fixture).resumeOperation({
      vaultId,
      operationId,
    });
    expect(recovered).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId,
    });
    expect(
      fixture.bucket.putAttempts.filter(
        (attempt) =>
          attempt.key ===
          syncFeedEventKey(vaultId, fixture.lane, FIRST_EVENT_SEQUENCE),
      ),
    ).toHaveLength(0);
    const journalCas = fixture.bucket.putAttempts.filter(
      (attempt) => attempt.key === journalKey,
    );
    expect(journalCas.at(-1)?.etagMatches).toBe(
      claim.observation.observed.etag,
    );
    expect(
      fixture.bucket.appliedThenLostResponses.filter(
        (attempt) => attempt.key === journalKey,
      ),
    ).toHaveLength(1);
    expect(
      await fixture.publication.readJournal(vaultId, operationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: {
            step: "create_event",
            outcomeIntent: "aborted",
            attempt: { state: "ready", generation: 0 },
          },
        },
      },
    });
    expect(await store.readCurrent({ vaultId, path })).toMatchObject({
      kind: "live",
      revision: tombstoneRevision,
      operationId: competingOperationId,
    });

    expect(
      await settleResume(createStore(fixture), fixture, scenario.request),
    ).toEqual({
      kind: "error",
      code: "stale_revision",
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      ),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          kind: "aborted",
          operationId,
          reason: "stale_revision",
        },
      },
    });
    const lane = await fixture.publication.readLaneHead(vaultId, fixture.lane);
    expect(lane).toMatchObject({
      kind: "observed",
      observation: { value: { committedSequence: FIRST_EVENT_SEQUENCE } },
    });
    if (lane.kind === "observed") {
      expect(lane.observation.value.pending).toBeUndefined();
    }
  });

  it("keeps create-head timeout unknown despite an exact read of the competitor", async () => {
    const fixture = await setup();
    const scenario = await prepareCreateHeadRace(fixture);
    const store = createStore(fixture);
    await advanceToHeadWrite(store, fixture, scenario.request);

    const headKey = syncHeadKey(vaultId, path);
    let competingHeadWrite: SyncR2WriteResult | undefined;
    fixture.bucket.beforeNextPut(headKey, "create", async () => {
      competingHeadWrite = await fixture.records.createHead(
        scenario.competingHead,
      );
      throw new Error(
        "Simulated lost create-head response at the CAS boundary.",
      );
    });
    const headWritesBefore = fixture.bucket.putAttempts.filter(
      (attempt) => attempt.key === headKey,
    ).length;

    const beforeWrite = await store.resumeOperation({
      vaultId,
      operationId,
    });
    expect(beforeWrite).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId,
    });
    if (beforeWrite.kind !== "error" || !("retryAfterEpochMs" in beforeWrite)) {
      return;
    }
    fixture.setNow(beforeWrite.retryAfterEpochMs);

    const uncertain = await store.resumeOperation({ vaultId, operationId });
    expect(competingHeadWrite).toEqual({ kind: "confirmed" });
    expect(uncertain).toMatchObject({
      kind: "error",
      code: "effect_unknown",
      operationId,
    });
    const headWrites = fixture.bucket.putAttempts
      .filter((attempt) => attempt.key === headKey)
      .slice(headWritesBefore);
    expect(headWrites).toHaveLength(2);
    expect(headWrites.map((attempt) => attempt.ifNoneMatch)).toEqual([
      "*",
      "*",
    ]);
    expect(await store.readCurrent({ vaultId, path })).toMatchObject({
      kind: "live",
      revision: tombstoneRevision,
      operationId: competingOperationId,
    });
    const pending = await fixture.publication.readJournal(vaultId, operationId);
    expect(pending).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: {
            step: "write_head",
            precondition: { kind: "absent" },
          },
        },
      },
    });
    const eventPosition = syncEventSequenceSchema.parse("00000000000000000001");
    expect(
      await fixture.publication.readEvent(vaultId, fixture.lane, eventPosition),
    ).toEqual({ kind: "absent" });
    const lane = await fixture.publication.readLaneHead(vaultId, fixture.lane);
    expect(lane).toMatchObject({
      kind: "observed",
      observation: { value: { pending: { operationId } } },
    });
    if (
      pending.kind !== "observed" ||
      pending.observation.value.status !== "pending" ||
      pending.observation.value.allocationState !== "allocated"
    ) {
      return;
    }
    if (
      pending.observation.value.stepEvidence.step !== "write_head" ||
      pending.observation.value.stepEvidence.attempt.state !== "attempting"
    ) {
      return;
    }
    const retryAfter =
      pending.observation.value.stepEvidence.attempt.claimedAtEpochMs + 1_100;
    const writesAfterTimeout = fixture.bucket.putAttempts.length;
    fixture.setNow(retryAfter);
    expect(await store.resumeOperation({ vaultId, operationId })).toMatchObject(
      {
        kind: "error",
        code: "effect_unknown",
        operationId,
      },
    );
    expect(fixture.bucket.putAttempts).toHaveLength(writesAfterTimeout);
    expect(
      await fixture.publication.readEvent(vaultId, fixture.lane, eventPosition),
    ).toEqual({ kind: "absent" });
  });
});

describe("write_head durable attempts", () => {
  it("claims before replacing the exact original head generation", async () => {
    const fixture = await setup();
    await seedLiveHead(fixture, "Exact original parent");
    const content = "Claimed current head replacement";
    const request: SyncMutationRequest = {
      kind: "update",
      vaultId,
      path,
      operationId: recoveryOperationId,
      revision: updatedRevision,
      parent: { kind: "revision", revision },
      contentSha256: await sha256Content(content),
      content,
      mediaType: "text/markdown",
      origin,
    };
    const store = createStore(fixture);
    await advanceToHeadWrite(store, fixture, request);
    const ready = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(ready.kind).toBe("observed");
    if (ready.kind !== "observed") return;
    const originalHead = await fixture.records.readHead(vaultId, path);
    expect(originalHead.kind).toBe("observed");
    if (originalHead.kind !== "observed") return;
    const originalEtag = originalHead.observation.observed.etag;
    const retryFloor =
      ready.observation.value.status === "pending" &&
      ready.observation.value.allocationState === "allocated" &&
      ready.observation.value.stepEvidence.step !== "commit_journal"
        ? (ready.observation.value.stepEvidence.retryAfterEpochMs ?? 0)
        : 0;
    fixture.setNow(
      Math.max(
        fixture.now(),
        ready.observation.observed.uploaded.getTime() + 1_100,
        originalHead.observation.observed.uploaded.getTime() + 1_100,
        retryFloor,
      ),
    );

    let claimAtDispatch: SyncJournalRecord | undefined;
    const headKey = syncHeadKey(vaultId, path);
    fixture.bucket.beforeNextPut(headKey, "replace", async () => {
      const journal = await fixture.publication.readJournal(
        vaultId,
        recoveryOperationId,
      );
      claimAtDispatch =
        journal.kind === "observed" ? journal.observation.value : undefined;
    });

    await store.resumeOperation({ vaultId, operationId: recoveryOperationId });

    expect(claimAtDispatch).toMatchObject({
      status: "pending",
      allocationState: "allocated",
      stepEvidence: {
        step: "write_head",
        attempt: { state: "attempting", generation: 1 },
      },
    });
    const headPut = fixture.bucket.putAttempts.find(
      (attempt) => attempt.key === headKey && attempt.phase === "replace",
    );
    expect(headPut?.etagMatches).toBe(originalEtag);
    expect(headPut?.ifNoneMatch).toBeUndefined();
    const targetVersion = await fixture.records.readVersion(
      vaultId,
      updatedRevision,
    );
    expect(targetVersion.kind).toBe("observed");
    if (targetVersion.kind === "observed") {
      expect(headPut?.bytes).toEqual(
        await encodeSyncRecord({
          kind: "head",
          record: targetVersion.observation.value,
        }),
      );
    }
  });

  it("dispatches only after a lost claim response is resolved to its exact journal bytes", async () => {
    const fixture = await setup();
    await seedLiveHead(fixture, "Parent before lost claim response");
    const content = "Head claim response is lost";
    const request: SyncMutationRequest = {
      kind: "update",
      vaultId,
      path,
      operationId: recoveryOperationId,
      revision: updatedRevision,
      parent: { kind: "revision", revision },
      contentSha256: await sha256Content(content),
      content,
      mediaType: "text/markdown",
      origin,
    };
    await advanceToHeadWrite(createStore(fixture), fixture, request);
    const journal = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    const parent = await fixture.records.readHead(vaultId, path);
    expect(journal.kind).toBe("observed");
    expect(parent.kind).toBe("observed");
    if (journal.kind !== "observed" || parent.kind !== "observed") return;
    fixture.setNow(
      Math.max(
        fixture.now(),
        journal.observation.observed.uploaded.getTime() + 1_100,
        parent.observation.observed.uploaded.getTime() + 1_100,
      ),
    );
    const journalKey = syncOperationKey(vaultId, recoveryOperationId);
    const headKey = syncHeadKey(vaultId, path);
    fixture.bucket.applyThenLoseResponse(journalKey, "replace", 1);
    let claimAtDispatch: SyncJournalRecord | undefined;
    fixture.bucket.beforeNextPut(headKey, "replace", async () => {
      const claim = await fixture.publication.readJournal(
        vaultId,
        recoveryOperationId,
      );
      claimAtDispatch =
        claim.kind === "observed" ? claim.observation.value : undefined;
    });

    await createStore(fixture).resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });

    expect(
      fixture.bucket.appliedThenLostResponses.some(
        (attempt) => attempt.key === journalKey && attempt.phase === "replace",
      ),
    ).toBe(true);
    expect(claimAtDispatch).toMatchObject({
      status: "pending",
      allocationState: "allocated",
      stepEvidence: {
        step: "write_head",
        attempt: { state: "attempting", generation: 1 },
      },
    });
    expect(
      fixture.bucket.putAttempts.filter(
        (attempt) => attempt.key === headKey && attempt.phase === "replace",
      ),
    ).toHaveLength(1);
    const headPut = fixture.bucket.putAttempts.find(
      (attempt) => attempt.key === headKey && attempt.phase === "replace",
    );
    expect(headPut?.etagMatches).toBe(parent.observation.observed.etag);
  });

  it("claims before creating a head under the original absent condition", async () => {
    const fixture = await setup();
    const request = await createMutationRequest("Claimed head creation");
    const store = createStore(fixture);
    await advanceToHeadWrite(store, fixture, request);
    const ready = await fixture.publication.readJournal(vaultId, operationId);
    expect(ready.kind).toBe("observed");
    if (ready.kind !== "observed") return;
    fixture.setNow(
      Math.max(
        fixture.now(),
        ready.observation.observed.uploaded.getTime() + 1_100,
      ),
    );

    let claimAtDispatch: SyncJournalRecord | undefined;
    const headKey = syncHeadKey(vaultId, path);
    fixture.bucket.beforeNextPut(headKey, "create", async () => {
      const journal = await fixture.publication.readJournal(
        vaultId,
        operationId,
      );
      claimAtDispatch =
        journal.kind === "observed" ? journal.observation.value : undefined;
    });

    await store.resumeOperation({ vaultId, operationId });

    expect(claimAtDispatch).toMatchObject({
      status: "pending",
      allocationState: "allocated",
      stepEvidence: {
        step: "write_head",
        precondition: { kind: "absent" },
        attempt: { state: "attempting", generation: 1 },
      },
    });
    const headPut = fixture.bucket.putAttempts.find(
      (attempt) => attempt.key === headKey && attempt.phase === "create",
    );
    expect(headPut?.ifNoneMatch).toBe("*");
    expect(headPut?.etagMatches).toBeUndefined();
  });

  it("reconciles an applied lost-response head without another PUT", async () => {
    const fixture = await setup();
    await seedLiveHead(fixture, "Parent before lost head response");
    const content = "Head applied before response loss";
    const request: SyncMutationRequest = {
      kind: "update",
      vaultId,
      path,
      operationId: recoveryOperationId,
      revision: updatedRevision,
      parent: { kind: "revision", revision },
      contentSha256: await sha256Content(content),
      content,
      mediaType: "text/markdown",
      origin,
    };
    const store = createStore(fixture);
    await advanceToHeadWrite(store, fixture, request);
    const headKey = syncHeadKey(vaultId, path);
    const headBefore = await fixture.records.readHead(vaultId, path);
    const journalBefore = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(headBefore.kind).toBe("observed");
    expect(journalBefore.kind).toBe("observed");
    if (headBefore.kind !== "observed" || journalBefore.kind !== "observed") {
      return;
    }
    fixture.setNow(
      Math.max(
        fixture.now(),
        headBefore.observation.observed.uploaded.getTime() + 1_100,
        journalBefore.observation.observed.uploaded.getTime() + 1_100,
      ),
    );
    fixture.bucket.applyThenLoseResponse(headKey, "replace", 2);

    const lost = await store.resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });

    expect(lost).toMatchObject({
      kind: "error",
      code: "effect_unknown",
      operationId: recoveryOperationId,
    });
    expect(
      fixture.bucket.putAttempts.filter(
        (attempt) => attempt.key === headKey && attempt.phase === "replace",
      ),
    ).toHaveLength(1);
    const claimedJournal = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(claimedJournal).toMatchObject({
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
    if (claimedJournal.kind !== "observed") return;

    fixture.setNow(
      Math.max(
        fixture.now(),
        claimedJournal.observation.observed.uploaded.getTime() + 1_100,
      ),
    );
    await createStore(fixture).resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });

    expect(
      fixture.bucket.putAttempts.filter(
        (attempt) => attempt.key === headKey && attempt.phase === "replace",
      ),
    ).toHaveLength(1);
    expect(
      await fixture.publication.readJournal(vaultId, recoveryOperationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: {
            step: "create_event",
            outcomeIntent: "changed",
            attempt: { state: "ready", generation: 0 },
          },
        },
      },
    });
  });

  it("does not adopt an exact target head that has no attempt claim", async () => {
    const fixture = await setup();
    await seedLiveHead(fixture, "Original before unclaimed target");
    const content = "Exact bytes without a claim";
    const request: SyncMutationRequest = {
      kind: "update",
      vaultId,
      path,
      operationId: recoveryOperationId,
      revision: updatedRevision,
      parent: { kind: "revision", revision },
      contentSha256: await sha256Content(content),
      content,
      mediaType: "text/markdown",
      origin,
    };
    const store = createStore(fixture);
    await advanceToHeadWrite(store, fixture, request);
    const version = await fixture.records.readVersion(vaultId, updatedRevision);
    expect(version.kind).toBe("observed");
    if (version.kind !== "observed") return;
    const headKey = syncHeadKey(vaultId, path);
    fixture.bucket.seed(
      headKey,
      await encodeSyncRecord({
        kind: "head",
        record: version.observation.value,
      }),
      fixture.now(),
    );

    expect(
      await store.resumeOperation({
        vaultId,
        operationId: recoveryOperationId,
      }),
    ).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId: recoveryOperationId,
    });
    expect(
      fixture.bucket.putAttempts.filter(
        (attempt) => attempt.key === headKey && attempt.phase === "replace",
      ),
    ).toHaveLength(0);
    expect(
      await fixture.publication.readJournal(vaultId, recoveryOperationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: {
            step: "write_head",
            attempt: { state: "ready", generation: 0 },
          },
        },
      },
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      ),
    ).toEqual({ kind: "absent" });
  });

  it.each([0, 10_000])(
    "waits through a lost head response and floor CAS after %i ms before retrying its original ETag",
    async (observationDelayMs) => {
      const fixture = await setup();
      await seedLiveHead(fixture, "Parent before head retry");
      const content = "Head retry keeps its original ETag";
      const request: SyncMutationRequest = {
        kind: "update",
        vaultId,
        path,
        operationId: recoveryOperationId,
        revision: updatedRevision,
        parent: { kind: "revision", revision },
        contentSha256: await sha256Content(content),
        content,
        mediaType: "text/markdown",
        origin,
      };
      const store = createStore(fixture);
      await advanceToHeadWrite(store, fixture, request);
      const ready = await fixture.publication.readJournal(
        vaultId,
        recoveryOperationId,
      );
      const parent = await fixture.records.readHead(vaultId, path);
      expect(ready.kind).toBe("observed");
      expect(parent.kind).toBe("observed");
      if (ready.kind !== "observed" || parent.kind !== "observed") return;
      const originalEtag = parent.observation.observed.etag;
      fixture.setNow(
        Math.max(
          fixture.now(),
          ready.observation.observed.uploaded.getTime() + 1_100,
          parent.observation.observed.uploaded.getTime() + 1_100,
        ),
      );
      const claimTime = fixture.now();
      const headKey = syncHeadKey(vaultId, path);
      const journalKey = syncOperationKey(vaultId, recoveryOperationId);
      fixture.bucket.beforeNextPut(headKey, "replace", async () => {
        throw new Error("Simulated timeout before the current-head PUT.");
      });

      const interrupted = await store.resumeOperation({
        vaultId,
        operationId: recoveryOperationId,
      });
      expect(interrupted).toMatchObject({
        kind: "error",
        code: "operation_pending",
        retryAfterEpochMs: claimTime + 1_100,
      });
      expect(
        fixture.bucket.putAttempts.filter(
          (attempt) => attempt.key === headKey && attempt.phase === "replace",
        ),
      ).toHaveLength(1);
      expect(
        await fixture.publication.readJournal(vaultId, recoveryOperationId),
      ).toMatchObject({
        kind: "observed",
        observation: {
          value: {
            status: "pending",
            allocationState: "allocated",
            stepEvidence: {
              step: "write_head",
              attempt: { state: "attempting", generation: 1 },
            },
          },
        },
      });

      fixture.setNow(claimTime + 1_100 + observationDelayMs);
      fixture.bucket.applyThenLoseResponse(journalKey, "replace", 1);
      await createStore(fixture).resumeOperation({
        vaultId,
        operationId: recoveryOperationId,
      });
      const retryJournal = await fixture.publication.readJournal(
        vaultId,
        recoveryOperationId,
      );
      expect(retryJournal).toMatchObject({
        kind: "observed",
        observation: {
          value: {
            stepEvidence: {
              step: "write_head",
              attempt: { state: "retry_wait", generation: 1 },
            },
          },
        },
      });
      expect(
        fixture.bucket.appliedThenLostResponses.some(
          (attempt) =>
            attempt.key === journalKey && attempt.phase === "replace",
        ),
      ).toBe(true);
      if (
        retryJournal.kind !== "observed" ||
        retryJournal.observation.value.status !== "pending" ||
        retryJournal.observation.value.allocationState !== "allocated" ||
        retryJournal.observation.value.stepEvidence.step !== "write_head" ||
        retryJournal.observation.value.stepEvidence.attempt.state !==
          "retry_wait"
      ) {
        return;
      }
      const fixedFloor =
        retryJournal.observation.value.stepEvidence.attempt.retryAfterEpochMs;
      expect(fixedFloor).toBe(claimTime + 2_200 + observationDelayMs);
      const writesBeforeEarlyResume = fixture.bucket.putAttempts.filter(
        (attempt) => attempt.key === headKey && attempt.phase === "replace",
      ).length;
      fixture.setNow(fixedFloor - 1);
      expect(
        await createStore(fixture).resumeOperation({
          vaultId,
          operationId: recoveryOperationId,
        }),
      ).toMatchObject({
        kind: "error",
        code: "operation_pending",
        retryAfterEpochMs: fixedFloor,
      });
      expect(
        fixture.bucket.putAttempts.filter(
          (attempt) => attempt.key === headKey && attempt.phase === "replace",
        ),
      ).toHaveLength(writesBeforeEarlyResume);

      let retryClaim: SyncJournalRecord | undefined;
      fixture.setNow(fixedFloor);
      fixture.bucket.beforeNextPut(headKey, "replace", async () => {
        const journal = await fixture.publication.readJournal(
          vaultId,
          recoveryOperationId,
        );
        retryClaim =
          journal.kind === "observed" ? journal.observation.value : undefined;
      });
      await createStore(fixture).resumeOperation({
        vaultId,
        operationId: recoveryOperationId,
      });
      expect(retryClaim).toMatchObject({
        status: "pending",
        allocationState: "allocated",
        stepEvidence: {
          step: "write_head",
          attempt: { state: "attempting", generation: 2 },
        },
      });
      const headPuts = fixture.bucket.putAttempts.filter(
        (attempt) => attempt.key === headKey && attempt.phase === "replace",
      );
      expect(headPuts).toHaveLength(2);
      expect(headPuts.map((attempt) => attempt.etagMatches)).toEqual([
        originalEtag,
        originalEtag,
      ]);
    },
  );

  it("honors a throttled head result before claiming its next generation", async () => {
    const fixture = await setup();
    await seedLiveHead(fixture, "Parent before head throttle");
    const content = "Head retry after throttle";
    const request: SyncMutationRequest = {
      kind: "update",
      vaultId,
      path,
      operationId: recoveryOperationId,
      revision: updatedRevision,
      parent: { kind: "revision", revision },
      contentSha256: await sha256Content(content),
      content,
      mediaType: "text/markdown",
      origin,
    };
    const store = createStore(fixture);
    await advanceToHeadWrite(store, fixture, request);
    const ready = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    const parent = await fixture.records.readHead(vaultId, path);
    expect(ready.kind).toBe("observed");
    expect(parent.kind).toBe("observed");
    if (ready.kind !== "observed" || parent.kind !== "observed") return;
    const originalEtag = parent.observation.observed.etag;
    fixture.setNow(
      Math.max(
        fixture.now(),
        ready.observation.observed.uploaded.getTime() + 1_100,
        parent.observation.observed.uploaded.getTime() + 1_100,
      ),
    );
    const headKey = syncHeadKey(vaultId, path);
    fixture.bucket.beforeNextPut(headKey, "replace", async () => {
      throw Object.assign(new Error("Too many requests"), { status: 429 });
    });

    const throttled = await store.resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });
    expect(throttled).toMatchObject({
      kind: "error",
      code: "operation_pending",
    });
    if (throttled.kind !== "error" || !("retryAfterEpochMs" in throttled)) {
      return;
    }
    expect(
      fixture.bucket.putAttempts.filter(
        (attempt) => attempt.key === headKey && attempt.phase === "replace",
      ),
    ).toHaveLength(1);

    fixture.setNow(throttled.retryAfterEpochMs);
    await createStore(fixture).resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });
    const retryJournal = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(retryJournal).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          stepEvidence: {
            step: "write_head",
            attempt: { state: "retry_wait", generation: 1 },
          },
        },
      },
    });
    if (
      retryJournal.kind !== "observed" ||
      retryJournal.observation.value.status !== "pending" ||
      retryJournal.observation.value.allocationState !== "allocated" ||
      retryJournal.observation.value.stepEvidence.step !== "write_head" ||
      retryJournal.observation.value.stepEvidence.attempt.state !== "retry_wait"
    ) {
      return;
    }
    const retryFloor =
      retryJournal.observation.value.stepEvidence.attempt.retryAfterEpochMs;
    expect(retryFloor).toBeGreaterThanOrEqual(throttled.retryAfterEpochMs);
    fixture.setNow(retryFloor);
    await createStore(fixture).resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });
    const headPuts = fixture.bucket.putAttempts.filter(
      (attempt) => attempt.key === headKey && attempt.phase === "replace",
    );
    expect(headPuts).toHaveLength(2);
    expect(headPuts.map((attempt) => attempt.etagMatches)).toEqual([
      originalEtag,
      originalEtag,
    ]);
  });

  it("allows only one same-operation resumer to put its head claim", async () => {
    const fixture = await setup();
    await seedLiveHead(fixture, "Parent before concurrent head resumers");
    const content = "Concurrent head claim";
    const request: SyncMutationRequest = {
      kind: "update",
      vaultId,
      path,
      operationId: recoveryOperationId,
      revision: updatedRevision,
      parent: { kind: "revision", revision },
      contentSha256: await sha256Content(content),
      content,
      mediaType: "text/markdown",
      origin,
    };
    await advanceToHeadWrite(createStore(fixture), fixture, request);
    const journal = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    expect(journal.kind).toBe("observed");
    if (journal.kind !== "observed") return;
    fixture.setNow(
      Math.max(
        fixture.now(),
        journal.observation.observed.uploaded.getTime() + 1_100,
      ),
    );
    const headKey = syncHeadKey(vaultId, path);
    fixture.bucket.barrierNextGets(
      syncOperationKey(vaultId, recoveryOperationId),
      2,
    );

    await Promise.all([
      createStore(fixture).resumeOperation({
        vaultId,
        operationId: recoveryOperationId,
      }),
      createStore(fixture).resumeOperation({
        vaultId,
        operationId: recoveryOperationId,
      }),
    ]);

    expect(
      fixture.bucket.putAttempts.filter(
        (attempt) => attempt.key === headKey && attempt.phase === "replace",
      ),
    ).toHaveLength(1);
    expect(
      await fixture.publication.readJournal(vaultId, recoveryOperationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: {
            step: "write_head",
            attempt: { state: "attempting", generation: 1 },
          },
        },
      },
    });
  });

  it("records a refused stale-head abort only while linked competitor proof is readable", async () => {
    const fixture = await setup();
    const scenario = await prepareCurrentHeadCasScenario(fixture);
    await advanceToHeadWrite(createStore(fixture), fixture, scenario.request);
    const journal = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    const parent = await fixture.records.readHead(vaultId, path);
    expect(journal.kind).toBe("observed");
    expect(parent.kind).toBe("observed");
    if (journal.kind !== "observed" || parent.kind !== "observed") return;
    fixture.setNow(
      Math.max(
        fixture.now(),
        journal.observation.observed.uploaded.getTime() + 1_100,
        parent.observation.observed.uploaded.getTime() + 1_100,
      ),
    );
    const headKey = syncHeadKey(vaultId, path);
    fixture.bucket.beforeNextPut(headKey, "replace", async () => {
      fixture.bucket.seed(
        headKey,
        await encodeSyncRecord({
          kind: "head",
          record: scenario.competingHead,
        }),
        fixture.now(),
      );
      fixture.setNow(fixture.now() + 1_100);
    });

    const refused = await createStore(fixture).resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });
    expect(refused).toMatchObject({
      kind: "error",
      code: "operation_pending",
      operationId: recoveryOperationId,
    });
    if (refused.kind !== "error" || !("retryAfterEpochMs" in refused)) return;
    fixture.setNow(refused.retryAfterEpochMs);
    await createStore(fixture).resumeOperation({
      vaultId,
      operationId: recoveryOperationId,
    });

    expect(
      await fixture.publication.readJournal(vaultId, recoveryOperationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: {
            step: "create_event",
            outcomeIntent: "aborted",
            attempt: { state: "ready", generation: 0 },
          },
        },
      },
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      ),
    ).toEqual({ kind: "absent" });
    expect(
      await createStore(fixture).readCurrent({ vaultId, path }),
    ).toMatchObject({
      kind: "live",
      revision: tombstoneRevision,
      operationId: competingOperationId,
    });
    expect(
      fixture.bucket.putAttempts.filter(
        (attempt) => attempt.key === headKey && attempt.phase === "replace",
      ),
    ).toHaveLength(1);
  });

  it("keeps a refused head CAS unknown when competitor linkage cannot be verified", async () => {
    const fixture = await setup();
    const scenario = await prepareCurrentHeadCasScenario(fixture);
    await advanceToHeadWrite(createStore(fixture), fixture, scenario.request);
    const journal = await fixture.publication.readJournal(
      vaultId,
      recoveryOperationId,
    );
    const parent = await fixture.records.readHead(vaultId, path);
    expect(journal.kind).toBe("observed");
    expect(parent.kind).toBe("observed");
    if (journal.kind !== "observed" || parent.kind !== "observed") return;
    fixture.setNow(
      Math.max(
        fixture.now(),
        journal.observation.observed.uploaded.getTime() + 1_100,
        parent.observation.observed.uploaded.getTime() + 1_100,
      ),
    );
    const headKey = syncHeadKey(vaultId, path);
    fixture.bucket.beforeNextPut(headKey, "replace", async () => {
      fixture.bucket.seed(
        headKey,
        await encodeSyncRecord({
          kind: "head",
          record: scenario.competingHead,
        }),
        fixture.now(),
      );
      fixture.bucket.failNextGets(
        syncVersionKey(vaultId, tombstoneRevision),
        1,
      );
    });

    expect(
      await createStore(fixture).resumeOperation({
        vaultId,
        operationId: recoveryOperationId,
      }),
    ).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId: recoveryOperationId,
    });
    expect(
      await fixture.publication.readJournal(vaultId, recoveryOperationId),
    ).toMatchObject({
      kind: "observed",
      observation: {
        value: {
          status: "pending",
          allocationState: "allocated",
          stepEvidence: {
            step: "write_head",
            attempt: { state: "attempting", generation: 1 },
          },
        },
      },
    });
    expect(
      await fixture.publication.readEvent(
        vaultId,
        fixture.lane,
        FIRST_EVENT_SEQUENCE,
      ),
    ).toEqual({ kind: "absent" });
  });
});

describe("review correction: intrinsic mutation admission", () => {
  it("rejects a null parent before any R2 access", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const request = await createMutationRequest("Malformed parent");
    fixture.bucket.failNextGets(syncOperationKey(vaultId, operationId), 1);

    // @ts-expect-error Models JavaScript input with a parent outside the closed request union.
    const malformed: SyncMutationRequest = { ...request, parent: null };
    expect(await store.mutate(malformed)).toEqual({
      kind: "error",
      code: "invalid_input",
    });
    expect(fixture.bucket.gets).toEqual([]);
    expect(fixture.bucket.puts).toEqual([]);
  });

  it("rejects digest-invalid and oversized content before an unavailable journal read", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const validRequest = await createMutationRequest("Digest validation");
    const invalidDigest: SyncMutationRequest = {
      ...validRequest,
      contentSha256: await sha256Content("different content"),
    };
    const oversized = await createMutationRequest("x".repeat(1024 * 1024 + 1));
    const journalKey = syncOperationKey(vaultId, operationId);
    fixture.bucket.failNextGets(journalKey, 1);

    expect(await store.mutate(invalidDigest)).toEqual({
      kind: "error",
      code: "invalid_input",
    });
    expect(await store.mutate(oversized)).toEqual({
      kind: "error",
      code: "invalid_input",
    });
    expect(fixture.bucket.gets).toEqual([]);
    expect(fixture.bucket.puts).toEqual([]);
  });

  it("rejects a malformed tombstone digest before any R2 access", async () => {
    const fixture = await setup();
    const store = createStore(fixture);
    const tombstoneId = recoveryOperationId;
    const request: SyncMutationRequest = {
      kind: "tombstone",
      vaultId,
      path,
      operationId: tombstoneId,
      revision: tombstoneRevision,
      parent: { kind: "revision", revision },
      // @ts-expect-error Exercise malformed runtime digest input at the adapter boundary.
      contentSha256: "not-a-sha256-digest",
      origin: alternateOrigin,
    };
    fixture.bucket.failNextGets(syncOperationKey(vaultId, tombstoneId), 1);

    expect(await store.mutate(request)).toEqual({
      kind: "error",
      code: "invalid_input",
    });
    expect(fixture.bucket.gets).toEqual([]);
    expect(fixture.bucket.puts).toEqual([]);
  });

  it("maps digest capability failure to storage_unavailable", async () => {
    const request = await createMutationRequest("Unavailable hash");

    expect(
      await validateMutationInput(request, async () => {
        throw new Error("Simulated Web Crypto failure.");
      }),
    ).toEqual({ kind: "error", code: "storage_unavailable" });
  });
});
