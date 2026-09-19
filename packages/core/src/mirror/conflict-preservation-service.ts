import type {
  ConflictPreservationRequest,
  ConflictPreservationResult,
} from "@core/mirror/conflict-preservation-service.types";
import {
  LOCAL_RECONCILIATION_DISPATCH_MODE,
  LOCAL_RECONCILIATION_WRITE_OUTCOME,
} from "@core/mirror/local-reconciliation-writer.constants";
import type { LocalReconciliationWriter } from "@core/mirror/local-reconciliation-writer.port";
import { MUTATION_EFFECT_CERTAINTY } from "@core/mirror/mirror.constants";
import type { ContentSha256 } from "@core/mirror/mirror.types";
import type { MirrorDeviceState } from "@core/mirror/mirror-state.types";
import type { MirrorStateOwner } from "@core/mirror/mirror-state-owner";
import { isDurableMutationAdmissionAllowed } from "@core/mirror/mirror-state-policy";
import {
  isHistoryReconciliationOperation,
  isRefinedHistoryReconciliationOperation,
} from "@core/mirror/reconciliation-operation";
import { createReconciliationPreservationPath } from "@core/mirror/reconciliation-preservation-path";
import {
  type RequiredReconciliationPreservation,
  requiredReconciliationPreservations,
} from "@core/mirror/reconciliation-preservation-policy";
import {
  HISTORY_CLEANUP_STEP_PHASE,
  HISTORY_PROGRESS_KIND,
  RECONCILIATION_OPERATION_PHASE,
  RECONCILIATION_PRESERVATION_PROOF_STATE,
  RECONCILIATION_PRESERVATION_SCOPE,
} from "@core/mirror/reconciliation-state.constants";
import type {
  HistoryStepPreservationReceipt,
  ReconciliationHistoryOperation,
  ReconciliationOperation,
  ReconciliationPreservationReceipt,
} from "@core/mirror/reconciliation-state.types";

/** Hash seam used to bind transient source text to immutable sampled evidence. */
export interface ConflictPreservationCryptography {
  /** @returns SHA-256 of exact UTF-8 text without retaining the body. */
  hashContent(content: string): Promise<ContentSha256>;
}

/**
 * Orders one required preservation effect around the durable operation ledger.
 *
 * The service consumes the central preservation matrix, persists a pending receipt
 * before host I/O, verifies the writer result, and persists `verified` last. A save
 * failure never deletes the artifact: the pending durable phase lets the same
 * operation recover by exact generated path and hash after restart.
 */
export class ConflictPreservationService {
  /**
   * @param writer - Narrow host adapter with generated create-only preservation.
   * @param stateOwner - Serialized durable operation owner.
   * @param cryptography - Exact transient text digest provider.
   */
  constructor(
    private readonly writer: LocalReconciliationWriter,
    private readonly stateOwner: MirrorStateOwner,
    private readonly cryptography: ConflictPreservationCryptography,
  ) {}

  /**
   * Creates or same-operation-adopts one evidence-required artifact.
   *
   * @param request - Durable operation/side plus transient exact source bytes.
   * @returns Verified receipt only after post-write proof and durable persistence.
   */
  async preserve(
    request: ConflictPreservationRequest,
  ): Promise<ConflictPreservationResult> {
    const before = this.stateOwner.snapshot();
    if (!before.persistenceAvailable) {
      return {
        kind: "rejected",
        reason: "persistence-failure",
        snapshot: before,
      };
    }
    if (!before.mutationAdmissionAllowed) {
      return {
        kind: "rejected",
        reason: "operation-not-active",
        snapshot: before,
      };
    }
    const authorization = await this.authorize(before.state, request);
    if (authorization.kind === "rejected") {
      return { ...authorization, snapshot: before };
    }
    const prepared = await this.prepare(authorization);
    if (prepared.kind !== "prepared") return prepared;
    const result = await this.writer.createPreservation({
      operationId: request.operationId,
      ...(request.stepId === undefined ? {} : { stepId: request.stepId }),
      side: request.side,
      content: request.content,
      contentSha256: authorization.requirement.contentSha256,
      mode: authorization.mode,
    });
    if (
      result.kind === "confirmed" &&
      (result.outcome === LOCAL_RECONCILIATION_WRITE_OUTCOME.created ||
        result.outcome === LOCAL_RECONCILIATION_WRITE_OUTCOME.adopted) &&
      result.path === authorization.receipt.preservationPath &&
      result.contentSha256 === authorization.requirement.contentSha256
    ) {
      const receipt = {
        ...authorization.receipt,
        proofState: RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
      } satisfies ReconciliationPreservationReceipt;
      const committed = await this.persistReceipt(
        request.operationId,
        receipt,
        RECONCILIATION_OPERATION_PHASE.preserving,
      );
      if (committed.kind !== "committed") {
        return {
          kind: "rejected",
          reason: "persistence-failure",
          snapshot: committed.snapshot,
        };
      }
      return { kind: "verified", receipt, snapshot: committed.snapshot };
    }
    if (
      (result.kind === "failed" && result.effect === "unknown") ||
      result.kind === "confirmed"
    ) {
      const committed = await this.persistReceipt(
        request.operationId,
        {
          ...authorization.receipt,
          proofState: RECONCILIATION_PRESERVATION_PROOF_STATE.evidenceRequired,
        },
        RECONCILIATION_OPERATION_PHASE.evidenceRequired,
      );
      if (committed.kind !== "committed") {
        return {
          kind: "rejected",
          reason: "persistence-failure",
          snapshot: committed.snapshot,
        };
      }
      return { kind: "evidence-required", snapshot: committed.snapshot };
    }
    const committed = await this.persistReceipt(
      request.operationId,
      {
        ...authorization.receipt,
        proofState: RECONCILIATION_PRESERVATION_PROOF_STATE.blocked,
      },
      RECONCILIATION_OPERATION_PHASE.blocked,
    );
    if (committed.kind !== "committed") {
      return {
        kind: "rejected",
        reason: "persistence-failure",
        snapshot: committed.snapshot,
      };
    }
    return { kind: "blocked", snapshot: committed.snapshot };
  }

