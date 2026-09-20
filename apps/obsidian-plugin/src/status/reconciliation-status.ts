import {
  HISTORY_PROGRESS_KIND,
  isHistoryReconciliationOperation,
  type MirrorDeviceState,
  RECONCILIATION_ACTION,
  RECONCILIATION_OPERATION_PHASE,
  RECONCILIATION_REVIEW_STATUS,
  type ReconciliationOperationPhase,
} from "@obsidian-ai-bridge/core";

/** Content-free M4 counts derived only from authoritative durable state. */
export interface ReconciliationOperationalStatus {
  readonly pendingReviews: number;
  readonly staleReviews: number;
  readonly activeOperations: number;
  readonly attentionOperations: number;
  readonly restoredPendingReview: number;
  readonly successorReviewRequired: number;
  readonly historyAttention: number;
}

/**
 * Projects durable M4 state without exposing bodies, transport failures, or hidden recovery data.
 *
 * @param state - Current validated device state.
 * @returns Closed content-free reconciliation counts.
 */
export function createReconciliationOperationalStatus(
  state: MirrorDeviceState,
): ReconciliationOperationalStatus {
  const active = state.reconciliationOperations.filter(
    (operation) =>
      operation.phase !== RECONCILIATION_OPERATION_PHASE.completed &&
      operation.phase !== RECONCILIATION_OPERATION_PHASE.stale,
  );
  const attentionPhases = new Set<ReconciliationOperationPhase>([
    RECONCILIATION_OPERATION_PHASE.blocked,
    RECONCILIATION_OPERATION_PHASE.evidenceRequired,
    RECONCILIATION_OPERATION_PHASE.partial,
  ]);
  return {
    pendingReviews: state.reconciliationReviews.filter(
      (review) => review.status === RECONCILIATION_REVIEW_STATUS.staged,
    ).length,
    staleReviews: state.reconciliationReviews.filter(
      (review) => review.status === RECONCILIATION_REVIEW_STATUS.stale,
    ).length,
    activeOperations: active.length,
    attentionOperations: active.filter((operation) =>
      attentionPhases.has(operation.phase),
    ).length,
    restoredPendingReview: active.filter(
      (operation) =>
        operation.phase ===
        RECONCILIATION_OPERATION_PHASE.restoredPendingReview,
    ).length,
    successorReviewRequired: active.filter(
      (operation) =>
        operation.phase ===
        RECONCILIATION_OPERATION_PHASE.successorReviewRequired,
    ).length,
    historyAttention: active.filter(
      (operation) =>
        operation.action.kind === RECONCILIATION_ACTION.resolveHistory &&
        isHistoryReconciliationOperation(operation) &&
        (operation.historyProgress.kind ===
          HISTORY_PROGRESS_KIND.legacyV3Unrefined ||
          attentionPhases.has(operation.phase)),
    ).length,
  };
}
