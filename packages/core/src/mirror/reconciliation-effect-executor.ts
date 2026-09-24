import {
  LocalInspectionKind,
  LocalVaultFailureReason,
} from "@core/local-vault/local-vault.constants";
import type { ReadOnlyLocalVault } from "@core/local-vault/read-only-local-vault.port";
import type { ConflictPreservationService } from "@core/mirror/conflict-preservation-service";
import type { LocalReconciliationWriteService } from "@core/mirror/local-reconciliation-write-service";
import {
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  CURRENT_NOTE_STATE_KIND,
  MUTATION_ACTION,
  MUTATION_EFFECT_CERTAINTY,
  RECOVERY_SNAPSHOT_STATE_KIND,
} from "@core/mirror/mirror.constants";
import type {
  ConditionalMutationRequest,
  ContentSha256,
  CurrentNoteState,
  MirrorOperationId,
  MutationAcknowledgement,
  MutationEffectCertainty,
  OperationReceipt,
  RecoverySnapshotState,
} from "@core/mirror/mirror.types";
import {
  MAX_MIRROR_TRACKED_PATHS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
} from "@core/mirror/mirror-state.constants";
import type {
  MirrorAcknowledgement,
  MirrorDeviceState,
  MirrorPathState,
  MirrorStateSnapshot,
} from "@core/mirror/mirror-state.types";
import type { MirrorStateOwner } from "@core/mirror/mirror-state-owner";
import { isDurableMutationAdmissionAllowed } from "@core/mirror/mirror-state-policy";
import { isNonHistoryReconciliationOperation } from "@core/mirror/reconciliation-operation";
import {
  type RequiredReconciliationPreservation,
  requiredReconciliationPreservations,
} from "@core/mirror/reconciliation-preservation-policy";
import {
  isRecoverySnapshotExpired,
  recoverySnapshotStatesEqual,
} from "@core/mirror/reconciliation-recovery-selection";
import type { ReconciliationObservationSource } from "@core/mirror/reconciliation-review.types";
import {
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_OBSERVATION_COVERAGE,
  RECONCILIATION_OPERATION_PHASE,
  RECONCILIATION_PRESERVATION_PROOF_STATE,
  RECONCILIATION_PRESERVATION_SIDE,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
  RECONCILIATION_REVIEW_STATUS,
} from "@core/mirror/reconciliation-state.constants";
import type {
  ReconciliationNonHistoryOperation,
  ReconciliationOperation,
  ReconciliationPathEvidence,
  ReconciliationRemoteEvidence,
} from "@core/mirror/reconciliation-state.types";
import type { RemoteBridge } from "@core/mirror/remote-bridge.types";
import type { NotePath } from "@core/note-path/note-path.types";

/** Runtime seams needed to prove transient note and recovery bytes. */
export interface ReconciliationEffectRuntime {
  readonly observations: ReconciliationObservationSource;
  /** @returns SHA-256 of exact transient UTF-8 text. */
  hashContent(content: string): Promise<ContentSha256>;
  /** @returns Current wall-clock time used only for sealed recovery expiry. */
  nowMilliseconds(): number;
}

/** Exact local body proven against one immutable operation snapshot. */
export interface ExactLocalReconciliationContent {
  readonly content: string;
  readonly contentSha256: ContentSha256;
}

/** Exact remote body proven against one immutable live or legacy sample. */
export interface ExactRemoteReconciliationContent {
  readonly content: string;
  readonly contentSha256: ContentSha256;
}

/** Exact recoverable body proven against selected metadata and current retention state. */
export interface ExactRecoveryReconciliationContent {
  readonly content: string;
  readonly metadata: RecoverySnapshotState;
}

