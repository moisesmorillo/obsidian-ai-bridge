import { classifyReconciliation } from "@core/mirror/divergence-classifier";
import { RECOVERY_SNAPSHOT_STATE_KIND } from "@core/mirror/mirror.constants";
import { MIRROR_ACKNOWLEDGEMENT_KIND } from "@core/mirror/mirror-state.constants";
import {
  RECONCILIATION_ACTION,
  RECONCILIATION_AUTHORITY_SOURCE,
  RECONCILIATION_CLASSIFICATION,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
} from "@core/mirror/reconciliation-state.constants";
import type {
  ReconciliationAction,
  ReconciliationReviewSnapshot,
} from "@core/mirror/reconciliation-state.types";

/**
 * Returns the one authoritative action set for a sampled classification and its
 * exact evidence kind. The result is advisory only; admission rechecks the sample.
 *
 * @param snapshot - Immutable review evidence used to derive operator actions.
 * @returns Closed action kinds supported by the current evidence.
 */
export function allowedReconciliationActions(
  snapshot: ReconciliationReviewSnapshot,
): readonly ReconciliationAction["kind"][] {
  const target = snapshot.paths.find(
    (evidence) => evidence.path === snapshot.targetPath,
  );
  if (target === undefined) return [];
  const classification = classifyReconciliation(snapshot);
  const hasUsableRecovery =
    snapshot.recovery !== null &&
    snapshot.recovery.kind !== RECOVERY_SNAPSHOT_STATE_KIND.purged;
  if (
    classification === RECONCILIATION_CLASSIFICATION.aligned ||
    classification === RECONCILIATION_CLASSIFICATION.localAhead
  ) {
    return isUnassociatedRemoteAbsence(target)
      ? []
      : [RECONCILIATION_ACTION.defer];
  }
  if (
    classification === RECONCILIATION_CLASSIFICATION.unknownLocal ||
    classification === RECONCILIATION_CLASSIFICATION.remoteUnavailable ||
    classification === RECONCILIATION_CLASSIFICATION.unresolvedM3Effect
  ) {
    return [RECONCILIATION_ACTION.defer];
  }
  if (classification === RECONCILIATION_CLASSIFICATION.deferredHistory) {
    return [RECONCILIATION_ACTION.resolveHistory, RECONCILIATION_ACTION.defer];
  }
  if (classification === RECONCILIATION_CLASSIFICATION.legacyRemote) {
    return [RECONCILIATION_ACTION.forkLegacy, RECONCILIATION_ACTION.defer];
  }
  if (classification === RECONCILIATION_CLASSIFICATION.localMissing) {
    return localMissingActions(target, hasUsableRecovery);
  }
  if (classification === RECONCILIATION_CLASSIFICATION.remoteTombstoned) {
    return tombstoneActions(target, hasUsableRecovery);
  }
  if (classification === RECONCILIATION_CLASSIFICATION.remoteAhead) {
    return remoteAheadActions(target);
  }
  return [
    RECONCILIATION_ACTION.keepLocal,
    RECONCILIATION_ACTION.useRemote,
    RECONCILIATION_ACTION.keepBoth,
    RECONCILIATION_ACTION.defer,
  ];
}

/**
 * Checks an explicit action against the same classification/evidence table used
 * by the current review UI.
 *
 * @param snapshot - Current immutable evidence.
 * @param action - Explicit operator action to validate.
 * @returns Whether the action is admissible for this exact sample.
 */
export function isReconciliationActionAllowed(
  snapshot: ReconciliationReviewSnapshot,
  action: ReconciliationAction,
): boolean {
  const allowed = allowedReconciliationActions(snapshot);
  if (!allowed.includes(action.kind)) return false;
  if (
    action.kind === RECONCILIATION_ACTION.keepBoth &&
    snapshot.paths.find((evidence) => evidence.path === snapshot.targetPath)
      ?.local.kind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.live
  ) {
    return false;
  }
  if (
    action.kind === RECONCILIATION_ACTION.adoptRevision &&
    !isExactAdoptionEvidence(snapshot)
  ) {
    return false;
  }
  if (
    action.kind === RECONCILIATION_ACTION.acceptTombstone &&
    !isAbsentTombstoneEvidence(snapshot)
  ) {
    return false;
  }
  if (
    action.kind === RECONCILIATION_ACTION.recreateRemote &&
    !isLiveTombstoneEvidence(snapshot)
  ) {
    return false;
  }
  return true;
}

/**
 * Returns the authority category required when an action is admitted.
 * @param action - Explicit operator action.
 * @returns Closed authority source for the action.
 */
export function reconciliationAuthorityForAction(
  action: ReconciliationAction,
): import("@core/mirror/reconciliation-state.types").ReconciliationAuthoritySource {
  switch (action.kind) {
    case RECONCILIATION_ACTION.keepLocal:
    case RECONCILIATION_ACTION.useRemote:
    case RECONCILIATION_ACTION.keepBoth:
    case RECONCILIATION_ACTION.defer:
      return RECONCILIATION_AUTHORITY_SOURCE.reconciliationDecision;
    case RECONCILIATION_ACTION.adoptRevision:
    case RECONCILIATION_ACTION.forkLegacy:
      return RECONCILIATION_AUTHORITY_SOURCE.adoptionDecision;
    case RECONCILIATION_ACTION.acceptTombstone:
    case RECONCILIATION_ACTION.recreateRemote:
      return RECONCILIATION_AUTHORITY_SOURCE.tombstoneDecision;
    case RECONCILIATION_ACTION.restoreRecovery:
      return RECONCILIATION_AUTHORITY_SOURCE.recoveryRestoreDecision;
    case RECONCILIATION_ACTION.resolveHistory:
      return RECONCILIATION_AUTHORITY_SOURCE.historyDecision;
  }
}

