import type {
  SyncMutationResult,
  SyncReadCurrentInput,
  SyncReadCurrentResult,
} from "@core/sync/sync-store.types";
import { syncFeedLaneHeadKey } from "@protocol/sync.codec";
import type {
  SyncFeedEventRecord,
  SyncJournalRecord,
  SyncLaneHeadRecord,
  SyncPublicationStepEvidence,
} from "@worker/infrastructure/sync/sync-publication.types";
import { SYNC_R2_WRITE_COOLDOWN_MS } from "@worker/infrastructure/sync/sync-r2.constants";
import type { SyncR2WriteResult } from "@worker/infrastructure/sync/sync-r2.types";
import {
  effectUnknown,
  eventMatchesRequest,
  isStoreFailure,
  matchesObservedPrecondition,
  observedPrecondition,
  operationPending,
  previousSequence,
  sameTerminalOutcome,
  terminalResult,
  writeFailure,
  writeRetryAfter,
} from "@worker/infrastructure/sync/sync-r2-mutation.helpers";
import type { SyncServerClock } from "@worker/infrastructure/sync/sync-r2-mutation.types";
import { mergeKnownPendingRetryFloors } from "@worker/infrastructure/sync/sync-r2-mutation-attempt-policy";
import type { SyncR2Publication } from "@worker/infrastructure/sync/sync-r2-publication";

/** Allocated pending journal authority accepted before feed/journal terminalization. */
type AllocatedPendingJournal = Extract<
  SyncJournalRecord,
  { status: "pending"; allocationState: "allocated" }
>;

/** Immutable committed or conclusively aborted journal authority. */
type TerminalJournal = Extract<
  SyncJournalRecord,
  { status: "committed" | "aborted" }
>;

/** Exact journal persistence capability required by terminal transitions. */
type PersistJournal = (
  expected: SyncJournalRecord,
  next: SyncJournalRecord,
) => Promise<SyncR2WriteResult>;

/** The feed and lane terminalization operations composed into the mutation state machine. */
export interface SyncR2MutationTerminal {
  /** Stores the journal terminal result from the exact verified event and reserved lane marker. */
  commitJournal(journal: AllocatedPendingJournal): Promise<SyncMutationResult>;
  /** Releases a terminal operation's lane only after all exact evidence rereads successfully. */
  advanceTerminal(journal: TerminalJournal): Promise<SyncMutationResult>;
}

/** Coordinates immutable feed evidence, terminal journals, and final lane-head release.
 * @param publication Exact-record read and conditional-write capability.
 * @param clock Server-supplied Unix epoch milliseconds for durable retry timing.
 * @param readCurrent Exact current-state reader used to verify terminal effects.
 * @param persistJournal Exact journal-transition capability supplied by the mutation owner.
 * @returns Terminal transitions that retain the lane blocker until verified release.
 */
