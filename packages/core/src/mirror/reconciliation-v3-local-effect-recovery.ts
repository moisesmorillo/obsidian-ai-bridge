import {
  LocalInspectionKind,
  LocalVaultFailureReason,
} from "@core/local-vault/local-vault.constants";
import type { ReadOnlyLocalVault } from "@core/local-vault/read-only-local-vault.port";
import { MUTATION_EFFECT_CERTAINTY } from "@core/mirror/mirror.constants";
import type {
  ContentSha256,
  MirrorOperationId,
} from "@core/mirror/mirror.types";
import type { MirrorDeviceState } from "@core/mirror/mirror-state.types";
import type { MirrorStateOwner } from "@core/mirror/mirror-state-owner";
import { isNonHistoryReconciliationOperation } from "@core/mirror/reconciliation-operation";
import {
  LEGACY_V3_LOCAL_EFFECT_RECOVERY_STATE,
  LOCAL_EFFECT_OBSERVATION_KIND,
  RECONCILIATION_ACTION,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_OPERATION_PHASE,
  RECONCILIATION_PRESERVATION_SIDE,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
  RECONCILIATION_REVIEW_STATUS,
} from "@core/mirror/reconciliation-state.constants";
import type {
  ReconciliationNonHistoryOperation,
  ReconciliationOperationPhase,
  ReconciliationPathEvidence,
} from "@core/mirror/reconciliation-state.types";
import type { ReconciliationV3LocalEffectRecoveryResult } from "@core/mirror/reconciliation-v3-local-effect-recovery.types";
import type { NotePath } from "@core/note-path/note-path.types";

/** Exact startup-only seams for inspecting migrated v3 local postconditions. */
export interface ReconciliationV3LocalEffectRecoveryDependencies {
  readonly local: ReadOnlyLocalVault;
  readonly stateOwner: MirrorStateOwner;
  /** @returns SHA-256 of exact transient UTF-8 text. */
  readonly hashContent: (content: string) => Promise<ContentSha256>;
  /** @returns Fresh synthetic UUID-v4 persisted only with an exact postcondition. */
  readonly createEffectId: () => MirrorOperationId;
}

/**
 * Startup owner for migrated v3 local effects that lack durable event fencing.
 *
 * The owner performs reads and state transitions only. It has no local writer, remote
 * port, review authority, or event source, so recovery cannot redispatch an effect,
 * invent a Vault callback, or create a new operator decision.
 */
export class ReconciliationV3LocalEffectRecoveryService {
  /** @param dependencies - Read-only local evidence, hashing, identity, and durable owner seams. */
  constructor(
    private readonly dependencies: ReconciliationV3LocalEffectRecoveryDependencies,
  ) {}

  /**
   * Recovers every migrated local-effect blocker before runtime/UI publication.
   *
   * Exact bytes become a synthetic recovered-v3 confirmation. Definite absence or
   * changed bytes block; unavailable/ambiguous reads require evidence. Persistence
   * failure stops startup while retaining the last published authoritative snapshot.
   *
   * @returns Completed recovery count or state-unavailable.
   */
  async recover(): Promise<ReconciliationV3LocalEffectRecoveryResult> {
    const operationIds = this.dependencies.stateOwner
      .snapshot()
      .state.reconciliationOperations.filter(isLegacyV3LocalEffectOperation)
      .map((operation) => operation.operationId);
    let recoveredOperations = 0;
    for (const operationId of operationIds) {
      const operation = this.operation(operationId);
      if (operation === undefined) continue;
      const expected = deriveMigratedLocalPostcondition(operation);
      const evidence =
        expected === undefined
          ? { kind: "ambiguous" as const }
          : await this.readPostcondition(expected);
      if (
        evidence.kind === "ambiguous" &&
        operation.localEffectObservation.kind ===
          LOCAL_EFFECT_OBSERVATION_KIND.legacyV3Unfenced &&
        operation.localEffectObservation.recoveryState ===
          LEGACY_V3_LOCAL_EFFECT_RECOVERY_STATE.evidenceRequired
      ) {
        continue;
      }
      const effectId =
        evidence.kind === "exact"
          ? this.dependencies.createEffectId()
          : undefined;
      const committed = await this.dependencies.stateOwner.transition((state) =>
        recoverOperation(state, operationId, expected, evidence.kind, effectId),
      );
      if (committed.kind !== "committed") {
        return {
          kind: "unavailable",
          snapshot: committed.snapshot,
        };
      }
      if (evidence.kind === "exact") recoveredOperations += 1;
    }
    return {
      kind: "completed",
      recoveredOperations,
      snapshot: this.dependencies.stateOwner.snapshot(),
    };
  }