/** Finite remote mutation settlement used by action-specific policy owners. */
export type ReconciliationRemoteMutationSettlement =
  | {
      readonly kind: "confirmed";
      readonly acknowledgement: MutationAcknowledgement;
      readonly snapshot: MirrorStateSnapshot;
    }
  | {
      readonly kind: "evidence-required";
      readonly snapshot: MirrorStateSnapshot;
    }
  | {
      readonly kind: "blocked";
      readonly snapshot: MirrorStateSnapshot;
    }
  | {
      readonly kind: "rejected";
      readonly reason:
        | "operation-not-active"
        | "evidence-changed"
        | "persistence-failure";
      readonly snapshot: MirrorStateSnapshot;
    };

/** Options for one conditional remote effect and its aggregate operation evidence. */
export interface ReconciliationRemoteMutationOptions {
  /** Whether this mutation completes the operation's aggregate remote-effect channel. */
  readonly aggregateEffect: boolean;
  /** Whether its exact acknowledgement should become a durable path baseline immediately. */
  readonly recordAcknowledgement: boolean;
}

/**
 * Implements mechanical evidence reads, preservation dispatch, conditional remote
 * settlement, and atomic baseline completion for action-specific M4 services.
 *
 * It never selects an action or invents a path/body. Every method consumes an
 * already admitted operation and evidence-derived request.
 */
export class ReconciliationEffectExecutor {
  /**
   * @param local - Existing read-only stable saved-note boundary.
   * @param remote - Existing bounded v2 remote capability.
   * @param stateOwner - Serialized durable operation owner.
   * @param preservation - Archive-first local preservation service.
   * @param localWrites - Narrow eligible local mutation service.
   * @param runtime - Hash, observation-generation, and clock seams.
   */
  constructor(
    readonly local: ReadOnlyLocalVault,
    readonly remote: RemoteBridge,
    readonly stateOwner: MirrorStateOwner,
    readonly preservation: ConflictPreservationService,
    readonly localWrites: LocalReconciliationWriteService,
    readonly runtime: ReconciliationEffectRuntime,
  ) {}

  /** @returns Latest authoritative state-owner snapshot. */
  snapshot(): MirrorStateSnapshot {
    return this.stateOwner.snapshot();
  }

  /** @returns Active operation by exact identity, or undefined after terminal release. */
  operation(
    operationId: MirrorOperationId,
  ): ReconciliationOperation | undefined {
    return this.stateOwner
      .snapshot()
      .state.reconciliationOperations.find(
        (operation) =>
          operation.operationId === operationId &&
          operation.phase !== RECONCILIATION_OPERATION_PHASE.completed &&
          operation.phase !== RECONCILIATION_OPERATION_PHASE.stale,
      );
  }

  /** @returns Immutable evidence for an operation-owned path. */
  evidence(
    operation: ReconciliationOperation,
    path: NotePath,
  ): ReconciliationPathEvidence | undefined {
    return operation.snapshot.paths.find(
      (candidate) => candidate.path === path,
    );
  }

  /**
   * Reads and hashes current local bytes while checking the sampled observation generation.
   * @returns Exact content, `absent`, or `changed` without retaining bytes durably.
   */
  async readExactLocal(
    evidence: ReconciliationPathEvidence,
  ): Promise<ExactLocalReconciliationContent | "absent" | "changed"> {
    const expected = evidence.local;
    if (expected.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown) {
      return "changed";
    }
    if (
      this.runtime.observations.current(evidence.path) !==
      expected.observationGeneration
    ) {
      return "changed";
    }
    const result = await this.local.read(evidence.path);
    if (expected.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.absent) {
      return result.kind === LocalInspectionKind.failed &&
        result.reason === LocalVaultFailureReason.missingFile &&
        this.runtime.observations.current(evidence.path) ===
          expected.observationGeneration
        ? "absent"
        : "changed";
    }
    if (result.kind !== LocalInspectionKind.ok) return "changed";
    const hash = await this.hash(result.content);
    if (
      hash !== expected.contentSha256 ||
      this.runtime.observations.current(evidence.path) !==
        expected.observationGeneration
    ) {
      return "changed";
    }
    return { content: result.content, contentSha256: hash };
  }

