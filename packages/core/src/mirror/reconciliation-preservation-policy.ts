import { isHistoryReconciliationOperation } from "@core/mirror/reconciliation-operation";
import {
  HISTORY_DECISION_KIND,
  HISTORY_PROGRESS_KIND,
  RECONCILIATION_ACTION,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_PRESERVATION_PROOF_STATE,
  RECONCILIATION_PRESERVATION_SCOPE,
  RECONCILIATION_PRESERVATION_SIDE,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
} from "@core/mirror/reconciliation-state.constants";
import type {
  ReconciliationOperation,
  ReconciliationPathEvidence,
  ReconciliationPreservationReceipt,
} from "@core/mirror/reconciliation-state.types";

/** Exact competing-byte identity derived from admitted evidence, never receipt claims. */
export interface RequiredReconciliationPreservation {
  /** Exact history step selector; absent for ordinary operation-scoped artifacts. */
  readonly stepId?: import("@core/mirror/mirror.types").MirrorOperationId;
  readonly originalPath: ReconciliationPreservationReceipt["originalPath"];
  readonly side: ReconciliationPreservationReceipt["side"];
  readonly sourceRevision: ReconciliationPreservationReceipt["sourceRevision"];
  readonly contentSha256: ReconciliationPreservationReceipt["contentSha256"];
}

/**
 * Owns the action-to-competing-bytes preservation matrix for validation and execution.
 *
 * An empty list means the action needs no archive. `undefined` means the immutable
 * evidence cannot establish the required bytes and therefore cannot authorize an
 * effect. Adapters must consume this decision rather than reimplement it.
 *
 * @param operation - Durable admitted operation with immutable sampled evidence.
 * @returns Exact preservation requirements, an empty list, or undefined for insufficient evidence.
 */
export function requiredReconciliationPreservations(
  operation: ReconciliationOperation,
): readonly RequiredReconciliationPreservation[] | undefined {
  const target = targetEvidence(operation);
  if (target === undefined) return undefined;
  switch (operation.action.kind) {
    case RECONCILIATION_ACTION.keepLocal:
      return remotePreservation(target);
    case RECONCILIATION_ACTION.useRemote:
      return target.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live
        ? localPreservation(target)
        : [];
    case RECONCILIATION_ACTION.keepBoth:
      return operation.action.primarySide ===
        RECONCILIATION_PRESERVATION_SIDE.local
        ? remotePreservation(target)
        : target.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live
          ? localPreservation(target)
          : undefined;
    case RECONCILIATION_ACTION.adoptRevision:
    case RECONCILIATION_ACTION.acceptTombstone:
    case RECONCILIATION_ACTION.defer:
      return [];
    case RECONCILIATION_ACTION.recreateRemote:
      return target.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live
        ? localPreservation(target)
        : undefined;
    case RECONCILIATION_ACTION.restoreRecovery: {
      const destination = destinationEvidence(operation);
      if (destination === undefined) return undefined;
      return destination.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live
        ? localPreservation(destination)
        : [];
    }
    case RECONCILIATION_ACTION.forkLegacy:
      return remotePreservation(target);
    case RECONCILIATION_ACTION.resolveHistory:
      return isHistoryReconciliationOperation(operation)
        ? historyPreservation(operation)
        : undefined;
  }
}

/**
 * Proves every evidence-derived requirement has one complete verified receipt.
 *
 * @param requirements - Canonical preservation identities derived from the operation.
 * @param receipts - Durable proof claims whose full identities must match.
 * @returns Whether every required competing version is durably verified.
 */
export function areRequiredReconciliationPreservationsVerified(
  requirements: readonly RequiredReconciliationPreservation[],
  receipts: readonly ReconciliationPreservationReceipt[],
): boolean {
  return requirements.every((required) =>
    receipts.some(
      (receipt) =>
        (required.stepId === undefined
          ? receipt.scope === RECONCILIATION_PRESERVATION_SCOPE.operation
          : receipt.scope === RECONCILIATION_PRESERVATION_SCOPE.historyStep &&
            receipt.stepId === required.stepId) &&
        receipt.originalPath === required.originalPath &&
        receipt.side === required.side &&
        receipt.sourceRevision === required.sourceRevision &&
        receipt.contentSha256 === required.contentSha256 &&
        receipt.proofState === RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
    ),
  );
}

/** @returns The immutable target path evidence, or undefined for malformed snapshots. */
function targetEvidence(
  operation: ReconciliationOperation,
): ReconciliationPathEvidence | undefined {
  return operation.snapshot.paths.find(
    (evidence) => evidence.path === operation.snapshot.targetPath,
  );
}

/** @returns Explicit destination evidence, falling back to the in-place target. */
function destinationEvidence(
  operation: ReconciliationOperation,
): ReconciliationPathEvidence | undefined {
  const destination =
    operation.destinationPath ?? operation.snapshot.targetPath;
  return operation.snapshot.paths.find(
    (evidence) => evidence.path === destination,
  );
}

/** @returns One exact local copy requirement, or undefined without live local bytes. */
function localPreservation(
  evidence: ReconciliationPathEvidence,
): readonly RequiredReconciliationPreservation[] | undefined {
  if (evidence.local.kind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.live) {
    return undefined;
  }
  return [
    {
      originalPath: evidence.path,
      side: RECONCILIATION_PRESERVATION_SIDE.local,
      sourceRevision: null,
      contentSha256: evidence.local.contentSha256,
    },
  ];
}

/** @returns One exact remote live/legacy copy requirement, or undefined without preservable bytes. */
function remotePreservation(
  evidence: ReconciliationPathEvidence,
): readonly RequiredReconciliationPreservation[] | undefined {
  switch (evidence.remote.kind) {
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.live:
      return [
        {
          originalPath: evidence.path,
          side: RECONCILIATION_PRESERVATION_SIDE.remote,
          sourceRevision: evidence.remote.revision,
          contentSha256: evidence.remote.contentSha256,
        },
      ];
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy:
      return [
        {
          originalPath: evidence.path,
          side: RECONCILIATION_PRESERVATION_SIDE.remote,
          sourceRevision: null,
          contentSha256: evidence.remote.contentSha256,
        },
      ];
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.absent:
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone:
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.unavailable:
      return undefined;
  }
}

/**
 * Derives the one current step-scoped remote preservation identity.
 *
 * @param operation - Refined or migrated history operation.
 * @returns No requirements for no-effect decisions, one exact step requirement, or undefined for migration attention.
 */
function historyPreservation(
  operation: Extract<
    ReconciliationOperation,
    { readonly action: { readonly kind: "bounded-history-decision" } }
  >,
): readonly RequiredReconciliationPreservation[] | undefined {
  if (
    operation.historyProgress.kind === HISTORY_PROGRESS_KIND.legacyV3Unrefined
  ) {
    return undefined;
  }
  if (
    operation.historyProgress.decision.kind ===
      HISTORY_DECISION_KIND.retainIndependent ||
    operation.historyProgress.decision.kind ===
      HISTORY_DECISION_KIND.deferHistory
  ) {
    return [];
  }
  const index = operation.historyProgress.nextStepIndex;
  if (index === null) return [];
  const step = operation.historyProgress.steps[index];
  if (step === undefined) return undefined;
  return [
    {
      stepId: step.stepId,
      originalPath: step.sourcePath,
      side: RECONCILIATION_PRESERVATION_SIDE.remote,
      sourceRevision: step.sourceRevision,
      contentSha256: step.sourceContentSha256,
    },
  ];
}
