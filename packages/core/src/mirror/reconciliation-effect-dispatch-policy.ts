import { MUTATION_EFFECT_CERTAINTY } from "@core/mirror/mirror.constants";
import type { MirrorOperationId } from "@core/mirror/mirror.types";
import { isHistoryReconciliationOperation } from "@core/mirror/reconciliation-operation";
import {
  HISTORY_CLEANUP_STEP_PHASE,
  HISTORY_PROGRESS_KIND,
  HISTORY_REMOTE_EFFECT_KIND,
  RECONCILIATION_ACTION,
  RECONCILIATION_EFFECT_DISPATCH_KIND,
  RECONCILIATION_OBSERVATION_COVERAGE,
  RECONCILIATION_OPERATION_PHASE,
} from "@core/mirror/reconciliation-state.constants";
import type {
  ReconciliationEffectDispatchKind,
  ReconciliationNonHistoryOperation,
  ReconciliationOperation,
} from "@core/mirror/reconciliation-state.types";

/**
 * Authorizes one operation-bound effect only while its durable phase names that exact boundary.
 *
 * History dispatch requires the current ordered step identity; a parent ID, prior step,
 * blocked step, or non-refined migration blocker cannot authorize another effect. M3
 * and maintenance requests without an M4 owner are classified by their runtime adapter.
 *
 * @param operation - Exact active or historical M4 operation matched by its parent/step identity.
 * @param effectIdentity - Parent operation ID or exact current history step ID.
 * @param kind - Local-preservation, local-mutation, or remote-mutation boundary.
 * @returns Whether the current durable M4 state authorizes this specific effect boundary.
 */
export function isReconciliationEffectDispatchAllowed(
  operation: ReconciliationOperation,
  effectIdentity: MirrorOperationId,
  kind: ReconciliationEffectDispatchKind,
): boolean {
  if (
    operation.observationCoverage !==
      RECONCILIATION_OBSERVATION_COVERAGE.continuous ||
    operation.phase === RECONCILIATION_OPERATION_PHASE.completed ||
    operation.phase === RECONCILIATION_OPERATION_PHASE.stale
  ) {
    return false;
  }
  if (!isHistoryReconciliationOperation(operation)) {
    return isOrdinaryEffectDispatchAllowed(operation, effectIdentity, kind);
  }
  if (
    operation.historyProgress.kind !== HISTORY_PROGRESS_KIND.refined ||
    effectIdentity === operation.operationId
  ) {
    return false;
  }
  const currentIndex = operation.historyProgress.nextStepIndex;
  if (currentIndex === null) return false;
  const currentStep = operation.historyProgress.steps[currentIndex];
  if (currentStep === undefined || currentStep.stepId !== effectIdentity) {
    return false;
  }
  switch (kind) {
    case RECONCILIATION_EFFECT_DISPATCH_KIND.localPreservation:
      return (
        operation.phase === RECONCILIATION_OPERATION_PHASE.preserving &&
        currentStep.phase === HISTORY_CLEANUP_STEP_PHASE.preserving &&
        currentStep.remoteEffect.kind ===
          HISTORY_REMOTE_EFFECT_KIND.notDispatched
      );
    case RECONCILIATION_EFFECT_DISPATCH_KIND.remoteMutation:
      return (
        operation.phase === RECONCILIATION_OPERATION_PHASE.mutatingRemote &&
        currentStep.phase === HISTORY_CLEANUP_STEP_PHASE.mutatingRemote &&
        currentStep.remoteEffect.kind ===
          HISTORY_REMOTE_EFFECT_KIND.notDispatched
      );
    case RECONCILIATION_EFFECT_DISPATCH_KIND.localMutation:
      return false;
  }
}

/**
 * Checks the ordinary operation phase and its corresponding effect certainty before dispatch.
 *
 * @param operation - Non-history operation whose aggregate effect fields are authoritative.
 * @param effectIdentity - Supplied operation ID that must match the durable owner.
 * @param kind - Local-preservation, local-mutation, or remote-mutation boundary.
 * @returns Whether this phase may begin the requested effect.
 */
function isOrdinaryEffectDispatchAllowed(
  operation: ReconciliationNonHistoryOperation,
  effectIdentity: MirrorOperationId,
  kind: ReconciliationEffectDispatchKind,
): boolean {
  if (effectIdentity !== operation.operationId) return false;
  switch (kind) {
    case RECONCILIATION_EFFECT_DISPATCH_KIND.localPreservation:
      return (
        operation.phase === RECONCILIATION_OPERATION_PHASE.preserving &&
        operation.localEffect === MUTATION_EFFECT_CERTAINTY.notDispatched &&
        operation.remoteEffect === MUTATION_EFFECT_CERTAINTY.notDispatched
      );
    case RECONCILIATION_EFFECT_DISPATCH_KIND.localMutation:
      return (
        (operation.phase === RECONCILIATION_OPERATION_PHASE.mutatingLocal ||
          (operation.phase ===
            RECONCILIATION_OPERATION_PHASE.restoredPendingReview &&
            operation.action.kind === RECONCILIATION_ACTION.restoreRecovery)) &&
        operation.localEffect === MUTATION_EFFECT_CERTAINTY.notDispatched
      );
    case RECONCILIATION_EFFECT_DISPATCH_KIND.remoteMutation:
      return (
        operation.phase === RECONCILIATION_OPERATION_PHASE.mutatingRemote &&
        operation.remoteEffect === MUTATION_EFFECT_CERTAINTY.notDispatched
      );
  }
}