  /** @returns Evidence-bound authorization without changing durable state. */
  private async authorize(
    state: MirrorDeviceState,
    request: ConflictPreservationRequest,
  ): Promise<PreservationAuthorization | PreservationRejection> {
    const operation = state.reconciliationOperations.find(
      (candidate) => candidate.operationId === request.operationId,
    );
    if (operation === undefined) return rejection("operation-not-found");
    if (!isActive(operation)) return rejection("operation-not-active");
    const requirements = requiredReconciliationPreservations(operation);
    const requirement = requirements?.find(
      (candidate) =>
        candidate.side === request.side && candidate.stepId === request.stepId,
    );
    if (requirement === undefined)
      return rejection("preservation-not-required");
    if (
      !operation.reservations.some(
        (reservation) => reservation.path === requirement.originalPath,
      )
    ) {
      return rejection("reservation-mismatch");
    }
    let hash: ContentSha256 | undefined;
    try {
      hash = await this.cryptography.hashContent(request.content);
    } catch {
      hash = undefined;
    }
    if (hash !== requirement.contentSha256) {
      return rejection("source-evidence-mismatch");
    }
    const path = createReconciliationPreservationPath(
      operation.operationId,
      requirement.side,
      requirement.stepId,
    );
    /* c8 ignore next -- valid persisted operation IDs and closed sides always generate a path. */
    if (path === undefined) return rejection("source-evidence-mismatch");
    const existing = operation.preservationReceipts.find(
      (receipt) =>
        receipt.side === requirement.side &&
        (requirement.stepId === undefined
          ? receipt.scope === RECONCILIATION_PRESERVATION_SCOPE.operation
          : receipt.scope === RECONCILIATION_PRESERVATION_SCOPE.historyStep &&
            receipt.stepId === requirement.stepId),
    );
    const historyStep =
      isHistoryReconciliationOperation(operation) &&
      operation.historyProgress.kind === HISTORY_PROGRESS_KIND.refined &&
      requirement.stepId !== undefined
        ? operation.historyProgress.steps.find(
            (step) => step.stepId === requirement.stepId,
          )
        : undefined;
    const mayFirstDispatch =
      historyStep === undefined
        ? operation.phase === RECONCILIATION_OPERATION_PHASE.admitted
        : historyStep.phase === HISTORY_CLEANUP_STEP_PHASE.pending;
    if (mayFirstDispatch) {
      if (existing !== undefined) return rejection("wrong-phase");
      return {
        kind: "authorized",
        requirement,
        mode: LOCAL_RECONCILIATION_DISPATCH_MODE.firstDispatch,
        receipt: pendingReceipt(operation, requirement, path),
      };
    }
    const mayRecover =
      historyStep === undefined
        ? operation.phase === RECONCILIATION_OPERATION_PHASE.preserving ||
          operation.phase === RECONCILIATION_OPERATION_PHASE.evidenceRequired
        : historyStep.phase === HISTORY_CLEANUP_STEP_PHASE.preserving ||
          historyStep.phase === HISTORY_CLEANUP_STEP_PHASE.evidenceRequired;
    if (
      mayRecover &&
      existing !== undefined &&
      receiptMatches(existing, requirement, path) &&
      existing.proofState !==
        RECONCILIATION_PRESERVATION_PROOF_STATE.verified &&
      existing.proofState !== RECONCILIATION_PRESERVATION_PROOF_STATE.blocked
    ) {
      return {
        kind: "authorized",
        requirement,
        mode: LOCAL_RECONCILIATION_DISPATCH_MODE.sameOperationRecovery,
        receipt: {
          ...existing,
          proofState: RECONCILIATION_PRESERVATION_PROOF_STATE.pending,
        },
      };
    }
    return rejection("wrong-phase");
  }