  /**
   * Verifies current local bytes by hash after an already proven operation effect.
   *
   * This does not grant first-effect authority and intentionally ignores the old
   * observation generation, which the operation's own saved event may have advanced.
   *
   * @param path - Operation-owned local path.
   * @param expectedHash - Exact postcondition digest already bound to the operation.
   * @returns Current exact content or `changed`.
   */
  async readCurrentLocal(
    path: NotePath,
    expectedHash: ContentSha256,
  ): Promise<ExactLocalReconciliationContent | "changed"> {
    const result = await this.local.read(path);
    if (result.kind !== LocalInspectionKind.ok) return "changed";
    const hash = await this.hash(result.content);
    return hash === expectedHash
      ? { content: result.content, contentSha256: hash }
      : "changed";
  }

  /**
   * Reads exact live/legacy remote bytes through a metadata-content-metadata barrier.
   * @returns Exact content, `non-content` for absence/tombstone, or `changed`.
   */
  async readExactRemote(
    evidence: ReconciliationPathEvidence,
  ): Promise<ExactRemoteReconciliationContent | "non-content" | "changed"> {
    const expected = evidence.remote;
    const first = await this.remote.inspectNote(evidence.path);
    if (
      first.kind !== "success" ||
      !remoteEvidenceMatches(expected, first.value)
    ) {
      return "changed";
    }
    if (
      expected.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.live &&
      expected.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy
    ) {
      const second = await this.remote.inspectNote(evidence.path);
      return second.kind === "success" &&
        remoteEvidenceMatches(expected, second.value)
        ? "non-content"
        : "changed";
    }
    const body = await this.remote.readNote(evidence.path);
    if (body.kind !== "success") return "changed";
    if (
      expected.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live &&
      (body.value.kind !== "live" || body.value.revision !== expected.revision)
    ) {
      return "changed";
    }
    if (
      expected.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy &&
      body.value.kind !== "legacy"
    ) {
      return "changed";
    }
    /* v8 ignore next -- matching live/legacy evidence and guards above exhaust body kinds. */
    if (body.value.kind !== "live" && body.value.kind !== "legacy") {
      return "changed";
    }
    const hash = await this.hash(body.value.content);
    const second = await this.remote.inspectNote(evidence.path);
    if (
      hash !== expected.contentSha256 ||
      second.kind !== "success" ||
      !remoteEvidenceMatches(expected, second.value)
    ) {
      return "changed";
    }
    return { content: body.value.content, contentSha256: hash };
  }

  /**
   * Revalidates selected recovery metadata and bytes, including sealed expiry.
   * @returns Exact content or a sanitized missing/changed/expired outcome.
   */
  async readExactRecovery(
    operation: ReconciliationOperation,
  ): Promise<
    ExactRecoveryReconciliationContent | "unavailable" | "expired" | "changed"
  > {
    const expected = operation.snapshot.recovery;
    if (
      expected === null ||
      expected.kind === RECOVERY_SNAPSHOT_STATE_KIND.purged
    ) {
      return "unavailable";
    }
    const first = await this.remote.inspectRecovery(expected.id);
    if (
      first.kind !== "success" ||
      first.value === null ||
      !recoverySnapshotStatesEqual(expected, first.value)
    ) {
      return "changed";
    }
    if (
      isRecoverySnapshotExpired(first.value, this.runtime.nowMilliseconds())
    ) {
      return "expired";
    }
    const body = await this.remote.readRecoveryContent(expected.id);
    if (body.kind !== "success" || body.value.kind !== "recoverable") {
      return "unavailable";
    }
    const hash = await this.hash(body.value.content);
    const second = await this.remote.inspectRecovery(expected.id);
    if (
      hash !== expected.contentSha256 ||
      second.kind !== "success" ||
      second.value === null ||
      !recoverySnapshotStatesEqual(expected, second.value)
    ) {
      return "changed";
    }
    return { content: body.value.content, metadata: second.value };
  }

