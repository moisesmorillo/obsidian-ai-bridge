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

/** Exact competing bytes derived from sampled evidence, never from a receipt's own claims. */
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

/**
 * Bounds sparse record counts, total receipts and all snapshot/reservation path references.
 *
 * @returns Whether all sparse-record and path-reference capacity limits hold.
 */
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

/**
 * Rejects M4 metadata before activation/staged handoff and active reservations after drain.
 *
 * @returns Whether this lifecycle permits the recorded M4 metadata and reservations.
 */
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

/**
 * Keeps historical snapshots bound to this device and association/origin without requiring current lifecycle equality.
 *
 * @returns Whether the sample belongs to the current device and enabled binding.
 */
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

/**
 * Checks durable review identity and snapshot shape; a staged review must name an operation.
 *
 * @returns Whether review identity, status linkage and snapshot shape are valid.
 */
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

/**
 * Rejects malformed or duplicate sampled paths and snapshots missing their target; does not sample live state.
 *
 * @returns Whether the sample has valid unique paths and includes its target.
 */
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

/**
 * Validates identity counters, writer IDs and lifecycle shape, not freshness against the running host.
 *
 * @param runtime - Persisted sampled runtime identity, not a live host observation.
 * @returns Whether all sampled runtime identity fields are valid.
 */
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

/**
 * Checks the sampled lifecycle's binding and pause reason without granting activation authority.
 *
 * @returns Whether the sampled lifecycle variant has a valid binding and pause reason.
 */
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

/**
 * Checks canonical association identity and bounded origin text; adapter decoding owns URL validation.
 *
 * @param associationId - Persisted association UUID.
 * @param origin - Persisted origin text already subject to adapter URL validation.
 * @returns Whether association syntax and origin length are admissible.
 */
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

/**
 * Composes local, baseline, remote and M3 evidence checks for one literal path; does not classify divergence.
 *
 * @returns Whether all evidence components for the literal path are valid.
 */
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

/**
 * Enforces stable positive-generation absence/live samples and bounded live bytes; unknown carries no exact evidence.
 *
 * @param evidence - Persisted local observation variant.
 * @returns Whether the local observation meets its variant's evidence requirements.
 */
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

/**
 * Checks sampled remote lineage and receipt relationships; physical absence and legacy hashes never become revision evidence.
 *
 * @returns Whether remote evidence satisfies its variant's lineage and receipt requirements.
 */
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

/**
 * Rejects foreign or malformed remote lineage relative to the snapshot's enabled binding.
 *
 * @returns Whether the remote association is canonical and matches the enabled binding.
 */
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

/**
 * Binds live receipt action, association, operation and hash to sampled evidence with the matching create/update predicate.
 *
 * @returns Whether the live receipt matches the sampled content and original predicate.
 */
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

/**
 * Validates baseline revision/hash or recovery identity without inferring association from equal content.
 *
 * @param acknowledgement - Persisted baseline variant to validate.
 * @returns Whether the baseline's identifiers match its acknowledgement variant.
 */
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

/**
 * Rejects simultaneous unresolved mutation and deferred history in one sample, then checks the represented M3 authority.
 *
 * @returns Whether sampled M3 authority is valid and mutually exclusive.
 */
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

/**
 * Checks sampled M3 path/writer/binding, finite budgets and tombstone-only phases; strict decoding owns intent field syntax.
 *
 * @returns Whether the sampled unresolved intent has compatible ownership, phase and budgets.
 */
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

/**
 * Validates sampled rename source, optional destination evidence, revisions and phase without reconstructing lost history.
 *
 * @returns Whether sampled rename identity, prerequisites and phase are valid.
 */
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

/**
 * Binds selected recovery metadata to target and association; validates timestamp form, not expiry against a clock.
 *
 * @returns Whether selected recovery metadata has valid target, lineage and retention fields.
 */
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

/**
 * Checks one operation's identity, action/evidence/phase, unique reservations and evidence-bound receipts before cross-record validation.
 *
 * @returns Whether operation fields, reservations and receipts are internally valid.
 */
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

/**
 * Requires a distinct successor ID only for a completed restore; all other states must leave the link null.
 *
 * @returns Whether successor identity is present exactly when required and is distinct.
 */
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

/**
 * Refuses terminal restore without a different reviewed successor reserving the restored path.
 * Its live sample must have a newer observation generation and the selected recovery hash;
 * successor completion, not local restore alone, can release ordinary M3 ownership.
 *
 * @returns Whether a completed restore has the required reviewed successor, or needs none.
 */
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

/**
 * Enforces action-specific sampled local/remote/recovery prerequisites; it neither selects an action nor refreshes evidence.
 *
 * @returns Whether sampled evidence permits the recorded action.
 */
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

