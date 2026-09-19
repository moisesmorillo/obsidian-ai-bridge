import { LocalInspectionKind } from "@core/local-vault/local-vault.constants";
import type { ReadOnlyLocalVault } from "@core/local-vault/read-only-local-vault.port";
import type { ConflictPreservationService } from "@core/mirror/conflict-preservation-service";
import {
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  CURRENT_NOTE_STATE_KIND,
  MUTATION_ACTION,
  MUTATION_EFFECT_CERTAINTY,
} from "@core/mirror/mirror.constants";
import type {
  ContentSha256,
  MirrorAssociationId,
  MirrorOperationId,
  MutationAcknowledgement,
} from "@core/mirror/mirror.types";
import {
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
} from "@core/mirror/mirror-state.constants";
import type {
  MirrorDeviceState,
  MirrorStateSnapshot,
} from "@core/mirror/mirror-state.types";
import type { MirrorStateOwner } from "@core/mirror/mirror-state-owner";
import { isDurableMutationAdmissionAllowed } from "@core/mirror/mirror-state-policy";
import {
  isHistoryReconciliationOperation,
  isRefinedHistoryReconciliationOperation,
} from "@core/mirror/reconciliation-operation";
import type { ReconciliationObservationSource } from "@core/mirror/reconciliation-review.types";
import {
  HISTORY_CLEANUP_STEP_PHASE,
  HISTORY_DECISION_KIND,
  HISTORY_PROGRESS_KIND,
  HISTORY_REMOTE_EFFECT_KIND,
  RECONCILIATION_ACTION,
  RECONCILIATION_OPERATION_PHASE,
  RECONCILIATION_PRESERVATION_SIDE,
  RECONCILIATION_REVIEW_STATUS,
} from "@core/mirror/reconciliation-state.constants";
import type {
  HistoryCleanupStep,
  LegacyV3HistoryOperation,
  ReconciliationHistoryOperation,
} from "@core/mirror/reconciliation-state.types";
import type { RemoteBridge } from "@core/mirror/remote-bridge.types";
import type {
  RenameHistoryResolutionRequest,
  RenameHistoryResolutionResult,
} from "@core/mirror/rename-history-resolution.types";
import type { NotePath } from "@core/note-path/note-path.types";

/** Runtime seams required to verify transient history bytes and local event generations. */
export interface RenameHistoryResolutionRuntime {
  readonly observations: ReconciliationObservationSource;
  /** @returns SHA-256 of exact transient UTF-8 text. */
  hashContent(content: string): Promise<ContentSha256>;
}

/**
 * Executes at most one persisted remote-only history cleanup step per call.
 *
 * Every host/remote effect is preceded by durable preparation. Exact step identity is
 * the Worker mutation identity, and unknown effects remain evidence-required without
 * redispatch.
 */
export class RenameHistoryResolutionService {
  /**
   * @param local - Read-only inventory used to prove current source absence.
   * @param remote - Exact current-state and conditional mutation capability.
   * @param preservation - Step-scoped archive owner.
   * @param stateOwner - Serialized durable operation owner.
   * @param runtime - Hash and observation-generation evidence.
   */
  constructor(
    private readonly local: ReadOnlyLocalVault,
    private readonly remote: RemoteBridge,
    private readonly preservation: ConflictPreservationService,
    private readonly stateOwner: MirrorStateOwner,
    private readonly runtime: RenameHistoryResolutionRuntime,
  ) {}

