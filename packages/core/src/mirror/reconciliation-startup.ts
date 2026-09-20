import type { MirrorDeviceState } from "@core/mirror/mirror-state.types";
import { RECONCILIATION_REVIEW_STATUS } from "@core/mirror/reconciliation-state.constants";

/**
 * Stales every durable nonterminal review that lacks its linked operation.
 *
 * Startup applies this content-free transition before publishing commands or UI.
 * Persisted operations are never cancelled or inferred from an orphaned review.
 *
 * @param state - Validated current device state.
 * @returns Original state when unchanged, otherwise the deterministic stale projection.
 */
export function staleOrphanedReconciliationReviews(
  state: MirrorDeviceState,
): MirrorDeviceState {
  const operationIds = new Set(
    state.reconciliationOperations.map((operation) => operation.operationId),
  );
  let changed = false;
  const reconciliationReviews = state.reconciliationReviews.map((review) => {
    const orphaned =
      review.status !== RECONCILIATION_REVIEW_STATUS.completed &&
      review.status !== RECONCILIATION_REVIEW_STATUS.stale &&
      (review.operationId === null || !operationIds.has(review.operationId));
    if (!orphaned) return review;
    changed = true;
    return {
      ...review,
      status: RECONCILIATION_REVIEW_STATUS.stale,
      operationId: null,
    };
  });
  return changed ? { ...state, reconciliationReviews } : state;
}