export function syncR2MutationTerminal(
  publication: SyncR2Publication,
  clock: SyncServerClock,
  readCurrent: (input: SyncReadCurrentInput) => Promise<SyncReadCurrentResult>,
  persistJournal: PersistJournal,
): SyncR2MutationTerminal {
  /** Marks the exact event outcome committed before persisting the lane-release precondition.
   * @param journal Allocated pending operation at its journal-commit phase.
   * @returns Pending progress with its retry floor, or conservative write certainty.
   */
  async function commitJournal(
    journal: AllocatedPendingJournal,
  ): Promise<SyncMutationResult> {
    const event = await publication.readEvent(
      journal.vaultId,
      journal.reservation.lane,
      journal.reservation.sequence,
    );
    if (
      event.kind !== "observed" ||
      !eventMatchesRequest(journal, event.observation.value)
    ) {
      return effectUnknown(journal.operationId);
    }
    const lane = await publication.readLaneHead(
      journal.vaultId,
      journal.reservation.lane,
    );
    if (
      lane.kind !== "observed" ||
      lane.observation.value.pending?.operationId !== journal.operationId ||
      lane.observation.value.pending.nextSequence !==
        journal.reservation.sequence ||
      lane.observation.value.committedSequence !==
        previousSequence(journal.reservation.sequence) ||
      lane.observation.value.committedAtEpochMs !==
        journal.reservation.previousCommittedAtEpochMs
    ) {
      return effectUnknown(journal.operationId);
    }
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      return effectUnknown(journal.operationId);
    }
    const evidence: SyncPublicationStepEvidence = {
      step: "commit_lane",
      key: syncFeedLaneHeadKey(journal.vaultId, journal.reservation.lane),
      precondition: observedPrecondition(lane.observation),
      retryAfterEpochMs: Math.max(
        now,
        lane.observation.observed.uploaded.getTime() +
          SYNC_R2_WRITE_COOLDOWN_MS,
      ),
      attempt: { state: "ready", generation: 0 },
    };
    const terminal = terminalJournal(
      journal,
      event.observation.value,
      evidence,
      event.observation.value.committedAtEpochMs,
    );
    const result = await persistJournal(journal, terminal);
    return result.kind === "confirmed"
      ? operationPending(
          journal.operationId,
          evidence.retryAfterEpochMs ?? undefined,
        )
      : writeFailure(journal.operationId, result);
  }

  /** Commits the lane last and returns terminal success only after every durable record rereads.
   * @param journal Persisted terminal outcome whose lane reservation remains to be released.
   * @returns Verified terminal result, pending cooldown, or uncertain effect failure.
   */
  async function advanceTerminal(
    journal: TerminalJournal,
  ): Promise<SyncMutationResult> {
    const journalRead = await publication.readJournal(
      journal.vaultId,
      journal.operationId,
    );
    if (journalRead.kind !== "observed")
      return effectUnknown(journal.operationId);
    const exactJournal = journalRead.observation.value;
    if (
      exactJournal.status !== journal.status ||
      exactJournal.stepEvidence.step !== "commit_lane" ||
      !sameTerminalOutcome(journal, exactJournal)
    ) {
      return effectUnknown(journal.operationId);
    }
    const event = await publication.readEvent(
      journal.vaultId,
      journal.reservation.lane,
      journal.reservation.sequence,
    );
    if (
      event.kind !== "observed" ||
      !eventMatchesTerminal(exactJournal, event.observation.value)
    ) {
      return effectUnknown(journal.operationId);
    }
    const current = await readCurrent({
      vaultId: journal.vaultId,
      path: journal.request.path,
    });
    if (isStoreFailure(current)) return effectUnknown(journal.operationId);
    if (exactJournal.status === "committed" && current.kind === "never_seen") {
      return effectUnknown(journal.operationId);
    }
    if (
      exactJournal.status === "aborted" &&
      current.kind !== "never_seen" &&
      current.operationId === journal.operationId &&
      current.revision === journal.request.revision
    ) {
      return effectUnknown(journal.operationId);
    }

    const lane = await publication.readLaneHead(
      journal.vaultId,
      journal.reservation.lane,
    );
    if (lane.kind !== "observed") return effectUnknown(journal.operationId);
    if (
      BigInt(lane.observation.value.committedSequence) >=
      BigInt(journal.reservation.sequence)
    ) {
      if (!laneClockMatches(lane.observation.value, journal)) {
        return effectUnknown(journal.operationId);
      }
      return terminalResult(exactJournal);
    }
    if (
      lane.observation.value.pending?.operationId !== journal.operationId ||
      lane.observation.value.pending.nextSequence !==
        journal.reservation.sequence ||
      lane.observation.value.committedSequence !==
        previousSequence(journal.reservation.sequence) ||
      !matchesObservedPrecondition(
        exactJournal.stepEvidence.precondition,
        lane.observation,
      )
    ) {
      return effectUnknown(journal.operationId);
    }

    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      return effectUnknown(journal.operationId);
    }
    const floor = exactJournal.stepEvidence.retryAfterEpochMs;
    if (floor !== null && now < floor) {
      return operationPending(journal.operationId, floor);
    }
    const nextFloor = Math.max(
      now + SYNC_R2_WRITE_COOLDOWN_MS,
      lane.observation.observed.uploaded.getTime() + SYNC_R2_WRITE_COOLDOWN_MS,
      floor ?? 0,
    );
    const prepared: TerminalJournal = {
      ...exactJournal,
      stepEvidence: {
        ...exactJournal.stepEvidence,
        retryAfterEpochMs: nextFloor,
      },
    };
    if (floor !== nextFloor) {
      const persisted = await publication.replaceJournal(
        journalRead.observation,
        prepared,
      );
      if (persisted.kind !== "confirmed") {
        return writeFailure(journal.operationId, persisted);
      }
    }
    const priorRetry =
      floor === null ? undefined : { retryAfterEpochMs: floor };
    const laneResult = await publication.replaceLaneHead(
      lane.observation,
      committedLaneHead(lane.observation.value, exactJournal),
      priorRetry,
    );
    if (laneResult.kind === "confirmed") {
      return await verifyTerminalCompletion(exactJournal);
    }
    const after = await publication.readLaneHead(
      journal.vaultId,
      journal.reservation.lane,
    );
    if (
      after.kind === "observed" &&
      laneCommitIsVisible(after.observation.value, exactJournal)
    ) {
      return await verifyTerminalCompletion(exactJournal);
    }
    const responseFloor = writeRetryAfter(laneResult);
    if (
      mergeKnownPendingRetryFloors(undefined, responseFloor).kind === "unsafe"
    ) {
      return effectUnknown(journal.operationId);
    }
    if (
      after.kind === "observed" &&
      matchesObservedPrecondition(
        exactJournal.stepEvidence.precondition,
        after.observation,
      )
    ) {
      const floorPlan = mergeKnownPendingRetryFloors(
        nextFloor,
        responseFloor,
        laneResult.kind === "throttled"
          ? undefined
          : clock() + SYNC_R2_WRITE_COOLDOWN_MS,
      );
      if (floorPlan.kind !== "known") return effectUnknown(journal.operationId);
      const persistedFloor = floorPlan.retryAfterEpochMs;
      const retryJournal: TerminalJournal = {
        ...exactJournal,
        stepEvidence: {
          ...exactJournal.stepEvidence,
          retryAfterEpochMs: persistedFloor,
        },
      };
      const latestJournal = await publication.readJournal(
        journal.vaultId,
        journal.operationId,
      );
      if (
        latestJournal.kind === "observed" &&
        latestJournal.observation.value.status !== "pending" &&
        sameTerminalOutcome(exactJournal, latestJournal.observation.value)
      ) {
        const floorWrite = await publication.replaceJournal(
          latestJournal.observation,
          retryJournal,
        );
        if (floorWrite.kind === "confirmed") {
          return operationPending(journal.operationId, persistedFloor);
        }
      }
      return operationPending(journal.operationId, persistedFloor);
    }
    return effectUnknown(journal.operationId, responseFloor);
  }

  /** Verifies all terminal evidence after lane release before exposing a result.
   * @param journal Exact terminal outcome expected across journal, event, current head, and lane.
   * @returns Terminal result only when every required persisted record confirms completion.
   */
  async function verifyTerminalCompletion(
    journal: TerminalJournal,
  ): Promise<SyncMutationResult> {
    const [storedJournal, event, current, lane] = await Promise.all([
      publication.readJournal(journal.vaultId, journal.operationId),
      publication.readEvent(
        journal.vaultId,
        journal.reservation.lane,
        journal.reservation.sequence,
      ),
      readCurrent({ vaultId: journal.vaultId, path: journal.request.path }),
      publication.readLaneHead(journal.vaultId, journal.reservation.lane),
    ]);
    if (
      storedJournal.kind !== "observed" ||
      storedJournal.observation.value.status !== journal.status ||
      !sameTerminalOutcome(journal, storedJournal.observation.value) ||
      event.kind !== "observed" ||
      !eventMatchesTerminal(journal, event.observation.value) ||
      isStoreFailure(current) ||
      lane.kind !== "observed" ||
      BigInt(lane.observation.value.committedSequence) <
        BigInt(journal.reservation.sequence) ||
      !laneClockMatches(lane.observation.value, journal)
    ) {
      return effectUnknown(journal.operationId);
    }
    if (journal.status === "committed" && current.kind === "never_seen") {
      return effectUnknown(journal.operationId);
    }
    if (
      journal.status === "aborted" &&
      current.kind !== "never_seen" &&
      current.operationId === journal.operationId &&
      current.revision === journal.request.revision
    ) {
      return effectUnknown(journal.operationId);
    }
    return terminalResult(journal);
  }

  return { commitJournal, advanceTerminal };
}