  /**
   * Creates every missing evidence-required preservation artifact in matrix order.
   * @returns Verified, blocked, evidence-required, or changed evidence.
   */
  async preserveRequired(
    operationId: MirrorOperationId,
  ): Promise<
    | "verified"
    | "blocked"
    | "evidence-required"
    | "changed"
    | "persistence-failure"
  > {
    let operation = this.operation(operationId);
    if (operation === undefined) return "changed";
    const requirements = requiredReconciliationPreservations(operation);
    if (requirements === undefined) return "changed";
    for (const requirement of requirements) {
      if (hasVerifiedReceipt(operation, requirement)) continue;
      const evidence = this.evidence(operation, requirement.originalPath);
      if (evidence === undefined) return "changed";
      const source =
        requirement.side === RECONCILIATION_PRESERVATION_SIDE.local
          ? await this.readExactLocal(evidence)
          : await this.readExactRemote(evidence);
      if (typeof source === "string") return "changed";
      const result = await this.preservation.preserve({
        operationId,
        side: requirement.side,
        content: source.content,
      });
      if (result.kind === "rejected") {
        return result.reason === "persistence-failure"
          ? "persistence-failure"
          : "changed";
      }
      if (result.kind !== "verified") return result.kind;
      operation = this.operation(operationId);
      if (operation === undefined) return "changed";
    }
    return "verified";
  }

  /**
   * Executes or evidence-recovers one exact conditional v2 mutation.
   * @param operationId - Active durable M4 operation.
   * @param request - Evidence-derived conditional request using the operation identity.
   * @param options - Aggregate effect and immediate baseline policy.
   * @returns Exact settlement with no hidden retry loop.
   */
  async mutateRemote(
    operationId: MirrorOperationId,
    request: ConditionalMutationRequest,
    options: ReconciliationRemoteMutationOptions,
  ): Promise<ReconciliationRemoteMutationSettlement> {
    const operation = this.operation(operationId);
    const before = this.stateOwner.snapshot();
    if (
      operation === undefined ||
      !isNonHistoryReconciliationOperation(operation) ||
      request.operationId !== operationId
    ) {
      return {
        kind: "rejected",
        reason: "operation-not-active",
        snapshot: before,
      };
    }
    const requestHash =
      request.action === MUTATION_ACTION.tombstone
        ? undefined
        : await this.hash(request.content);
    if (
      request.action !== MUTATION_ACTION.tombstone &&
      requestHash === undefined
    ) {
      return { kind: "rejected", reason: "evidence-changed", snapshot: before };
    }
    const current = await this.remote.inspectNote(request.path);
    if (current.kind === "success") {
      const acknowledgement = acknowledgementForRequest(
        current.value,
        request,
        requestHash,
      );
      if (acknowledgement !== undefined) {
        return this.persistRemoteConfirmation(
          operationId,
          acknowledgement,
          options,
        );
      }
    }
    if (
      operation.observationCoverage ===
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired ||
      operation.phase === RECONCILIATION_OPERATION_PHASE.mutatingRemote ||
      (operation.phase === RECONCILIATION_OPERATION_PHASE.evidenceRequired &&
        operation.remoteEffect === MUTATION_EFFECT_CERTAINTY.unknown)
    ) {
      return {
        kind: "evidence-required",
        snapshot: this.stateOwner.snapshot(),
      };
    }
    if (
      current.kind !== "success" ||
      !requestPreconditionMatches(current.value, request)
    ) {
      return this.blockRemote(operationId, "evidence-changed");
    }
    const prepared = await this.stateOwner.transition((state) => {
      const currentOperation = activeNonHistoryOperation(state, operationId);
      if (
        currentOperation === undefined ||
        !isDurableMutationAdmissionAllowed(state)
      ) {
        return undefined;
      }
      return replaceOperation(state, {
        ...currentOperation,
        phase: RECONCILIATION_OPERATION_PHASE.mutatingRemote,
        remoteEffect: options.aggregateEffect
          ? MUTATION_EFFECT_CERTAINTY.notDispatched
          : currentOperation.remoteEffect,
      });
    });
    if (prepared.kind !== "committed") {
      return {
        kind: "rejected",
        reason: prepared.snapshot.persistenceAvailable
          ? "operation-not-active"
          : "persistence-failure",
        snapshot: prepared.snapshot,
      };
    }
    const result = await this.remote.mutateNote(request);
    if (result.kind === MUTATION_EFFECT_CERTAINTY.confirmed) {
      if (
        !acknowledgementMatchesRequest(result.confirmed, request, requestHash)
      ) {
        return this.persistUnknownRemote(operationId);
      }
      return this.persistRemoteConfirmation(
        operationId,
        result.confirmed,
        options,
      );
    }
    if (result.effect === MUTATION_EFFECT_CERTAINTY.unknown) {
      return this.persistUnknownRemote(operationId);
    }
    return this.blockRemote(operationId, "remote-effect-failed");
  }