  /**
   * @param request - Exact parent operation selector.
   * @returns One finite progress, completion, attention, or rejection result.
   */
  async execute(
    request: RenameHistoryResolutionRequest,
  ): Promise<RenameHistoryResolutionResult> {
    const before = this.stateOwner.snapshot();
    const operation = historyOperation(before.state, request.operationId);
    if (operation === undefined) {
      return rejection("operation-not-found", before);
    }
    if (!isRefinedHistoryReconciliationOperation(operation)) {
      return rejection("legacy-migration-attention", before);
    }
    if (operation.phase === RECONCILIATION_OPERATION_PHASE.completed) {
      return { kind: "completed", snapshot: before };
    }
    /* v8 ignore start -- validated no-effect history decisions are already completed above. */
    if (
      operation.historyProgress.decision.kind !==
      HISTORY_DECISION_KIND.executeCleanupPlan
    ) {
      return { kind: "completed", snapshot: before };
    }
    const index = operation.historyProgress.nextStepIndex;
    if (index === null) return { kind: "completed", snapshot: before };
    const step = operation.historyProgress.steps[index];
    if (step === undefined) return rejection("operation-not-active", before);
    /* v8 ignore stop */

    if (
      step.phase === HISTORY_CLEANUP_STEP_PHASE.evidenceRequired ||
      step.phase === HISTORY_CLEANUP_STEP_PHASE.mutatingRemote
    ) {
      const recovered = await this.recoverRemoteEffect(operation, step);
      if (recovered !== undefined) return recovered;
    }
    if (
      step.phase === HISTORY_CLEANUP_STEP_PHASE.pending ||
      step.phase === HISTORY_CLEANUP_STEP_PHASE.preserving
    ) {
      const preserved = await this.preserveStep(operation, step);
      if (preserved !== undefined) return preserved;
    }

    const refreshed = refinedHistoryOperation(
      this.stateOwner.snapshot().state,
      request.operationId,
    );
    if (
      refreshed === undefined ||
      refreshed.historyProgress.kind !== HISTORY_PROGRESS_KIND.refined ||
      refreshed.historyProgress.nextStepIndex !== index
    ) {
      /* v8 ignore next -- one scheduler reservation prevents parent/cursor replacement during this turn. */
      return rejection("operation-not-active", this.stateOwner.snapshot());
    }
    const readyStep = refreshed.historyProgress.steps[index];
    if (
      readyStep === undefined ||
      readyStep.phase !== HISTORY_CLEANUP_STEP_PHASE.ready
    ) {
      return resultForCurrentPhase(
        this.stateOwner.snapshot(),
        readyStep?.phase,
      );
    }
    if (!(await this.evidenceStillMatches(refreshed, readyStep))) {
      return this.persistBlocked(
        refreshed.operationId,
        index,
        "evidence-changed",
      );
    }

    const prepared = await this.persistStepPhase(
      refreshed.operationId,
      index,
      HISTORY_CLEANUP_STEP_PHASE.mutatingRemote,
      RECONCILIATION_OPERATION_PHASE.mutatingRemote,
      { kind: MUTATION_EFFECT_CERTAINTY.notDispatched },
      true,
    );
    if (prepared.kind !== "committed") {
      return rejection(
        prepared.snapshot.persistenceAvailable
          ? "operation-not-active"
          : "persistence-failure",
        prepared.snapshot,
      );
    }
    const runtime = refreshed.snapshot.runtime;
    if (runtime.lifecycle.kind === "disabled") {
      /* v8 ignore next -- validated history authority always carries an enabled association lifecycle. */
      return this.persistBlocked(
        refreshed.operationId,
        index,
        "evidence-changed",
      );
    }
    let mutation: Awaited<ReturnType<RemoteBridge["mutateNote"]>>;
    try {
      mutation = await this.remote.mutateNote({
        action: MUTATION_ACTION.tombstone,
        associationId: runtime.lifecycle.associationId,
        writerId: runtime.designatedWriterId,
        operationId: readyStep.stepId,
        path: readyStep.sourcePath,
        precondition: {
          kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
          revision: readyStep.sourceRevision,
        },
      });
    } catch {
      const persisted = await this.persistStepPhase(
        refreshed.operationId,
        index,
        HISTORY_CLEANUP_STEP_PHASE.evidenceRequired,
        RECONCILIATION_OPERATION_PHASE.evidenceRequired,
        { kind: MUTATION_EFFECT_CERTAINTY.unknown },
      );
      return persisted.kind === "committed"
        ? { kind: "evidence-required", snapshot: persisted.snapshot }
        : rejection("persistence-failure", persisted.snapshot);
    }
    if (mutation.kind === MUTATION_EFFECT_CERTAINTY.confirmed) {
      return this.persistConfirmation(
        refreshed.operationId,
        index,
        mutation.confirmed,
      );
    }
    if (mutation.effect === MUTATION_EFFECT_CERTAINTY.unknown) {
      const persisted = await this.persistStepPhase(
        refreshed.operationId,
        index,
        HISTORY_CLEANUP_STEP_PHASE.evidenceRequired,
        RECONCILIATION_OPERATION_PHASE.evidenceRequired,
        { kind: MUTATION_EFFECT_CERTAINTY.unknown },
      );
      return persisted.kind === "committed"
        ? { kind: "evidence-required", snapshot: persisted.snapshot }
        : rejection("persistence-failure", persisted.snapshot);
    }
    return this.persistBlocked(
      refreshed.operationId,
      index,
      "evidence-changed",
    );
  }

