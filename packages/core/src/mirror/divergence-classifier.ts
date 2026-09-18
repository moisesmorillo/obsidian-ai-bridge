import { MIRROR_ACKNOWLEDGEMENT_KIND } from "@core/mirror/mirror-state.constants";
import {
  RECONCILIATION_CLASSIFICATION,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
} from "@core/mirror/reconciliation-state.constants";
import type {
  ReconciliationClassification,
  ReconciliationPathEvidence,
  ReconciliationReviewSnapshot,
} from "@core/mirror/reconciliation-state.types";

/**
 * Classifies one complete snapshot using the authoritative M4 precedence table.
 * M3 ownership and unavailable evidence are evaluated before three-way content
 * comparison, so remote divergence never becomes mutation authority by itself.
 *
 * @param snapshot - Complete local, baseline, remote and related-path evidence.
 * @returns Deterministic M4 classification for the target path.
 */
export function classifyReconciliation(
  snapshot: ReconciliationReviewSnapshot,
): ReconciliationClassification {
  const precedence = precedenceClassification(snapshot);
  if (precedence !== undefined) return precedence;
  const target = targetEvidence(snapshot);
  if (target === undefined) return RECONCILIATION_CLASSIFICATION.unknownLocal;
  return classifyOrdinaryEvidence(target);
}

/**
 * Determines whether a snapshot is useful as an M4 review rather than ordinary
 * aligned state or an unassociated local create that M3 already owns.
 *
 * @param snapshot - Complete sampled snapshot to assess for review creation.
 * @returns Whether an ephemeral review should be retained.
 */
export function isReconciliationReviewable(
  snapshot: ReconciliationReviewSnapshot,
): boolean {
  const classification = classifyReconciliation(snapshot);
  if (classification === RECONCILIATION_CLASSIFICATION.aligned) return false;
  const target = targetEvidence(snapshot);
  return !(
    classification === RECONCILIATION_CLASSIFICATION.localAhead &&
    target !== undefined &&
    target.baseline.kind === MIRROR_ACKNOWLEDGEMENT_KIND.unassociated &&
    target.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.absent
  );
}

/**
 * Returns precedence classifications shared by every related path.
 * @param snapshot - Snapshot whose related paths are checked.
 * @returns The first blocking classification, or undefined.
 */
function precedenceClassification(
  snapshot: ReconciliationReviewSnapshot,
): ReconciliationClassification | undefined {
  if (
    snapshot.paths.some((evidence) => evidence.m3.unresolvedMutation !== null)
  ) {
    return RECONCILIATION_CLASSIFICATION.unresolvedM3Effect;
  }
  if (snapshot.paths.some((evidence) => evidence.m3.deferredHistory !== null)) {
    return RECONCILIATION_CLASSIFICATION.deferredHistory;
  }
  if (
    snapshot.paths.some(
      (evidence) =>
        evidence.remote.kind ===
        RECONCILIATION_REMOTE_EVIDENCE_KIND.unavailable,
    )
  ) {
    return RECONCILIATION_CLASSIFICATION.remoteUnavailable;
  }
  if (
    snapshot.paths.some(
      (evidence) =>
        evidence.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown,
    )
  ) {
    return RECONCILIATION_CLASSIFICATION.unknownLocal;
  }
  return undefined;
}

/**
 * Classifies local/baseline/remote evidence after all blocking precedence rows pass.
 * @param evidence - One complete target-path evidence tuple.
 * @returns The ordinary three-way classification.
 */
function classifyOrdinaryEvidence(
  evidence: ReconciliationPathEvidence,
): ReconciliationClassification {
  if (evidence.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy) {
    return RECONCILIATION_CLASSIFICATION.legacyRemote;
  }
  if (evidence.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone) {
    if (
      evidence.baseline.kind === MIRROR_ACKNOWLEDGEMENT_KIND.tombstone &&
      evidence.baseline.revision === evidence.remote.revision &&
      evidence.baseline.recoveryId === evidence.remote.recoveryId &&
      evidence.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.absent
    ) {
      return RECONCILIATION_CLASSIFICATION.aligned;
    }
    return RECONCILIATION_CLASSIFICATION.remoteTombstoned;
  }
  if (evidence.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.absent) {
    return evidence.baseline.kind === MIRROR_ACKNOWLEDGEMENT_KIND.unassociated
      ? evidence.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.absent
        ? RECONCILIATION_CLASSIFICATION.aligned
        : RECONCILIATION_CLASSIFICATION.localAhead
      : RECONCILIATION_CLASSIFICATION.remoteUnavailable;
  }
  if (evidence.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.absent) {
    return RECONCILIATION_CLASSIFICATION.localMissing;
  }
  if (evidence.baseline.kind === MIRROR_ACKNOWLEDGEMENT_KIND.unassociated) {
    return RECONCILIATION_CLASSIFICATION.remoteAhead;
  }
  if (evidence.baseline.kind === MIRROR_ACKNOWLEDGEMENT_KIND.tombstone) {
    return RECONCILIATION_CLASSIFICATION.remoteAhead;
  }
  if (
    evidence.local.kind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.live ||
    evidence.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.live
  ) {
    return RECONCILIATION_CLASSIFICATION.unknownLocal;
  }
  const localChanged =
    evidence.local.contentSha256 !== evidence.baseline.contentSha256;
  const remoteChanged =
    evidence.remote.revision !== evidence.baseline.revision ||
    evidence.remote.contentSha256 !== evidence.baseline.contentSha256;
  if (!localChanged && !remoteChanged) {
    return RECONCILIATION_CLASSIFICATION.aligned;
  }
  if (localChanged && remoteChanged) {
    return RECONCILIATION_CLASSIFICATION.bothChanged;
  }
  return remoteChanged
    ? RECONCILIATION_CLASSIFICATION.remoteAhead
    : RECONCILIATION_CLASSIFICATION.localAhead;
}

/**
 * Locates the target without treating a missing target as an absence observation.
 * @param snapshot - Complete review snapshot.
 * @returns Target evidence, or undefined for malformed input.
 */
function targetEvidence(
  snapshot: ReconciliationReviewSnapshot,
): ReconciliationPathEvidence | undefined {
  return snapshot.paths.find(
    (evidence) => evidence.path === snapshot.targetPath,
  );
}