  /**
   * Persists the pending receipt/phase before the first or recovery host dispatch.
   *
   * @param authorization - Exact evidence-bound receipt and dispatch mode.
   * @returns Prepared authority or a typed durable rejection.
   */
  private async prepare(
    authorization: PreservationAuthorization,
  ): Promise<PreparedPreservation | ConflictPreservationResult> {
    const committed = await this.persistReceipt(
      authorization.receipt.operationId,
      authorization.receipt,
      RECONCILIATION_OPERATION_PHASE.preserving,
      true,
    );
    if (
      committed.kind === "committed" &&
      committed.snapshot.mutationAdmissionAllowed
    ) {
      return { kind: "prepared" };
    }
    return {
      kind: "rejected",
      reason: committed.snapshot.persistenceAvailable
        ? "operation-not-active"
        : "persistence-failure",
      snapshot: committed.snapshot,
    };
  }

  /**
   * Replaces exactly one operation receipt and phase through the serialized owner.
   *
   * @param operationId - Exact durable operation identity.
   * @param receipt - Complete preservation proof metadata to persist.
   * @param phase - Resulting operation phase.
   * @param requireAdmission - Whether this pre-effect transition must recheck the current lifecycle/global fence.
   * @returns Serialized owner commit result.
   */
  private persistReceipt(
    operationId: ReconciliationOperation["operationId"],
    receipt: ReconciliationPreservationReceipt,
    phase: ReconciliationOperation["phase"],
    requireAdmission = false,
  ) {
    return this.stateOwner.transition((state) => {
      const operation = state.reconciliationOperations.find(
        (candidate) => candidate.operationId === operationId,
      );
      if (
        operation === undefined ||
        !isActive(operation) ||
        (requireAdmission && !isDurableMutationAdmissionAllowed(state))
      ) {
        return undefined;
      }
      const otherReceipts = operation.preservationReceipts.filter(
        (candidate) =>
          candidate.side !== receipt.side ||
          candidate.scope !== receipt.scope ||
          (candidate.scope === RECONCILIATION_PRESERVATION_SCOPE.historyStep &&
            receipt.scope === RECONCILIATION_PRESERVATION_SCOPE.historyStep &&
            candidate.stepId !== receipt.stepId),
      );
      const nextOperation: ReconciliationOperation =
        isRefinedHistoryReconciliationOperation(operation) &&
        receipt.scope === RECONCILIATION_PRESERVATION_SCOPE.historyStep
          ? updateHistoryPreservation(operation, receipt, [
              ...otherReceipts,
              receipt,
            ])
          : !isHistoryReconciliationOperation(operation)
            ? {
                ...operation,
                phase,
                preservationReceipts: [...otherReceipts, receipt],
                localEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
                remoteEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
              }
            : operation;
      return replaceOperation(state, nextOperation);
    });
  }
}

/**
 * Advances one history step's preservation phase while leaving every other step intact.
 *
 * @param operation - Refined parent operation.
 * @param receipt - Exact step-scoped receipt being persisted.
 * @param receipts - Complete deduplicated parent receipt set.
 * @returns Updated parent and step lifecycle.
 */
function updateHistoryPreservation(
  operation: ReconciliationHistoryOperation,
  receipt: HistoryStepPreservationReceipt,
  receipts: readonly ReconciliationPreservationReceipt[],
): ReconciliationHistoryOperation {
  const stepPhase =
    receipt.proofState === RECONCILIATION_PRESERVATION_PROOF_STATE.pending
      ? HISTORY_CLEANUP_STEP_PHASE.preserving
      : receipt.proofState === RECONCILIATION_PRESERVATION_PROOF_STATE.verified
        ? HISTORY_CLEANUP_STEP_PHASE.ready
        : receipt.proofState ===
            RECONCILIATION_PRESERVATION_PROOF_STATE.evidenceRequired
          ? HISTORY_CLEANUP_STEP_PHASE.evidenceRequired
          : HISTORY_CLEANUP_STEP_PHASE.blocked;
  const parentPhase =
    stepPhase === HISTORY_CLEANUP_STEP_PHASE.preserving
      ? RECONCILIATION_OPERATION_PHASE.preserving
      : stepPhase === HISTORY_CLEANUP_STEP_PHASE.evidenceRequired
        ? RECONCILIATION_OPERATION_PHASE.evidenceRequired
        : stepPhase === HISTORY_CLEANUP_STEP_PHASE.blocked
          ? RECONCILIATION_OPERATION_PHASE.blocked
          : RECONCILIATION_OPERATION_PHASE.partial;
  return {
    ...operation,
    phase: parentPhase,
    preservationReceipts: receipts,
    historyProgress: {
      ...operation.historyProgress,
      steps: operation.historyProgress.steps.map((step) =>
        step.stepId === receipt.stepId ? { ...step, phase: stepPhase } : step,
      ),
    },
  };
}

