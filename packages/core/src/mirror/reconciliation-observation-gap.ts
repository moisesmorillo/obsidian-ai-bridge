import type { MirrorOperationId } from "@core/mirror/mirror.types";
import type { MirrorDeviceState } from "@core/mirror/mirror-state.types";
import {
  RECONCILIATION_OBSERVATION_COVERAGE,
  RECONCILIATION_OPERATION_PHASE,
} from "@core/mirror/reconciliation-state.constants";

/**
 * Fences every nonterminal operation whose listener interval may have been uncovered.
 *
 * Terminal audit records remain immutable. The operation's phase, effect certainty,
 * history step receipt, observed successor range and reservations are preserved;
 * this projection makes no claim about events or effects during the gap.
 *
 * @param state - Current serialized device-local state.
 * @returns State with every active operation explicitly requiring fresh gap review.
 */
export function fenceActiveReconciliationForObservationGap(
  state: MirrorDeviceState,
): MirrorDeviceState {
  let changed = false;
  const reconciliationOperations = state.reconciliationOperations.map(
    (operation) => {
      if (
        operation.phase === RECONCILIATION_OPERATION_PHASE.completed ||
        operation.phase === RECONCILIATION_OPERATION_PHASE.stale ||
        operation.observationCoverage ===
          RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired
      ) {
        return operation;
      }
      changed = true;
      return {
        ...operation,
        observationCoverage:
          RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
      };
    },
  );
  return changed ? { ...state, reconciliationOperations } : state;
}

/**
 * Determines whether a predecessor retains active reservation authority after a gap.
 *
 * @param state - Current serialized device-local state.
 * @param operationId - Exact predecessor identity.
 * @returns Whether the operation is still active and gap-fenced.
 */
export function isGapFencedReconciliationOperation(
  state: MirrorDeviceState,
  operationId: MirrorOperationId,
): boolean {
  return state.reconciliationOperations.some(
    (operation) =>
      operation.operationId === operationId &&
      operation.observationCoverage ===
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired &&
      operation.phase !== RECONCILIATION_OPERATION_PHASE.completed &&
      operation.phase !== RECONCILIATION_OPERATION_PHASE.stale,
  );
}
