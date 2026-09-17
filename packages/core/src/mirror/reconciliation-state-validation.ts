import { MUTATION_EFFECT_CERTAINTY } from "@core/mirror/mirror.constants";
import {
  createApplicationRevision,
  createMirrorAssociationId,
  createMirrorOperationId,
  createRecoverySnapshotId,
  isContentSha256,
} from "@core/mirror/mirror-identifiers";
import {
  MAX_MIRROR_TRACKED_PATHS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
} from "@core/mirror/mirror-state.constants";
import type { MirrorDeviceState } from "@core/mirror/mirror-state.types";
import {
  MAX_RECONCILIATION_OPERATIONS,
  MAX_RECONCILIATION_PRESERVATION_RECEIPTS,
  MAX_RECONCILIATION_REVIEWS,
  RECONCILIATION_ACTION,
  RECONCILIATION_AUTHORITY_SOURCE,
  RECONCILIATION_CLASSIFICATION,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_OPERATION_PHASE,
  RECONCILIATION_PATH_REFERENCE_KIND,
  RECONCILIATION_PRESERVATION_PROOF_STATE,
  RECONCILIATION_PRESERVATION_SIDE,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
  RECONCILIATION_REVIEW_RETENTION,
  RECONCILIATION_REVIEW_STATUS,
} from "@core/mirror/reconciliation-state.constants";
import type {
  ReconciliationEvidence,
  ReconciliationOperation,
  ReconciliationPreservationReceipt,
  ReconciliationReview,
} from "@core/mirror/reconciliation-state.types";
import { isNormalizedNotePath } from "@core/note-path/note-path";

/**
 * Validates all cross-field M4 review, operation, reservation, and M3-precedence rules.
 *
 * The implementation indexes paths and identities once so validation remains linear
 * in tracked paths plus sparse M4 records. It validates metadata only; note bodies
 * are not part of the type or wire schema.
 *
 * @param state - Candidate version-3 device state after strict field conversion.
 * @returns Whether its sparse M4 relationships are internally safe.
 */
export function isReconciliationStateConsistent(
  state: MirrorDeviceState,
): boolean {
  if (!validateCapacity(state)) return false;
  const trackedPaths = new Set(state.paths.map((entry) => entry.path));
  const pathStates = new Map(state.paths.map((entry) => [entry.path, entry]));
  const reviews = new Map<string, ReconciliationReview>();
  const operations = new Map<string, ReconciliationOperation>();

  for (const review of state.reconciliationReviews) {
    if (
      !validateReview(review) ||
      !validateEvidenceAssociation(state, review.evidence) ||
      reviews.has(review.reviewId)
    ) {
      return false;
    }
    reviews.set(review.reviewId, review);
  }
  for (const operation of state.reconciliationOperations) {
    if (
      !validateOperationFields(operation) ||
      operations.has(operation.operationId)
    ) {
      return false;
    }
    if (reviews.has(operation.operationId)) return false;
    operations.set(operation.operationId, operation);
  }
  if (!validateLifecycle(state)) return false;

  const activelyReservedPaths = new Set<string>();
  for (const operation of state.reconciliationOperations) {
    const review = reviews.get(operation.reviewId);
    if (
      review === undefined ||
      review.operationId !== operation.operationId ||
      review.targetPath !== operation.sourcePath ||
      !evidenceEquals(review.evidence, operation.evidence) ||
      !validateReviewOperationLifecycle(review, operation) ||
      !validateClassificationAction(review, operation) ||
      !validateOperationAuthority(operation) ||
      !validateOperationPaths(operation, review, trackedPaths) ||
      !validateM3Precedence(operation, pathStates)
    ) {
      return false;
    }
    if (isActiveOperation(operation)) {
      for (const reservation of operation.reservations) {
        if (activelyReservedPaths.has(reservation.path)) return false;
        activelyReservedPaths.add(reservation.path);
      }
    }
  }

  for (const review of state.reconciliationReviews) {
    if (!validateReviewRelationship(review, operations, pathStates))
      return false;
  }
  return true;
}

