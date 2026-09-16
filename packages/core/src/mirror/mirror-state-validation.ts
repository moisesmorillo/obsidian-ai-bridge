import {
  MAX_MUTATION_ATTEMPTS,
  MAX_MUTATION_EVIDENCE_ATTEMPTS,
  MUTATION_ACTION,
} from "@core/mirror/mirror.constants";
import {
  MAX_MIRROR_TRACKED_PATHS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_MUTATION_PHASE,
  MIRROR_RENAME_PHASE,
} from "@core/mirror/mirror-state.constants";
import type {
  MirrorDeviceState,
  MirrorPathState,
} from "@core/mirror/mirror-state.types";

/**
 * Validates cross-field invariants of an already strongly typed device state.
 *
 * Syntax and serialization remain adapter responsibilities. This validator owns
 * application invariants shared by state loading and every committed transition.
 *
 * @param state - Candidate complete device-local state.
 * @returns Whether lifecycle, intent, evidence, and handoff relationships are safe.
 */
export function isMirrorDeviceStateConsistent(
  state: MirrorDeviceState,
): boolean {
  return (
    validateStateCapacity(state) &&
    validateLifecycleAndHandoff(state) &&
    validateIdentifierUniqueness(state) &&
    validateDrainedState(state) &&
    state.paths.every((entry) => validatePathState(state, entry))
  );
}

/**
 * Validates practical bounds for active and staged path ledgers.
 *
 * @param state - Candidate complete device-local state.
 * @returns Whether both ledger scopes fit the configured capacity.
 */
function validateStateCapacity(state: MirrorDeviceState): boolean {
  return (
    state.paths.length <= MAX_MIRROR_TRACKED_PATHS &&
    (state.stagedHandoff === null ||
      state.stagedHandoff.entries.length <= MAX_MIRROR_TRACKED_PATHS)
  );
}

/**
 * Validates variant-specific lifecycle ownership of active or staged state.
 *
 * @param state - Candidate complete device-local state.
 * @returns Whether lifecycle and handoff payload relationships are consistent.
 */
function validateLifecycleAndHandoff(state: MirrorDeviceState): boolean {
  const { lifecycle, stagedHandoff } = state;
  switch (lifecycle.kind) {
    case MIRROR_DEVICE_LIFECYCLE_KIND.disabled:
      return stagedHandoff === null && state.paths.length === 0;
    case MIRROR_DEVICE_LIFECYCLE_KIND.active:
    case MIRROR_DEVICE_LIFECYCLE_KIND.paused:
    case MIRROR_DEVICE_LIFECYCLE_KIND.handoffDraining:
    case MIRROR_DEVICE_LIFECYCLE_KIND.handoffDrained:
      return stagedHandoff === null;
    case MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged:
      return (
        stagedHandoff !== null &&
        state.paths.length === 0 &&
        stagedHandoff.associationId === lifecycle.associationId &&
        stagedHandoff.origin === lifecycle.origin &&
        stagedHandoff.entries.every((entry) =>
          isNonNegativeSafeInteger(entry.observationGeneration),
        )
      );
  }
}

/**
 * Validates path and operation/recovery identities within each ledger scope.
 *
 * @param state - Candidate complete device-local state.
 * @returns Whether path, operation, and recovery identities are unambiguous.
 */
function validateIdentifierUniqueness(state: MirrorDeviceState): boolean {
  if (hasDuplicate(state.paths.map((entry) => entry.path))) return false;
  const operationIds = state.paths.flatMap((entry) =>
    entry.unresolvedMutation === null
      ? []
      : [entry.unresolvedMutation.intent.operationId],
  );
  if (hasDuplicate(operationIds)) return false;
  const recoveryIds = state.paths.flatMap((entry) =>
    entry.acknowledgement.kind === MIRROR_ACKNOWLEDGEMENT_KIND.tombstone
      ? [entry.acknowledgement.recoveryId]
      : [],
  );
  const recoveryIdSet = new Set(recoveryIds);
  if (
    recoveryIdSet.size !== recoveryIds.length ||
    operationIds.some((operationId) => recoveryIdSet.has(operationId))
  ) {
    return false;
  }
  if (state.stagedHandoff === null) return true;
  const stagedRecoveryIds = state.stagedHandoff.entries.flatMap((entry) =>
    entry.acknowledgement.kind === MIRROR_ACKNOWLEDGEMENT_KIND.tombstone
      ? [entry.acknowledgement.recoveryId]
      : [],
  );
  return (
    !hasDuplicate(state.stagedHandoff.entries.map((entry) => entry.path)) &&
    !hasDuplicate(stagedRecoveryIds)
  );
}

