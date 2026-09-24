import {
  HISTORY_PROGRESS_KIND,
  RECONCILIATION_ACTION,
} from "@core/mirror/reconciliation-state.constants";
import type {
  LegacyV3HistoryOperation,
  ReconciliationHistoryOperation,
  ReconciliationNonHistoryOperation,
  ReconciliationOperation,
} from "@core/mirror/reconciliation-state.types";

/**
 * Narrows aggregate-effect operations away from refined and migrated history records.
 *
 * @param operation - Any current v5 operation.
 * @returns Whether aggregate local/remote effect fields are authoritative.
 */
export function isNonHistoryReconciliationOperation(
  operation: ReconciliationOperation,
): operation is ReconciliationNonHistoryOperation {
  return operation.action.kind !== RECONCILIATION_ACTION.resolveHistory;
}

/**
 * Narrows every deferred-history operation without deciding whether it may dispatch.
 *
 * @param operation - Any current v5 operation.
 * @returns Whether history progress, rather than aggregate effect fields, is authoritative.
 */
export function isHistoryReconciliationOperation(
  operation: ReconciliationOperation,
): operation is ReconciliationHistoryOperation | LegacyV3HistoryOperation {
  return operation.action.kind === RECONCILIATION_ACTION.resolveHistory;
}

/**
 * Narrows history state to an operator-refined ordered step ledger.
 *
 * @param operation - Any current v5 operation.
 * @returns Whether the operation may own refined history step execution.
 */
export function isRefinedHistoryReconciliationOperation(
  operation: ReconciliationOperation,
): operation is ReconciliationHistoryOperation {
  return (
    isHistoryReconciliationOperation(operation) &&
    operation.historyProgress.kind === HISTORY_PROGRESS_KIND.refined
  );
}
