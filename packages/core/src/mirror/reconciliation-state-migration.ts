import { MUTATION_EFFECT_CERTAINTY } from "@core/mirror/mirror.constants";
import type {
  MirrorDeviceState,
  MirrorDeviceStateV3,
  MirrorDeviceStateV4,
} from "@core/mirror/mirror-state.types";
import {
  HISTORY_PROGRESS_KIND,
  LEGACY_V3_LOCAL_EFFECT_RECOVERY_STATE,
  LOCAL_EFFECT_OBSERVATION_KIND,
  RECONCILIATION_ACTION,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_OBSERVATION_COVERAGE,
  RECONCILIATION_OPERATION_PHASE,
  RECONCILIATION_PRESERVATION_SCOPE,
  RECONCILIATION_REVIEW_STATUS,
} from "@core/mirror/reconciliation-state.constants";
import type {
  LocalEffectObservation,
  ReconciliationOperation,
  ReconciliationOperationV3,
  ReconciliationOperationV4,
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
): MirrorDeviceStateV4 {
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
 * Projects the frozen v4 state into the strict v5 contract without asserting listener continuity.
 *
 * Every nonterminal operation is fenced because persisted epochs and exact effects
 * cannot prove coverage through the cold-start interval. Historical fields and IDs
 * remain unchanged; no reviews, effects, ranges or decisions are synthesized.
 *
 * @param state - Strictly decoded and validated version-4 state.
 * @returns Version-5 projection requiring complete semantic validation.
 */
export function projectMirrorDeviceStateV4ToV5(
  state: MirrorDeviceStateV4,
): MirrorDeviceState {
  return {
    deviceId: state.deviceId,
    lifecycle: state.lifecycle,
    globalBlockReason: state.globalBlockReason,
    paths: state.paths,
    stagedHandoff: state.stagedHandoff,
    reconciliationReviews: state.reconciliationReviews,
    reconciliationGapGroupReviews: [],
    reconciliationOperations:
      state.reconciliationOperations.map(projectV4Operation),
  };
}

/**
 * Retains terminal historical audit evidence and fences every operation still owning authority.
 *
 * @param operation - Strictly decoded version-4 operation.
 * @returns Exact v5 operation projection with no fabricated successor links.
 */
function projectV4Operation(
  operation: ReconciliationOperationV4,
): ReconciliationOperation {
  const observationCoverage =
    operation.phase === RECONCILIATION_OPERATION_PHASE.completed ||
    operation.phase === RECONCILIATION_OPERATION_PHASE.stale
      ? RECONCILIATION_OBSERVATION_COVERAGE.continuous
      : RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired;
  const common = {
    ...operation,
    observationCoverage,
    gapSuccessorOperationIds: [],
  };
  return common;
}

/**
 * Projects one historical operation without repairing or reinterpreting evidence.
 *
 * @param operation - Frozen v3 aggregate operation.
 * @returns Version-4 non-history observation state or a non-dispatchable history blocker.
 */
function projectOperation(
  operation: ReconciliationOperationV3,
): ReconciliationOperationV4 {
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
  } satisfies ReconciliationOperationV4;
}

/**
 * Determines only whether the historical action had a local effect channel.
 *
 * This does not infer that an effect occurred or authorize a future effect. Frozen
 * v4 validation checks the projection; runtime action services retain dispatch authority.
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
