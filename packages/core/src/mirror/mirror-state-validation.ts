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
  if (state.paths.length > MAX_MIRROR_TRACKED_PATHS) return false;
  const stagedLifecycle =
    state.lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged;
  if (stagedLifecycle !== (state.stagedHandoff !== null)) return false;
  if (
    state.lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.disabled &&
    state.paths.length > 0
  ) {
    return false;
  }
  if (state.stagedHandoff !== null) {
    if (state.lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged) {
      return false;
    }
    if (
      state.paths.length > 0 ||
      state.stagedHandoff.entries.length > MAX_MIRROR_TRACKED_PATHS ||
      state.stagedHandoff.associationId !== state.lifecycle.associationId ||
      state.stagedHandoff.origin !== state.lifecycle.origin ||
      state.stagedHandoff.entries.some(
        (entry) => !isNonNegativeSafeInteger(entry.observationGeneration),
      )
    ) {
      return false;
    }
  }
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
  if (state.stagedHandoff !== null) {
    const stagedRecoveryIds = state.stagedHandoff.entries.flatMap((entry) =>
      entry.acknowledgement.kind === MIRROR_ACKNOWLEDGEMENT_KIND.tombstone
        ? [entry.acknowledgement.recoveryId]
        : [],
    );
    if (
      hasDuplicate(state.stagedHandoff.entries.map((entry) => entry.path)) ||
      hasDuplicate(stagedRecoveryIds)
    ) {
      return false;
    }
  }
  if (
    state.lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.handoffDrained &&
    (state.globalBlockReason !== null ||
      state.paths.some(
        (entry) =>
          entry.unresolvedMutation !== null ||
          entry.desired.kind !== MIRROR_DESIRED_STATE_KIND.none ||
          entry.blockedReason !== null,
      ))
  ) {
    return false;
  }
  return state.paths.every((entry) => validatePathInvariants(state, entry));
}

function validatePathInvariants(
  state: MirrorDeviceState,
  entry: MirrorPathState,
): boolean {
  const unresolved = entry.unresolvedMutation;
  if (unresolved !== null) {
    const intent = unresolved.intent;
    if (
      ((unresolved.phase === MIRROR_MUTATION_PHASE.recoveryPreparation ||
        unresolved.phase === MIRROR_MUTATION_PHASE.tombstoneCommit) &&
        intent.action !== MUTATION_ACTION.tombstone) ||
      intent.path !== entry.path ||
      intent.writerId !== state.deviceId ||
      !isNonNegativeSafeInteger(intent.mutationAttempts) ||
      intent.mutationAttempts > MAX_MUTATION_ATTEMPTS ||
      !isNonNegativeSafeInteger(intent.evidenceAttempts) ||
      intent.evidenceAttempts > MAX_MUTATION_EVIDENCE_ATTEMPTS
    ) {
      return false;
    }
    if (
      state.lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.disabled ||
      state.lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged ||
      intent.associationId !== state.lifecycle.associationId
    ) {
      return false;
    }
    if (
      entry.acknowledgement.kind === MIRROR_ACKNOWLEDGEMENT_KIND.unassociated &&
      intent.action !== MUTATION_ACTION.create
    ) {
      return false;
    }
    if (entry.acknowledgement.kind === MIRROR_ACKNOWLEDGEMENT_KIND.live) {
      if (
        (intent.action !== MUTATION_ACTION.update &&
          intent.action !== MUTATION_ACTION.tombstone) ||
        intent.precondition.revision !== entry.acknowledgement.revision
      ) {
        return false;
      }
    }
    if (entry.acknowledgement.kind === MIRROR_ACKNOWLEDGEMENT_KIND.tombstone) {
      if (
        intent.action !== MUTATION_ACTION.recreate ||
        intent.precondition.revision !== entry.acknowledgement.revision
      ) {
        return false;
      }
    }
  }
  if (entry.desired.kind === MIRROR_DESIRED_STATE_KIND.none) return true;
  if (!isNonNegativeSafeInteger(entry.desired.observationGeneration)) {
    return false;
  }
  if (
    entry.desired.kind === MIRROR_DESIRED_STATE_KIND.renameDeferred &&
    entry.desired.counterpartPath === entry.path
  ) {
    return false;
  }
  if (entry.desired.kind !== MIRROR_DESIRED_STATE_KIND.runtimeDelete)
    return true;
  return (
    entry.acknowledgement.kind === MIRROR_ACKNOWLEDGEMENT_KIND.live &&
    entry.desired.expectedRevision === entry.acknowledgement.revision &&
    state.lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.disabled &&
    state.lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged &&
    entry.desired.associationId === state.lifecycle.associationId
  );
}

function hasDuplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