/**
 * Selects live/live actions while reserving exact-revision adoption for equal or absent local evidence.
 * @param snapshotPath - Target evidence for the remote-ahead classification.
 * @returns Allowed action kinds.
 */
function remoteAheadActions(
  snapshotPath: ReconciliationReviewSnapshot["paths"][number],
): readonly ReconciliationAction["kind"][] {
  if (snapshotPath.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.live) {
    return [RECONCILIATION_ACTION.defer];
  }
  if (
    snapshotPath.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.absent ||
    (snapshotPath.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live &&
      snapshotPath.local.contentSha256 === snapshotPath.remote.contentSha256)
  ) {
    return [
      RECONCILIATION_ACTION.useRemote,
      RECONCILIATION_ACTION.adoptRevision,
      RECONCILIATION_ACTION.defer,
    ];
  }
  return [
    RECONCILIATION_ACTION.keepLocal,
    RECONCILIATION_ACTION.useRemote,
    RECONCILIATION_ACTION.keepBoth,
    RECONCILIATION_ACTION.defer,
  ];
}

/**
 * Selects safe tombstone actions without adding local delete authority.
 * @param path - Target evidence containing local state.
 * @param hasRecovery - Whether a usable recovery metadata selection exists.
 * @returns Allowed action kinds.
 */
function tombstoneActions(
  path: ReconciliationReviewSnapshot["paths"][number],
  hasRecovery: boolean,
): readonly ReconciliationAction["kind"][] {
  if (path.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.absent) {
    return [
      RECONCILIATION_ACTION.acceptTombstone,
      ...(hasRecovery ? [RECONCILIATION_ACTION.restoreRecovery] : []),
      RECONCILIATION_ACTION.defer,
    ];
  }
  return [
    RECONCILIATION_ACTION.recreateRemote,
    RECONCILIATION_ACTION.keepBoth,
    ...(hasRecovery ? [RECONCILIATION_ACTION.restoreRecovery] : []),
    RECONCILIATION_ACTION.defer,
  ];
}

/**
 * Selects exact remote import/adoption actions for an absent local path.
 * @param path - Target evidence containing remote state.
 * @param hasRecovery - Whether a usable recovery metadata selection exists.
 * @returns Allowed action kinds.
 */
function localMissingActions(
  path: ReconciliationReviewSnapshot["paths"][number],
  hasRecovery: boolean,
): readonly ReconciliationAction["kind"][] {
  if (path.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.live) {
    return hasRecovery
      ? [RECONCILIATION_ACTION.restoreRecovery, RECONCILIATION_ACTION.defer]
      : [RECONCILIATION_ACTION.defer];
  }
  return [
    RECONCILIATION_ACTION.useRemote,
    RECONCILIATION_ACTION.adoptRevision,
    ...(hasRecovery ? [RECONCILIATION_ACTION.restoreRecovery] : []),
    RECONCILIATION_ACTION.defer,
  ];
}

/**
 * Keeps adoption explicit and limited to a revisioned live remote with absent/equal local bytes.
 * @param snapshot - Immutable sampled evidence.
 * @returns Whether exact adoption evidence is present.
 */
function isExactAdoptionEvidence(
  snapshot: ReconciliationReviewSnapshot,
): boolean {
  const target = snapshot.paths.find(
    (evidence) => evidence.path === snapshot.targetPath,
  );
  return (
    target?.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live &&
    (target.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.absent ||
      (target.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live &&
        target.local.contentSha256 === target.remote.contentSha256))
  );
}

/**
 * Accepts a tombstone only when the exact local observation proves absence.
 * @param snapshot - Immutable sampled evidence.
 * @returns Whether local absence and tombstone evidence align.
 */
function isAbsentTombstoneEvidence(
  snapshot: ReconciliationReviewSnapshot,
): boolean {
  const target = snapshot.paths.find(
    (evidence) => evidence.path === snapshot.targetPath,
  );
  return (
    target?.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.absent &&
    target.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone
  );
}

/**
 * Accepts remote recreation only for a live local sample and exact tombstone evidence.
 * @param snapshot - Immutable sampled evidence.
 * @returns Whether remote recreation prerequisites are present.
 */
function isLiveTombstoneEvidence(
  snapshot: ReconciliationReviewSnapshot,
): boolean {
  const target = snapshot.paths.find(
    (evidence) => evidence.path === snapshot.targetPath,
  );
  return (
    target?.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live &&
    target.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone
  );
}

/**
 * Identifies unassociated local absence from remote physical absence as ordinary M3 territory.
 * @param path - Target evidence.
 * @returns Whether M3, rather than M4, owns this absence.
 */
function isUnassociatedRemoteAbsence(
  path: ReconciliationReviewSnapshot["paths"][number],
): boolean {
  return (
    path.baseline.kind === MIRROR_ACKNOWLEDGEMENT_KIND.unassociated &&
    path.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live &&
    path.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.absent
  );
}