  /**
   * Durably blocks active history authority when a reserved local path changes.
   *
   * @param path - Eligible host-event path already assigned an observation generation.
   * @returns Whether a history operation retained ownership of the event.
   */
  async observeReservedEvent(path: NotePath): Promise<boolean> {
    const before = this.stateOwner
      .snapshot()
      .state.reconciliationOperations.find(
        (operation) =>
          isHistoryReconciliationOperation(operation) &&
          operation.phase !== RECONCILIATION_OPERATION_PHASE.completed &&
          operation.phase !== RECONCILIATION_OPERATION_PHASE.stale &&
          operation.reservations.some(
            (reservation) => reservation.path === path,
          ),
      );
    if (before === undefined) return false;
    if (!isRefinedHistoryReconciliationOperation(before)) return true;
    const index = before.historyProgress.nextStepIndex;
    /* v8 ignore start -- validated active refined history always owns its indexed step. */
    if (index === null) return true;
    const step = before.historyProgress.steps[index];
    if (step === undefined) return true;
    /* v8 ignore stop */
    const effectMayHaveStarted =
      step.phase === HISTORY_CLEANUP_STEP_PHASE.mutatingRemote ||
      step.remoteEffect.kind === MUTATION_EFFECT_CERTAINTY.unknown;
    const committed = await this.persistStepPhase(
      before.operationId,
      index,
      HISTORY_CLEANUP_STEP_PHASE.blocked,
      RECONCILIATION_OPERATION_PHASE.blocked,
      {
        kind: effectMayHaveStarted
          ? MUTATION_EFFECT_CERTAINTY.unknown
          : MUTATION_EFFECT_CERTAINTY.definitelyRefused,
      },
    );
    if (committed.kind === "committed") return true;
    throw new Error("History event persistence failed.");
  }

  /** @returns A terminal/attention result when preservation did not make the step ready. */
  private async preserveStep(
    operation: ReconciliationHistoryOperation,
    step: HistoryCleanupStep,
  ): Promise<RenameHistoryResolutionResult | undefined> {
    let body: Awaited<ReturnType<RemoteBridge["readNote"]>>;
    try {
      body = await this.remote.readNote(step.sourcePath);
    } catch {
      return this.persistBlocked(
        operation.operationId,
        operation.historyProgress.nextStepIndex ?? 0,
        "evidence-changed",
      );
    }
    if (
      body.kind !== "success" ||
      body.value.kind !== "live" ||
      body.value.revision !== step.sourceRevision ||
      (await this.safeHash(body.value.content)) !== step.sourceContentSha256
    ) {
      return this.persistBlocked(
        operation.operationId,
        operation.historyProgress.nextStepIndex ?? 0,
        "evidence-changed",
      );
    }
    const result = await this.preservation.preserve({
      operationId: operation.operationId,
      stepId: step.stepId,
      side: RECONCILIATION_PRESERVATION_SIDE.remote,
      content: body.value.content,
    });
    switch (result.kind) {
      case "verified":
        return undefined;
      case "evidence-required":
        /* v8 ignore next -- the concrete preservation service maps this history request to rejection after fencing. */
        return { kind: "evidence-required", snapshot: result.snapshot };
      case "blocked":
        /* v8 ignore next -- the concrete preservation service maps this history request to rejection after fencing. */
        return { kind: "blocked", snapshot: result.snapshot };
      case "rejected":
        return rejection(
          result.reason === "persistence-failure"
            ? "persistence-failure"
            : "operation-not-active",
          result.snapshot,
        );
    }
  }