/**
 * Rejects forbidden local/remote effect channels and phases, including mutating tombstone acceptance or non-restore restore fences.
 *
 * @returns Whether the recorded phase and effect channels are permitted for the action.
 */
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

/**
 * Checks the permitted action matrix for an already classified review; unavailable or M3-owned work permits only defer.
 *
 * @returns Whether the action is permitted for the review classification.
 */
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

/**
 * Requires each action's explicit operator authority category; remote observations are never an authority source.
 *
 * @returns Whether the operation carries the required operator authority category.
 */
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

/**
 * Enforces action-specific destination rules and exact sampled/reserved path coverage, including absent new destinations.
 *
 * @returns Whether destination and reservation coverage match the action's sampled paths.
 */
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

/**
 * Requires sampled local/remote absence, no baseline and no M3 work before a path can be a new destination.
 *
 * @returns Whether the sample permits a genuinely new destination.
 */
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

/**
 * Rejects receipts not bound to this operation's generated path and evidence-derived side, revision and hash; performs no file I/O.
 *
 * @returns Whether the receipt is bound to the operation and required preservation identity.
 */
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

/**
 * Owns the action-to-competing-bytes preservation matrix used for both receipt admission and effect fencing.
 * An empty list means no preservation is required; undefined means the evidence cannot
 * establish required bytes. Other validators enforce the action's evidence prerequisites.
 *
 * @returns Required preservation identities, an empty list when unnecessary, or undefined when evidence cannot establish them.
 */
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

/**
 * Derives the exact live local safety copy; local bytes have no application source revision.
 *
 * @returns One local copy requirement for live bytes, or undefined for non-live evidence.
 */
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

/**
 * Derives live revision-bound or legacy hash-only remote copies; absent, tombstoned or unavailable evidence supplies no bytes.
 *
 * @returns One remote copy requirement for live/legacy bytes, or undefined without those bytes.
 */
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

/**
 * Distinguishes no-effect history retention from preservation/cleanup progress that requires an exact remote safety copy.
 *
 * @returns Whether deferred history has preservation or cleanup progress.
 */
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

/**
 * Enforces phase/effect/proof consistency and verified preservation before effects may have started.
 * Unknown effects retain evidence ownership; restored-pending-review keeps a local-only
 * reservation even before dispatch. Receipt metadata is validated, not reverified on disk.
 *
 * @returns Whether phase, effect certainty and required preservation proofs are consistent.
 */
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

/**
 * Requires a verified receipt matching every evidence-derived identity; vacuously accepts actions needing no copies.
 *
 * @param requirements - Evidence-derived copies required before effects.
 * @param receipts - Persisted proof claims to match by complete identity.
 * @returns Whether every requirement has a matching verified receipt.
 */
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

/**
 * Checks action-specific completion evidence, allowing equal-byte adoption and no-effect history completion without a write.
 *
 * @returns Whether the recorded effects satisfy action-specific completion requirements.
 */
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

/**
 * Determines whether use-remote/adoption needs a local write rather than equal-byte association from the sampled target.
 *
 * @returns Whether sampled evidence requires a local content write.
 */
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

/**
 * Rejects active M4 ownership over current unresolved M3 mutations/deletes; deferred rename allows only reviewed history.
 *
 * @returns Whether current M3 ownership permits the operation's active reservations.
 */
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

/**
 * Couples active, stale and completed operation phases to the linked durable review's status.
 *
 * @returns Whether the linked review status agrees with the operation phase.
 */
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

/**
 * Checks reciprocal operation linkage and sampled M3 classification precedence without recomputing ordinary divergence.
 *
 * @returns Whether reciprocal linkage and sampled M3 classification precedence hold.
 */
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

/**
 * Keeps blocked, partial, unknown-effect and restored-pending-review operations active; only stale/completed release reservations.
 *
 * @returns Whether the operation still retains reservation ownership.
 */
function isActiveOperation(operation: ReconciliationOperation): boolean {
  return (
    operation.phase !== RECONCILIATION_OPERATION_PHASE.stale &&
    operation.phase !== RECONCILIATION_OPERATION_PHASE.completed
  );
}

/**
 * Selects the immutable target sample; undefined is malformed/missing evidence, never an absence observation.
 *
 * @returns The immutable target sample, or undefined if missing.
 */
function targetEvidence(
  snapshot: ReconciliationReviewSnapshot,
): ReconciliationPathEvidence | undefined {
  return snapshot.paths.find(
    (evidence) => evidence.path === snapshot.targetPath,
  );
}

/**
 * Selects an explicit destination sample or the original target for an in-place restore.
 *
 * @returns The selected destination sample, or undefined if missing.
 */