/** Validates event and terminal-journal outcome equality including immutable request provenance.
 * @param journal Verified committed or aborted journal record.
 * @param event Candidate immutable feed event for the same reserved position.
 * @returns Whether the event proves the exact terminal journal outcome.
 */
function eventMatchesTerminal(
  journal: TerminalJournal,
  event: SyncFeedEventRecord,
): boolean {
  if (
    event.vaultId !== journal.vaultId ||
    event.lane !== journal.reservation.lane ||
    event.sequence !== journal.reservation.sequence ||
    event.operationId !== journal.operationId ||
    event.committedAtEpochMs !== journal.committedAtEpochMs
  ) {
    return false;
  }
  if (journal.status === "aborted") {
    return event.kind === "aborted" && event.reason === journal.reason;
  }
  return (
    event.kind === "changed" &&
    event.path === journal.request.path &&
    event.origin === journal.request.origin &&
    event.result.kind ===
      (journal.request.kind === "tombstone" ? "tombstone" : "live") &&
    event.result.revision === journal.revision
  );
}

/** Converts a verified feed event to its immutable terminal journal state.
 * @param journal Allocated pending operation bound to the event's reservation.
 * @param event Exact persisted changed or aborted event.
 * @param evidence Commit-lane precondition captured from the lane head.
 * @param committedAtEpochMs Monotonic event time in Unix epoch milliseconds.
 * @returns The committed or aborted journal preserving the operation's exact authority.
 */