function validateCapacity(state: MirrorDeviceState): boolean {
  if (
    state.reconciliationReviews.length > MAX_RECONCILIATION_REVIEWS ||
    state.reconciliationOperations.length > MAX_RECONCILIATION_OPERATIONS
  ) {
    return false;
  }
  let receipts = 0;
  let pathReferences = 0;
  for (const review of state.reconciliationReviews) {
    pathReferences += 1 + review.relatedPaths.length;
  }
  for (const operation of state.reconciliationOperations) {
    receipts += operation.preservationReceipts.length;
    pathReferences += operation.reservations.length;
  }
  return (
    receipts <= MAX_RECONCILIATION_PRESERVATION_RECEIPTS &&
    pathReferences <= MAX_MIRROR_TRACKED_PATHS
  );
}

function validateLifecycle(state: MirrorDeviceState): boolean {
  const hasActiveOperation =
    state.reconciliationOperations.some(isActiveOperation);
  switch (state.lifecycle.kind) {
    case MIRROR_DEVICE_LIFECYCLE_KIND.disabled:
    case MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged:
      return (
        state.reconciliationReviews.length === 0 &&
        state.reconciliationOperations.length === 0
      );
    case MIRROR_DEVICE_LIFECYCLE_KIND.handoffDrained:
      return !hasActiveOperation;
    case MIRROR_DEVICE_LIFECYCLE_KIND.active:
    case MIRROR_DEVICE_LIFECYCLE_KIND.paused:
    case MIRROR_DEVICE_LIFECYCLE_KIND.handoffDraining:
      return true;
  }
}

function validateReview(review: ReconciliationReview): boolean {
  if (
    review.retention !== RECONCILIATION_REVIEW_RETENTION.durable ||
    createMirrorOperationId(review.reviewId) !== review.reviewId ||
    !isNormalizedNotePath(review.targetPath) ||
    review.relatedPaths.length > MAX_MIRROR_TRACKED_PATHS
  ) {
    return false;
  }
  const paths = new Set<string>([review.targetPath]);
  for (const path of review.relatedPaths) {
    if (!isNormalizedNotePath(path) || paths.has(path)) return false;
    paths.add(path);
  }
  if (!validateEvidence(review.evidence)) return false;
  if (review.operationId !== null) {
    return createMirrorOperationId(review.operationId) === review.operationId;
  }
  return review.status !== RECONCILIATION_REVIEW_STATUS.staged;
}

function validateOperationFields(operation: ReconciliationOperation): boolean {
  if (
    createMirrorOperationId(operation.operationId) !== operation.operationId ||
    createMirrorOperationId(operation.reviewId) !== operation.reviewId ||
    operation.operationId === operation.reviewId ||
    !isNormalizedNotePath(operation.sourcePath) ||
    (operation.destinationPath !== null &&
      (!isNormalizedNotePath(operation.destinationPath) ||
        operation.destinationPath === operation.sourcePath)) ||
    operation.reservations.length === 0 ||
    !validateEvidence(operation.evidence) ||
    !validateRecovery(operation) ||
    !validateActionEvidence(operation) ||
    !validateActionPhase(operation)
  ) {
    return false;
  }
  const reserved = new Set<string>();
  for (const reservation of operation.reservations) {
    if (
      !isNormalizedNotePath(reservation.path) ||
      reserved.has(reservation.path)
    ) {
      return false;
    }
    reserved.add(reservation.path);
  }
  if (!reserved.has(operation.sourcePath)) return false;
  if (
    operation.destinationPath !== null &&
    !reserved.has(operation.destinationPath)
  ) {
    return false;
  }
  const receiptSides = new Set<string>();
  for (const receipt of operation.preservationReceipts) {
    if (
      !validatePreservationReceipt(operation, receipt) ||
      receiptSides.has(receipt.side)
    ) {
      return false;
    }
    receiptSides.add(receipt.side);
  }
  return (
    validatePreservationPolicy(operation, receiptSides) &&
    validateOperationLifecycleEvidence(operation)
  );
}

function validateEvidenceAssociation(
  state: MirrorDeviceState,
  evidence: ReconciliationEvidence,
): boolean {
  if (
    evidence.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.live &&
    evidence.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone
  ) {
    return true;
  }
  return (
    state.lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.disabled &&
    evidence.remote.associationId === state.lifecycle.associationId
  );
}