  /**
   * Atomically records final baselines, terminal effects, and linked review completion.
   * @param operationId - Exact active operation.
   * @param acknowledgements - Baselines proven by sampled or mutation evidence.
   * @param localEffect - Aggregate local effect certainty required by the action.
   * @param remoteEffect - Aggregate remote effect certainty required by the action.
   * @returns Committed snapshot or persistence/validation rejection.
   */
  async complete(
    operationId: MirrorOperationId,
    acknowledgements: readonly MutationAcknowledgement[],
    localEffect: MutationEffectCertainty,
    remoteEffect: MutationEffectCertainty,
  ): Promise<MirrorStateSnapshot | undefined> {
    const committed = await this.stateOwner.transition((state) => {
      const operation = activeNonHistoryOperation(state, operationId);
      if (operation === undefined) return undefined;
      let next = state;
      for (const acknowledgement of acknowledgements) {
        const updated = recordAcknowledgement(next, acknowledgement, true);
        if (updated === undefined) return undefined;
        next = updated;
      }
      const successorObserved =
        "successor" in operation.localEffectObservation &&
        operation.localEffectObservation.successor !== null;
      const gapFenced =
        operation.observationCoverage ===
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired;
      next = replaceOperation(next, {
        ...operation,
        phase: gapFenced
          ? operation.phase
          : successorObserved
            ? RECONCILIATION_OPERATION_PHASE.successorReviewRequired
            : RECONCILIATION_OPERATION_PHASE.completed,
        localEffect,
        remoteEffect,
      });
      return gapFenced || successorObserved
        ? next
        : completeReview(next, operation.reviewId);
    });
    return committed.kind === "committed" ? committed.snapshot : undefined;
  }

  /**
   * @param content - Exact transient UTF-8 text.
   * @returns Safe digest, or an impossible sentinel when hashing is unavailable.
   */
  private async hash(content: string): Promise<ContentSha256 | undefined> {
    try {
      return await this.runtime.hashContent(content);
    } catch {
      return undefined;
    }
  }