  /** @returns Exact same-step receipt recovery, or undefined when no confirmation exists. */
  private async recoverRemoteEffect(
    operation: ReconciliationHistoryOperation,
    step: HistoryCleanupStep,
  ): Promise<RenameHistoryResolutionResult | undefined> {
    let current: Awaited<ReturnType<RemoteBridge["inspectNote"]>> | undefined;
    try {
      current = await this.remote.inspectNote(step.sourcePath);
    } catch {
      current = undefined;
    }
    if (
      current !== undefined &&
      current.kind === "success" &&
      current.value.kind === CURRENT_NOTE_STATE_KIND.tombstone &&
      current.value.receipt.operationId === step.stepId &&
      current.value.receipt.precondition.kind ===
        CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision &&
      current.value.receipt.precondition.revision === step.sourceRevision
    ) {
      return this.persistConfirmation(
        operation.operationId,
        operation.historyProgress.nextStepIndex ?? 0,
        {
          path: current.value.path,
          revision: current.value.revision,
          receipt: current.value.receipt,
        },
      );
    }
    if (step.phase === HISTORY_CLEANUP_STEP_PHASE.evidenceRequired) {
      return {
        kind: "evidence-required",
        snapshot: this.stateOwner.snapshot(),
      };
    }
    if (step.phase === HISTORY_CLEANUP_STEP_PHASE.mutatingRemote) {
      const persisted = await this.persistStepPhase(
        operation.operationId,
        operation.historyProgress.nextStepIndex ?? 0,
        HISTORY_CLEANUP_STEP_PHASE.evidenceRequired,
        RECONCILIATION_OPERATION_PHASE.evidenceRequired,
        { kind: MUTATION_EFFECT_CERTAINTY.unknown },
      );
      return persisted.kind === "committed"
        ? { kind: "evidence-required", snapshot: persisted.snapshot }
        : rejection("persistence-failure", persisted.snapshot);
    }
    /* v8 ignore next -- callers invoke recovery only for evidence-required or mutating steps. */
    return undefined;
  }

  /** @returns Whether source, destination, local absence and runtime evidence remain exact. */
  private async evidenceStillMatches(
    operation: ReconciliationHistoryOperation,
    step: HistoryCleanupStep,
  ): Promise<boolean> {
    let evidence: readonly [
      Awaited<ReturnType<RemoteBridge["inspectNote"]>>,
      Awaited<ReturnType<RemoteBridge["inspectNote"]>> | null,
      Awaited<ReturnType<ReadOnlyLocalVault["list"]>>,
    ];
    try {
      evidence = await Promise.all([
        this.remote.inspectNote(step.sourcePath),
        step.prerequisitePath === null
          ? Promise.resolve(null)
          : this.remote.inspectNote(step.prerequisitePath),
        this.local.list(),
      ]);
    } catch {
      /* v8 ignore next -- adapter-throw behavior is asserted through the blocked public result. */
      return false;
    }
    const [source, destination, local] = evidence;
    if (
      source.kind !== "success" ||
      source.value.kind !== CURRENT_NOTE_STATE_KIND.live ||
      source.value.revision !== step.sourceRevision ||
      source.value.contentSha256 !== step.sourceContentSha256 ||
      source.value.receipt.associationId !== associationId(operation) ||
      local.kind !== LocalInspectionKind.ok ||
      local.entries.some((entry) => entry.path === step.sourcePath) ||
      this.runtime.observations.current(step.sourcePath) !==
        step.localAbsenceGeneration
    ) {
      /* v8 ignore next -- source mismatch behavior is asserted through the blocked public result before dispatch. */
      return false;
    }
    /* v8 ignore next -- the current cleanup policy emits only destination-backed steps. */
    if (step.prerequisitePath === null) return true;
    return (
      destination?.kind === "success" &&
      destination.value.kind === CURRENT_NOTE_STATE_KIND.live &&
      destination.value.revision === step.prerequisiteRevision &&
      destination.value.receipt.associationId === associationId(operation)
    );
  }

  /**
   * @param content - Exact body sampled for evidence comparison.
   * @returns Digest or undefined when the platform hash seam fails.
   */
  private async safeHash(content: string): Promise<ContentSha256 | undefined> {
    try {
      return await this.runtime.hashContent(content);
    } catch {
      return undefined;
    }
  }