function validateEvidence(evidence: ReconciliationEvidence): boolean {
  if (!validateAcknowledgement(evidence.baseline)) return false;
  switch (evidence.local.kind) {
    case RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown:
      break;
    case RECONCILIATION_LOCAL_EVIDENCE_KIND.absent:
      if (!isPositiveSafeInteger(evidence.local.observationGeneration)) {
        return false;
      }
      break;
    case RECONCILIATION_LOCAL_EVIDENCE_KIND.live:
      if (
        !isPositiveSafeInteger(evidence.local.observationGeneration) ||
        !isContentSha256(evidence.local.contentSha256)
      ) {
        return false;
      }
      break;
  }
  switch (evidence.remote.kind) {
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.absent:
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.unavailable:
      return true;
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy:
      return isContentSha256(evidence.remote.contentSha256);
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.live:
      return (
        createMirrorAssociationId(evidence.remote.associationId) ===
          evidence.remote.associationId &&
        createApplicationRevision(evidence.remote.revision) ===
          evidence.remote.revision &&
        isContentSha256(evidence.remote.contentSha256)
      );
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone:
      return (
        createMirrorAssociationId(evidence.remote.associationId) ===
          evidence.remote.associationId &&
        createApplicationRevision(evidence.remote.revision) ===
          evidence.remote.revision &&
        createRecoverySnapshotId(evidence.remote.recoveryId) ===
          evidence.remote.recoveryId
      );
  }
}

function validateAcknowledgement(
  acknowledgement: ReconciliationEvidence["baseline"],
): boolean {
  switch (acknowledgement.kind) {
    case MIRROR_ACKNOWLEDGEMENT_KIND.unassociated:
      return true;
    case MIRROR_ACKNOWLEDGEMENT_KIND.live:
      return (
        createApplicationRevision(acknowledgement.revision) ===
          acknowledgement.revision &&
        isContentSha256(acknowledgement.contentSha256)
      );
    case MIRROR_ACKNOWLEDGEMENT_KIND.tombstone:
      return (
        createApplicationRevision(acknowledgement.revision) ===
          acknowledgement.revision &&
        createRecoverySnapshotId(acknowledgement.recoveryId) ===
          acknowledgement.recoveryId
      );
  }
}

function validateRecovery(operation: ReconciliationOperation): boolean {
  if (operation.action.kind !== RECONCILIATION_ACTION.restoreRecovery) {
    return operation.recovery === null;
  }
  return (
    operation.recovery !== null &&
    createRecoverySnapshotId(operation.recovery.recoveryId) ===
      operation.recovery.recoveryId &&
    createApplicationRevision(operation.recovery.revision) ===
      operation.recovery.revision &&
    isContentSha256(operation.recovery.contentSha256)
  );
}

function validateActionEvidence(operation: ReconciliationOperation): boolean {
  const localKind = operation.evidence.local.kind;
  const remoteKind = operation.evidence.remote.kind;
  switch (operation.action.kind) {
    case RECONCILIATION_ACTION.keepLocal:
      return (
        localKind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live &&
        remoteKind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live
      );
    case RECONCILIATION_ACTION.useRemote:
      return (
        localKind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown &&
        remoteKind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live
      );
    case RECONCILIATION_ACTION.keepBoth:
      return (
        localKind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live &&
        (remoteKind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live ||
          (remoteKind === RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone &&
            operation.action.primarySide ===
              RECONCILIATION_PRESERVATION_SIDE.remote))
      );
    case RECONCILIATION_ACTION.adoptRevision:
      return (
        remoteKind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live &&
        (localKind === RECONCILIATION_LOCAL_EVIDENCE_KIND.absent ||
          (localKind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live &&
            operation.evidence.local.contentSha256 ===
              operation.evidence.remote.contentSha256))
      );
    case RECONCILIATION_ACTION.acceptTombstone:
      return (
        localKind === RECONCILIATION_LOCAL_EVIDENCE_KIND.absent &&
        remoteKind === RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone
      );
    case RECONCILIATION_ACTION.recreateRemote:
      return (
        localKind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live &&
        remoteKind === RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone
      );
    case RECONCILIATION_ACTION.restoreRecovery:
      return localKind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown;
    case RECONCILIATION_ACTION.forkLegacy:
      return remoteKind === RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy;
    case RECONCILIATION_ACTION.resolveHistory:
    case RECONCILIATION_ACTION.defer:
      return true;
  }
}

