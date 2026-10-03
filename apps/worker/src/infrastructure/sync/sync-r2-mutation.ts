import type {
  SyncMutationRequest,
  SyncMutationResult,
  SyncResumeOperationInput,
  SyncResumeOperationResult,
  SyncStoreFailure,
} from "@core/sync/sync-store.types";
import { decodeBase64Url, encodeBase64Url } from "@obsidian-ai-bridge/core";
import {
  syncContentKey,
  syncFeedEventKey,
  syncFeedLaneForPath,
  syncFeedLaneHeadKey,
  syncHeadKey,
  syncOperationKey,
  syncRecoveryKey,
  syncVersionKey,
} from "@protocol/sync.codec";
import { SYNC_SEQUENCE_WIDTH } from "@protocol/sync.constants";
import {
  syncOperationIdSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";

import {
  decodeSyncPublication,
  encodeSyncPublication,
} from "@worker/infrastructure/sync/sync-publication.codec";
import type {
  SyncEventOutcomeIntent,
  SyncFeedEventRecord,
  SyncHeadRefusalPrecondition,
  SyncHeadRefusalReceiptRecord,
  SyncJournalRecord,
  SyncLaneHeadRecord,
  SyncPublicationStepEvidence,
  SyncUnallocatedPendingJournalRecord,
} from "@worker/infrastructure/sync/sync-publication.types";
import { SYNC_R2_WRITE_COOLDOWN_MS } from "@worker/infrastructure/sync/sync-r2.constants";
import type {
  SyncR2NoEffectOutcome,
  SyncR2RetryContext,
  SyncR2WriteResult,
  SyncRecordObservation,
  SyncRecordRead,
} from "@worker/infrastructure/sync/sync-r2.types";
import {
  commitTime,
  effectUnknown,
  equalBytes,
  evaluateMutation,
  firstImmutableKey,
  isStoreFailure,
  isValidMutationRequest,
  matchesLanePrecondition,
  matchesObservedPrecondition,
  mutationRejection,
  nextEventSequence,
  nextImmutableKey,
  observedPrecondition,
  operationPending,
  operationRecord,
  previousSequence,
  recoveryForRequest,
  sameCurrentAndHead,
  storageUnavailable,
  tombstoneVersionForRequest,
  validateMutationInput,
  versionForRequest,
  withoutUnallocatedFields,
  withStep,
  writeFailure,
  writeRetryAfter,
} from "@worker/infrastructure/sync/sync-r2-mutation.helpers";
import {
  syncR2CurrentStateFromHead,
  syncR2MutationReads,
  syncR2ReadTombstoneSource,
} from "@worker/infrastructure/sync/sync-r2-mutation.reads";
import { syncR2MutationTerminal } from "@worker/infrastructure/sync/sync-r2-mutation.terminal";
import type {
  SyncR2MutationInvocationCapabilities,
  SyncR2MutationInvocationFactory,
  SyncR2MutationStore,
  SyncServerClock,
} from "@worker/infrastructure/sync/sync-r2-mutation.types";
import {
  claimClockIsSafe,
  mergeKnownPendingRetryFloors,
  planPendingClaim,
  planPendingRetryWait,
} from "@worker/infrastructure/sync/sync-r2-mutation-attempt-policy";
import type { SyncR2Records } from "@worker/infrastructure/sync/sync-r2-records";
import { encodeSyncRecord } from "@worker/infrastructure/sync/sync-record.codec";
import type {
  SyncBodyRecord,
  SyncHeadRecord,
  SyncRecoveryMetadata,
  SyncVersionMetadata,
} from "@worker/infrastructure/sync/sync-record.types";
import { sha256Content } from "@worker/storage/storage-crypto";

export { createSyncR2MutationInvocationFactory } from "@worker/infrastructure/sync/sync-r2-mutation.factory";

/** One exact immutable object selected from an allocated mutation's ordered plan. */
type SyncImmutableTarget =
  | {
      readonly kind: "content";
      readonly record: Extract<
        SyncBodyRecord,
        { readonly kind: "contentBody" }
      >;
    }
  | {
      readonly kind: "recoveryBody";
      readonly record: Extract<
        SyncBodyRecord,
        { readonly kind: "recoveryBody" }
      >;
    }
  | { readonly kind: "recovery"; readonly record: SyncRecoveryMetadata }
  | { readonly kind: "version"; readonly record: SyncVersionMetadata };

/** Exact target read classification used before claiming or recovering an external write. */
type SyncPendingTargetObservation =
  | { readonly kind: "prior" }
  | { readonly kind: "exact" }
  | { readonly kind: "divergent" }
  | { readonly kind: "unavailable" };

/** Decision produced by pending external-step claim and reconciliation. */
type SyncPendingAttemptResult =
  | {
      readonly kind: "dispatch";
      readonly journal: Extract<
        SyncJournalRecord,
        { status: "pending"; allocationState: "allocated" }
      >;
    }
  | {
      readonly kind: "target_present";
      readonly journal: Extract<
        SyncJournalRecord,
        { status: "pending"; allocationState: "allocated" }
      >;
    }
  | { readonly kind: "deferred"; readonly result: SyncMutationResult };

/** Exact operation-journal generation classification for one claim or floor CAS. */
type SyncJournalAttemptObservation =
  | {
      readonly kind: "current";
      readonly observation: SyncRecordObservation<SyncJournalRecord>;
    }
  | { readonly kind: "changed"; readonly record: SyncJournalRecord }
  | { readonly kind: "unavailable" };

/** Creates a facade whose every mutation/resume call gets one fresh shared R2 call budget.
 * @param readOnlyRecords Marker-gated reads used only by the facade's public read methods.
 * @param createInvocation Factory for a fresh records/publication pair sharing one 64-call budget.
 * @param clock Server clock used only for persisted cooldown and event timing.
 * @returns Exact read methods plus bounded mutation and same-operation resumption.
 */
export function syncR2Mutation(
  readOnlyRecords: SyncR2Records,
  createInvocation: SyncR2MutationInvocationFactory,
  clock: SyncServerClock,
): SyncR2MutationStore {
  const exactReads = syncR2MutationReads(readOnlyRecords);

  /** Runs a mutation with capabilities scoped to this one public call.
   * @param request Closed mutation request with stable vault and operation identities.
   * @returns Verified mutation result, typed rejection, or durable pending/uncertain state.
   */
  async function mutate(
    request: SyncMutationRequest,
  ): Promise<SyncMutationResult> {
    const invocation = createSyncR2MutationInvocation(
      createInvocation(),
      clock,
    );
    return invocation.mutate(request);
  }

  /** Resumes an operation with capabilities scoped to this one public call.
   * @param input Vault and operation IDs used to locate the exact persisted journal.
   * @returns Progress or terminal result for that journal, without creating a replacement.
   */
  async function resumeOperation(
    input: SyncResumeOperationInput,
  ): Promise<SyncResumeOperationResult> {
    const invocation = createSyncR2MutationInvocation(
      createInvocation(),
      clock,
    );
    return invocation.resumeOperation(input);
  }

  return { ...exactReads, mutate, resumeOperation };
}

/** Builds the private state machine for one mutation/resume invocation.
 * @param capabilities Budgeted records and publication facades sharing one object store.
 * @param clock Server clock used only for persisted cooldown and event timing.
 * @returns State transitions that cannot issue storage calls outside this invocation's budget.
 */
function createSyncR2MutationInvocation(
  capabilities: SyncR2MutationInvocationCapabilities,
  clock: SyncServerClock,
): SyncR2MutationStore {
  const { records, publication } = capabilities;
  /** Exact reads used internally by this invocation's mutation policy. */
  const exactReads = syncR2MutationReads(records);
  const { readCurrent, readVersion, readRecovery } = exactReads;
  const terminalTransitions = syncR2MutationTerminal(
    publication,
    clock,
    readCurrent,
    persistJournal,
  );

  /** Starts an exact operation or joins the existing operation identity.
   * @param request Closed mutation request with stable vault and operation identities.
   * @returns Verified mutation result, typed rejection, or durable pending/uncertain state.
   */
  async function mutate(
    request: SyncMutationRequest,
  ): Promise<SyncMutationResult> {
    if (!isValidMutationRequest(request)) {
      return { kind: "error", code: "invalid_input" };
    }
    const inputFailure = await validateMutationInput(request, sha256Content);
    if (inputFailure !== undefined) return inputFailure;

    const existing = await publication.readJournal(
      request.vaultId,
      request.operationId,
    );
    if (existing.kind === "unavailable") {
      return effectUnknown(request.operationId);
    }
    if (existing.kind === "observed") {
      const decision = await evaluateMutation(
        request,
        { kind: "never_seen" },
        operationRecord(existing.observation.value),
      );
      if (decision.kind === "error") return decision;
      if (
        decision.kind === "reject" &&
        decision.code === "operation_id_reused"
      ) {
        return { kind: "error", code: "operation_id_reused" };
      }
      if (decision.kind === "reject" && decision.code === "invalid_input") {
        return { kind: "error", code: "invalid_input" };
      }
      return advance(existing.observation.value);
    }

    const observed = await readCurrent({
      vaultId: request.vaultId,
      path: request.path,
    });
    if (isStoreFailure(observed)) return observed;
    const decision = await evaluateMutation(request, observed, undefined);
    if (decision.kind === "error") return decision;
    if (decision.kind === "reject" && decision.code === "invalid_input") {
      return { kind: "error", code: "invalid_input" };
    }

    const lane = await syncFeedLaneForPath(request.path);
    const laneHead = await ensureInitialLaneHead(request, lane);
    if (isStoreFailure(laneHead)) return laneHead;

    const initial: SyncUnallocatedPendingJournalRecord = {
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
          : { byteSize: new TextEncoder().encode(request.content).byteLength },
      allocationState: "unallocated",
      lane,
      laneObservation: {
        key: syncFeedLaneHeadKey(request.vaultId, lane),
        precondition: observedPrecondition(laneHead),
        retryAfterEpochMs: null,
      },
    };
    const created = await publication.createJournal(initial);
    if (created.kind === "throttled") {
      return {
        kind: "error",
        code: "storage_throttled",
        retryAfterEpochMs: created.retryAfterEpochMs,
      };
    }
    const journal = await publication.readJournal(
      request.vaultId,
      request.operationId,
    );
    if (journal.kind === "observed") {
      const replay = await evaluateMutation(
        request,
        { kind: "never_seen" },
        operationRecord(journal.observation.value),
      );
      if (replay.kind === "reject" && replay.code === "operation_id_reused") {
        return { kind: "error", code: "operation_id_reused" };
      }
      if (replay.kind === "error") return replay;
      return advance(journal.observation.value);
    }
    if (journal.kind === "unavailable") {
      return effectUnknown(
        request.operationId,
        created.kind === "effect_unknown"
          ? created.retryAfterEpochMs
          : undefined,
      );
    }
    if (created.kind === "effect_unknown") {
      return effectUnknown(request.operationId, created.retryAfterEpochMs);
    }
    if (created.kind === "refused") {
      return {
        kind: "error",
        code: "mutation_not_admitted",
        operationId: request.operationId,
      };
    }
    return effectUnknown(request.operationId);
  }

  /** Resumes only the durable operation identified by the validated vault and operation IDs.
   * @param input Vault and operation IDs used to locate the exact persisted journal.
   * @returns Progress or terminal result for that journal, without creating a replacement.
   */
  async function resumeOperation(
    input: SyncResumeOperationInput,
  ): Promise<SyncResumeOperationResult> {
    const vault = syncVaultIdSchema.safeParse(input.vaultId);
    const operationId = syncOperationIdSchema.safeParse(input.operationId);
    if (!vault.success || !operationId.success) {
      return { kind: "error", code: "invalid_input" };
    }
    const journal = await publication.readJournal(vault.data, operationId.data);
    if (journal.kind !== "observed") {
      return effectUnknown(operationId.data);
    }
    if (journal.observation.value.vaultId !== vault.data) {
      return effectUnknown(operationId.data);
    }
    return advance(journal.observation.value);
  }

  /** Routes one durable journal generation to its next bounded recovery step.
   * @param journal Exact persisted operation state selected for one recovery attempt.
   * @returns The next bounded mutation result without skipping durable publication steps.
   */
  async function advance(
    journal: SyncJournalRecord,
  ): Promise<SyncMutationResult> {
    if (journal.status === "committed" || journal.status === "aborted") {
      return terminalTransitions.advanceTerminal(journal);
    }
    if (journal.allocationState === "unallocated") {
      return advanceUnallocated(journal);
    }
    switch (journal.stepEvidence.step) {
      case "immutable_create":
        return advanceImmutable(journal);
      case "write_head":
        return advanceHead(journal);
      case "create_event":
        return advanceEvent(journal);
      case "commit_journal":
        return terminalTransitions.commitJournal(journal);
      case "commit_lane":
        return effectUnknown(journal.operationId);
    }
  }

  /** Creates/read-backs the initial zero lane before an unallocated journal records its ETag.
   * @param request Mutation whose path selects this feed lane and vault namespace.
   * @param lane Protocol lane selected for the request path.
   * @returns Exact observed lane generation or a typed store failure.
   */
  async function ensureInitialLaneHead(
    request: SyncMutationRequest,
    lane: number,
  ): Promise<SyncRecordObservation<SyncLaneHeadRecord> | SyncStoreFailure> {
    let current = await publication.readLaneHead(request.vaultId, lane);
    if (current.kind === "unavailable") return storageUnavailable();
    if (current.kind === "absent") {
      const initial: SyncLaneHeadRecord = {
        schemaVersion: 1,
        protocolMajor: 1,
        vaultId: request.vaultId,
        kind: "laneHead",
        lane,
        committedSequence: syncSequenceSchema.parse(
          "0".repeat(SYNC_SEQUENCE_WIDTH),
        ),
        committedAtEpochMs: 0,
      };
      const created = await publication.createLaneHead(initial);
      if (created.kind === "throttled") {
        return {
          kind: "error",
          code: "storage_throttled",
          retryAfterEpochMs: created.retryAfterEpochMs,
        };
      }
      current = await publication.readLaneHead(request.vaultId, lane);
      if (current.kind !== "observed") {
        return created.kind === "effect_unknown"
          ? effectUnknown(request.operationId, created.retryAfterEpochMs)
          : storageUnavailable();
      }
    }
    return current.observation;
  }

  /** Recovers or wins the one lane reservation without rebasing an unproven ETag.
   * @param journal Unallocated operation with its durable prior lane observation.
   * @returns Pending progress, typed rejection, or uncertainty while preserving lane authority.
   */
  async function advanceUnallocated(
    journal: SyncUnallocatedPendingJournalRecord,
  ): Promise<SyncMutationResult> {
    let lane = await publication.readLaneHead(journal.vaultId, journal.lane);
    if (lane.kind === "unavailable") return effectUnknown(journal.operationId);
    if (lane.kind === "absent") {
      if (journal.laneObservation.precondition.kind !== "absent") {
        return effectUnknown(journal.operationId);
      }
      const initial: SyncLaneHeadRecord = {
        schemaVersion: 1,
        protocolMajor: 1,
        vaultId: journal.vaultId,
        kind: "laneHead",
        lane: journal.lane,
        committedSequence: syncSequenceSchema.parse(
          "0".repeat(SYNC_SEQUENCE_WIDTH),
        ),
        committedAtEpochMs: 0,
      };
      const created = await publication.createLaneHead(initial);
      lane = await publication.readLaneHead(journal.vaultId, journal.lane);
      if (lane.kind !== "observed") {
        return writeFailure(journal.operationId, created);
      }
      return persistLaneReobservation(journal, lane.observation);
    }

    const head = lane.observation.value;
    if (head.pending?.operationId === journal.operationId) {
      const allocation = await allocationFromOwnMarker(
        journal,
        lane.observation,
      );
      if (allocation === undefined) return effectUnknown(journal.operationId);
      const saved = await persistJournal(journal, allocation);
      return saved.kind === "confirmed"
        ? operationPending(journal.operationId)
        : writeFailure(journal.operationId, saved);
    }
    if (head.pending !== undefined)
      return operationPending(journal.operationId);

    if (
      !matchesLanePrecondition(
        journal.laneObservation.precondition,
        lane.observation,
      )
    ) {
      if (
        journal.laneObservation.precondition.kind === "absent" &&
        (head.committedSequence !== "0".repeat(SYNC_SEQUENCE_WIDTH) ||
          head.committedAtEpochMs !== 0)
      ) {
        return effectUnknown(journal.operationId);
      }
      return persistLaneReobservation(journal, lane.observation);
    }

    const sequence = nextEventSequence(head.committedSequence);
    if (sequence === undefined) {
      return { kind: "error", code: "sequence_exhausted" };
    }
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      return { kind: "error", code: "invalid_input" };
    }
    const priorFloor = journal.laneObservation.retryAfterEpochMs;
    if (priorFloor !== null && now < priorFloor) {
      return operationPending(journal.operationId, priorFloor);
    }
    const safeFloor = Math.max(
      now + SYNC_R2_WRITE_COOLDOWN_MS,
      lane.observation.observed.uploaded.getTime() + SYNC_R2_WRITE_COOLDOWN_MS,
      priorFloor ?? 0,
    );
    const prepared: SyncUnallocatedPendingJournalRecord = {
      ...journal,
      laneObservation: {
        ...journal.laneObservation,
        retryAfterEpochMs: safeFloor,
      },
    };
    const persisted = await persistJournal(journal, prepared);
    if (persisted.kind !== "confirmed") {
      return writeFailure(journal.operationId, persisted);
    }

    const reservation: SyncLaneHeadRecord = {
      ...head,
      pending: { operationId: journal.operationId, nextSequence: sequence },
    };
    const result = await publication.replaceLaneHead(
      lane.observation,
      reservation,
      priorFloor === null ? undefined : { retryAfterEpochMs: priorFloor },
    );
    if (result.kind === "confirmed") {
      return operationPending(journal.operationId, safeFloor);
    }
    const after = await publication.readLaneHead(journal.vaultId, journal.lane);
    if (
      mergeKnownPendingRetryFloors(undefined, writeRetryAfter(result)).kind ===
      "unsafe"
    ) {
      return effectUnknown(journal.operationId);
    }
    if (after.kind === "unavailable") {
      return effectUnknown(journal.operationId, writeRetryAfter(result));
    }
    if (
      after.kind === "observed" &&
      after.observation.value.pending?.operationId === journal.operationId
    ) {
      return operationPending(journal.operationId, safeFloor);
    }
    if (
      after.kind === "observed" &&
      after.observation.value.pending === undefined &&
      !matchesLanePrecondition(
        journal.laneObservation.precondition,
        after.observation,
      )
    ) {
      const latest = await publication.readJournal(
        journal.vaultId,
        journal.operationId,
      );
      if (
        latest.kind !== "observed" ||
        latest.observation.value.allocationState !== "unallocated"
      ) {
        return effectUnknown(journal.operationId);
      }
      return persistLaneReobservation(
        latest.observation.value,
        after.observation,
      );
    }
    if (
      after.kind === "observed" &&
      after.observation.value.pending !== undefined
    ) {
      return operationPending(journal.operationId, writeRetryAfter(result));
    }
    if (after.kind === "observed") {
      const floor = writeRetryAfter(result) ?? safeFloor;
      const current = await publication.readJournal(
        journal.vaultId,
        journal.operationId,
      );
      if (
        current.kind === "observed" &&
        current.observation.value.allocationState === "unallocated"
      ) {
        const next = {
          ...current.observation.value,
          laneObservation: {
            ...current.observation.value.laneObservation,
            retryAfterEpochMs: Math.max(
              current.observation.value.laneObservation.retryAfterEpochMs ?? 0,
              floor,
            ),
          },
        } satisfies SyncUnallocatedPendingJournalRecord;
        await persistJournal(current.observation.value, next);
      }
      return operationPending(journal.operationId, floor);
    }
    return effectUnknown(journal.operationId, writeRetryAfter(result));
  }

  /** Persists an exact unreserved lane generation before a fresh reservation attempt.
   * @param journal Current unallocated journal generation guarding the update.
   * @param lane Fresh observed lane head proven unreserved for a later attempt.
   * @returns Pending progress or conservative journal-write certainty.
   */
  async function persistLaneReobservation(
    journal: SyncUnallocatedPendingJournalRecord,
    lane: SyncRecordObservation<SyncLaneHeadRecord>,
  ): Promise<SyncMutationResult> {
    const next: SyncUnallocatedPendingJournalRecord = {
      ...journal,
      laneObservation: {
        key: syncFeedLaneHeadKey(journal.vaultId, journal.lane),
        precondition: observedPrecondition(lane),
        retryAfterEpochMs: null,
      },
    };
    const result = await persistJournal(journal, next);
    return result.kind === "confirmed"
      ? operationPending(journal.operationId)
      : writeFailure(journal.operationId, result);
  }

  /** Builds a winner-only allocated journal after exact own-marker and predecessor proof.
   * @param journal Unallocated request retaining the exact pre-reservation lane evidence.
   * @param lane Current lane observation containing the candidate operation marker.
   * @returns Allocated authority only when the marker and derived predecessor match exactly.
   */
  async function allocationFromOwnMarker(
    journal: SyncUnallocatedPendingJournalRecord,
    lane: SyncRecordObservation<SyncLaneHeadRecord>,
  ): Promise<
    Extract<SyncJournalRecord, { allocationState: "allocated" }> | undefined
  > {
    const prior = await priorLaneHead(journal);
    if (prior === undefined) return undefined;
    const sequence = nextEventSequence(prior.committedSequence);
    if (
      sequence === undefined ||
      lane.value.pending?.operationId !== journal.operationId ||
      lane.value.pending.nextSequence !== sequence ||
      lane.value.committedSequence !== prior.committedSequence ||
      lane.value.committedAtEpochMs !== prior.committedAtEpochMs
    ) {
      return undefined;
    }
    return {
      ...withoutUnallocatedFields(journal),
      allocationState: "allocated",
      reservation: {
        lane: journal.lane,
        sequence,
        previousCommittedAtEpochMs: prior.committedAtEpochMs,
      },
      stepEvidence: {
        step: "immutable_create",
        key: firstImmutableKey(journal.request),
        precondition: { kind: "absent" },
        retryAfterEpochMs: null,
        attempt: { state: "ready", generation: 0 },
      },
    };
  }

  /** Validates the current exact parent before any immutable publication write.
   * @param journal Allocated pending operation at its immutable-create step.
   * @returns Progress or failure after exact parent policy and immutable-write evidence.
   */
  async function advanceImmutable(
    journal: Extract<
      SyncJournalRecord,
      { status: "pending"; allocationState: "allocated" }
    >,
  ): Promise<SyncMutationResult> {
    const current = await readCurrent({
      vaultId: journal.vaultId,
      path: journal.request.path,
    });
    if (isStoreFailure(current)) return effectUnknown(journal.operationId);
    const initialHead = await records.readHead(
      journal.vaultId,
      journal.request.path,
    );
    if (initialHead.kind === "unavailable") {
      return effectUnknown(journal.operationId);
    }
    if (
      (current.kind === "never_seen" && initialHead.kind !== "absent") ||
      (current.kind !== "never_seen" &&
        (initialHead.kind !== "observed" ||
          !sameCurrentAndHead(current, initialHead.observation.value)))
    ) {
      return effectUnknown(journal.operationId);
    }
    const decision = await evaluateMutation(
      journal.request,
      current,
      undefined,
    );
    if (decision.kind === "error") return effectUnknown(journal.operationId);
    if (decision.kind === "reject") {
      if (decision.code !== "stale_revision") {
        return mutationRejection(decision.code, journal.operationId);
      }
      const evidence = journal.stepEvidence;
      if (evidence.step !== "immutable_create") {
        return effectUnknown(journal.operationId);
      }
      if (
        evidence.attempt.state === "ready" &&
        evidence.attempt.generation === 0
      ) {
        return moveToEvent(journal, "aborted");
      }
    }

    const target = await immutableTarget(journal);
    if (target.kind === "error") return target.failure;
    const targetEvidence = await readImmutableTarget(target.target, journal);
    const attempt = await preparePendingTargetAttempt(
      journal,
      targetEvidence,
      () => readImmutableTarget(target.target, journal),
    );
    if (attempt.kind === "deferred") return attempt.result;
    if (attempt.kind === "target_present") {
      return completeImmutableStep(attempt.journal, initialHead);
    }

    const result = await writeImmutable(target.target);
    const after = await readImmutableTarget(target.target, attempt.journal);
    if (after.kind === "exact") {
      return completeImmutableStep(attempt.journal, initialHead);
    }
    if (after.kind === "prior") {
      return persistPendingRetryWait(attempt.journal, result);
    }
    return effectUnknown(
      journal.operationId,
      result.kind === "throttled" || result.kind === "effect_unknown"
        ? result.retryAfterEpochMs
        : undefined,
    );
  }

  /** Persists completion of one exact immutable target before naming the next key.
   * @param journal Allocated operation whose immutable target is known to exist exactly.
   * @param initialHead Exact linked path state observed before the immutable target write.
   * @returns Pending progress or the next bounded head-preparation result.
   */
  async function completeImmutableStep(
    journal: Extract<
      SyncJournalRecord,
      { status: "pending"; allocationState: "allocated" }
    >,
    initialHead: SyncRecordRead<SyncHeadRecord>,
  ): Promise<SyncMutationResult> {
    const nextKey = nextImmutableKey(journal);
    if (nextKey === undefined) return prepareHead(journal, initialHead);
    const next = withStep(journal, {
      ...journal.stepEvidence,
      step: "immutable_create",
      key: nextKey,
      precondition: { kind: "absent" },
      retryAfterEpochMs: null,
      attempt: { state: "ready", generation: 0 },
    });
    const persisted = await persistJournal(journal, next);
    return persisted.kind === "confirmed"
      ? operationPending(journal.operationId)
      : writeFailure(journal.operationId, persisted);
  }

  /** Reads the exact request parent and records its original absence or ETag before head CAS.
   * @param journal Allocated operation whose request parent must be revalidated.
   * @param initialHead Exact linked parent observation from before the final immutable write.
   * @returns Pending progress, typed policy rejection, or conservative storage certainty.
   */
  async function prepareHead(
    journal: Extract<
      SyncJournalRecord,
      { status: "pending"; allocationState: "allocated" }
    >,
    initialHead: SyncRecordRead<SyncHeadRecord>,
  ): Promise<SyncMutationResult> {
    const current = await records.readHead(
      journal.vaultId,
      journal.request.path,
    );
    if (current.kind === "unavailable")
      return effectUnknown(journal.operationId);
    const state =
      current.kind === "absent"
        ? { kind: "never_seen" as const }
        : syncR2CurrentStateFromHead(current.observation.value);
    const decision = await evaluateMutation(journal.request, state, undefined);
    if (decision.kind === "error") return effectUnknown(journal.operationId);
    let precondition: SyncPublicationStepEvidence["precondition"];
    if (decision.kind === "reject") {
      if (decision.code !== "stale_revision") {
        return mutationRejection(decision.code, journal.operationId);
      }
      if (current.kind !== "observed" || initialHead.kind === "unavailable") {
        return effectUnknown(journal.operationId);
      }
      const initialHeadMatchesParent =
        journal.request.kind === "create"
          ? initialHead.kind === "absent"
          : initialHead.kind === "observed" &&
            initialHead.observation.value.revision ===
              journal.request.parent.revision;
      if (!initialHeadMatchesParent) {
        return effectUnknown(journal.operationId);
      }
      precondition =
        initialHead.kind === "absent"
          ? { kind: "absent" }
          : observedPrecondition(initialHead.observation);
    } else {
      precondition =
        current.kind === "absent"
          ? { kind: "absent" }
          : observedPrecondition(current.observation);
    }
    const evidence: SyncPublicationStepEvidence = {
      step: "write_head",
      key: syncHeadKey(journal.vaultId, journal.request.path),
      precondition,
      retryAfterEpochMs: null,
      attempt: { state: "ready", generation: 0 },
    };
    const persisted = await persistJournal(
      journal,
      withStep(journal, evidence),
    );
    return persisted.kind === "confirmed"
      ? operationPending(journal.operationId)
      : writeFailure(journal.operationId, persisted);
  }

  /** Claims, writes, or reconciles the exact current-head target retained by the journal.
   * @param journal Allocated operation carrying the original head key and CAS condition.
   * @returns Pending progress, a verified stale-parent abort, or conservative effect uncertainty.
   */
  async function advanceHead(
    journal: Extract<
      SyncJournalRecord,
      { status: "pending"; allocationState: "allocated" }
    >,
  ): Promise<SyncMutationResult> {
    if (journal.stepEvidence.step !== "write_head") {
      return effectUnknown(journal.operationId);
    }
    const current = await records.readHead(
      journal.vaultId,
      journal.request.path,
    );
    if (current.kind === "unavailable") {
      return effectUnknown(journal.operationId);
    }
    const target = await mutationHeadForRequest(journal);
    if (target === undefined) return effectUnknown(journal.operationId);
    const targetObservation = await classifyHeadTarget(
      journal,
      target,
      current,
    );
    if (targetObservation.kind === "unavailable") {
      return effectUnknown(journal.operationId);
    }
    if (targetObservation.kind === "divergent") {
      if (
        journal.stepEvidence.attempt.state === "attempting" &&
        journal.stepEvidence.attempt.generation === 1
      ) {
        return recoverHeadRefusalReceipt(journal, target);
      }
      return journal.stepEvidence.attempt.state === "ready" &&
        current.kind === "observed"
        ? publishHeadCasAbortEvent(journal, current.observation)
        : effectUnknown(journal.operationId);
    }
    if (targetObservation.kind === "prior") {
      const currentState =
        current.kind === "absent"
          ? { kind: "never_seen" as const }
          : syncR2CurrentStateFromHead(current.observation.value);
      const decision = await evaluateMutation(
        journal.request,
        currentState,
        undefined,
      );
      if (decision.kind === "error") return effectUnknown(journal.operationId);
      if (decision.kind === "reject") {
        if (decision.code !== "stale_revision") {
          return mutationRejection(decision.code, journal.operationId);
        }
        if (
          journal.stepEvidence.attempt.state === "ready" &&
          journal.stepEvidence.attempt.generation === 0 &&
          current.kind === "observed"
        ) {
          return publishHeadCasAbortEvent(journal, current.observation);
        }
        return effectUnknown(journal.operationId);
      }
    }

    const attempt = await preparePendingTargetAttempt(
      journal,
      targetObservation,
      () => readHeadTarget(journal, target),
    );
    if (attempt.kind === "deferred") return attempt.result;
    if (attempt.kind === "target_present") {
      return moveToEvent(attempt.journal, "changed");
    }
    if (targetObservation.kind !== "prior") {
      return effectUnknown(journal.operationId);
    }

    const retryContext =
      attempt.journal.stepEvidence.retryAfterEpochMs === null
        ? undefined
        : {
            retryAfterEpochMs: attempt.journal.stepEvidence.retryAfterEpochMs,
          };
    const result =
      current.kind === "absent"
        ? await records.createHead(target, retryContext)
        : await records.replaceHead(current.observation, target, retryContext);
    const after = await records.readHead(journal.vaultId, journal.request.path);
    if (after.kind === "unavailable") {
      return effectUnknown(journal.operationId);
    }
    const afterTarget = await classifyHeadTarget(
      attempt.journal,
      target,
      after,
    );
    if (afterTarget.kind === "exact") {
      return moveToEvent(attempt.journal, "changed");
    }
    if (afterTarget.kind === "prior" && result.kind !== "confirmed") {
      return persistPendingRetryWait(attempt.journal, result);
    }
    if (
      afterTarget.kind === "divergent" &&
      after.kind === "observed" &&
      "noEffectProvenance" in result
    ) {
      return createHeadRefusalReceipt(
        attempt.journal,
        target,
        after.observation,
        result,
      );
    }
    return effectUnknown(journal.operationId);
  }

  /** Persists definite first-claim no-effect evidence without publishing an event in that invocation.
   * @param journal Owner-confirmed generation-one write-head claim and original condition.
   * @param target Exact intended head bytes covered by the private receipt.
   * @param competingHead Exact stale linked current head read after the no-effect outcome.
   * @param noEffect Direct preflight or conditional-null provenance from this head attempt.
   * @returns Pending receipt recovery, or uncertainty when its exact evidence cannot be retained.
   */
  async function createHeadRefusalReceipt(
    journal: Extract<
      SyncJournalRecord,
      { status: "pending"; allocationState: "allocated" }
    >,
    target: SyncHeadRecord,
    competingHead: SyncRecordObservation<SyncHeadRecord>,
    noEffect: SyncR2NoEffectOutcome,
  ): Promise<SyncMutationResult> {
    const evidence = journal.stepEvidence;
    if (evidence.step !== "write_head") {
      return effectUnknown(journal.operationId);
    }
    const attempt = evidence.attempt;
    if (
      attempt.state !== "attempting" ||
      attempt.generation !== 1 ||
      !(await isVerifiedHeadCasAbort(journal, competingHead))
    ) {
      return effectUnknown(journal.operationId);
    }
    let targetBytes: Uint8Array;
    try {
      targetBytes = await encodeSyncRecord({ kind: "head", record: target });
    } catch {
      return effectUnknown(journal.operationId);
    }
    let targetDigest: SyncMutationRequest["contentSha256"];
    try {
      const targetText = new TextDecoder("utf-8", { fatal: true }).decode(
        targetBytes,
      );
      targetDigest = await sha256Content(targetText);
    } catch {
      return effectUnknown(journal.operationId);
    }
    const receipt: SyncHeadRefusalReceiptRecord = {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId: journal.vaultId,
      operationId: journal.operationId,
      claimId: attempt.claimId,
      generation: 1,
      headKey: evidence.key,
      headTargetSha256: targetDigest,
      headPrecondition: evidence.precondition,
      lane: journal.reservation.lane,
      sequence: journal.reservation.sequence,
      refusalSource: noEffect.noEffectProvenance,
      competingHead: {
        etag: competingHead.observed.etag,
        bytes: encodeBase64Url(competingHead.observed.bytes),
        uploadedAtEpochMs: competingHead.observed.uploaded.getTime(),
      },
    };
    const saved = await publication.createHeadRefusalReceipt(
      receipt,
      target,
      noEffect,
    );
    if (saved.kind !== "confirmed") {
      return effectUnknown(journal.operationId, writeRetryAfter(saved));
    }
    const current = await readJournalAttempt(journal);
    if (current.kind !== "current") {
      return effectUnknown(journal.operationId, writeRetryAfter(saved));
    }
    const journalCooldown =
      current.observation.observed.uploaded.getTime() +
      SYNC_R2_WRITE_COOLDOWN_MS;
    return Number.isSafeInteger(journalCooldown)
      ? operationPending(journal.operationId, journalCooldown)
      : effectUnknown(journal.operationId);
  }

  /** Recovers a refusal only from the currently persisted generation-one claim and exact receipt.
   * @param journal Fresh invocation's attempting head-write phase.
   * @param target Canonical intended head tied to the operation request.
   * @returns Pending after one exact journal CAS, never an event write in this invocation.
   */
  async function recoverHeadRefusalReceipt(
    journal: Extract<
      SyncJournalRecord,
      { status: "pending"; allocationState: "allocated" }
    >,
    target: SyncHeadRecord,
  ): Promise<SyncMutationResult> {
    if (journal.stepEvidence.step !== "write_head") {
      return effectUnknown(journal.operationId);
    }
    const attempt = journal.stepEvidence.attempt;
    if (attempt.state !== "attempting" || attempt.generation !== 1) {
      return effectUnknown(journal.operationId);
    }
    const receiptRead = await publication.readHeadRefusalReceipt(
      journal.vaultId,
      journal.operationId,
    );
    if (receiptRead.kind !== "observed") {
      return effectUnknown(journal.operationId);
    }
    const receipt = receiptRead.observation.value;
    if (!matchesHeadRefusalReceipt(receipt, journal)) {
      return effectUnknown(journal.operationId);
    }

    const currentJournal = await publication.readJournal(
      journal.vaultId,
      journal.operationId,
    );
    if (currentJournal.kind !== "observed") {
      return effectUnknown(journal.operationId);
    }
    const journalBytes = await encodeSyncPublication(journal);
    if (!equalBytes(currentJournal.observation.observed.bytes, journalBytes)) {
      return effectUnknown(journal.operationId);
    }
    const currentHead = await records.readHead(
      journal.vaultId,
      journal.request.path,
    );
    if (
      currentHead.kind !== "observed" ||
      !matchesReceiptCompetitor(receipt, currentHead.observation) ||
      !(await isVerifiedHeadCasAbort(journal, currentHead.observation))
    ) {
      return effectUnknown(journal.operationId);
    }

    const now = clock();
    const journalCooldown =
      currentJournal.observation.observed.uploaded.getTime() +
      SYNC_R2_WRITE_COOLDOWN_MS;
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(journalCooldown)) {
      return effectUnknown(journal.operationId);
    }
    if (now < journalCooldown) {
      return operationPending(journal.operationId, journalCooldown);
    }
    const next = withStep(journal, {
      step: "create_event",
      key: syncFeedEventKey(
        journal.vaultId,
        journal.reservation.lane,
        journal.reservation.sequence,
      ),
      committedAtEpochMs: commitTime(journal, now),
      outcomeIntent: "aborted",
      precondition: { kind: "absent" },
      retryAfterEpochMs: null,
      attempt: { state: "ready", generation: 0 },
    });
    const saved = await publication.replaceJournalFromHeadRefusalReceipt(
      currentJournal.observation,
      receipt,
      target,
      next,
    );
    if (saved.kind === "confirmed") {
      return operationPending(journal.operationId);
    }

    const readback = await publication.readJournal(
      journal.vaultId,
      journal.operationId,
    );
    if (readback.kind === "observed") {
      const nextBytes = await encodeSyncPublication(next);
      if (equalBytes(readback.observation.observed.bytes, nextBytes)) {
        return operationPending(journal.operationId);
      }
    }
    return effectUnknown(journal.operationId, writeRetryAfter(saved));
  }

  /** Checks that a persisted receipt binds the exact current generation-one head tuple.
   * @param receipt Strict private receipt recovered by its operation-bound key.
   * @param journal Current typed operation record supplied by resume routing.
   * @returns Whether claim, request, original head condition, and reservation all agree.
   */
  function matchesHeadRefusalReceipt(
    receipt: SyncHeadRefusalReceiptRecord,
    journal: Extract<
      SyncJournalRecord,
      { status: "pending"; allocationState: "allocated" }
    >,
  ): boolean {
    const evidence = journal.stepEvidence;
    if (evidence.step !== "write_head") return false;
    const attempt = evidence.attempt;
    if (attempt.state !== "attempting" || attempt.generation !== 1) {
      return false;
    }
    return (
      receipt.vaultId === journal.vaultId &&
      receipt.operationId === journal.operationId &&
      receipt.claimId === attempt.claimId &&
      receipt.generation === attempt.generation &&
      receipt.headKey === evidence.key &&
      receipt.lane === journal.reservation.lane &&
      receipt.sequence === journal.reservation.sequence &&
      sameHeadRefusalPrecondition(
        receipt.headPrecondition,
        evidence.precondition,
      )
    );
  }

  /** Compares the receipt's raw competitor generation with a fresh exact head read.
   * @param receipt Persisted no-effect witness carrying one stale competitor observation.
   * @param current Fresh exact head record and R2 generation evidence.
   * @returns Whether bytes, ETag, and server upload time remain identical.
   */
  function matchesReceiptCompetitor(
    receipt: SyncHeadRefusalReceiptRecord,
    current: SyncRecordObservation<SyncHeadRecord>,
  ): boolean {
    return (
      receipt.competingHead.etag === current.observed.etag &&
      receipt.competingHead.uploadedAtEpochMs ===
        current.observed.uploaded.getTime() &&
      receipt.competingHead.bytes === encodeBase64Url(current.observed.bytes)
    );
  }

  /** Compares a refusal receipt's original absent/observed predicate with the journal tuple.
   * @param receiptPrecondition Canonical condition persisted in the private receipt.
   * @param journalPrecondition Original target condition persisted in the exact journal step.
   * @returns Whether both authority predicates are byte-for-byte identical.
   */
  function sameHeadRefusalPrecondition(
    receiptPrecondition: SyncHeadRefusalPrecondition,
    journalPrecondition: SyncPublicationStepEvidence["precondition"],
  ): boolean {
    if (receiptPrecondition.kind !== journalPrecondition.kind) return false;
    if (receiptPrecondition.kind === "absent") return true;
    return (
      journalPrecondition.kind === "observed" &&
      receiptPrecondition.etag === journalPrecondition.etag &&
      receiptPrecondition.bytes === journalPrecondition.bytes &&
      receiptPrecondition.uploadedAtEpochMs ===
        journalPrecondition.uploadedAtEpochMs
    );
  }

  /** Persists an event step after a stale-head CAS refusal is fully revalidated.
   * @param journal Exact pending request and current-head condition from the durable journal.
   * @param competingHead Read-back head that defeated the operation's original CAS predicate.
   * @returns Pending progress or uncertainty without writing an unclaimed event.
   */
  async function publishHeadCasAbortEvent(
    journal: Extract<
      SyncJournalRecord,
      { status: "pending"; allocationState: "allocated" }
    >,
    competingHead: SyncRecordObservation<SyncHeadRecord>,
  ): Promise<SyncMutationResult> {
    if (
      journal.stepEvidence.step !== "write_head" ||
      journal.stepEvidence.attempt.state !== "ready" ||
      journal.stepEvidence.attempt.generation !== 0 ||
      !(await isVerifiedHeadCasAbort(journal, competingHead))
    ) {
      return effectUnknown(journal.operationId);
    }
    const existing = await publication.readEvent(
      journal.vaultId,
      journal.reservation.lane,
      journal.reservation.sequence,
    );
    if (existing.kind === "unavailable") {
      return effectUnknown(journal.operationId);
    }
    if (
      existing.kind === "observed" &&
      !matchesHeadCasAbortEvent(journal, existing.observation.value)
    ) {
      return effectUnknown(journal.operationId);
    }
    return moveToEvent(
      journal,
      "aborted",
      existing.kind === "observed"
        ? existing.observation.value.committedAtEpochMs
        : undefined,
      competingHead,
    );
  }

  /** Rechecks the exact journal, lane reservation, and stale competitor before trusting an abort.
   * @param journal Pending allocated request whose original parent CAS was refused.
   * @param competingHead Current-head bytes and generation read after that refusal.
   * @returns Whether the current linked head is non-own and the exact request remains stale.
   */
  async function isVerifiedHeadCasAbort(
    journal: Extract<
      SyncJournalRecord,
      { status: "pending"; allocationState: "allocated" }
    >,
    competingHead: SyncRecordObservation<SyncHeadRecord>,
  ): Promise<boolean> {
    try {
      if (journal.stepEvidence.step !== "write_head") return false;
      const [storedJournal, lane, current] = await Promise.all([
        publication.readJournal(journal.vaultId, journal.operationId),
        publication.readLaneHead(journal.vaultId, journal.reservation.lane),
        readCurrent({ vaultId: journal.vaultId, path: journal.request.path }),
      ]);
      const expectedJournalBytes = await encodeSyncPublication(journal);
      if (
        storedJournal.kind !== "observed" ||
        !equalBytes(
          storedJournal.observation.observed.bytes,
          expectedJournalBytes,
        ) ||
        lane.kind !== "observed" ||
        lane.observation.value.pending?.operationId !== journal.operationId ||
        lane.observation.value.pending.nextSequence !==
          journal.reservation.sequence ||
        lane.observation.value.committedSequence !==
          previousSequence(journal.reservation.sequence) ||
        lane.observation.value.committedAtEpochMs !==
          journal.reservation.previousCommittedAtEpochMs ||
        isStoreFailure(current) ||
        current.kind === "never_seen" ||
        !sameCurrentAndHead(current, competingHead.value) ||
        current.operationId === journal.operationId ||
        current.revision === journal.request.revision
      ) {
        return false;
      }
      const decision = await evaluateMutation(
        journal.request,
        current,
        undefined,
      );
      return decision.kind === "reject" && decision.code === "stale_revision";
    } catch {
      return false;
    }
  }

  /** Matches the exact operation-owned stale-abort witness for its reserved lane position.
   * @param journal Pending request retaining the won lane and exact current-head condition.
   * @param event Strictly decoded feed record currently stored at the reserved sequence.
   * @returns Whether this is the operation's stale-revision abort with a monotonic event time.
   */
  function matchesHeadCasAbortEvent(
    journal: Extract<
      SyncJournalRecord,
      { status: "pending"; allocationState: "allocated" }
    >,
    event: SyncFeedEventRecord,
  ): boolean {
    return (
      event.kind === "aborted" &&
      event.vaultId === journal.vaultId &&
      event.lane === journal.reservation.lane &&
      event.sequence === journal.reservation.sequence &&
      event.operationId === journal.operationId &&
      event.reason === "stale_revision" &&
      event.committedAtEpochMs > journal.reservation.previousCommittedAtEpochMs
    );
  }

  /** Revalidates the persisted outcome against current evidence before accepting or creating its event.
   * @param journal Allocated operation with its exact reserved feed position and immutable intent.
   * @returns Journal-commit progress or conservative event-write certainty.
   */
  async function advanceEvent(
    journal: Extract<
      SyncJournalRecord,
      { status: "pending"; allocationState: "allocated" }
    >,
  ): Promise<SyncMutationResult> {
    if (journal.stepEvidence.step !== "create_event") {
      return effectUnknown(journal.operationId);
    }
    const eventRecord = await eventForJournal(journal);
    if (eventRecord.kind === "error") return eventRecord.failure;
    const expectedBytes = await encodeSyncPublication(eventRecord.event);
    const existing = await publication.readEvent(
      journal.vaultId,
      journal.reservation.lane,
      journal.reservation.sequence,
    );
    if (existing.kind === "unavailable") {
      return effectUnknown(journal.operationId);
    }
    if (existing.kind === "observed") {
      if (
        !equalBytes(existing.observation.observed.bytes, expectedBytes) ||
        (journal.stepEvidence.attempt.state === "ready" &&
          eventRecord.event.kind !== "aborted")
      ) {
        return effectUnknown(journal.operationId);
      }
      return moveToJournalCommit(journal);
    }

    const targetEvidence = await readEventTarget(journal, eventRecord.event);
    const attempt = await preparePendingTargetAttempt(
      journal,
      targetEvidence,
      () => readEventTarget(journal, eventRecord.event),
    );
    if (attempt.kind === "deferred") return attempt.result;
    if (attempt.kind === "target_present") {
      return moveToJournalCommit(attempt.journal);
    }

    const result = await publication.createEvent(eventRecord.event);
    const after = await readEventTarget(attempt.journal, eventRecord.event);
    if (after.kind === "exact") {
      return moveToJournalCommit(attempt.journal);
    }
    if (after.kind === "prior") {
      return persistPendingRetryWait(attempt.journal, result);
    }
    return effectUnknown(
      journal.operationId,
      result.kind === "throttled" || result.kind === "effect_unknown"
        ? result.retryAfterEpochMs
        : undefined,
    );
  }

  /** Persists one proven event intent and fixed timestamp before any event claim.
   * @param journal Allocated operation with its exact reserved feed position.
   * @param outcomeIntent Changed only after exact own-head evidence; aborted only after stale-parent proof.
   * @param witnessedCommitTime Exact timestamp from a validated pre-existing aborted witness, when present.
   * @param readyHeadCasWitness Exact current head that separately authorizes the unclaimed stale-abort edge.
   * @returns Pending event-publication progress or conservative journal-write certainty.
   */
  async function moveToEvent(
    journal: Extract<
      SyncJournalRecord,
      { status: "pending"; allocationState: "allocated" }
    >,
    outcomeIntent: SyncEventOutcomeIntent,
    witnessedCommitTime?: number,
    readyHeadCasWitness?: SyncRecordObservation<SyncHeadRecord>,
  ): Promise<SyncMutationResult> {
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      return { kind: "error", code: "invalid_input" };
    }
    const committedAtEpochMs = witnessedCommitTime ?? commitTime(journal, now);
    if (
      !Number.isSafeInteger(committedAtEpochMs) ||
      committedAtEpochMs <= journal.reservation.previousCommittedAtEpochMs
    ) {
      return effectUnknown(journal.operationId);
    }
    const next = withStep(journal, {
      step: "create_event",
      key: syncFeedEventKey(
        journal.vaultId,
        journal.reservation.lane,
        journal.reservation.sequence,
      ),
      committedAtEpochMs,
      outcomeIntent,
      precondition: { kind: "absent" },
      retryAfterEpochMs: null,
      attempt: { state: "ready", generation: 0 },
    });
    const result = await persistJournal(journal, next, readyHeadCasWitness);
    return result.kind === "confirmed"
      ? operationPending(journal.operationId)
      : writeFailure(journal.operationId, result);
  }

  /** Records that a verified feed event is the sole evidence for journal terminalization.
   * @param journal Allocated operation whose immutable feed event has been verified.
   * @returns Pending terminalization progress or conservative journal-write certainty.
   */
  async function moveToJournalCommit(
    journal: Extract<
      SyncJournalRecord,
      { status: "pending"; allocationState: "allocated" }
    >,
  ): Promise<SyncMutationResult> {
    const next = withStep(journal, {
      step: "commit_journal",
      key: syncOperationKey(journal.vaultId, journal.operationId),
      precondition: { kind: "journal_phase", status: "pending" },
      retryAfterEpochMs: null,
    });
    const result = await persistJournal(journal, next);
    return result.kind === "confirmed"
      ? operationPending(journal.operationId)
      : writeFailure(journal.operationId, result);
  }

  /** Builds the exact head target, resolving tombstone attributes from retained source evidence.
   * @param journal Allocated operation whose request determines the target revision.
   * @returns Exact live or tombstone head, or undefined when source evidence is incomplete.
   */
  async function mutationHeadForRequest(
    journal: Extract<
      SyncJournalRecord,
      { status: "pending"; allocationState: "allocated" }
    >,
  ): Promise<SyncHeadRecord | undefined> {
    if (journal.request.kind !== "tombstone") {
      return versionForRequest(journal);
    }
    const source = await syncR2ReadTombstoneSource(
      records,
      journal.vaultId,
      journal.request.path,
      journal.request.parent.revision,
      journal.request.contentSha256,
    );
    if (source === undefined) return undefined;
    return tombstoneVersionForRequest(journal, source.version);
  }

  /** Selects the exact next content, recovery, or immutable version object.
   * @param journal Allocated operation at one persisted immutable-create step.
   * @returns Exact object target or a conservative failure when evidence is incomplete.
   */
  async function immutableTarget(
    journal: Extract<
      SyncJournalRecord,
      { status: "pending"; allocationState: "allocated" }
    >,
  ): Promise<
    | { readonly kind: "target"; readonly target: SyncImmutableTarget }
    | { readonly kind: "error"; readonly failure: SyncMutationResult }
  > {
    const request = journal.request;
    if (request.kind !== "tombstone") {
      const bytes = new TextEncoder().encode(request.content);
      if (
        journal.stepEvidence.key ===
        syncContentKey(journal.vaultId, request.revision)
      ) {
        return {
          kind: "target",
          target: {
            kind: "content",
            record: {
              kind: "contentBody",
              vaultId: journal.vaultId,
              revision: request.revision,
              bytes,
              byteSize: bytes.byteLength,
              contentSha256: request.contentSha256,
            },
          },
        };
      }
      if (
        journal.stepEvidence.key ===
        syncVersionKey(journal.vaultId, request.revision)
      ) {
        return {
          kind: "target",
          target: { kind: "version", record: versionForRequest(journal) },
        };
      }
      return { kind: "error", failure: effectUnknown(journal.operationId) };
    }

    const source = await syncR2ReadTombstoneSource(
      records,
      journal.vaultId,
      request.path,
      request.parent.revision,
      request.contentSha256,
    );
    if (source === undefined) {
      return { kind: "error", failure: effectUnknown(journal.operationId) };
    }
    if (
      journal.stepEvidence.key ===
      syncRecoveryKey(journal.vaultId, request.operationId, "content")
    ) {
      return {
        kind: "target",
        target: {
          kind: "recoveryBody",
          record: {
            kind: "recoveryBody",
            vaultId: journal.vaultId,
            operationId: request.operationId,
            bytes: source.body.bytes,
            byteSize: source.body.byteSize,
            contentSha256: source.body.contentSha256,
          },
        },
      };
    }
    if (
      journal.stepEvidence.key ===
      syncRecoveryKey(journal.vaultId, request.operationId, "metadata")
    ) {
      return {
        kind: "target",
        target: {
          kind: "recovery",
          record: recoveryForRequest(journal, source.version),
        },
      };
    }
    if (
      journal.stepEvidence.key ===
      syncVersionKey(journal.vaultId, request.revision)
    ) {
      return {
        kind: "target",
        target: {
          kind: "version",
          record: tombstoneVersionForRequest(journal, source.version),
        },
      };
    }
    return { kind: "error", failure: effectUnknown(journal.operationId) };
  }

  /** Writes the one immutable object selected by the journal's current key.
   * @param target Exact immutable record selected by the persisted operation phase.
   * @param retryContext Previously persisted cooldown evidence for that object key.
   * @returns Create-only write certainty from the record adapter.
   */
  async function writeImmutable(
    target: SyncImmutableTarget,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult> {
    switch (target.kind) {
      case "content":
        return records.createContent(target.record, retryContext);
      case "recoveryBody":
        return records.createRecoveryBody(target.record, retryContext);
      case "recovery":
        return records.createRecovery(target.record, retryContext);
      case "version":
        return records.createVersion(target.record, retryContext);
    }
  }

  /** Reads only the exact immutable key currently selected by the journaled step.
   * @param target Immutable record whose canonical bytes are eligible for the saved key.
   * @param journal Operation identity and step selecting the one target key.
   * @returns Exact target, create-only absence, divergent bytes, or unavailable evidence.
   */
  async function readImmutableTarget(
    target: SyncImmutableTarget,
    journal: Extract<
      SyncJournalRecord,
      { status: "pending"; allocationState: "allocated" }
    >,
  ): Promise<SyncPendingTargetObservation> {
    switch (target.kind) {
      case "content":
        return classifyImmutableRead(
          await records.readContentBody(
            journal.vaultId,
            target.record.revision,
          ),
          { kind: "contentBody", record: target.record },
        );
      case "recoveryBody":
        return classifyImmutableRead(
          await records.readRecoveryBody(
            journal.vaultId,
            target.record.operationId,
          ),
          { kind: "recoveryBody", record: target.record },
        );
      case "recovery":
        return classifyImmutableRead(
          await records.readRecoveryMetadata(
            journal.vaultId,
            target.record.operationId,
          ),
          { kind: "recoveryMetadata", record: target.record },
        );
      case "version":
        return classifyImmutableRead(
          await records.readVersionMetadata(
            journal.vaultId,
            target.record.revision,
          ),
          { kind: "version", record: target.record },
        );
    }
  }

  /** Compares one validated immutable key with its exact canonical write bytes.
   * @param stored Marker-gated raw object observation for the selected target key.
   * @param expected Exact body or metadata record authorized by the operation journal.
   * @returns Exact equality, proven absence, or conservative divergent/unavailable evidence.
   */
  async function classifyImmutableRead(
    stored: SyncRecordRead<
      SyncBodyRecord | SyncRecoveryMetadata | SyncVersionMetadata
    >,
    expected: Parameters<typeof encodeSyncRecord>[0],
  ): Promise<SyncPendingTargetObservation> {
    if (stored.kind === "absent") return { kind: "prior" };
    if (stored.kind === "unavailable") return { kind: "unavailable" };
    try {
      const bytes = await encodeSyncRecord(expected);
      return equalBytes(stored.observation.observed.bytes, bytes)
        ? { kind: "exact" }
        : { kind: "divergent" };
    } catch {
      return { kind: "unavailable" };
    }
  }

  /** Reads and compares the immutable event's exact canonical bytes at its reserved position.
   * @param journal Fixed create-event step and operation identity.
   * @param expected Event bytes authorized by that journaled step time.
   * @returns Exact target, create-only absence, divergent bytes, or unavailable evidence.
   */
  async function readEventTarget(
    journal: Extract<
      SyncJournalRecord,
      { status: "pending"; allocationState: "allocated" }
    >,
    expected: SyncFeedEventRecord,
  ): Promise<SyncPendingTargetObservation> {
    const stored = await publication.readEvent(
      journal.vaultId,
      journal.reservation.lane,
      journal.reservation.sequence,
    );
    if (stored.kind === "absent") return { kind: "prior" };
    if (stored.kind === "unavailable") return { kind: "unavailable" };
    try {
      const bytes = await encodeSyncPublication(expected);
      return equalBytes(stored.observation.observed.bytes, bytes)
        ? { kind: "exact" }
        : { kind: "divergent" };
    } catch {
      return { kind: "unavailable" };
    }
  }

  /** Reads the journal-selected head key and compares target bytes and its original CAS generation.
   * @param journal Allocated operation whose immutable write_head tuple governs this read.
   * @param target Exact current-head record the operation is authorized to install.
   * @returns Exact target, exact original condition, divergence, or unavailable evidence.
   */
  async function readHeadTarget(
    journal: Extract<
      SyncJournalRecord,
      { status: "pending"; allocationState: "allocated" }
    >,
    target: SyncHeadRecord,
  ): Promise<SyncPendingTargetObservation> {
    return classifyHeadTarget(
      journal,
      target,
      await records.readHead(journal.vaultId, journal.request.path),
    );
  }

  /** Classifies a head read without treating absence or a refreshed ETag as the saved prior.
   * @param journal Allocated write_head evidence with its immutable prior condition.
   * @param target Exact canonical head bytes requested by the operation.
   * @param stored Strict read result for the one journaled current-head key.
   * @returns Exact target, exact original condition, divergence, or unavailable evidence.
   */
  async function classifyHeadTarget(
    journal: Extract<
      SyncJournalRecord,
      { status: "pending"; allocationState: "allocated" }
    >,
    target: SyncHeadRecord,
    stored: SyncRecordRead<SyncHeadRecord>,
  ): Promise<SyncPendingTargetObservation> {
    if (journal.stepEvidence.step !== "write_head") {
      return { kind: "unavailable" };
    }
    if (stored.kind === "unavailable") return { kind: "unavailable" };
    if (stored.kind === "absent") {
      return journal.stepEvidence.precondition.kind === "absent"
        ? { kind: "prior" }
        : { kind: "divergent" };
    }
    try {
      const targetBytes = await encodeSyncRecord({
        kind: "head",
        record: target,
      });
      if (equalBytes(stored.observation.observed.bytes, targetBytes)) {
        return { kind: "exact" };
      }
      return matchesObservedPrecondition(
        journal.stepEvidence.precondition,
        stored.observation,
      )
        ? { kind: "prior" }
        : { kind: "divergent" };
    } catch {
      return { kind: "unavailable" };
    }
  }

  /** Reads the operation journal and classifies the exact typed body needed by a CAS.
   * @param expected Journal body the caller proposes to replace or has just written.
   * @returns Exact matching generation, a different decoded state, or unavailable evidence.
   */
  async function readJournalAttempt(
    expected: SyncJournalRecord,
  ): Promise<SyncJournalAttemptObservation> {
    const current = await publication.readJournal(
      expected.vaultId,
      expected.operationId,
    );
    if (current.kind !== "observed") return { kind: "unavailable" };
    try {
      const expectedBytes = await encodeSyncPublication(expected);
      return equalBytes(current.observation.observed.bytes, expectedBytes)
        ? { kind: "current", observation: current.observation }
        : { kind: "changed", record: current.observation.value };
    } catch {
      return { kind: "unavailable" };
    }
  }

  /** Claims one pending external target or reconciles a prior persisted claim.
   * @param journal Allocated pending journal for an immutable, head, or event write.
   * @param targetObservation Exact target state read before claim/recovery policy is selected.
   * @param readTarget Fresh exact read used after claim and immediately before dispatch.
   * @returns One dispatch authorization, exact-target progress, or typed deferred/unknown result.
   */
  async function preparePendingTargetAttempt(
    journal: Extract<
      SyncJournalRecord,
      { status: "pending"; allocationState: "allocated" }
    >,
    targetObservation: SyncPendingTargetObservation,
    readTarget: () => Promise<SyncPendingTargetObservation>,
  ): Promise<SyncPendingAttemptResult> {
    if (
      journal.stepEvidence.step !== "immutable_create" &&
      journal.stepEvidence.step !== "write_head" &&
      journal.stepEvidence.step !== "create_event"
    ) {
      return {
        kind: "deferred",
        result: effectUnknown(journal.operationId),
      };
    }
    if (
      targetObservation.kind === "unavailable" ||
      targetObservation.kind === "divergent"
    ) {
      return {
        kind: "deferred",
        result: effectUnknown(journal.operationId),
      };
    }
    const attempt = journal.stepEvidence.attempt;
    if (targetObservation.kind === "exact") {
      return attempt.state === "ready"
        ? {
            kind: "deferred",
            result: effectUnknown(journal.operationId),
          }
        : { kind: "target_present", journal };
    }
    if (attempt.state === "attempting") {
      return {
        kind: "deferred",
        result: await persistPendingRetryWait(journal),
      };
    }
    if (attempt.state === "retry_wait") {
      const now = clock();
      if (!Number.isSafeInteger(now) || now < 0) {
        return {
          kind: "deferred",
          result: { kind: "error", code: "invalid_input" },
        };
      }
      if (now < attempt.retryAfterEpochMs) {
        return {
          kind: "deferred",
          result: operationPending(
            journal.operationId,
            attempt.retryAfterEpochMs,
          ),
        };
      }
    }
    return claimPendingTarget(journal, readTarget);
  }

  /** Persists one fresh claim and grants only its creator one exact target dispatch.
   * @param journal Ready or retry-wait journal whose original target tuple is immutable.
   * @param readTarget Exact target reader repeated after the claim CAS.
   * @returns The exact confirmed claim owner, existing target evidence, or no-dispatch outcome.
   * A claim is never persisted when its mandatory observation-plus-cooldown floor cannot be represented safely.
   */
  async function claimPendingTarget(
    journal: Extract<
      SyncJournalRecord,
      { status: "pending"; allocationState: "allocated" }
    >,
    readTarget: () => Promise<SyncPendingTargetObservation>,
  ): Promise<SyncPendingAttemptResult> {
    const now = clock();
    if (!claimClockIsSafe(now)) {
      return {
        kind: "deferred",
        result: { kind: "error", code: "invalid_input" },
      };
    }
    const current = await readJournalAttempt(journal);
    if (current.kind === "unavailable") {
      return {
        kind: "deferred",
        result: effectUnknown(journal.operationId),
      };
    }
    if (current.kind === "changed") {
      return {
        kind: "deferred",
        result: pendingAfterJournalChange(journal.operationId, current.record),
      };
    }
    const plan = planPendingClaim(
      journal.stepEvidence,
      now,
      current.observation.observed.uploaded.getTime(),
    );
    if (plan.kind === "unsafe") {
      return { kind: "deferred", result: effectUnknown(journal.operationId) };
    }
    if (plan.kind === "wait") {
      return {
        kind: "deferred",
        result: operationPending(journal.operationId, plan.retryAfterEpochMs),
      };
    }
    if (plan.kind === "already_claimed") {
      return {
        kind: "deferred",
        result: operationPending(journal.operationId),
      };
    }
    const { evidence, generation } = plan;
    const claimId = syncOperationIdSchema.parse(globalThis.crypto.randomUUID());
    const claimed = withStep(journal, {
      ...evidence,
      attempt: {
        state: "attempting",
        claimId,
        generation,
        claimedAtEpochMs: now,
      },
    });
    const claimResult = await persistJournal(journal, claimed);
    const savedClaim = await readJournalAttempt(claimed);
    if (savedClaim.kind === "unavailable") {
      return {
        kind: "deferred",
        result: effectUnknown(
          journal.operationId,
          writeRetryAfter(claimResult),
        ),
      };
    }
    if (savedClaim.kind === "changed") {
      return {
        kind: "deferred",
        result: pendingAfterJournalChange(
          journal.operationId,
          savedClaim.record,
          writeRetryAfter(claimResult),
        ),
      };
    }

    const target = await readTarget();
    if (target.kind === "exact") {
      return { kind: "target_present", journal: claimed };
    }
    if (target.kind !== "prior") {
      return {
        kind: "deferred",
        result: effectUnknown(
          journal.operationId,
          writeRetryAfter(claimResult),
        ),
      };
    }
    const confirmedClaim = await readJournalAttempt(claimed);
    if (confirmedClaim.kind === "current") {
      return { kind: "dispatch", journal: claimed };
    }
    if (confirmedClaim.kind === "changed") {
      return {
        kind: "deferred",
        result: pendingAfterJournalChange(
          journal.operationId,
          confirmedClaim.record,
          writeRetryAfter(claimResult),
        ),
      };
    }
    return {
      kind: "deferred",
      result: effectUnknown(journal.operationId, writeRetryAfter(claimResult)),
    };
  }

  /** Reconciles an exact prior/absent target into a journaled fixed retry floor.
   * @param journal Attempting target claim proven still to have its original condition.
   * @param result Known response floor from the target request, if that request just returned.
   * @returns Fixed-floor pending result or uncertainty; this function never dispatches a target.
   */
  async function persistPendingRetryWait(
    journal: Extract<
      SyncJournalRecord,
      { status: "pending"; allocationState: "allocated" }
    >,
    result?: SyncR2WriteResult,
  ): Promise<SyncMutationResult> {
    const plan = planPendingRetryWait(journal.stepEvidence, clock(), result);
    if (plan.kind === "unsafe") {
      return effectUnknown(journal.operationId);
    }
    const { evidence, attempt, observedAtEpochMs, retryAfterEpochMs } = plan;
    const current = await readJournalAttempt(journal);
    if (current.kind === "unavailable") {
      return effectUnknown(journal.operationId, retryAfterEpochMs);
    }
    if (current.kind === "changed") {
      return pendingAfterJournalChange(
        journal.operationId,
        current.record,
        retryAfterEpochMs,
      );
    }
    const journalFloor =
      current.observation.observed.uploaded.getTime() +
      SYNC_R2_WRITE_COOLDOWN_MS;
    if (!Number.isSafeInteger(journalFloor)) {
      return effectUnknown(journal.operationId, retryAfterEpochMs);
    }
    if (observedAtEpochMs < journalFloor) {
      return operationPending(
        journal.operationId,
        Math.max(retryAfterEpochMs, journalFloor),
      );
    }

    const retryWait = withStep(journal, {
      ...evidence,
      retryAfterEpochMs,
      attempt: {
        state: "retry_wait",
        claimId: attempt.claimId,
        generation: attempt.generation,
        observedAtEpochMs,
        retryAfterEpochMs,
      },
    });
    const saved = await persistJournal(journal, retryWait);
    const confirmed = await readJournalAttempt(retryWait);
    if (confirmed.kind === "current") {
      return operationPending(journal.operationId, retryAfterEpochMs);
    }
    if (confirmed.kind === "changed") {
      return pendingAfterJournalChange(
        journal.operationId,
        confirmed.record,
        retryAfterEpochMs,
        writeRetryAfter(saved),
      );
    }
    if (saved.kind === "throttled") {
      return operationPending(
        journal.operationId,
        Math.max(retryAfterEpochMs, saved.retryAfterEpochMs),
      );
    }
    return effectUnknown(
      journal.operationId,
      Math.max(retryAfterEpochMs, writeRetryAfter(saved) ?? 0),
    );
  }

  /** Defers a superseded journal without discarding locally known response or planned floors.
   * @param operationId Original caller operation; the changed snapshot grants no new write authority.
   * @param changed Newly observed journal whose inline floor may be lower or absent after phase progress.
   * @param knownFloor Minimum already known to this caller before observing the changed generation.
   * @param responseFloor Additional floor returned by the just-attempted journal CAS.
   * @returns Maximum-floor pending response, floorless pending when no floor is known, or uncertainty for unsafe evidence.
   */
  function pendingAfterJournalChange(
    operationId: SyncMutationRequest["operationId"],
    changed: SyncJournalRecord,
    knownFloor?: number,
    responseFloor?: number,
  ): SyncMutationResult {
    const merged = mergeKnownPendingRetryFloors(
      retryFloorFromJournal(changed),
      knownFloor,
      responseFloor,
    );
    switch (merged.kind) {
      case "unsafe":
        return effectUnknown(operationId);
      case "none":
        return operationPending(operationId);
      case "known":
        return operationPending(operationId, merged.retryAfterEpochMs);
    }
  }

  /** Returns the persisted retry floor for an allocated journal's current external step.
   * @param journal Any decoded journal that may have changed during a concurrent resume.
   * @returns The known step floor, or undefined when the record has no external step evidence.
   */
  function retryFloorFromJournal(
    journal: SyncJournalRecord,
  ): number | undefined {
    if (
      journal.allocationState !== "allocated" ||
      journal.stepEvidence.step === "commit_journal"
    ) {
      return undefined;
    }
    return journal.stepEvidence.retryAfterEpochMs ?? undefined;
  }

  /** Resolves only the outcome kind already fixed in the create-event journal step.
   * @param journal Allocated operation with an immutable persisted event intent and timestamp.
   * @returns Exact intended event only when its head and linked records prove it, otherwise uncertainty.
   */
  async function eventForJournal(
    journal: Extract<
      SyncJournalRecord,
      { status: "pending"; allocationState: "allocated" }
    >,
  ): Promise<
    | { readonly kind: "event"; readonly event: SyncFeedEventRecord }
    | { readonly kind: "error"; readonly failure: SyncMutationResult }
  > {
    if (journal.stepEvidence.step !== "create_event") {
      return { kind: "error", failure: effectUnknown(journal.operationId) };
    }
    const committedAtEpochMs = journal.stepEvidence.committedAtEpochMs;
    const current = await readCurrent({
      vaultId: journal.vaultId,
      path: journal.request.path,
    });
    if (isStoreFailure(current)) {
      return { kind: "error", failure: effectUnknown(journal.operationId) };
    }
    if (journal.stepEvidence.outcomeIntent === "changed") {
      if (
        current.kind === "never_seen" ||
        current.operationId !== journal.operationId ||
        current.revision !== journal.request.revision
      ) {
        return { kind: "error", failure: effectUnknown(journal.operationId) };
      }
      const head = await mutationHeadForRequest(journal);
      if (head === undefined || !sameCurrentAndHead(current, head)) {
        return { kind: "error", failure: effectUnknown(journal.operationId) };
      }
      if (journal.request.kind !== "tombstone") {
        const body = await records.readContent(
          journal.vaultId,
          journal.request.revision,
        );
        const expectedBytes = new TextEncoder().encode(journal.request.content);
        if (
          body.kind !== "observed" ||
          journal.payload === null ||
          body.observation.value.byteSize !== journal.payload.byteSize ||
          body.observation.value.contentSha256 !==
            journal.request.contentSha256 ||
          !equalBytes(body.observation.value.bytes, expectedBytes)
        ) {
          return { kind: "error", failure: effectUnknown(journal.operationId) };
        }
      }
      return {
        kind: "event",
        event: {
          schemaVersion: 1,
          protocolMajor: 1,
          vaultId: journal.vaultId,
          kind: "changed",
          lane: journal.reservation.lane,
          sequence: journal.reservation.sequence,
          path: journal.request.path,
          result: {
            kind: journal.request.kind === "tombstone" ? "tombstone" : "live",
            revision: journal.request.revision,
          },
          operationId: journal.operationId,
          origin: journal.request.origin,
          committedAtEpochMs,
        },
      };
    }
    if (
      current.kind !== "never_seen" &&
      current.operationId === journal.operationId
    ) {
      return { kind: "error", failure: effectUnknown(journal.operationId) };
    }
    const decision = await evaluateMutation(
      journal.request,
      current,
      undefined,
    );
    if (decision.kind !== "reject" || decision.code !== "stale_revision") {
      return { kind: "error", failure: effectUnknown(journal.operationId) };
    }
    return {
      kind: "event",
      event: {
        schemaVersion: 1,
        protocolMajor: 1,
        vaultId: journal.vaultId,
        kind: "aborted",
        lane: journal.reservation.lane,
        sequence: journal.reservation.sequence,
        operationId: journal.operationId,
        reason: "stale_revision",
        committedAtEpochMs,
      },
    };
  }

  /** Stores one pending journal transition only from the exact current typed phase.
   * @param expected Exact persisted generation required before replacing the journal.
   * @param next Typed journal state proposed for that same operation.
   * @param readyHeadCasWitness Exact linked stale competitor for the one unclaimed head-abort edge.
   * @returns Confirmed, refused, or uncertain conditional-write certainty.
   */
  async function persistJournal(
    expected: SyncJournalRecord,
    next: SyncJournalRecord,
    readyHeadCasWitness?: SyncRecordObservation<SyncHeadRecord>,
  ): Promise<SyncR2WriteResult> {
    const current = await publication.readJournal(
      expected.vaultId,
      expected.operationId,
    );
    if (current.kind === "unavailable" || current.kind === "absent") {
      return { kind: "effect_unknown" };
    }
    const expectedBytes = await encodeSyncPublication(expected);
    const nextBytes = await encodeSyncPublication(next);
    if (equalBytes(current.observation.observed.bytes, nextBytes)) {
      return { kind: "confirmed" };
    }
    if (!equalBytes(current.observation.observed.bytes, expectedBytes)) {
      return { kind: "refused" };
    }
    if (readyHeadCasWitness !== undefined) {
      return publication.replaceJournalFromReadyHeadCasAbort(
        current.observation,
        readyHeadCasWitness,
        next,
      );
    }
    return publication.replaceJournal(current.observation, next);
  }

  return { mutate, resumeOperation, readCurrent, readVersion, readRecovery };
}

/** Rehydrates the exact prior lane head whose bytes and ETag were persisted before reservation.
 * @param journal Unallocated operation retaining the original lane-head generation.
 * @returns Strictly decoded prior lane head, or undefined when exact bytes are unavailable.
 */
async function priorLaneHead(
  journal: SyncUnallocatedPendingJournalRecord,
): Promise<SyncLaneHeadRecord | undefined> {
  const precondition = journal.laneObservation.precondition;
  if (precondition.kind !== "observed") return undefined;
  const bytes = decodeBase64Url(precondition.bytes);
  if (bytes === undefined) return undefined;
  try {
    const decoded = await decodeSyncPublication(
      "laneHead",
      journal.laneObservation.key,
      bytes,
      journal.vaultId,
    );
    return decoded.kind === "laneHead" ? decoded : undefined;
  } catch {
    return undefined;
  }
}