  /**
   * Persists an exact remote receipt and optional path baseline.
   * @param operationId - Active operation identity.
   * @param acknowledgement - Exact conditional mutation receipt.
   * @param options - Aggregate effect and baseline policy.
   * @returns Confirmed settlement only after durable persistence.
   */
  private async persistRemoteConfirmation(
    operationId: MirrorOperationId,
    acknowledgement: MutationAcknowledgement,
    options: ReconciliationRemoteMutationOptions,
  ): Promise<ReconciliationRemoteMutationSettlement> {
    const committed = await this.stateOwner.transition((state) => {
      const operation = activeNonHistoryOperation(state, operationId);
      if (operation === undefined) return undefined;
      const withAcknowledgement = options.recordAcknowledgement
        ? recordAcknowledgement(state, acknowledgement, false)
        : state;
      if (withAcknowledgement === undefined) return undefined;
      const remoteEffect = options.aggregateEffect
        ? MUTATION_EFFECT_CERTAINTY.confirmed
        : operation.remoteEffect;
      const successorObserved =
        "successor" in operation.localEffectObservation &&
        operation.localEffectObservation.successor !== null;
      return replaceOperation(withAcknowledgement, {
        ...operation,
        phase:
          operation.observationCoverage ===
          RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired
            ? operation.phase
            : successorObserved &&
                (remoteEffect === MUTATION_EFFECT_CERTAINTY.confirmed ||
                  operation.localEffect === MUTATION_EFFECT_CERTAINTY.confirmed)
              ? RECONCILIATION_OPERATION_PHASE.successorReviewRequired
              : RECONCILIATION_OPERATION_PHASE.partial,
        remoteEffect,
      });
    });
    if (committed.kind !== "committed") {
      return {
        kind: "rejected",
        reason: "persistence-failure",
        snapshot: committed.snapshot,
      };
    }
    return { kind: "confirmed", acknowledgement, snapshot: committed.snapshot };
  }

  /**
   * Persists ambiguous remote effect evidence without redispatching it.
   * @param operationId - Active operation identity.
   * @returns Evidence-required settlement.
   */
  private async persistUnknownRemote(
    operationId: MirrorOperationId,
  ): Promise<ReconciliationRemoteMutationSettlement> {
    const committed = await this.stateOwner.transition((state) => {
      const operation = activeNonHistoryOperation(state, operationId);
      if (operation === undefined) return undefined;
      return replaceOperation(state, {
        ...operation,
        phase: RECONCILIATION_OPERATION_PHASE.evidenceRequired,
        remoteEffect: MUTATION_EFFECT_CERTAINTY.unknown,
      });
    });
    return committed.kind === "committed"
      ? { kind: "evidence-required", snapshot: committed.snapshot }
      : {
          kind: "rejected",
          reason: "persistence-failure",
          snapshot: committed.snapshot,
        };
  }

  /**
   * Persists a finite blocked remote outcome.
   * @param operationId - Active operation identity.
   * @param _reason - Sanitized trigger retained only for caller classification.
   * @returns Blocked settlement after durable persistence.
   */
  private async blockRemote(
    operationId: MirrorOperationId,
    _reason: "evidence-changed" | "remote-effect-failed",
  ): Promise<ReconciliationRemoteMutationSettlement> {
    const committed = await this.stateOwner.transition((state) => {
      const operation = activeNonHistoryOperation(state, operationId);
      if (operation === undefined) return undefined;
      return replaceOperation(state, {
        ...operation,
        phase: RECONCILIATION_OPERATION_PHASE.blocked,
        remoteEffect:
          operation.remoteEffect === MUTATION_EFFECT_CERTAINTY.unknown
            ? MUTATION_EFFECT_CERTAINTY.unknown
            : MUTATION_EFFECT_CERTAINTY.definitelyRefused,
      });
    });
    return committed.kind === "committed"
      ? { kind: "blocked", snapshot: committed.snapshot }
      : {
          kind: "rejected",
          reason: "persistence-failure",
          snapshot: committed.snapshot,
        };
  }
}

/** @returns Active operation retaining reservation ownership. */
function activeOperation(
  state: MirrorDeviceState,
  operationId: MirrorOperationId,
): ReconciliationOperation | undefined {
  return state.reconciliationOperations.find(
    (operation) =>
      operation.operationId === operationId &&
      operation.phase !== RECONCILIATION_OPERATION_PHASE.completed &&
      operation.phase !== RECONCILIATION_OPERATION_PHASE.stale,
  );
}