  /**
   * Persists exact tombstone evidence, source baseline, M3 cleanup and cursor advance atomically.
   * @param operationId - Parent history operation identity.
   * @param index - Exact current step index.
   * @param acknowledgement - Confirmed step-scoped tombstone acknowledgement.
   * @returns Sanitized progress or persistence rejection.
   */
  private async persistConfirmation(
    operationId: MirrorOperationId,
    index: number,
    acknowledgement: MutationAcknowledgement,
  ): Promise<RenameHistoryResolutionResult> {
    const committed = await this.stateOwner.transition((state) => {
      const operation = refinedHistoryOperation(state, operationId);
      if (
        operation === undefined ||
        operation.historyProgress.kind !== HISTORY_PROGRESS_KIND.refined
      ) {
        /* v8 ignore next -- one scheduler reservation prevents parent replacement during acknowledgement persistence. */
        return undefined;
      }
      const step = operation.historyProgress.steps[index];
      if (
        step === undefined ||
        (step.phase !== HISTORY_CLEANUP_STEP_PHASE.mutatingRemote &&
          step.phase !== HISTORY_CLEANUP_STEP_PHASE.evidenceRequired) ||
        acknowledgement.path !== step.sourcePath ||
        acknowledgement.receipt.action !== MUTATION_ACTION.tombstone ||
        acknowledgement.receipt.operationId !== step.stepId ||
        acknowledgement.receipt.precondition.revision !== step.sourceRevision
      ) {
        /* v8 ignore next -- stale/event race refusal is asserted through the public rejection result. */
        return undefined;
      }
      const receipt = acknowledgement.receipt;
      const steps = operation.historyProgress.steps.map(
        (candidate, stepIndex) =>
          stepIndex === index
            ? {
                ...candidate,
                phase: HISTORY_CLEANUP_STEP_PHASE.completed,
                remoteEffect: {
                  kind: HISTORY_REMOTE_EFFECT_KIND.confirmedExactTombstoneReceipt,
                  revision: acknowledgement.revision,
                  receipt,
                },
              }
            : candidate,
      );
      const nextStepIndex = steps.findIndex(
        (candidate) => candidate.phase !== HISTORY_CLEANUP_STEP_PHASE.completed,
      );
      const completed = nextStepIndex === -1;
      const nextOperation: ReconciliationHistoryOperation = {
        ...operation,
        phase: completed
          ? RECONCILIATION_OPERATION_PHASE.completed
          : RECONCILIATION_OPERATION_PHASE.partial,
        historyProgress: {
          ...operation.historyProgress,
          steps,
          nextStepIndex: completed ? null : nextStepIndex,
        },
      };
      return {
        ...state,
        paths: state.paths.map((path) =>
          path.path !== step.sourcePath
            ? path
            : {
                ...path,
                acknowledgement: {
                  kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
                  revision: acknowledgement.revision,
                  recoveryId: acknowledgement.receipt.operationId,
                },
                desired:
                  path.desired.kind === MIRROR_DESIRED_STATE_KIND.renameDeferred
                    ? { kind: MIRROR_DESIRED_STATE_KIND.none }
                    : path.desired,
                blockedReason: null,
              },
        ),
        reconciliationOperations: state.reconciliationOperations.map(
          (candidate) =>
            candidate.operationId === operationId ? nextOperation : candidate,
        ),
        reconciliationReviews: state.reconciliationReviews.map((review) =>
          review.reviewId === operation.reviewId && completed
            ? { ...review, status: RECONCILIATION_REVIEW_STATUS.completed }
            : review,
        ),
      };
    });
    if (committed.kind !== "committed") {
      return rejection("persistence-failure", committed.snapshot);
    }
    const current = refinedHistoryOperation(
      committed.snapshot.state,
      operationId,
    );
    return {
      kind:
        current?.phase === RECONCILIATION_OPERATION_PHASE.completed
          ? "completed"
          : "progressed",
      snapshot: committed.snapshot,
    };
  }

