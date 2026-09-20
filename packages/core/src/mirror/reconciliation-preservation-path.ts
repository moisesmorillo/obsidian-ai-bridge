import { RECONCILIATION_PRESERVATION_ROOT } from "@core/mirror/local-reconciliation-writer.constants";
import type { ReconciliationPreservationPath } from "@core/mirror/local-reconciliation-writer.types";
import type { MirrorOperationId } from "@core/mirror/mirror.types";
import { createMirrorOperationId } from "@core/mirror/mirror-identifiers";
import { RECONCILIATION_PRESERVATION_SIDE } from "@core/mirror/reconciliation-state.constants";
import type { ReconciliationPreservationReceipt } from "@core/mirror/reconciliation-state.types";

/**
 * Generates the only supported conflict-preservation destination.
 *
 * The source note path is intentionally absent: only a validated parent UUID,
 * optional history-step UUID, and one closed side may shape the reserved destination,
 * so traversal and remote path interpolation are unrepresentable.
 *
 * @param operationId - Durable locally generated parent operation identity.
 * @param side - Closed competitor side.
 * @param stepId - Optional history-step identity inserted before the side.
 * @returns The exact reserved path, or undefined for malformed runtime input.
 */
export function createReconciliationPreservationPath(
  operationId: MirrorOperationId,
  side: ReconciliationPreservationReceipt["side"],
  stepId?: MirrorOperationId,
): ReconciliationPreservationPath | undefined {
  if (
    createMirrorOperationId(operationId) !== operationId ||
    (stepId !== undefined && createMirrorOperationId(stepId) !== stepId)
  ) {
    return undefined;
  }
  switch (side) {
    case RECONCILIATION_PRESERVATION_SIDE.local:
    case RECONCILIATION_PRESERVATION_SIDE.remote: {
      const step = stepId === undefined ? "" : `/${stepId}`;
      return `${RECONCILIATION_PRESERVATION_ROOT}/${operationId}${step}/${side}.md` as ReconciliationPreservationPath;
    }
  }
}

/**
 * Verifies that a candidate is exactly the generated path for one operation and side.
 *
 * @param candidate - Untrusted persisted or host path.
 * @param operationId - Expected durable operation identity.
 * @param side - Expected closed competitor side.
 * @param stepId - Optional exact history-step identity.
 * @returns Whether the candidate has no normalization or traversal variance.
 */
export function isReconciliationPreservationPath(
  candidate: string,
  operationId: MirrorOperationId,
  side: ReconciliationPreservationReceipt["side"],
  stepId?: MirrorOperationId,
): candidate is ReconciliationPreservationPath {
  return (
    candidate ===
    createReconciliationPreservationPath(operationId, side, stepId)
  );
}