/** @returns Active non-history operation whose aggregate effect fields are authoritative. */
function activeNonHistoryOperation(
  state: MirrorDeviceState,
  operationId: MirrorOperationId,
): ReconciliationNonHistoryOperation | undefined {
  const operation = activeOperation(state, operationId);
  return operation !== undefined &&
    isNonHistoryReconciliationOperation(operation)
    ? operation
    : undefined;
}

/** @returns Whether one verified receipt proves the exact preservation requirement. */
function hasVerifiedReceipt(
  operation: ReconciliationOperation,
  requirement: RequiredReconciliationPreservation,
): boolean {
  return operation.preservationReceipts.some(
    (receipt) =>
      receipt.originalPath === requirement.originalPath &&
      receipt.side === requirement.side &&
      receipt.sourceRevision === requirement.sourceRevision &&
      receipt.contentSha256 === requirement.contentSha256 &&
      receipt.proofState === RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
  );
}

/** @returns Whether current metadata exactly matches immutable sampled remote evidence. */
function remoteEvidenceMatches(
  expected: ReconciliationRemoteEvidence,
  current: CurrentNoteState,
): boolean {
  switch (expected.kind) {
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.absent:
      return current.kind === CURRENT_NOTE_STATE_KIND.absent;
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy:
      return current.kind === CURRENT_NOTE_STATE_KIND.legacy;
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.unavailable:
      return false;
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.live:
      return (
        current.kind === CURRENT_NOTE_STATE_KIND.live &&
        current.revision === expected.revision &&
        current.contentSha256 === expected.contentSha256 &&
        receiptEquals(current.receipt, expected.receipt)
      );
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone:
      return (
        current.kind === CURRENT_NOTE_STATE_KIND.tombstone &&
        current.revision === expected.revision &&
        current.deletedRevision === expected.deletedRevision &&
        current.recoveryId === expected.recoveryId &&
        receiptEquals(current.receipt, expected.receipt)
      );
  }
}

/** @returns Whether complete operation receipts identify the same exact request. */
function receiptEquals(
  left: OperationReceipt,
  right: OperationReceipt,
): boolean {
  return (
    left.action === right.action &&
    left.associationId === right.associationId &&
    left.operationId === right.operationId &&
    preconditionEquals(left.precondition, right.precondition) &&
    (left.action === MUTATION_ACTION.tombstone ||
      (right.action !== MUTATION_ACTION.tombstone &&
        left.contentSha256 === right.contentSha256))
  );
}

/**
 * @param left - First conditional predicate.
 * @param right - Second conditional predicate.
 * @returns Whether conditional predicates are exactly equal.
 */
function preconditionEquals(
  left: ConditionalMutationRequest["precondition"],
  right: ConditionalMutationRequest["precondition"],
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === CONDITIONAL_MUTATION_PRECONDITION_KIND.absent ||
      (right.kind === CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision &&
        left.revision === right.revision))
  );
}

/** @returns Whether current remote state still satisfies the original request predicate. */
function requestPreconditionMatches(
  current: CurrentNoteState,
  request: ConditionalMutationRequest,
): boolean {
  if (
    request.precondition.kind === CONDITIONAL_MUTATION_PRECONDITION_KIND.absent
  ) {
    return current.kind === CURRENT_NOTE_STATE_KIND.absent;
  }
  return (
    (current.kind === CURRENT_NOTE_STATE_KIND.live ||
      current.kind === CURRENT_NOTE_STATE_KIND.tombstone) &&
    current.revision === request.precondition.revision
  );
}

/** @returns Exact acknowledgement only when current state proves this request committed. */
function acknowledgementForRequest(
  current: CurrentNoteState,
  request: ConditionalMutationRequest,
  requestHash: ContentSha256 | undefined,
): MutationAcknowledgement | undefined {
  if (
    current.kind !== CURRENT_NOTE_STATE_KIND.live &&
    current.kind !== CURRENT_NOTE_STATE_KIND.tombstone
  ) {
    return undefined;
  }
  const acknowledgement = {
    path: current.path,
    revision: current.revision,
    receipt: current.receipt,
  };
  return acknowledgementMatchesRequest(acknowledgement, request, requestHash)
    ? acknowledgement
    : undefined;
}

