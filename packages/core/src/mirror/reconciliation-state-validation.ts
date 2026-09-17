import {
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  MAX_MUTATION_ATTEMPTS,
  MAX_MUTATION_EVIDENCE_ATTEMPTS,
  MUTATION_ACTION,
  MUTATION_EFFECT_CERTAINTY,
  RECOVERY_SNAPSHOT_STATE_KIND,
} from "@core/mirror/mirror.constants";
import {
  createApplicationRevision,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  createRecoverySnapshotId,
  isContentSha256,
} from "@core/mirror/mirror-identifiers";
import {
  MAX_MIRROR_TRACKED_PATHS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_MUTATION_PHASE,
  MIRROR_PAUSE_REASON,
  MIRROR_RENAME_PHASE,
} from "@core/mirror/mirror-state.constants";
import type {
  MirrorDeviceLifecycle,
  MirrorDeviceState,
  MirrorPathState,
  MirrorUnresolvedMutation,
  RenameDeferredMirrorState,
} from "@core/mirror/mirror-state.types";
import {
  MAX_RECONCILIATION_OPERATIONS,
  MAX_RECONCILIATION_PRESERVATION_RECEIPTS,
  MAX_RECONCILIATION_REVIEWS,
  RECONCILIATION_ACTION,
  RECONCILIATION_AUTHORITY_SOURCE,
  RECONCILIATION_CLASSIFICATION,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_LOCAL_STABILITY,
  RECONCILIATION_OPERATION_PHASE,
  RECONCILIATION_PATH_REFERENCE_KIND,
  RECONCILIATION_PRESERVATION_PROOF_STATE,
  RECONCILIATION_PRESERVATION_SIDE,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
  RECONCILIATION_REVIEW_RETENTION,
  RECONCILIATION_REVIEW_STATUS,
} from "@core/mirror/reconciliation-state.constants";
import type {
  ReconciliationOperation,
  ReconciliationPathEvidence,
  ReconciliationPreservationReceipt,
  ReconciliationReview,
  ReconciliationReviewSnapshot,
} from "@core/mirror/reconciliation-state.types";
import { isNormalizedNotePath } from "@core/note-path/note-path";
import { MAX_NOTE_SIZE_BYTES } from "@core/vault/vault.constants";

interface RequiredPreservation {
  readonly originalPath: ReconciliationPreservationReceipt["originalPath"];
  readonly side: ReconciliationPreservationReceipt["side"];
  readonly sourceRevision: ReconciliationPreservationReceipt["sourceRevision"];
  readonly contentSha256: ReconciliationPreservationReceipt["contentSha256"];
}

/**
 * Validates all cross-field M4 review, operation, reservation, and M3-precedence rules.
 *
 * The implementation indexes paths and identities once so validation remains linear
 * in tracked paths plus sparse M4 records. It validates metadata only; note bodies
 * are not part of the type or persisted schema.
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
      !validateSnapshotOwner(state, review.snapshot) ||
      reviews.has(review.reviewId)
    ) {
      return false;
    }
    reviews.set(review.reviewId, review);
  }
  for (const operation of state.reconciliationOperations) {
    if (
      !validateOperationFields(operation) ||
      operations.has(operation.operationId) ||
      reviews.has(operation.operationId)
    ) {
      return false;
    }
    operations.set(operation.operationId, operation);
  }
  if (!validateLifecycle(state)) return false;

  const activelyReservedPaths = new Set<string>();
  for (const operation of state.reconciliationOperations) {
    const review = reviews.get(operation.reviewId);
    if (
      review === undefined ||
      review.operationId !== operation.operationId ||
      !reconciliationReviewSnapshotsEqual(
        review.snapshot,
        operation.snapshot,
      ) ||
      !validateReviewOperationLifecycle(review, operation) ||
      !validateClassificationAction(review, operation) ||
      !validateOperationAuthority(operation) ||
      !validateOperationPaths(operation, trackedPaths) ||
      !validateRestoreSuccessor(operation, operations) ||
      !validateM3Precedence(operation, pathStates)
    ) {
      return false;
    }
    if (!isActiveOperation(operation)) continue;
    for (const reservation of operation.reservations) {
      if (activelyReservedPaths.has(reservation.path)) return false;
      activelyReservedPaths.add(reservation.path);
    }
  }

  for (const review of state.reconciliationReviews) {
    if (!validateReviewRelationship(review, operations)) return false;
  }
  return true;
}

/**
 * Determines whether durable M4 ownership fences ordinary M3 work for one path.
 *
 * @param state - Current validated device state.
 * @param path - Eligible path considered for ordinary M3 scheduling or admission.
 * @returns Whether an active operation owns the path across restart and re-enable.
 */
export function isReconciliationPathReserved(
  state: MirrorDeviceState,
  path: string,
): boolean {
  return state.reconciliationOperations.some(
    (operation) =>
      isActiveOperation(operation) &&
      operation.reservations.some((reservation) => reservation.path === path),
  );
}

