import { MUTATION_EFFECT_CERTAINTY } from "@core/mirror/mirror.constants";
import type {
  MirrorDeviceState,
  MirrorDeviceStateV3,
} from "@core/mirror/mirror-state.types";
import {
  HISTORY_PROGRESS_KIND,
  LEGACY_V3_LOCAL_EFFECT_RECOVERY_STATE,
  LOCAL_EFFECT_OBSERVATION_KIND,
  RECONCILIATION_ACTION,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_OPERATION_PHASE,
  RECONCILIATION_PRESERVATION_SCOPE,
  RECONCILIATION_REVIEW_STATUS,
} from "@core/mirror/reconciliation-state.constants";
import type {
  LocalEffectObservation,
  ReconciliationNonHistoryOperation,
  ReconciliationOperation,
  ReconciliationOperationV3,
} from "@core/mirror/reconciliation-state.types";

/**
 * Deterministically projects the frozen v3 state into the strict v4 domain shape.
 *
 * Every M3 field and every v3 M4 record is retained. History remains an explicit
 * unrefined blocker and a started local effect remains unfenced; this projection
 * never invents an operator choice, cleanup step, host event, or effect certainty.
 *
 * @param state - Strictly decoded version-3 state.
 * @returns Version-4 state requiring normal complete semantic validation.
 */
export function projectMirrorDeviceStateV3ToV4(
  state: MirrorDeviceStateV3,
): MirrorDeviceState {
  const reconciliationOperations =
    state.reconciliationOperations.map(projectOperation);
  const attentionOperationIds = new Set(
    reconciliationOperations
      .filter(
        (operation) =>
          operation.phase === RECONCILIATION_OPERATION_PHASE.blocked,
      )
      .map((operation) => operation.operationId),
  );
  return {
    deviceId: state.deviceId,
    lifecycle: state.lifecycle,
    globalBlockReason: state.globalBlockReason,
    paths: state.paths,
    stagedHandoff: state.stagedHandoff,
    reconciliationReviews: state.reconciliationReviews.map((review) =>
      review.operationId !== null &&
      attentionOperationIds.has(review.operationId)
        ? { ...review, status: RECONCILIATION_REVIEW_STATUS.staged }
        : review,
    ),
    reconciliationOperations,
  };
}

/**
 * Projects one historical operation without repairing or reinterpreting evidence.
 *
 * @param operation - Frozen v3 aggregate operation.
 * @returns V4 non-history observation state or a non-dispatchable history blocker.
 */
function projectOperation(
  operation: ReconciliationOperationV3,
): ReconciliationOperation {
  const preservationReceipts = operation.preservationReceipts.map(
    (receipt) => ({
      ...receipt,
      scope: RECONCILIATION_PRESERVATION_SCOPE.operation,
    }),
  );
  if (operation.action.kind === RECONCILIATION_ACTION.resolveHistory) {
    return {
      operationId: operation.operationId,
      reviewId: operation.reviewId,
      authority: operation.authority,
      action: operation.action,
      phase: RECONCILIATION_OPERATION_PHASE.blocked,
      snapshot: operation.snapshot,
      destinationPath: operation.destinationPath,
      reservations: operation.reservations,
      preservationReceipts,
      successorOperationId: operation.successorOperationId,
      historyProgress: {
        kind: HISTORY_PROGRESS_KIND.legacyV3Unrefined,
        aggregateLocalEffect: operation.localEffect,
        aggregateRemoteEffect: operation.remoteEffect,
      },
    };
  }
  const target = operation.snapshot.paths.find(
    (evidence) => evidence.path === operation.snapshot.targetPath,
  );
  const localEffectObservation: LocalEffectObservation =
    operation.localEffect !== MUTATION_EFFECT_CERTAINTY.notDispatched ||
    operation.phase === RECONCILIATION_OPERATION_PHASE.mutatingLocal
      ? {
          kind: LOCAL_EFFECT_OBSERVATION_KIND.legacyV3Unfenced,
          priorPhase: operation.phase,
          recoveryState: LEGACY_V3_LOCAL_EFFECT_RECOVERY_STATE.pending,
        }
      : actionCanWriteLocal(operation)
        ? { kind: LOCAL_EFFECT_OBSERVATION_KIND.notStarted }
        : {
            kind: LOCAL_EFFECT_OBSERVATION_KIND.notRequired,
            path: operation.snapshot.targetPath,
            listenerEpoch: operation.snapshot.runtime.listenerEpoch,
            beforeGeneration:
              target === undefined ||
              target.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown
                ? 0
                : target.local.observationGeneration,
            successor: null,
          };
  return {
    ...operation,
    action: operation.action,
    phase:
      localEffectObservation.kind ===
      LOCAL_EFFECT_OBSERVATION_KIND.legacyV3Unfenced
        ? RECONCILIATION_OPERATION_PHASE.blocked
        : operation.phase,
    preservationReceipts,
    localEffectObservation,
  } satisfies ReconciliationNonHistoryOperation;
}

/**
 * Determines only whether the historical action had a local effect channel.
 *
 * This does not infer that an effect occurred or that a future effect is allowed;
 * v4 validation and action services retain that authority.
 *
 * @param operation - Historical non-history operation.
 * @returns Whether its accepted action can require local create/replace.
 */
function actionCanWriteLocal(operation: ReconciliationOperationV3): boolean {
  switch (operation.action.kind) {
    case RECONCILIATION_ACTION.useRemote:
    case RECONCILIATION_ACTION.keepBoth:
    case RECONCILIATION_ACTION.adoptRevision:
    case RECONCILIATION_ACTION.restoreRecovery:
    case RECONCILIATION_ACTION.forkLegacy:
      return true;
    case RECONCILIATION_ACTION.keepLocal:
    case RECONCILIATION_ACTION.acceptTombstone:
    case RECONCILIATION_ACTION.recreateRemote:
    case RECONCILIATION_ACTION.resolveHistory:
    case RECONCILIATION_ACTION.defer:
      return false;
  }
}