function validateActionPhase(operation: ReconciliationOperation): boolean {
  const { kind } = operation.action;
  const phase = operation.phase;
  if (kind === RECONCILIATION_ACTION.defer) {
    return (
      phase === RECONCILIATION_OPERATION_PHASE.completed && noEffects(operation)
    );
  }
  if (kind === RECONCILIATION_ACTION.acceptTombstone) {
    return (
      (phase === RECONCILIATION_OPERATION_PHASE.admitted ||
        phase === RECONCILIATION_OPERATION_PHASE.stale ||
        phase === RECONCILIATION_OPERATION_PHASE.blocked ||
        phase === RECONCILIATION_OPERATION_PHASE.completed) &&
      noEffects(operation)
    );
  }
  if (
    (kind === RECONCILIATION_ACTION.keepLocal ||
      kind === RECONCILIATION_ACTION.recreateRemote) &&
    phase === RECONCILIATION_OPERATION_PHASE.mutatingLocal
  ) {
    return false;
  }
  if (
    (kind === RECONCILIATION_ACTION.useRemote ||
      kind === RECONCILIATION_ACTION.adoptRevision ||
      kind === RECONCILIATION_ACTION.restoreRecovery) &&
    phase === RECONCILIATION_OPERATION_PHASE.mutatingRemote
  ) {
    return false;
  }
  if (
    (kind === RECONCILIATION_ACTION.useRemote ||
      kind === RECONCILIATION_ACTION.adoptRevision ||
      kind === RECONCILIATION_ACTION.restoreRecovery) &&
    operation.remoteEffect !== MUTATION_EFFECT_CERTAINTY.notDispatched
  ) {
    return false;
  }
  if (
    (kind === RECONCILIATION_ACTION.keepLocal ||
      kind === RECONCILIATION_ACTION.recreateRemote) &&
    operation.localEffect !== MUTATION_EFFECT_CERTAINTY.notDispatched
  ) {
    return false;
  }
  return true;
}

function validateClassificationAction(
  review: ReconciliationReview,
  operation: ReconciliationOperation,
): boolean {
  const action = operation.action.kind;
  if (action === RECONCILIATION_ACTION.defer) return true;
  switch (review.classification) {
    case RECONCILIATION_CLASSIFICATION.aligned:
    case RECONCILIATION_CLASSIFICATION.unknownLocal:
    case RECONCILIATION_CLASSIFICATION.remoteUnavailable:
    case RECONCILIATION_CLASSIFICATION.unresolvedM3Effect:
      return false;
    case RECONCILIATION_CLASSIFICATION.localAhead:
      return false;
    case RECONCILIATION_CLASSIFICATION.remoteAhead:
      return (
        action === RECONCILIATION_ACTION.keepLocal ||
        action === RECONCILIATION_ACTION.useRemote ||
        action === RECONCILIATION_ACTION.keepBoth ||
        action === RECONCILIATION_ACTION.adoptRevision
      );
    case RECONCILIATION_CLASSIFICATION.bothChanged:
      return (
        action === RECONCILIATION_ACTION.keepLocal ||
        action === RECONCILIATION_ACTION.useRemote ||
        action === RECONCILIATION_ACTION.keepBoth
      );
    case RECONCILIATION_CLASSIFICATION.remoteTombstoned:
      return (
        action === RECONCILIATION_ACTION.acceptTombstone ||
        action === RECONCILIATION_ACTION.recreateRemote ||
        action === RECONCILIATION_ACTION.keepBoth ||
        action === RECONCILIATION_ACTION.restoreRecovery
      );
    case RECONCILIATION_CLASSIFICATION.localMissing:
      return (
        action === RECONCILIATION_ACTION.useRemote ||
        action === RECONCILIATION_ACTION.adoptRevision ||
        action === RECONCILIATION_ACTION.restoreRecovery
      );
    case RECONCILIATION_CLASSIFICATION.legacyRemote:
      return action === RECONCILIATION_ACTION.forkLegacy;
    case RECONCILIATION_CLASSIFICATION.deferredHistory:
      return action === RECONCILIATION_ACTION.resolveHistory;
  }
}

function validateOperationAuthority(
  operation: ReconciliationOperation,
): boolean {
  switch (operation.action.kind) {
    case RECONCILIATION_ACTION.keepLocal:
    case RECONCILIATION_ACTION.useRemote:
    case RECONCILIATION_ACTION.keepBoth:
    case RECONCILIATION_ACTION.defer:
      return (
        operation.authority ===
        RECONCILIATION_AUTHORITY_SOURCE.reconciliationDecision
      );
    case RECONCILIATION_ACTION.adoptRevision:
    case RECONCILIATION_ACTION.forkLegacy:
      return (
        operation.authority === RECONCILIATION_AUTHORITY_SOURCE.adoptionDecision
      );
    case RECONCILIATION_ACTION.acceptTombstone:
    case RECONCILIATION_ACTION.recreateRemote:
      return (
        operation.authority ===
        RECONCILIATION_AUTHORITY_SOURCE.tombstoneDecision
      );
    case RECONCILIATION_ACTION.restoreRecovery:
      return (
        operation.authority ===
        RECONCILIATION_AUTHORITY_SOURCE.recoveryRestoreDecision
      );
    case RECONCILIATION_ACTION.resolveHistory:
      return (
        operation.authority === RECONCILIATION_AUTHORITY_SOURCE.historyDecision
      );
  }
}