  /** @returns Current unresolved migrated operation with no effect capability. */
  private operation(
    operationId: MirrorOperationId,
  ): ReconciliationNonHistoryOperation | undefined {
    return this.dependencies.stateOwner
      .snapshot()
      .state.reconciliationOperations.find(
        (operation): operation is ReconciliationNonHistoryOperation =>
          operation.operationId === operationId &&
          isLegacyV3LocalEffectOperation(operation),
      );
  }

  /** @returns Exact, definitely changed/absent, or ambiguous current local evidence. */
  private async readPostcondition(
    expected: MigratedLocalPostcondition,
  ): Promise<MigrationPostconditionEvidence> {
    let current: Awaited<ReturnType<ReadOnlyLocalVault["read"]>>;
    try {
      current = await this.dependencies.local.read(expected.path);
    } catch {
      return { kind: "ambiguous" };
    }
    if (current.kind === LocalInspectionKind.failed) {
      return current.reason === LocalVaultFailureReason.missingFile
        ? { kind: "absent" }
        : { kind: "ambiguous" };
    }
    try {
      const hash = await this.dependencies.hashContent(current.content);
      return hash === expected.expectedHash
        ? { kind: "exact" }
        : { kind: "changed" };
    } catch {
      return { kind: "ambiguous" };
    }
  }
}

/** Exact current local postcondition recoverable from persisted operation evidence. */
interface MigratedLocalPostcondition {
  readonly path: NotePath;
  readonly expectedHash: ContentSha256;
  readonly beforeGeneration: number;
}

/** Closed read classification that never retains note content. */
type MigrationPostconditionEvidence =
  | { readonly kind: "exact" }
  | { readonly kind: "changed" }
  | { readonly kind: "absent" }
  | { readonly kind: "ambiguous" };

/**
 * @param operation - Candidate migrated operation.
 * @returns Whether one operation still requires the focused v3 postcondition transition.
 */
function isLegacyV3LocalEffectOperation(
  operation: MirrorDeviceState["reconciliationOperations"][number],
): operation is ReconciliationNonHistoryOperation {
  return (
    isNonHistoryReconciliationOperation(operation) &&
    operation.localEffectObservation.kind ===
      LOCAL_EFFECT_OBSERVATION_KIND.legacyV3Unfenced &&
    operation.localEffectObservation.recoveryState !==
      LEGACY_V3_LOCAL_EFFECT_RECOVERY_STATE.blocked
  );
}

/**
 * Derives the current/latest local postcondition from existing action/effect evidence only.
 *
 * @param operation - Migrated aggregate operation with no event-fence evidence.
 * @returns One exact path/hash/generation or undefined when historical aggregate state
 * cannot identify a unique local postcondition.
 */
export function deriveMigratedLocalPostcondition(
  operation: ReconciliationNonHistoryOperation,
): MigratedLocalPostcondition | undefined {
  const target = evidence(operation, operation.snapshot.targetPath);
  const destination =
    operation.destinationPath === null
      ? undefined
      : evidence(operation, operation.destinationPath);
  switch (operation.action.kind) {
    case RECONCILIATION_ACTION.useRemote:
    case RECONCILIATION_ACTION.adoptRevision:
      return target?.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live
        ? postcondition(target, target.remote.contentSha256)
        : undefined;
    case RECONCILIATION_ACTION.keepBoth:
      if (
        target?.local.kind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.live ||
        destination === undefined
      ) {
        return undefined;
      }
      if (
        target.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone
      ) {
        return postcondition(destination, target.local.contentSha256);
      }
      if (target.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.live) {
        return undefined;
      }
      if (
        operation.action.primarySide === RECONCILIATION_PRESERVATION_SIDE.local
      ) {
        return postcondition(destination, target.remote.contentSha256);
      }
      return operation.remoteEffect === MUTATION_EFFECT_CERTAINTY.confirmed
        ? postcondition(target, target.remote.contentSha256)
        : postcondition(destination, target.local.contentSha256);
    case RECONCILIATION_ACTION.forkLegacy:
      return target?.remote.kind ===
        RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy && destination !== undefined
        ? postcondition(destination, target.remote.contentSha256)
        : undefined;
    case RECONCILIATION_ACTION.restoreRecovery: {
      const restoreTarget = destination ?? target;
      return restoreTarget !== undefined && operation.snapshot.recovery !== null
        ? postcondition(
            restoreTarget,
            operation.snapshot.recovery.contentSha256,
          )
        : undefined;
    }
    case RECONCILIATION_ACTION.keepLocal:
    case RECONCILIATION_ACTION.acceptTombstone:
    case RECONCILIATION_ACTION.recreateRemote:
    case RECONCILIATION_ACTION.defer:
      return undefined;
  }
}

/** @returns Exact local generation bound to one expected postcondition path. */
function postcondition(
  current: ReconciliationPathEvidence,
  expectedHash: ContentSha256,
): MigratedLocalPostcondition {
  return {
    path: current.path,
    expectedHash,
    beforeGeneration:
      current.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown
        ? 0
        : current.local.observationGeneration,
  };
}