/**
 * Compares every immutable authority and evidence dimension of two review snapshots.
 *
 * Future decision admission can use this pure comparison without an untyped runtime
 * side channel. A changed epoch, receipt, size, path, M3 state, or lifecycle makes
 * the snapshot stale even when note bytes remain equal.
 *
 * @param left - Previously sampled authoritative snapshot.
 * @param right - Fresh candidate snapshot.
 * @returns Whether both snapshots identify exactly the same decision authority.
 */
export function reconciliationReviewSnapshotsEqual(
  left: ReconciliationReviewSnapshot,
  right: ReconciliationReviewSnapshot,
): boolean {
  if (
    left.targetPath !== right.targetPath ||
    !runtimeIdentityEquals(left.runtime, right.runtime) ||
    !recoveryEvidenceEquals(left.recovery, right.recovery) ||
    left.paths.length !== right.paths.length
  ) {
    return false;
  }
  return left.paths.every((path, index) =>
    pathEvidenceEquals(path, right.paths[index]),
  );
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
    pathReferences += review.snapshot.paths.length;
  }
  for (const operation of state.reconciliationOperations) {
    receipts += operation.preservationReceipts.length;
    pathReferences +=
      operation.snapshot.paths.length + operation.reservations.length;
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

function validateSnapshotOwner(
  state: MirrorDeviceState,
  snapshot: ReconciliationReviewSnapshot,
): boolean {
  if (
    snapshot.runtime.deviceId !== state.deviceId ||
    state.lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.disabled ||
    snapshot.runtime.lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.disabled
  ) {
    return false;
  }
  return (
    snapshot.runtime.lifecycle.associationId ===
      state.lifecycle.associationId &&
    snapshot.runtime.lifecycle.origin === state.lifecycle.origin
  );
}

function validateReview(review: ReconciliationReview): boolean {
  return (
    review.retention === RECONCILIATION_REVIEW_RETENTION.durable &&
    createMirrorOperationId(review.reviewId) === review.reviewId &&
    validateSnapshot(review.snapshot) &&
    (review.operationId === null
      ? review.status !== RECONCILIATION_REVIEW_STATUS.staged
      : createMirrorOperationId(review.operationId) === review.operationId)
  );
}

function validateSnapshot(snapshot: ReconciliationReviewSnapshot): boolean {
  if (
    !validateRuntimeIdentity(snapshot.runtime) ||
    !isNormalizedNotePath(snapshot.targetPath) ||
    snapshot.paths.length === 0 ||
    snapshot.paths.length > MAX_MIRROR_TRACKED_PATHS ||
    !validateRecoveryEvidence(snapshot)
  ) {
    return false;
  }
  const paths = new Set<string>();
  for (const evidence of snapshot.paths) {
    if (!validatePathEvidence(snapshot, evidence) || paths.has(evidence.path)) {
      return false;
    }
    paths.add(evidence.path);
  }
  return paths.has(snapshot.targetPath);
}

function validateRuntimeIdentity(
  runtime: ReconciliationReviewSnapshot["runtime"],
): boolean {
  return (
    isPositiveSafeInteger(runtime.runtimeOwnerVersion) &&
    isNonNegativeSafeInteger(runtime.configurationGeneration) &&
    isPositiveSafeInteger(runtime.listenerEpoch) &&
    createMirrorWriterId(runtime.deviceId) === runtime.deviceId &&
    createMirrorWriterId(runtime.designatedWriterId) ===
      runtime.designatedWriterId &&
    validateDeviceLifecycle(runtime.lifecycle)
  );
}

function validateDeviceLifecycle(lifecycle: MirrorDeviceLifecycle): boolean {
  switch (lifecycle.kind) {
    case MIRROR_DEVICE_LIFECYCLE_KIND.disabled:
      return true;
    case MIRROR_DEVICE_LIFECYCLE_KIND.active:
    case MIRROR_DEVICE_LIFECYCLE_KIND.handoffDraining:
    case MIRROR_DEVICE_LIFECYCLE_KIND.handoffDrained:
    case MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged:
      return validateBinding(lifecycle.associationId, lifecycle.origin);
    case MIRROR_DEVICE_LIFECYCLE_KIND.paused:
      return (
        validateBinding(lifecycle.associationId, lifecycle.origin) &&
        (lifecycle.reason === MIRROR_PAUSE_REASON.manual ||
          lifecycle.reason === MIRROR_PAUSE_REASON.persistenceFailure)
      );
  }
}

function validateBinding(
  associationId: Parameters<typeof createMirrorAssociationId>[0],
  origin: string,
): boolean {
  return (
    createMirrorAssociationId(associationId) === associationId &&
    origin.length > 0 &&
    origin.length <= 2_048
  );
}

function validatePathEvidence(
  snapshot: ReconciliationReviewSnapshot,
  evidence: ReconciliationPathEvidence,
): boolean {
  if (
    !isNormalizedNotePath(evidence.path) ||
    !validateLocalEvidence(evidence.local) ||
    !validateAcknowledgement(evidence.baseline) ||
    !validateRemoteEvidence(snapshot, evidence.remote) ||
    !validateM3Evidence(snapshot, evidence)
  ) {
    return false;
  }
  return true;
}

function validateLocalEvidence(
  evidence: ReconciliationPathEvidence["local"],
): boolean {
  switch (evidence.kind) {
    case RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown:
      return evidence.stability === RECONCILIATION_LOCAL_STABILITY.unknown;
    case RECONCILIATION_LOCAL_EVIDENCE_KIND.absent:
      return (
        evidence.stability === RECONCILIATION_LOCAL_STABILITY.stable &&
        isPositiveSafeInteger(evidence.observationGeneration)
      );
    case RECONCILIATION_LOCAL_EVIDENCE_KIND.live:
      return (
        evidence.stability === RECONCILIATION_LOCAL_STABILITY.stable &&
        isPositiveSafeInteger(evidence.observationGeneration) &&
        isNonNegativeSafeInteger(evidence.byteSize) &&
        evidence.byteSize <= MAX_NOTE_SIZE_BYTES &&
        isContentSha256(evidence.contentSha256)
      );
  }
}

function validateRemoteEvidence(
  snapshot: ReconciliationReviewSnapshot,
  evidence: ReconciliationPathEvidence["remote"],
): boolean {
  switch (evidence.kind) {
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.absent:
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.unavailable:
      return true;
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy:
      return isContentSha256(evidence.contentSha256);
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.live:
      return (
        validateRemoteAssociation(snapshot, evidence.associationId) &&
        createApplicationRevision(evidence.revision) === evidence.revision &&
        isContentSha256(evidence.contentSha256) &&
        validateContentReceipt(evidence)
      );
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone:
      return (
        validateRemoteAssociation(snapshot, evidence.associationId) &&
        createApplicationRevision(evidence.revision) === evidence.revision &&
        createApplicationRevision(evidence.deletedRevision) ===
          evidence.deletedRevision &&
        createRecoverySnapshotId(evidence.recoveryId) === evidence.recoveryId &&
        evidence.receipt.action === MUTATION_ACTION.tombstone &&
        evidence.receipt.associationId === evidence.associationId &&
        evidence.receipt.operationId === evidence.recoveryId &&
        evidence.receipt.precondition.kind ===
          CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision &&
        evidence.receipt.precondition.revision === evidence.deletedRevision
      );
  }
}

function validateRemoteAssociation(
  snapshot: ReconciliationReviewSnapshot,
  associationId: Parameters<typeof createMirrorAssociationId>[0],
): boolean {
  if (createMirrorAssociationId(associationId) !== associationId) return false;
  return snapshot.runtime.lifecycle.kind ===
    MIRROR_DEVICE_LIFECYCLE_KIND.disabled
    ? false
    : snapshot.runtime.lifecycle.associationId === associationId;
}

function validateContentReceipt(
  evidence: Extract<
    ReconciliationPathEvidence["remote"],
    { readonly kind: "live" }
  >,
): boolean {
  const receipt = evidence.receipt;
  if (
    receipt.action !== MUTATION_ACTION.create &&
    receipt.action !== MUTATION_ACTION.update &&
    receipt.action !== MUTATION_ACTION.recreate
  ) {
    return false;
  }
  if (
    receipt.associationId !== evidence.associationId ||
    createMirrorOperationId(receipt.operationId) !== receipt.operationId ||
    receipt.contentSha256 !== evidence.contentSha256
  ) {
    return false;
  }
  if (
    receipt.precondition.kind === CONDITIONAL_MUTATION_PRECONDITION_KIND.absent
  ) {
    return receipt.action === MUTATION_ACTION.create;
  }
  return (
    createApplicationRevision(receipt.precondition.revision) ===
      receipt.precondition.revision &&
    (receipt.action === MUTATION_ACTION.update ||
      receipt.action === MUTATION_ACTION.recreate)
  );
}

function validateAcknowledgement(
  acknowledgement: ReconciliationPathEvidence["baseline"],
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

function validateM3Evidence(
  snapshot: ReconciliationReviewSnapshot,
  evidence: ReconciliationPathEvidence,
): boolean {
  const unresolved = evidence.m3.unresolvedMutation;
  const deferred = evidence.m3.deferredHistory;
  if (unresolved !== null && deferred !== null) return false;
  if (
    unresolved !== null &&
    !validateUnresolvedMutation(snapshot, evidence, unresolved)
  ) {
    return false;
  }
  return (
    deferred === null || validateDeferredHistory(snapshot, evidence, deferred)
  );
}

function validateUnresolvedMutation(
  snapshot: ReconciliationReviewSnapshot,
  evidence: ReconciliationPathEvidence,
  unresolved: MirrorUnresolvedMutation,
): boolean {
  const intent = unresolved.intent;
  if (
    intent.path !== evidence.path ||
    intent.writerId !== snapshot.runtime.deviceId ||
    !isNonNegativeSafeInteger(intent.mutationAttempts) ||
    intent.mutationAttempts > MAX_MUTATION_ATTEMPTS ||
    !isNonNegativeSafeInteger(intent.evidenceAttempts) ||
    intent.evidenceAttempts > MAX_MUTATION_EVIDENCE_ATTEMPTS ||
    snapshot.runtime.lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.disabled ||
    intent.associationId !== snapshot.runtime.lifecycle.associationId
  ) {
    return false;
  }
  switch (unresolved.phase) {
    case MIRROR_MUTATION_PHASE.intentPersisted:
    case MIRROR_MUTATION_PHASE.dispatched:
    case MIRROR_MUTATION_PHASE.evidenceRequired:
      return true;
    case MIRROR_MUTATION_PHASE.recoveryPreparation:
    case MIRROR_MUTATION_PHASE.tombstoneCommit:
      return intent.action === MUTATION_ACTION.tombstone;
  }
}

function validateDeferredHistory(
  snapshot: ReconciliationReviewSnapshot,
  evidence: ReconciliationPathEvidence,
  deferred: RenameDeferredMirrorState,
): boolean {
  return (
    deferred.kind === MIRROR_DESIRED_STATE_KIND.renameDeferred &&
    deferred.sourcePath === evidence.path &&
    deferred.destinationPath !== evidence.path &&
    isNonNegativeSafeInteger(deferred.observationGeneration) &&
    isNonNegativeSafeInteger(deferred.graceDeadlineMilliseconds) &&
    createMirrorOperationId(deferred.renameId) === deferred.renameId &&
    snapshot.runtime.lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.disabled &&
    deferred.associationId === snapshot.runtime.lifecycle.associationId &&
    createApplicationRevision(deferred.sourceExpectedRevision) ===
      deferred.sourceExpectedRevision &&
    (deferred.destinationPath === null ||
      isNormalizedNotePath(deferred.destinationPath)) &&
    (deferred.destinationObservationGeneration === null ||
      isNonNegativeSafeInteger(deferred.destinationObservationGeneration)) &&
    (deferred.destinationAcknowledgedRevision === null ||
      createApplicationRevision(deferred.destinationAcknowledgedRevision) ===
        deferred.destinationAcknowledgedRevision) &&
    (deferred.phase === MIRROR_RENAME_PHASE.destinationRequired ||
      deferred.phase === MIRROR_RENAME_PHASE.sourceCleanupRequired ||
      deferred.phase === MIRROR_RENAME_PHASE.invalidated)
  );
}

function validateRecoveryEvidence(
  snapshot: ReconciliationReviewSnapshot,
): boolean {
  const recovery = snapshot.recovery;
  if (recovery === null) return true;
  if (
    createRecoverySnapshotId(recovery.id) !== recovery.id ||
    createMirrorAssociationId(recovery.associationId) !==
      recovery.associationId ||
    !isNormalizedNotePath(recovery.path) ||
    recovery.path !== snapshot.targetPath ||
    createApplicationRevision(recovery.revision) !== recovery.revision ||
    createApplicationRevision(recovery.sourceRevision) !==
      recovery.sourceRevision ||
    !isContentSha256(recovery.contentSha256) ||
    snapshot.runtime.lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.disabled ||
    recovery.associationId !== snapshot.runtime.lifecycle.associationId
  ) {
    return false;
  }
  switch (recovery.kind) {
    case RECOVERY_SNAPSHOT_STATE_KIND.prepared:
      return true;
    case RECOVERY_SNAPSHOT_STATE_KIND.sealed:
    case RECOVERY_SNAPSHOT_STATE_KIND.purged:
      return isCanonicalInstant(recovery.recoverUntil);
  }
}

function validateOperationFields(operation: ReconciliationOperation): boolean {
  if (
    createMirrorOperationId(operation.operationId) !== operation.operationId ||
    createMirrorOperationId(operation.reviewId) !== operation.reviewId ||
    operation.operationId === operation.reviewId ||
    !validateSnapshot(operation.snapshot) ||
    (operation.destinationPath !== null &&
      !isNormalizedNotePath(operation.destinationPath)) ||
    operation.reservations.length === 0 ||
    !validateSuccessorIdentity(operation) ||
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
  if (!reserved.has(operation.snapshot.targetPath)) return false;
  const receiptKeys = new Set<string>();
  for (const receipt of operation.preservationReceipts) {
    const key = `${receipt.originalPath}:${receipt.side}`;
    if (
      !validatePreservationReceipt(operation, receipt) ||
      receiptKeys.has(key)
    ) {
      return false;
    }
    receiptKeys.add(key);
  }
  return validateOperationLifecycleEvidence(operation);
}

function validateSuccessorIdentity(
  operation: ReconciliationOperation,
): boolean {
  if (operation.action.kind !== RECONCILIATION_ACTION.restoreRecovery) {
    return operation.successorOperationId === null;
  }
  if (operation.phase !== RECONCILIATION_OPERATION_PHASE.completed) {
    return operation.successorOperationId === null;
  }
  return (
    operation.successorOperationId !== null &&
    operation.successorOperationId !== operation.operationId &&
    createMirrorOperationId(operation.successorOperationId) ===
      operation.successorOperationId
  );
}

function validateRestoreSuccessor(
  operation: ReconciliationOperation,
  operations: ReadonlyMap<string, ReconciliationOperation>,
): boolean {
  if (operation.action.kind !== RECONCILIATION_ACTION.restoreRecovery) {
    return operation.successorOperationId === null;
  }
  if (operation.phase !== RECONCILIATION_OPERATION_PHASE.completed) {
    return operation.successorOperationId === null;
  }
  const successor =
    operation.successorOperationId === null
      ? undefined
      : operations.get(operation.successorOperationId);
  if (
    successor === undefined ||
    successor.phase === RECONCILIATION_OPERATION_PHASE.stale
  ) {
    return false;
  }
  const restoredPath =
    operation.destinationPath ?? operation.snapshot.targetPath;
  const beforeRestore = destinationEvidence(operation);
  const afterRestore = targetEvidence(successor.snapshot);
  const recovery = operation.snapshot.recovery;
  return (
    successor.reviewId !== operation.reviewId &&
    successor.snapshot.targetPath === restoredPath &&
    successor.reservations.some(
      (reservation) => reservation.path === restoredPath,
    ) &&
    beforeRestore !== undefined &&
    beforeRestore.local.kind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown &&
    afterRestore?.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live &&
    afterRestore.local.observationGeneration >
      beforeRestore.local.observationGeneration &&
    recovery !== null &&
    afterRestore.local.contentSha256 === recovery.contentSha256
  );
}

function validateActionEvidence(operation: ReconciliationOperation): boolean {
  const target = targetEvidence(operation.snapshot);
  if (target === undefined) return false;
  const localKind = target.local.kind;
  const remoteKind = target.remote.kind;
  switch (operation.action.kind) {
    case RECONCILIATION_ACTION.keepLocal:
      return (
        localKind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live &&
        remoteKind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live &&
        operation.snapshot.recovery === null
      );
    case RECONCILIATION_ACTION.useRemote:
      return (
        localKind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown &&
        remoteKind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live &&
        operation.snapshot.recovery === null
      );
    case RECONCILIATION_ACTION.keepBoth:
      return (
        localKind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live &&
        (remoteKind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live ||
          (remoteKind === RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone &&
            operation.action.primarySide ===
              RECONCILIATION_PRESERVATION_SIDE.remote)) &&
        operation.snapshot.recovery === null
      );
    case RECONCILIATION_ACTION.adoptRevision:
      return (
        remoteKind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live &&
        (localKind === RECONCILIATION_LOCAL_EVIDENCE_KIND.absent ||
          (localKind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live &&
            target.local.contentSha256 === target.remote.contentSha256)) &&
        operation.snapshot.recovery === null
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
      return (
        operation.snapshot.recovery !== null &&
        operation.snapshot.recovery.kind !==
          RECOVERY_SNAPSHOT_STATE_KIND.purged &&
        destinationEvidence(operation)?.local.kind !==
          RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown
      );
    case RECONCILIATION_ACTION.forkLegacy:
      return remoteKind === RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy;
    case RECONCILIATION_ACTION.resolveHistory:
      return target.m3.deferredHistory !== null;
    case RECONCILIATION_ACTION.defer:
      return true;
  }
}

function validateActionPhase(operation: ReconciliationOperation): boolean {
  const { kind } = operation.action;
  const phase = operation.phase;
  if (phase === RECONCILIATION_OPERATION_PHASE.restoredPendingReview) {
    return kind === RECONCILIATION_ACTION.restoreRecovery;
  }
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
      kind === RECONCILIATION_ACTION.recreateRemote ||
      kind === RECONCILIATION_ACTION.resolveHistory) &&
    (phase === RECONCILIATION_OPERATION_PHASE.mutatingLocal ||
      operation.localEffect !== MUTATION_EFFECT_CERTAINTY.notDispatched)
  ) {
    return false;
  }
  if (
    (kind === RECONCILIATION_ACTION.useRemote ||
      kind === RECONCILIATION_ACTION.adoptRevision ||
      kind === RECONCILIATION_ACTION.restoreRecovery ||
      kind === RECONCILIATION_ACTION.forkLegacy) &&
    phase === RECONCILIATION_OPERATION_PHASE.mutatingRemote &&
    kind !== RECONCILIATION_ACTION.forkLegacy
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
  if (operation.destinationPath === operation.snapshot.targetPath) return false;

  const snapshotPaths = new Set(
    operation.snapshot.paths.map((evidence) => evidence.path),
  );
  const reservedPaths = new Set(
    operation.reservations.map((reservation) => reservation.path),
  );
  if (
    operation.snapshot.paths.some(
      (evidence) => !reservedPaths.has(evidence.path),
    )
  ) {
    return false;
  }
  if (
    operation.destinationPath !== null &&
    !snapshotPaths.has(operation.destinationPath)
  ) {
    return false;
  }
  for (const reservation of operation.reservations) {
    if (!snapshotPaths.has(reservation.path)) return false;
    switch (reservation.kind) {
      case RECONCILIATION_PATH_REFERENCE_KIND.tracked:
        if (!trackedPaths.has(reservation.path)) return false;
        break;
      case RECONCILIATION_PATH_REFERENCE_KIND.reviewTarget:
        if (reservation.path !== operation.snapshot.targetPath) return false;
        break;
      case RECONCILIATION_PATH_REFERENCE_KIND.newDestination:
        if (
          operation.destinationPath !== reservation.path ||
          trackedPaths.has(reservation.path) ||
          !isAbsentDestination(operation.snapshot, reservation.path)
        ) {
          return false;
        }
        break;
    }
  }
  return true;
}

function isAbsentDestination(
  snapshot: ReconciliationReviewSnapshot,
  path: string,
): boolean {
  const evidence = snapshot.paths.find((candidate) => candidate.path === path);
  return (
    evidence?.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.absent &&
    evidence.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.absent &&
    evidence.baseline.kind === MIRROR_ACKNOWLEDGEMENT_KIND.unassociated &&
    evidence.m3.unresolvedMutation === null &&
    evidence.m3.deferredHistory === null
  );
}

function validatePreservationReceipt(
  operation: ReconciliationOperation,
  receipt: ReconciliationPreservationReceipt,
): boolean {
  if (
    receipt.operationId !== operation.operationId ||
    !isNormalizedNotePath(receipt.originalPath) ||
    !isContentSha256(receipt.contentSha256) ||
    !validatePreservationProofState(receipt)
  ) {
    return false;
  }
  const expectedPath = `.ai-bridge-conflicts/${operation.operationId}/${receipt.side}.md`;
  if (receipt.preservationPath !== expectedPath) return false;
  const requirements = requiredPreservations(operation);
  if (requirements === undefined) return false;
  return requirements.some(
    (required) =>
      required.originalPath === receipt.originalPath &&
      required.side === receipt.side &&
      required.sourceRevision === receipt.sourceRevision &&
      required.contentSha256 === receipt.contentSha256,
  );
}

function requiredPreservations(
  operation: ReconciliationOperation,
): readonly RequiredPreservation[] | undefined {
  const target = targetEvidence(operation.snapshot);
  if (target === undefined) return undefined;
  switch (operation.action.kind) {
    case RECONCILIATION_ACTION.keepLocal:
      return remotePreservation(target);
    case RECONCILIATION_ACTION.useRemote:
      return target.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live
        ? localPreservations(target)
        : [];
    case RECONCILIATION_ACTION.keepBoth:
      return operation.action.primarySide ===
        RECONCILIATION_PRESERVATION_SIDE.local
        ? remotePreservation(target)
        : target.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live
          ? localPreservations(target)
          : undefined;
    case RECONCILIATION_ACTION.adoptRevision:
    case RECONCILIATION_ACTION.acceptTombstone:
    case RECONCILIATION_ACTION.defer:
      return [];
    case RECONCILIATION_ACTION.recreateRemote:
      return target.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live
        ? localPreservations(target)
        : undefined;
    case RECONCILIATION_ACTION.restoreRecovery: {
      const destination = destinationEvidence(operation);
      if (destination === undefined) return undefined;
      return destination.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live
        ? localPreservations(destination)
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

function localPreservations(
  evidence: ReconciliationPathEvidence,
): readonly RequiredPreservation[] | undefined {
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

function remotePreservation(
  evidence: ReconciliationPathEvidence,
): readonly RequiredPreservation[] | undefined {
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

function validateOperationLifecycleEvidence(
  operation: ReconciliationOperation,
): boolean {
  const requirements = requiredPreservations(operation);
  if (requirements === undefined) return false;
  const receipts = operation.preservationReceipts;
  if (
    receipts.some(
      (receipt) =>
        !requirements.some(
          (required) =>
            required.originalPath === receipt.originalPath &&
            required.side === receipt.side,
        ),
    )
  ) {
    return false;
  }
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
      phaseIsConsistent = noEffects(operation) && requirements.length > 0;
      break;
    case RECONCILIATION_OPERATION_PHASE.mutatingLocal:
    case RECONCILIATION_OPERATION_PHASE.mutatingRemote:
      phaseIsConsistent = requiredReceiptsVerified(requirements, receipts);
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
    case RECONCILIATION_OPERATION_PHASE.restoredPendingReview:
      phaseIsConsistent =
        operation.action.kind === RECONCILIATION_ACTION.restoreRecovery &&
        (operation.localEffect === MUTATION_EFFECT_CERTAINTY.notDispatched ||
          operation.localEffect === MUTATION_EFFECT_CERTAINTY.confirmed) &&
        operation.remoteEffect === MUTATION_EFFECT_CERTAINTY.notDispatched &&
        requiredReceiptsVerified(requirements, receipts);
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

  const materialEffectMayHaveStarted =
    operation.phase === RECONCILIATION_OPERATION_PHASE.mutatingLocal ||
    operation.phase === RECONCILIATION_OPERATION_PHASE.mutatingRemote ||
    operation.phase === RECONCILIATION_OPERATION_PHASE.partial ||
    operation.phase === RECONCILIATION_OPERATION_PHASE.restoredPendingReview ||
    operation.phase === RECONCILIATION_OPERATION_PHASE.completed ||
    effects.some(
      (effect) => effect !== MUTATION_EFFECT_CERTAINTY.notDispatched,
    );
  return (
    !materialEffectMayHaveStarted ||
    requiredReceiptsVerified(requirements, receipts)
  );
}

function requiredReceiptsVerified(
  requirements: readonly RequiredPreservation[],
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

function validateCompletedEffects(operation: ReconciliationOperation): boolean {
  const localConfirmed =
    operation.localEffect === MUTATION_EFFECT_CERTAINTY.confirmed;
  const remoteConfirmed =
    operation.remoteEffect === MUTATION_EFFECT_CERTAINTY.confirmed;
  switch (operation.action.kind) {
    case RECONCILIATION_ACTION.keepLocal:
      return remoteConfirmed;
    case RECONCILIATION_ACTION.useRemote:
    case RECONCILIATION_ACTION.adoptRevision:
      return requiredLocalEffect(operation) ? localConfirmed : true;
    case RECONCILIATION_ACTION.keepBoth:
      return targetEvidence(operation.snapshot)?.remote.kind ===
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
    case RECONCILIATION_ACTION.defer:
      return true;
    case RECONCILIATION_ACTION.resolveHistory:
      return noEffects(operation) || remoteConfirmed;
  }
}

function requiredLocalEffect(operation: ReconciliationOperation): boolean {
  const target = targetEvidence(operation.snapshot);
  if (target === undefined) return false;
  if (target.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.absent) {
    return true;
  }
  return (
    target.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live &&
    target.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live &&
    target.local.contentSha256 !== target.remote.contentSha256
  );
}

function validateM3Precedence(
  operation: ReconciliationOperation,
  pathStates: ReadonlyMap<string, MirrorPathState>,
): boolean {
  if (!isActiveOperation(operation)) return true;
  for (const reservation of operation.reservations) {
    const pathState = pathStates.get(reservation.path);
    if (pathState === undefined) continue;
    if (pathState.unresolvedMutation !== null) return false;
    if (pathState.desired.kind === MIRROR_DESIRED_STATE_KIND.renameDeferred) {
      if (operation.action.kind !== RECONCILIATION_ACTION.resolveHistory) {
        return false;
      }
      continue;
    }
    if (pathState.desired.kind === MIRROR_DESIRED_STATE_KIND.runtimeDelete) {
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
): boolean {
  if (
    review.operationId !== null &&
    operations.get(review.operationId)?.reviewId !== review.reviewId
  ) {
    return false;
  }
  const hasUnresolved = review.snapshot.paths.some(
    (path) => path.m3.unresolvedMutation !== null,
  );
  const hasDeferredHistory = review.snapshot.paths.some(
    (path) => path.m3.deferredHistory !== null,
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
  return (
    review.classification !==
      RECONCILIATION_CLASSIFICATION.unresolvedM3Effect &&
    review.classification !== RECONCILIATION_CLASSIFICATION.deferredHistory
  );
}

function isActiveOperation(operation: ReconciliationOperation): boolean {
  return (
    operation.phase !== RECONCILIATION_OPERATION_PHASE.stale &&
    operation.phase !== RECONCILIATION_OPERATION_PHASE.completed
  );
}

function targetEvidence(
  snapshot: ReconciliationReviewSnapshot,
): ReconciliationPathEvidence | undefined {
  return snapshot.paths.find(
    (evidence) => evidence.path === snapshot.targetPath,
  );
}

function destinationEvidence(
  operation: ReconciliationOperation,
): ReconciliationPathEvidence | undefined {
  const destination =
    operation.destinationPath ?? operation.snapshot.targetPath;
  return operation.snapshot.paths.find(
    (evidence) => evidence.path === destination,
  );
}

function runtimeIdentityEquals(
  left: ReconciliationReviewSnapshot["runtime"],
  right: ReconciliationReviewSnapshot["runtime"],
): boolean {
  return (
    left.runtimeOwnerVersion === right.runtimeOwnerVersion &&
    left.configurationGeneration === right.configurationGeneration &&
    left.listenerEpoch === right.listenerEpoch &&
    left.deviceId === right.deviceId &&
    left.designatedWriterId === right.designatedWriterId &&
    lifecycleEquals(left.lifecycle, right.lifecycle)
  );
}

function lifecycleEquals(
  left: MirrorDeviceLifecycle,
  right: MirrorDeviceLifecycle,
): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case MIRROR_DEVICE_LIFECYCLE_KIND.disabled:
      return true;
    case MIRROR_DEVICE_LIFECYCLE_KIND.paused:
      return (
        right.kind === MIRROR_DEVICE_LIFECYCLE_KIND.paused &&
        left.associationId === right.associationId &&
        left.origin === right.origin &&
        left.reason === right.reason
      );
    case MIRROR_DEVICE_LIFECYCLE_KIND.active:
    case MIRROR_DEVICE_LIFECYCLE_KIND.handoffDraining:
    case MIRROR_DEVICE_LIFECYCLE_KIND.handoffDrained:
    case MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged:
      return (
        right.kind === left.kind &&
        left.associationId === right.associationId &&
        left.origin === right.origin
      );
  }
}

function pathEvidenceEquals(
  left: ReconciliationPathEvidence,
  right: ReconciliationPathEvidence | undefined,
): boolean {
  return (
    right !== undefined &&
    left.path === right.path &&
    localEvidenceEquals(left.local, right.local) &&
    acknowledgementEquals(left.baseline, right.baseline) &&
    remoteEvidenceEquals(left.remote, right.remote) &&
    m3EvidenceEquals(left, right)
  );
}

function localEvidenceEquals(
  left: ReconciliationPathEvidence["local"],
  right: ReconciliationPathEvidence["local"],
): boolean {
  if (left.kind !== right.kind || left.stability !== right.stability)
    return false;
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
        left.byteSize === right.byteSize &&
        left.contentSha256 === right.contentSha256
      );
  }
}

function acknowledgementEquals(
  left: ReconciliationPathEvidence["baseline"],
  right: ReconciliationPathEvidence["baseline"],
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
  left: ReconciliationPathEvidence["remote"],
  right: ReconciliationPathEvidence["remote"],
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
        left.contentSha256 === right.contentSha256 &&
        contentReceiptEquals(left.receipt, right.receipt)
      );
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone:
      return (
        right.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone &&
        left.associationId === right.associationId &&
        left.revision === right.revision &&
        left.deletedRevision === right.deletedRevision &&
        left.recoveryId === right.recoveryId &&
        tombstoneReceiptEquals(left.receipt, right.receipt)
      );
  }
}

function contentReceiptEquals(
  left: Extract<
    ReconciliationPathEvidence["remote"],
    { readonly kind: "live" }
  >["receipt"],
  right: Extract<
    ReconciliationPathEvidence["remote"],
    { readonly kind: "live" }
  >["receipt"],
): boolean {
  return (
    left.action === right.action &&
    left.associationId === right.associationId &&
    left.operationId === right.operationId &&
    left.contentSha256 === right.contentSha256 &&
    preconditionEquals(left.precondition, right.precondition)
  );
}

function tombstoneReceiptEquals(
  left: Extract<
    ReconciliationPathEvidence["remote"],
    { readonly kind: "tombstone" }
  >["receipt"],
  right: Extract<
    ReconciliationPathEvidence["remote"],
    { readonly kind: "tombstone" }
  >["receipt"],
): boolean {
  return (
    left.action === right.action &&
    left.associationId === right.associationId &&
    left.operationId === right.operationId &&
    preconditionEquals(left.precondition, right.precondition)
  );
}

function preconditionEquals(
  left:
    | Extract<
        ReconciliationPathEvidence["remote"],
        { readonly kind: "live" }
      >["receipt"]["precondition"]
    | Extract<
        ReconciliationPathEvidence["remote"],
        { readonly kind: "tombstone" }
      >["receipt"]["precondition"],
  right: typeof left,
): boolean {
  if (left.kind !== right.kind) return false;
  return (
    left.kind === CONDITIONAL_MUTATION_PRECONDITION_KIND.absent ||
    (right.kind === CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision &&
      left.revision === right.revision)
  );
}

function m3EvidenceEquals(
  left: ReconciliationPathEvidence,
  right: ReconciliationPathEvidence,
): boolean {
  return (
    unresolvedMutationEquals(
      left.m3.unresolvedMutation,
      right.m3.unresolvedMutation,
    ) &&
    deferredHistoryEquals(left.m3.deferredHistory, right.m3.deferredHistory)
  );
}

function unresolvedMutationEquals(
  left: MirrorUnresolvedMutation | null,
  right: MirrorUnresolvedMutation | null,
): boolean {
  if (left === null || right === null) return left === right;
  const leftIntent = left.intent;
  const rightIntent = right.intent;
  return (
    left.phase === right.phase &&
    leftIntent.action === rightIntent.action &&
    leftIntent.associationId === rightIntent.associationId &&
    leftIntent.writerId === rightIntent.writerId &&
    leftIntent.operationId === rightIntent.operationId &&
    leftIntent.path === rightIntent.path &&
    preconditionEquals(leftIntent.precondition, rightIntent.precondition) &&
    leftIntent.mutationAttempts === rightIntent.mutationAttempts &&
    leftIntent.evidenceAttempts === rightIntent.evidenceAttempts &&
    (leftIntent.action === MUTATION_ACTION.tombstone ||
      (rightIntent.action !== MUTATION_ACTION.tombstone &&
        leftIntent.contentSha256 === rightIntent.contentSha256))
  );
}

function deferredHistoryEquals(
  left: RenameDeferredMirrorState | null,
  right: RenameDeferredMirrorState | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.kind === right.kind &&
    left.observationGeneration === right.observationGeneration &&
    left.renameId === right.renameId &&
    left.associationId === right.associationId &&
    left.sourcePath === right.sourcePath &&
    left.destinationPath === right.destinationPath &&
    left.sourceExpectedRevision === right.sourceExpectedRevision &&
    left.destinationObservationGeneration ===
      right.destinationObservationGeneration &&
    left.destinationAcknowledgedRevision ===
      right.destinationAcknowledgedRevision &&
    left.graceDeadlineMilliseconds === right.graceDeadlineMilliseconds &&
    left.phase === right.phase
  );
}

function recoveryEvidenceEquals(
  left: ReconciliationReviewSnapshot["recovery"],
  right: ReconciliationReviewSnapshot["recovery"],
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    left.associationId === right.associationId &&
    left.path === right.path &&
    left.revision === right.revision &&
    left.sourceRevision === right.sourceRevision &&
    left.contentSha256 === right.contentSha256 &&
    (left.kind === RECOVERY_SNAPSHOT_STATE_KIND.prepared ||
      (right.kind !== RECOVERY_SNAPSHOT_STATE_KIND.prepared &&
        left.recoverUntil === right.recoverUntil))
  );
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

function isCanonicalInstant(value: string): boolean {
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