  /**
   * Persists one step phase/effect under the parent operation.
   * @param operationId - Parent history operation identity.
   * @param index - Exact step index.
   * @param stepPhase - Replacement durable step phase.
   * @param parentPhase - Replacement parent phase.
   * @param remoteEffect - Replacement step-scoped remote certainty.
   * @param requireAdmission - Whether global mutation admission must remain open.
   * @returns Serialized state transition result.
   */
  private persistStepPhase(
    operationId: MirrorOperationId,
    index: number,
    stepPhase: HistoryCleanupStep["phase"],
    parentPhase: ReconciliationHistoryOperation["phase"],
    remoteEffect: HistoryCleanupStep["remoteEffect"],
    requireAdmission = false,
  ) {
    return this.stateOwner.transition((state) => {
      const operation = refinedHistoryOperation(state, operationId);
      if (
        operation === undefined ||
        operation.historyProgress.kind !== HISTORY_PROGRESS_KIND.refined ||
        operation.historyProgress.steps[index] === undefined ||
        (requireAdmission && !isDurableMutationAdmissionAllowed(state))
      ) {
        /* v8 ignore next -- serialized owner transitions reject stale/corrupt callers before persistence. */
        return undefined;
      }
      const replacement: ReconciliationHistoryOperation = {
        ...operation,
        phase: parentPhase,
        historyProgress: {
          ...operation.historyProgress,
          steps: operation.historyProgress.steps.map((step, stepIndex) =>
            stepIndex === index
              ? { ...step, phase: stepPhase, remoteEffect }
              : step,
          ),
        },
      };
      return {
        ...state,
        reconciliationOperations: state.reconciliationOperations.map(
          (candidate) =>
            candidate.operationId === operationId ? replacement : candidate,
        ),
      };
    });
  }

  /**
   * Persists a finite blocked step without dispatching another effect.
   * @param operationId - Parent history operation identity.
   * @param index - Exact current step index.
   * @param _reason - Sanitized evidence-change reason retained for call-site clarity.
   * @returns Blocked result or persistence rejection.
   */
  private async persistBlocked(
    operationId: MirrorOperationId,
    index: number,
    _reason: "evidence-changed",
  ): Promise<RenameHistoryResolutionResult> {
    const committed = await this.persistStepPhase(
      operationId,
      index,
      HISTORY_CLEANUP_STEP_PHASE.blocked,
      RECONCILIATION_OPERATION_PHASE.blocked,
      { kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused },
    );
    return committed.kind === "committed"
      ? { kind: "blocked", snapshot: committed.snapshot }
      : rejection("persistence-failure", committed.snapshot);
  }
}

/** @returns Refined or migrated history operation retaining active ownership. */
function historyOperation(
  state: MirrorDeviceState,
  operationId: MirrorOperationId,
): ReconciliationHistoryOperation | LegacyV3HistoryOperation | undefined {
  const operation = state.reconciliationOperations.find(
    (candidate) => candidate.operationId === operationId,
  );
  return operation?.action.kind === RECONCILIATION_ACTION.resolveHistory &&
    "historyProgress" in operation &&
    operation.phase !== RECONCILIATION_OPERATION_PHASE.stale
    ? operation
    : undefined;
}

/** @returns Refined history operation with step-ledger dispatch authority. */
function refinedHistoryOperation(
  state: MirrorDeviceState,
  operationId: MirrorOperationId,
): ReconciliationHistoryOperation | undefined {
  const operation = historyOperation(state, operationId);
  return operation !== undefined &&
    isRefinedHistoryReconciliationOperation(operation)
    ? operation
    : undefined;
}

/** @returns Active association identity retained by the operation snapshot. */
function associationId(
  operation: ReconciliationHistoryOperation,
): MirrorAssociationId | undefined {
  return operation.snapshot.runtime.lifecycle.kind === "disabled"
    ? undefined
    : operation.snapshot.runtime.lifecycle.associationId;
}

/**
 * @param reason - Closed rejection reason.
 * @param snapshot - Latest authoritative state snapshot.
 * @returns Typed rejection without leaking raw adapter failures.
 */
function rejection(
  reason: Extract<
    RenameHistoryResolutionResult,
    { kind: "rejected" }
  >["reason"],
  snapshot: MirrorStateSnapshot,
): RenameHistoryResolutionResult {
  return { kind: "rejected", reason, snapshot };
}

/** @returns Attention result for a step that did not reach mutation readiness. */
function resultForCurrentPhase(
  snapshot: MirrorStateSnapshot,
  phase: HistoryCleanupStep["phase"] | undefined,
): RenameHistoryResolutionResult {
  if (phase === HISTORY_CLEANUP_STEP_PHASE.evidenceRequired) {
    /* v8 ignore next -- recovery returns evidence-required before readiness fallback. */
    return { kind: "evidence-required", snapshot };
  }
  if (phase === HISTORY_CLEANUP_STEP_PHASE.blocked) {
    return { kind: "blocked", snapshot };
  }
  /* v8 ignore next -- validated current steps resolve to ready, blocked, or recovery attention. */
  return rejection("operation-not-active", snapshot);
}