/** @returns Whether an acknowledgement exactly proves the conditional request. */
function acknowledgementMatchesRequest(
  acknowledgement: MutationAcknowledgement,
  request: ConditionalMutationRequest,
  requestHash: ContentSha256 | undefined,
): boolean {
  const receipt = acknowledgement.receipt;
  return (
    acknowledgement.path === request.path &&
    receipt.action === request.action &&
    receipt.associationId === request.associationId &&
    receipt.operationId === request.operationId &&
    preconditionEquals(receipt.precondition, request.precondition) &&
    (request.action === MUTATION_ACTION.tombstone ||
      (receipt.action !== MUTATION_ACTION.tombstone &&
        requestHash !== undefined &&
        receipt.contentSha256 === requestHash))
  );
}

/**
 * Records a proven baseline without consuming or inventing M3 mutation intent.
 * Content receipt hash is authoritative because the Worker validated the exact body.
 * @param state - Current durable state.
 * @param acknowledgement - Exact proven remote generation.
 * @param clearBlock - Whether completed resolution releases the path blocker.
 * @returns Updated state, or undefined when capacity or M3 ownership prevents adoption.
 */
function recordAcknowledgement(
  state: MirrorDeviceState,
  acknowledgement: MutationAcknowledgement,
  clearBlock: boolean,
): MirrorDeviceState | undefined {
  const baseline = baselineForAcknowledgement(acknowledgement);
  const index = state.paths.findIndex(
    (entry) => entry.path === acknowledgement.path,
  );
  if (index < 0) {
    if (state.paths.length >= MAX_MIRROR_TRACKED_PATHS) return undefined;
    return {
      ...state,
      paths: [
        ...state.paths,
        {
          path: acknowledgement.path,
          acknowledgement: baseline,
          unresolvedMutation: null,
          desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
          blockedReason: null,
        },
      ],
    };
  }
  const existing = state.paths[index];
  if (existing === undefined || existing.unresolvedMutation !== null)
    return undefined;
  const replacement: MirrorPathState = {
    ...existing,
    acknowledgement: baseline,
    blockedReason: clearBlock ? null : existing.blockedReason,
  };
  return {
    ...state,
    paths: state.paths.map((entry, entryIndex) =>
      entryIndex === index ? replacement : entry,
    ),
  };
}

/** @returns Mirror acknowledgement derived from one exact v2 mutation receipt. */
function baselineForAcknowledgement(
  acknowledgement: MutationAcknowledgement,
): MirrorAcknowledgement {
  if (acknowledgement.receipt.action === MUTATION_ACTION.tombstone) {
    return {
      kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
      revision: acknowledgement.revision,
      recoveryId: acknowledgement.receipt.operationId,
    };
  }
  return {
    kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
    revision: acknowledgement.revision,
    contentSha256: acknowledgement.receipt.contentSha256,
  };
}

/** @returns State with one operation replacement and every unrelated reservation intact. */
function replaceOperation(
  state: MirrorDeviceState,
  replacement: ReconciliationOperation,
): MirrorDeviceState {
  return {
    ...state,
    reconciliationOperations: state.reconciliationOperations.map((operation) =>
      operation.operationId === replacement.operationId
        ? replacement
        : operation,
    ),
  };
}

/** @returns State with the operation's linked durable review marked terminal. */
function completeReview(
  state: MirrorDeviceState,
  reviewId: MirrorOperationId,
): MirrorDeviceState {
  return {
    ...state,
    reconciliationReviews: state.reconciliationReviews.map((review) =>
      review.reviewId === reviewId
        ? { ...review, status: RECONCILIATION_REVIEW_STATUS.completed }
        : review,
    ),
  };
}