function validateOperationPaths(
  operation: ReconciliationOperation,
  review: ReconciliationReview,
  trackedPaths: ReadonlySet<string>,
): boolean {
  const requiresDestination =
    operation.action.kind === RECONCILIATION_ACTION.keepBoth ||
    operation.action.kind === RECONCILIATION_ACTION.forkLegacy;
  const permitsDestination =
    requiresDestination ||
    operation.action.kind === RECONCILIATION_ACTION.restoreRecovery;
  if (requiresDestination && operation.destinationPath === null) return false;
  if (!permitsDestination && operation.destinationPath !== null) return false;
  const allowedPaths = new Set<string>([
    review.targetPath,
    ...review.relatedPaths,
    ...(operation.destinationPath === null ? [] : [operation.destinationPath]),
  ]);
  const reservedPaths = new Set(
    operation.reservations.map((reservation) => reservation.path),
  );
  if (review.relatedPaths.some((path) => !reservedPaths.has(path)))
    return false;
  for (const reservation of operation.reservations) {
    if (!allowedPaths.has(reservation.path)) return false;
    switch (reservation.kind) {
      case RECONCILIATION_PATH_REFERENCE_KIND.tracked:
        if (!trackedPaths.has(reservation.path)) return false;
        break;
      case RECONCILIATION_PATH_REFERENCE_KIND.reviewTarget:
        if (reservation.path !== review.targetPath) return false;
        break;
      case RECONCILIATION_PATH_REFERENCE_KIND.newDestination:
        if (
          operation.destinationPath !== reservation.path ||
          trackedPaths.has(reservation.path)
        ) {
          return false;
        }
        break;
    }
  }
  return true;
}

function validatePreservationReceipt(
  operation: ReconciliationOperation,
  receipt: ReconciliationPreservationReceipt,
): boolean {
  if (
    receipt.operationId !== operation.operationId ||
    receipt.originalPath !== operation.sourcePath ||
    !isContentSha256(receipt.contentSha256) ||
    !validatePreservationProofState(receipt)
  ) {
    return false;
  }
  const expectedPath = `.ai-bridge-conflicts/${operation.operationId}/${receipt.side}.md`;
  if (receipt.preservationPath !== expectedPath) return false;
  if (receipt.side === RECONCILIATION_PRESERVATION_SIDE.local) {
    return receipt.sourceRevision === null;
  }
  if (receipt.sourceRevision === null) {
    return (
      operation.evidence.remote.kind ===
      RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy
    );
  }
  return (
    createApplicationRevision(receipt.sourceRevision) ===
      receipt.sourceRevision &&
    (operation.evidence.remote.kind ===
      RECONCILIATION_REMOTE_EVIDENCE_KIND.live ||
      operation.evidence.remote.kind ===
        RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone) &&
    operation.evidence.remote.revision === receipt.sourceRevision
  );
}

function validatePreservationPolicy(
  operation: ReconciliationOperation,
  receiptSides: ReadonlySet<string>,
): boolean {
  switch (operation.action.kind) {
    case RECONCILIATION_ACTION.adoptRevision:
    case RECONCILIATION_ACTION.acceptTombstone:
    case RECONCILIATION_ACTION.defer:
      return receiptSides.size === 0;
    case RECONCILIATION_ACTION.keepLocal:
    case RECONCILIATION_ACTION.forkLegacy:
      return onlyAllowedSide(
        receiptSides,
        RECONCILIATION_PRESERVATION_SIDE.remote,
      );
    case RECONCILIATION_ACTION.useRemote:
    case RECONCILIATION_ACTION.recreateRemote:
    case RECONCILIATION_ACTION.restoreRecovery:
      return onlyAllowedSide(
        receiptSides,
        RECONCILIATION_PRESERVATION_SIDE.local,
      );
    case RECONCILIATION_ACTION.keepBoth:
      return onlyAllowedSide(
        receiptSides,
        operation.action.primarySide === RECONCILIATION_PRESERVATION_SIDE.local
          ? RECONCILIATION_PRESERVATION_SIDE.remote
          : RECONCILIATION_PRESERVATION_SIDE.local,
      );
    case RECONCILIATION_ACTION.resolveHistory:
      return true;
  }
}