function terminalJournal(
  journal: AllocatedPendingJournal,
  event: SyncFeedEventRecord,
  evidence: SyncPublicationStepEvidence,
  committedAtEpochMs: number,
): TerminalJournal {
  const common = {
    ...journal,
    stepEvidence: evidence,
    position: {
      lane: journal.reservation.lane,
      sequence: journal.reservation.sequence,
    },
    committedAtEpochMs,
  };
  if (event.kind === "aborted") {
    return { ...common, status: "aborted", reason: "stale_revision" };
  }
  return {
    ...common,
    status: "committed",
    revision: journal.request.revision,
  };
}

/** Builds the lane clock that releases this operation's reservation without retaining pending.
 * @param head Exact observed lane head whose identity and schema are preserved.
 * @param journal Terminal operation owning the reservation being committed.
 * @returns The committed lane head at the operation's reserved sequence and time.
 */
function committedLaneHead(
  head: SyncLaneHeadRecord,
  journal: TerminalJournal,
): SyncLaneHeadRecord {
  return {
    schemaVersion: head.schemaVersion,
    protocolMajor: head.protocolMajor,
    vaultId: head.vaultId,
    kind: "laneHead",
    lane: head.lane,
    committedSequence: journal.reservation.sequence,
    committedAtEpochMs: journal.committedAtEpochMs,
  };
}

/** Checks whether lane read-back contains this operation's committed sequence and clock.
 * @param head Fresh lane-head observation after a conditional release attempt.
 * @param journal Terminal operation whose reservation must be visible.
 * @returns Whether the lane has committed this sequence with a compatible clock.
 */
function laneCommitIsVisible(
  head: SyncLaneHeadRecord,
  journal: TerminalJournal,
): boolean {
  return (
    head.lane === journal.reservation.lane &&
    BigInt(head.committedSequence) >= BigInt(journal.reservation.sequence) &&
    laneClockMatches(head, journal)
  );
}

/** Requires a same-sequence exact time or a strictly later committed lane clock.
 * @param head Observed lane clock after this operation's reservation.
 * @param journal Terminal outcome with the operation's commit time.
 * @returns Whether the lane timestamp proves this or a later commit.
 */
function laneClockMatches(
  head: SyncLaneHeadRecord,
  journal: TerminalJournal,
): boolean {
  return head.committedSequence === journal.reservation.sequence
    ? head.committedAtEpochMs === journal.committedAtEpochMs
    : head.committedAtEpochMs > journal.committedAtEpochMs;
}
