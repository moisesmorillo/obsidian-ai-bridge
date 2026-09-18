import { RECONCILIATION_PRESERVATION_ROOT } from "@core/mirror/local-reconciliation-writer.constants";
import type { ReconciliationPreservationPath } from "@core/mirror/local-reconciliation-writer.types";
import type { MirrorOperationId } from "@core/mirror/mirror.types";
import { createMirrorOperationId } from "@core/mirror/mirror-identifiers";
import { RECONCILIATION_PRESERVATION_SIDE } from "@core/mirror/reconciliation-state.constants";
import type { ReconciliationPreservationReceipt } from "@core/mirror/reconciliation-state.types";

/**
 * Generates the only supported conflict-preservation destination.
 *
 * The source note path is intentionally absent: only a validated local operation UUID
 * and one closed side may shape the reserved destination, so traversal and remote path
 * interpolation are unrepresentable.
 *
 * @param operationId - Durable locally generated operation identity.
 * @param side - Closed competitor side.
 * @returns The exact reserved path, or undefined for malformed runtime input.
 */
export function createReconciliationPreservationPath(
  operationId: MirrorOperationId,
  side: ReconciliationPreservationReceipt["side"],
): ReconciliationPreservationPath | undefined {
  if (createMirrorOperationId(operationId) !== operationId) return undefined;
  switch (side) {
    case RECONCILIATION_PRESERVATION_SIDE.local:
    case RECONCILIATION_PRESERVATION_SIDE.remote:
      return `${RECONCILIATION_PRESERVATION_ROOT}/${operationId}/${side}.md` as ReconciliationPreservationPath;
  }
}

/**
 * Verifies that a candidate is exactly the generated path for one operation and side.
 *
 * @param candidate - Untrusted persisted or host path.
 * @param operationId - Expected durable operation identity.
 * @param side - Expected closed competitor side.
 * @returns Whether the candidate has no normalization or traversal variance.
 */
export function isReconciliationPreservationPath(
  candidate: string,
  operationId: MirrorOperationId,
  side: ReconciliationPreservationReceipt["side"],
): candidate is ReconciliationPreservationPath {
  return candidate === createReconciliationPreservationPath(operationId, side);
}