function validateOperationLifecycleEvidence(
  operation: ReconciliationOperation,
): boolean {
  const receipts = operation.preservationReceipts;
  const effects = [operation.localEffect, operation.remoteEffect];
  const hasUnknownEffect = effects.includes(MUTATION_EFFECT_CERTAINTY.unknown);
  const hasMaterialEffect = effects.some(
    (effect) =>
      effect === MUTATION_EFFECT_CERTAINTY.confirmed ||
      effect === MUTATION_EFFECT_CERTAINTY.unknown,
  );
  const receiptsVerified = receipts.every(
    (receipt) =>
      receipt.proofState === RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
  );
  const noPendingReceipts = receipts.every(
    (receipt) =>
      receipt.proofState !== RECONCILIATION_PRESERVATION_PROOF_STATE.pending,
  );

  let phaseIsConsistent: boolean;
  switch (operation.phase) {
    case RECONCILIATION_OPERATION_PHASE.admitted:
      phaseIsConsistent = noEffects(operation) && receipts.length === 0;
      break;
    case RECONCILIATION_OPERATION_PHASE.preserving:
      phaseIsConsistent = noEffects(operation);
      break;
    case RECONCILIATION_OPERATION_PHASE.mutatingLocal:
    case RECONCILIATION_OPERATION_PHASE.mutatingRemote:
      phaseIsConsistent = receiptsVerified;
      break;
    case RECONCILIATION_OPERATION_PHASE.evidenceRequired:
      phaseIsConsistent =
        noPendingReceipts &&
        (hasUnknownEffect ||
          receipts.some(
            (receipt) =>
              receipt.proofState ===
              RECONCILIATION_PRESERVATION_PROOF_STATE.evidenceRequired,
          ));
      break;
    case RECONCILIATION_OPERATION_PHASE.partial:
      phaseIsConsistent = receiptsVerified && hasMaterialEffect;
      break;
    case RECONCILIATION_OPERATION_PHASE.stale:
      phaseIsConsistent = noEffects(operation) && receiptsVerified;
      break;
    case RECONCILIATION_OPERATION_PHASE.blocked:
      phaseIsConsistent = noPendingReceipts;
      break;
    case RECONCILIATION_OPERATION_PHASE.completed:
      phaseIsConsistent =
        !hasUnknownEffect &&
        receiptsVerified &&
        validateCompletedEffects(operation);
      break;
  }
  if (!phaseIsConsistent) return false;

  const effectMayHaveStarted =
    operation.phase === RECONCILIATION_OPERATION_PHASE.mutatingLocal ||
    operation.phase === RECONCILIATION_OPERATION_PHASE.mutatingRemote ||
    operation.phase === RECONCILIATION_OPERATION_PHASE.partial ||
    operation.phase === RECONCILIATION_OPERATION_PHASE.completed ||
    effects.some(
      (effect) => effect !== MUTATION_EFFECT_CERTAINTY.notDispatched,
    );
  if (!effectMayHaveStarted) return true;
  const requiredSide = requiredPreservationSide(operation);
  return (
    requiredSide === null ||
    receipts.some(
      (receipt) =>
        receipt.side === requiredSide &&
        receipt.proofState === RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
    )
  );
}

function validateCompletedEffects(operation: ReconciliationOperation): boolean {
  const localConfirmed =
    operation.localEffect === MUTATION_EFFECT_CERTAINTY.confirmed;
  const remoteConfirmed =
    operation.remoteEffect === MUTATION_EFFECT_CERTAINTY.confirmed;
  switch (operation.action.kind) {
    case RECONCILIATION_ACTION.keepLocal:
      return requiredPreservationSide(operation) === null || remoteConfirmed;
    case RECONCILIATION_ACTION.useRemote:
    case RECONCILIATION_ACTION.adoptRevision:
      return requiredLocalEffect(operation) ? localConfirmed : true;
    case RECONCILIATION_ACTION.keepBoth:
      return operation.evidence.remote.kind ===
        RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone
        ? localConfirmed
        : localConfirmed && remoteConfirmed;
    case RECONCILIATION_ACTION.recreateRemote:
      return remoteConfirmed;
    case RECONCILIATION_ACTION.restoreRecovery:
      return localConfirmed;
    case RECONCILIATION_ACTION.forkLegacy:
      return localConfirmed && remoteConfirmed;
    case RECONCILIATION_ACTION.acceptTombstone:
    case RECONCILIATION_ACTION.resolveHistory:
    case RECONCILIATION_ACTION.defer:
      return true;
  }
}

