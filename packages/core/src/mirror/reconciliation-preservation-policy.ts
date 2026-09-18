import { MUTATION_EFFECT_CERTAINTY } from "@core/mirror/mirror.constants";
import {
  RECONCILIATION_ACTION,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_OPERATION_PHASE,
  RECONCILIATION_PRESERVATION_PROOF_STATE,
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
      return historyHasMaterialEffect(operation)
        ? remotePreservation(target)
        : [];
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

/** @returns Whether history has entered archive/cleanup progress rather than no-effect retention. */
function historyHasMaterialEffect(operation: ReconciliationOperation): boolean {
  return (
    operation.phase === RECONCILIATION_OPERATION_PHASE.preserving ||
    operation.phase === RECONCILIATION_OPERATION_PHASE.mutatingRemote ||
    operation.phase === RECONCILIATION_OPERATION_PHASE.evidenceRequired ||
    operation.phase === RECONCILIATION_OPERATION_PHASE.partial ||
    operation.remoteEffect !== MUTATION_EFFECT_CERTAINTY.notDispatched ||
    operation.preservationReceipts.length > 0
  );
}