/** Successful internal preservation authorization. */
interface PreservationAuthorization {
  readonly kind: "authorized";
  readonly requirement: RequiredReconciliationPreservation;
  readonly mode:
    | typeof LOCAL_RECONCILIATION_DISPATCH_MODE.firstDispatch
    | typeof LOCAL_RECONCILIATION_DISPATCH_MODE.sameOperationRecovery;
  readonly receipt: ReconciliationPreservationReceipt;
}

/** Internal authorization rejection before any effect. */
interface PreservationRejection {
  readonly kind: "rejected";
  readonly reason: Exclude<
    import("@core/mirror/conflict-preservation-service.types").ConflictPreservationRejection,
    "persistence-failure"
  >;
}

/** Internal marker proving the pre-effect durable transition committed. */
interface PreparedPreservation {
  readonly kind: "prepared";
}

/**
 * @param reason - Closed authorization rejection reason.
 * @returns A typed internal rejection without state/body data.
 */
function rejection(
  reason: PreservationRejection["reason"],
): PreservationRejection {
  return { kind: "rejected", reason };
}

/**
 * @param operation - Durable operation to classify.
 * @returns Whether it retains reservation ownership.
 */
function isActive(operation: ReconciliationOperation): boolean {
  return (
    operation.phase !== RECONCILIATION_OPERATION_PHASE.stale &&
    operation.phase !== RECONCILIATION_OPERATION_PHASE.completed
  );
}

/**
 * Creates the content-free pending receipt persisted before host I/O.
 *
 * @param operation - Authorized durable operation.
 * @param requirement - Exact evidence-derived competing bytes.
 * @param preservationPath - Generated reserved destination.
 * @returns Pending receipt bound to operation, evidence, and destination.
 */
function pendingReceipt(
  operation: ReconciliationOperation,
  requirement: RequiredReconciliationPreservation,
  preservationPath: ReconciliationPreservationReceipt["preservationPath"],
): ReconciliationPreservationReceipt {
  return {
    operationId: operation.operationId,
    ...(requirement.stepId === undefined
      ? { scope: RECONCILIATION_PRESERVATION_SCOPE.operation }
      : {
          scope: RECONCILIATION_PRESERVATION_SCOPE.historyStep,
          stepId: requirement.stepId,
        }),
    originalPath: requirement.originalPath,
    side: requirement.side,
    sourceRevision: requirement.sourceRevision,
    contentSha256: requirement.contentSha256,
    preservationPath,
    proofState: RECONCILIATION_PRESERVATION_PROOF_STATE.pending,
  };
}

/**
 * @param receipt - Existing durable receipt metadata.
 * @param requirement - Current evidence-derived preservation requirement.
 * @param preservationPath - Expected generated destination.
 * @returns Whether metadata is the exact same-operation recovery identity.
 */
function receiptMatches(
  receipt: ReconciliationPreservationReceipt,
  requirement: RequiredReconciliationPreservation,
  preservationPath: ReconciliationPreservationReceipt["preservationPath"],
): boolean {
  return (
    (requirement.stepId === undefined
      ? receipt.scope === RECONCILIATION_PRESERVATION_SCOPE.operation
      : receipt.scope === RECONCILIATION_PRESERVATION_SCOPE.historyStep &&
        receipt.stepId === requirement.stepId) &&
    receipt.originalPath === requirement.originalPath &&
    receipt.side === requirement.side &&
    receipt.sourceRevision === requirement.sourceRevision &&
    receipt.contentSha256 === requirement.contentSha256 &&
    receipt.preservationPath === preservationPath
  );
}

/**
 * Replaces one durable operation without changing review identity or unrelated operations.
 *
 * @param state - Current durable state.
 * @param replacement - Validated operation replacement.
 * @returns State with only the matching operation replaced.
 */
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