function requiredLocalEffect(operation: ReconciliationOperation): boolean {
  if (
    operation.evidence.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.absent
  ) {
    return true;
  }
  return (
    operation.evidence.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live &&
    operation.evidence.remote.kind ===
      RECONCILIATION_REMOTE_EVIDENCE_KIND.live &&
    operation.evidence.local.contentSha256 !==
      operation.evidence.remote.contentSha256
  );
}

function requiredPreservationSide(
  operation: ReconciliationOperation,
):
  | (typeof RECONCILIATION_PRESERVATION_SIDE)[keyof typeof RECONCILIATION_PRESERVATION_SIDE]
  | null {
  const local = operation.evidence.local;
  const remote = operation.evidence.remote;
  switch (operation.action.kind) {
    case RECONCILIATION_ACTION.keepLocal:
      return local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live &&
        remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live &&
        local.contentSha256 !== remote.contentSha256
        ? RECONCILIATION_PRESERVATION_SIDE.remote
        : null;
    case RECONCILIATION_ACTION.useRemote:
      return local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live &&
        remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live &&
        local.contentSha256 !== remote.contentSha256
        ? RECONCILIATION_PRESERVATION_SIDE.local
        : null;
    case RECONCILIATION_ACTION.keepBoth:
      return remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone
        ? RECONCILIATION_PRESERVATION_SIDE.local
        : operation.action.primarySide ===
            RECONCILIATION_PRESERVATION_SIDE.local
          ? RECONCILIATION_PRESERVATION_SIDE.remote
          : RECONCILIATION_PRESERVATION_SIDE.local;
    case RECONCILIATION_ACTION.restoreRecovery:
      return local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live &&
        operation.recovery !== null &&
        local.contentSha256 !== operation.recovery.contentSha256
        ? RECONCILIATION_PRESERVATION_SIDE.local
        : null;
    case RECONCILIATION_ACTION.adoptRevision:
    case RECONCILIATION_ACTION.acceptTombstone:
    case RECONCILIATION_ACTION.recreateRemote:
    case RECONCILIATION_ACTION.forkLegacy:
    case RECONCILIATION_ACTION.resolveHistory:
    case RECONCILIATION_ACTION.defer:
      return null;
  }
}

function validateM3Precedence(
  operation: ReconciliationOperation,
  pathStates: ReadonlyMap<string, MirrorDeviceState["paths"][number]>,
): boolean {
  if (!isActiveOperation(operation)) return true;
  for (const reservation of operation.reservations) {
    const pathState = pathStates.get(reservation.path);
    if (pathState === undefined) continue;
    if (pathState.unresolvedMutation !== null) return false;
    if (
      pathState.desired.kind === MIRROR_DESIRED_STATE_KIND.renameDeferred &&
      operation.action.kind !== RECONCILIATION_ACTION.resolveHistory
    ) {
      return false;
    }
  }
  return true;
}

function validateReviewOperationLifecycle(
  review: ReconciliationReview,
  operation: ReconciliationOperation,
): boolean {
  if (isActiveOperation(operation)) {
    return review.status === RECONCILIATION_REVIEW_STATUS.staged;
  }
  if (operation.phase === RECONCILIATION_OPERATION_PHASE.stale) {
    return review.status === RECONCILIATION_REVIEW_STATUS.stale;
  }
  return review.status === RECONCILIATION_REVIEW_STATUS.completed;
}