/** @returns Exact immutable path evidence owned by the persisted operation. */
function evidence(
  operation: ReconciliationNonHistoryOperation,
  path: NotePath,
): ReconciliationPathEvidence | undefined {
  return operation.snapshot.paths.find((candidate) => candidate.path === path);
}

/**
 * Applies one evidence result only while the exact operation remains migration-unfenced.
 *
 * @returns Complete prospective state or undefined after stale identity/evidence.
 */
function recoverOperation(
  state: MirrorDeviceState,
  operationId: MirrorOperationId,
  expected: MigratedLocalPostcondition | undefined,
  evidenceKind: MigrationPostconditionEvidence["kind"],
  effectId: MirrorOperationId | undefined,
): MirrorDeviceState | undefined {
  const operation = state.reconciliationOperations.find(
    (candidate): candidate is ReconciliationNonHistoryOperation =>
      candidate.operationId === operationId &&
      isLegacyV3LocalEffectOperation(candidate),
  );
  if (
    operation === undefined ||
    operation.localEffectObservation.kind !==
      LOCAL_EFFECT_OBSERVATION_KIND.legacyV3Unfenced
  ) {
    return undefined;
  }
  let replacement: ReconciliationNonHistoryOperation;
  if (evidenceKind === "exact") {
    if (expected === undefined || effectId === undefined) return undefined;
    const priorPhase = operation.localEffectObservation.priorPhase;
    replacement = {
      ...operation,
      phase: deriveRecoveredV3Phase(operation, priorPhase),
      localEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
      localEffectObservation: {
        kind: LOCAL_EFFECT_OBSERVATION_KIND.recoveredV3,
        effectId,
        path: expected.path,
        expectedHash: expected.expectedHash,
        listenerEpoch: operation.snapshot.runtime.listenerEpoch,
        beforeGeneration: expected.beforeGeneration,
        postconditionHash: expected.expectedHash,
        successor: null,
      },
    };
  } else {
    const recoveryState =
      evidenceKind === "ambiguous"
        ? LEGACY_V3_LOCAL_EFFECT_RECOVERY_STATE.evidenceRequired
        : LEGACY_V3_LOCAL_EFFECT_RECOVERY_STATE.blocked;
    replacement = {
      ...operation,
      phase:
        evidenceKind === "ambiguous"
          ? RECONCILIATION_OPERATION_PHASE.evidenceRequired
          : RECONCILIATION_OPERATION_PHASE.blocked,
      localEffectObservation: {
        ...operation.localEffectObservation,
        recoveryState,
      },
    };
  }
  return replaceOperationAndReview(state, replacement);
}

/**
 * @param operation - Migrated operation whose exact local postcondition was recovered.
 * @param priorPhase - Exact phase retained from frozen v3 state.
 * @returns Safe post-recovery phase without reopening a completed or separately blocked operation.
 */
export function deriveRecoveredV3Phase(
  operation: ReconciliationNonHistoryOperation,
  priorPhase: ReconciliationOperationPhase,
): ReconciliationOperationPhase {
  if (
    priorPhase === RECONCILIATION_OPERATION_PHASE.completed ||
    priorPhase === RECONCILIATION_OPERATION_PHASE.stale ||
    priorPhase === RECONCILIATION_OPERATION_PHASE.blocked
  ) {
    return priorPhase;
  }
  if (operation.action.kind === RECONCILIATION_ACTION.restoreRecovery) {
    return RECONCILIATION_OPERATION_PHASE.restoredPendingReview;
  }
  return operation.remoteEffect === MUTATION_EFFECT_CERTAINTY.unknown
    ? RECONCILIATION_OPERATION_PHASE.evidenceRequired
    : RECONCILIATION_OPERATION_PHASE.partial;
}

/** @returns State with reciprocal review lifecycle updated in the same durable save. */
function replaceOperationAndReview(
  state: MirrorDeviceState,
  replacement: ReconciliationNonHistoryOperation,
): MirrorDeviceState {
  const reviewStatus =
    replacement.phase === RECONCILIATION_OPERATION_PHASE.completed
      ? RECONCILIATION_REVIEW_STATUS.completed
      : replacement.phase === RECONCILIATION_OPERATION_PHASE.stale
        ? RECONCILIATION_REVIEW_STATUS.stale
        : RECONCILIATION_REVIEW_STATUS.staged;
  return {
    ...state,
    reconciliationReviews: state.reconciliationReviews.map((review) =>
      review.reviewId === replacement.reviewId
        ? { ...review, status: reviewStatus }
        : review,
    ),
    reconciliationOperations: state.reconciliationOperations.map((operation) =>
      operation.operationId === replacement.operationId
        ? replacement
        : operation,
    ),
  };
}