/**
 * Requires the exported handoff state to remain globally and per-path quiescent.
 *
 * @param state - Candidate complete device-local state.
 * @returns Whether a drained lifecycle contains no pending or blocked work.
 */
function validateDrainedState(state: MirrorDeviceState): boolean {
  if (state.lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.handoffDrained) {
    return true;
  }
  return (
    state.globalBlockReason === null &&
    state.paths.every(
      (entry) =>
        entry.unresolvedMutation === null &&
        entry.desired.kind === MIRROR_DESIRED_STATE_KIND.none &&
        entry.blockedReason === null,
    )
  );
}

/**
 * Validates unresolved remote work and coalesced local evidence for one path.
 *
 * @param state - Candidate complete device-local state.
 * @param entry - Path ledger entry to validate in device context.
 * @returns Whether mutation and desired-state invariants hold for the path.
 */
function validatePathState(
  state: MirrorDeviceState,
  entry: MirrorPathState,
): boolean {
  return (
    (entry.unresolvedMutation === null ||
      validateUnresolvedMutation(state, entry)) &&
    validateDesiredState(state, entry)
  );
}

/**
 * Validates mutation ownership, finite budgets, phase, and acknowledged baseline.
 *
 * @param state - Candidate complete device-local state.
 * @param entry - Path containing the unresolved mutation.
 * @returns Whether the unresolved mutation remains safe and internally consistent.
 */
function validateUnresolvedMutation(
  state: MirrorDeviceState,
  entry: MirrorPathState,
): boolean {
  const unresolved = entry.unresolvedMutation;
  if (unresolved === null) return true;
  const { intent } = unresolved;
  return (
    validateMutationPhase(unresolved) &&
    intent.path === entry.path &&
    intent.writerId === state.deviceId &&
    isNonNegativeSafeInteger(intent.mutationAttempts) &&
    intent.mutationAttempts <= MAX_MUTATION_ATTEMPTS &&
    isNonNegativeSafeInteger(intent.evidenceAttempts) &&
    intent.evidenceAttempts <= MAX_MUTATION_EVIDENCE_ATTEMPTS &&
    lifecycleMatchesAssociation(state, intent.associationId) &&
    validateAcknowledgementAction(entry.acknowledgement, intent)
  );
}

/**
 * Makes the closed mutation-phase/action policy explicit and exhaustive.
 *
 * @param unresolved - Durable mutation and current workflow phase.
 * @returns Whether the action is valid in that phase.
 */
function validateMutationPhase(
  unresolved: NonNullable<MirrorPathState["unresolvedMutation"]>,
): boolean {
  switch (unresolved.phase) {
    case MIRROR_MUTATION_PHASE.intentPersisted:
    case MIRROR_MUTATION_PHASE.dispatched:
    case MIRROR_MUTATION_PHASE.evidenceRequired:
      return true;
    case MIRROR_MUTATION_PHASE.recoveryPreparation:
    case MIRROR_MUTATION_PHASE.tombstoneCommit:
      return unresolved.intent.action === MUTATION_ACTION.tombstone;
  }
}

/**
 * Makes the closed acknowledgement/action/revision matrix explicit.
 *
 * @param acknowledgement - Last confirmed remote path state.
 * @param intent - Unresolved mutation to compare with that state.
 * @returns Whether the action and revision are compatible with the acknowledgement.
 */