function destinationEvidence(
  operation: ReconciliationOperation,
): ReconciliationPathEvidence | undefined {
  const destination =
    operation.destinationPath ?? operation.snapshot.targetPath;
  return operation.snapshot.paths.find(
    (evidence) => evidence.path === destination,
  );
}

/**
 * Compares every runtime/epoch/configuration/writer and lifecycle field so byte equality cannot hide stale authority.
 *
 * @param left - Previously sampled runtime identity.
 * @param right - Runtime identity being compared for decision staleness.
 * @returns Whether every runtime identity dimension is equal.
 */
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

/**
 * Compares lifecycle kind, binding and pause reason rather than treating all enabled states as interchangeable.
 *
 * @returns Whether lifecycle kind, binding and pause reason match.
 */
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

/**
 * Requires the same path and complete local/baseline/remote/M3 sample; a missing peer is unequal.
 *
 * @returns Whether the complete path evidence matches an existing peer.
 */
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

/**
 * Includes stability, generation and byte size as well as hash, retaining same-text event invalidation.
 *
 * @param left - Previously sampled local evidence.
 * @param right - Local evidence being compared for staleness.
 * @returns Whether the complete local sample is unchanged.
 */
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

/**
 * Compares baseline kind and exact revision/hash or recovery identity, not just equal live bytes.
 *
 * @param left - Previously sampled baseline.
 * @param right - Baseline being compared for staleness.
 * @returns Whether the exact baseline identities match.
 */
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

/**
 * Compares full remote generation and receipt identity; legacy equality remains hash-only observation, not CAS authority.
 *
 * @param left - Previously sampled remote evidence.
 * @param right - Remote evidence being compared for staleness.
 * @returns Whether the complete remote observation is unchanged.
 */
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

/**
 * Requires the same content operation identity and original predicate in addition to the content hash.
 *
 * @param left - Previously sampled content receipt.
 * @param right - Content receipt being compared for staleness.
 * @returns Whether content receipt identity and predicate match.
 */
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

/**
 * Requires the same deletion receipt identity and exact parent predicate without inventing content on a tombstone.
 *
 * @param left - Previously sampled tombstone receipt.
 * @param right - Tombstone receipt being compared for staleness.
 * @returns Whether deletion receipt identity and predicate match.
 */
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

/**
 * Keeps absence predicates distinct from matching-revision predicates and compares the exact parent revision.
 *
 * @param left - Previously sampled mutation precondition.
 * @param right - Precondition being compared for staleness.
 * @returns Whether both original predicates match exactly.
 */
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

/**
 * Detects any sampled unresolved-intent or deferred-history change that would invalidate M4 decision identity.
 *
 * @returns Whether all sampled M3 authority is unchanged.
 */
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

/**
 * Compares nullable M3 intent identity, phase, predicate and consumed budgets; a retry alone can stale a review.
 *
 * @param left - Previously sampled unresolved mutation.
 * @param right - Mutation state being compared for staleness.
 * @returns Whether the complete nullable intent state is unchanged.
 */
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

/**
 * Compares all rename generations, paths, prerequisites, grace and phase rather than inferring equivalent history.
 *
 * @param left - Previously sampled deferred history.
 * @param right - Deferred history being compared for staleness.
 * @returns Whether the complete nullable deferred history is unchanged.
 */
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

/**
 * Compares selected recovery lineage, revision, bytes and retention deadline; null means no selected snapshot.
 *
 * @param left - Previously selected recovery evidence.
 * @param right - Recovery evidence being compared for staleness.
 * @returns Whether the complete nullable recovery sample is unchanged.
 */
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

/**
 * Requires both channels to remain undispatched; definite refusal is not equivalent to never having dispatched.
 *
 * @returns Whether neither effect channel has been dispatched.
 */
function noEffects(operation: ReconciliationOperation): boolean {
  return (
    operation.localEffect === MUTATION_EFFECT_CERTAINTY.notDispatched &&
    operation.remoteEffect === MUTATION_EFFECT_CERTAINTY.notDispatched
  );
}

/**
 * Accepts only the closed persisted proof states; a verified label alone does not prove receipt identity.
 *
 * @returns Whether the persisted proof state belongs to the closed supported set.
 */
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

/**
 * Accepts only finite timestamps in canonical ISO serialization; does not determine whether retention has expired.
 *
 * @param value - Persisted retention deadline text.
 * @returns Whether the value is a canonical finite ISO instant.
 */
function isCanonicalInstant(value: string): boolean {
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

/**
 * Validates nonzero epoch/version/generation counters without lossy integer representation.
 *
 * @param value - Persisted epoch, version or generation counter.
 * @returns Whether the value is a positive safe integer.
 */
function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Validates exactly representable counters and millisecond values that may start at zero.
 *
 * @param value - Persisted counter or millisecond value.
 * @returns Whether the value is a nonnegative safe integer.
 */
function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