function validateReviewRelationship(
  review: ReconciliationReview,
  operations: ReadonlyMap<string, ReconciliationOperation>,
  pathStates: ReadonlyMap<string, MirrorDeviceState["paths"][number]>,
): boolean {
  if (
    review.operationId !== null &&
    operations.get(review.operationId)?.reviewId !== review.reviewId
  ) {
    return false;
  }
  const reviewedPathStates = [review.targetPath, ...review.relatedPaths]
    .map((path) => pathStates.get(path))
    .filter((pathState) => pathState !== undefined);
  const hasUnresolved = reviewedPathStates.some(
    (pathState) => pathState.unresolvedMutation !== null,
  );
  const hasDeferredHistory = reviewedPathStates.some(
    (pathState) =>
      pathState.desired.kind === MIRROR_DESIRED_STATE_KIND.renameDeferred,
  );
  if (hasUnresolved) {
    return (
      review.classification ===
        RECONCILIATION_CLASSIFICATION.unresolvedM3Effect &&
      review.operationId === null
    );
  }
  if (hasDeferredHistory) {
    return (
      review.classification === RECONCILIATION_CLASSIFICATION.deferredHistory
    );
  }
  if (
    review.classification ===
      RECONCILIATION_CLASSIFICATION.unresolvedM3Effect ||
    review.classification === RECONCILIATION_CLASSIFICATION.deferredHistory
  ) {
    return false;
  }
  return true;
}

function isActiveOperation(operation: ReconciliationOperation): boolean {
  return (
    operation.phase !== RECONCILIATION_OPERATION_PHASE.stale &&
    operation.phase !== RECONCILIATION_OPERATION_PHASE.completed
  );
}

function evidenceEquals(
  left: ReconciliationEvidence,
  right: ReconciliationEvidence,
): boolean {
  return (
    localEvidenceEquals(left.local, right.local) &&
    acknowledgementEquals(left.baseline, right.baseline) &&
    remoteEvidenceEquals(left.remote, right.remote)
  );
}

function localEvidenceEquals(
  left: ReconciliationEvidence["local"],
  right: ReconciliationEvidence["local"],
): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown:
      return true;
    case RECONCILIATION_LOCAL_EVIDENCE_KIND.absent:
      return (
        right.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.absent &&
        left.observationGeneration === right.observationGeneration
      );
    case RECONCILIATION_LOCAL_EVIDENCE_KIND.live:
      return (
        right.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live &&
        left.observationGeneration === right.observationGeneration &&
        left.contentSha256 === right.contentSha256
      );
  }
}

function acknowledgementEquals(
  left: ReconciliationEvidence["baseline"],
  right: ReconciliationEvidence["baseline"],
): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case MIRROR_ACKNOWLEDGEMENT_KIND.unassociated:
      return true;
    case MIRROR_ACKNOWLEDGEMENT_KIND.live:
      return (
        right.kind === MIRROR_ACKNOWLEDGEMENT_KIND.live &&
        left.revision === right.revision &&
        left.contentSha256 === right.contentSha256
      );
    case MIRROR_ACKNOWLEDGEMENT_KIND.tombstone:
      return (
        right.kind === MIRROR_ACKNOWLEDGEMENT_KIND.tombstone &&
        left.revision === right.revision &&
        left.recoveryId === right.recoveryId
      );
  }
}

function remoteEvidenceEquals(
  left: ReconciliationEvidence["remote"],
  right: ReconciliationEvidence["remote"],
): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.absent:
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.unavailable:
      return true;
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy:
      return (
        right.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy &&
        left.contentSha256 === right.contentSha256
      );
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.live:
      return (
        right.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live &&
        left.associationId === right.associationId &&
        left.revision === right.revision &&
        left.contentSha256 === right.contentSha256
      );
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone:
      return (
        right.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone &&
        left.associationId === right.associationId &&
        left.revision === right.revision &&
        left.recoveryId === right.recoveryId
      );
  }
}

function onlyAllowedSide(sides: ReadonlySet<string>, allowed: string): boolean {
  return sides.size === 0 || (sides.size === 1 && sides.has(allowed));
}

function noEffects(operation: ReconciliationOperation): boolean {
  return (
    operation.localEffect === MUTATION_EFFECT_CERTAINTY.notDispatched &&
    operation.remoteEffect === MUTATION_EFFECT_CERTAINTY.notDispatched
  );
}

function validatePreservationProofState(
  receipt: ReconciliationPreservationReceipt,
): boolean {
  switch (receipt.proofState) {
    case RECONCILIATION_PRESERVATION_PROOF_STATE.pending:
    case RECONCILIATION_PRESERVATION_PROOF_STATE.verified:
    case RECONCILIATION_PRESERVATION_PROOF_STATE.evidenceRequired:
    case RECONCILIATION_PRESERVATION_PROOF_STATE.blocked:
      return true;
  }
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