function validateAcknowledgementAction(
  acknowledgement: MirrorPathState["acknowledgement"],
  intent: NonNullable<MirrorPathState["unresolvedMutation"]>["intent"],
): boolean {
  switch (acknowledgement.kind) {
    case MIRROR_ACKNOWLEDGEMENT_KIND.unassociated:
      return intent.action === MUTATION_ACTION.create;
    case MIRROR_ACKNOWLEDGEMENT_KIND.live:
      return (
        (intent.action === MUTATION_ACTION.update ||
          intent.action === MUTATION_ACTION.tombstone) &&
        intent.precondition.revision === acknowledgement.revision
      );
    case MIRROR_ACKNOWLEDGEMENT_KIND.tombstone:
      return (
        intent.action === MUTATION_ACTION.recreate &&
        intent.precondition.revision === acknowledgement.revision
      );
  }
}

/**
 * Makes each desired-state variant's evidence and authority rules explicit.
 *
 * @param state - Candidate complete device-local state.
 * @param entry - Path containing the coalesced desired state.
 * @returns Whether the desired state carries valid evidence and authority.
 */
function validateDesiredState(
  state: MirrorDeviceState,
  entry: MirrorPathState,
): boolean {
  const { desired } = entry;
  switch (desired.kind) {
    case MIRROR_DESIRED_STATE_KIND.none:
      return true;
    case MIRROR_DESIRED_STATE_KIND.dirtyPresent:
      return isNonNegativeSafeInteger(desired.observationGeneration);
    case MIRROR_DESIRED_STATE_KIND.renameDeferred:
      return (
        isNonNegativeSafeInteger(desired.observationGeneration) &&
        isNonNegativeSafeInteger(desired.graceDeadlineMilliseconds) &&
        desired.sourcePath === entry.path &&
        desired.destinationPath !== entry.path &&
        (desired.destinationPath === null
          ? desired.destinationObservationGeneration === null &&
            desired.destinationAcknowledgedRevision === null
          : isNonNegativeSafeInteger(
              desired.destinationObservationGeneration ?? -1,
            )) &&
        (desired.phase === MIRROR_RENAME_PHASE.destinationRequired
          ? desired.destinationPath !== null &&
            desired.destinationAcknowledgedRevision === null
          : true) &&
        (desired.phase === MIRROR_RENAME_PHASE.sourceCleanupRequired
          ? desired.destinationPath === null ||
            desired.destinationAcknowledgedRevision !== null
          : true) &&
        entry.acknowledgement.kind === MIRROR_ACKNOWLEDGEMENT_KIND.live &&
        desired.sourceExpectedRevision === entry.acknowledgement.revision &&
        lifecycleMatchesAssociation(state, desired.associationId)
      );
    case MIRROR_DESIRED_STATE_KIND.runtimeDelete:
      return (
        isNonNegativeSafeInteger(desired.observationGeneration) &&
        isNonNegativeSafeInteger(desired.graceDeadlineMilliseconds) &&
        entry.acknowledgement.kind === MIRROR_ACKNOWLEDGEMENT_KIND.live &&
        desired.expectedRevision === entry.acknowledgement.revision &&
        lifecycleMatchesAssociation(state, desired.associationId)
      );
  }
}

/**
 * Checks that durable path work remains bound to an association-bearing lifecycle.
 *
 * @param state - Candidate complete device-local state.
 * @param associationId - Association retained by path-local work.
 * @returns Whether the lifecycle permits that exact association.
 */
function lifecycleMatchesAssociation(
  state: MirrorDeviceState,
  associationId: NonNullable<
    MirrorPathState["unresolvedMutation"]
  >["intent"]["associationId"],
): boolean {
  switch (state.lifecycle.kind) {
    case MIRROR_DEVICE_LIFECYCLE_KIND.disabled:
    case MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged:
      return false;
    case MIRROR_DEVICE_LIFECYCLE_KIND.active:
    case MIRROR_DEVICE_LIFECYCLE_KIND.paused:
    case MIRROR_DEVICE_LIFECYCLE_KIND.handoffDraining:
    case MIRROR_DEVICE_LIFECYCLE_KIND.handoffDrained:
      return state.lifecycle.associationId === associationId;
  }
}

function hasDuplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
