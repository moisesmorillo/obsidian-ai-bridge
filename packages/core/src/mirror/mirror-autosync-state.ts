import {
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  MUTATION_ACTION,
} from "@core/mirror/mirror.constants";
import type {
  ContentSha256,
  MirrorOperationId,
  UnresolvedContentMutationIntent,
  UnresolvedMutationIntent,
} from "@core/mirror/mirror.types";
import {
  MAX_MIRROR_TRACKED_PATHS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_MUTATION_PHASE,
} from "@core/mirror/mirror-state.constants";
import type {
  MirrorDeviceState,
  MirrorPathBlockReason,
  MirrorPathState,
  MirrorStateSnapshot,
} from "@core/mirror/mirror-state.types";
import type { NotePath } from "@core/note-path/note-path.types";

/** @returns The durable state for one path, when tracked. */
export function findMirrorPath(
  state: MirrorDeviceState,
  path: NotePath,
): MirrorPathState | undefined {
  return state.paths.find((entry) => entry.path === path);
}

/** @returns Current positive desired generation, or `-1` when none exists. */
export function desiredGeneration(
  snapshot: MirrorStateSnapshot,
  path: NotePath,
): number {
  const desired = findMirrorPath(snapshot.state, path)?.desired;
  return desired?.kind === MIRROR_DESIRED_STATE_KIND.dirtyPresent
    ? desired.observationGeneration
    : -1;
}

/** @returns Current unresolved intent for one path, when present. */
export function requireIntent(
  snapshot: MirrorStateSnapshot,
  path: NotePath,
): UnresolvedMutationIntent | undefined {
  return findMirrorPath(snapshot.state, path)?.unresolvedMutation?.intent;
}

/**
 * Adds or refreshes one positive desired state without changing unresolved evidence.
 *
 * @returns Updated state, or `undefined` when adding the path exceeds capacity.
 */
export function upsertDirtyPath(
  state: MirrorDeviceState,
  path: NotePath,
  generation: number,
): MirrorDeviceState | undefined {
  const existing = findMirrorPath(state, path);
  if (existing !== undefined) {
    return updatePath(state, path, (entry) => ({
      ...entry,
      desired: {
        kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent,
        observationGeneration: generation,
      },
    }));
  }
  if (state.paths.length >= MAX_MIRROR_TRACKED_PATHS) return undefined;
  return {
    ...state,
    paths: [
      ...state.paths,
      {
        path,
        acknowledgement: { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
        unresolvedMutation: null,
        desired: {
          kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent,
          observationGeneration: generation,
        },
        blockedReason: null,
      },
    ],
  };
}

/**
 * Creates the exact content intent implied by the path acknowledgement.
 *
 * @returns A create/update/recreate intent, or no intent without active authority.
 */
export function createContentIntent(
  path: MirrorPathState,
  device: MirrorDeviceState,
  contentSha256: ContentSha256,
  operationId: MirrorOperationId,
): UnresolvedContentMutationIntent | undefined {
  if (device.lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.active) {
    return undefined;
  }
  const common = {
    associationId: device.lifecycle.associationId,
    writerId: device.deviceId,
    operationId,
    path: path.path,
    contentSha256,
    mutationAttempts: 0,
    evidenceAttempts: 0,
  };
  switch (path.acknowledgement.kind) {
    case MIRROR_ACKNOWLEDGEMENT_KIND.unassociated:
      return {
        ...common,
        action: MUTATION_ACTION.create,
        precondition: {
          kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent,
        },
      };
    case MIRROR_ACKNOWLEDGEMENT_KIND.live:
      return {
        ...common,
        action: MUTATION_ACTION.update,
        precondition: {
          kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
          revision: path.acknowledgement.revision,
        },
      };
    case MIRROR_ACKNOWLEDGEMENT_KIND.tombstone:
      return {
        ...common,
        action: MUTATION_ACTION.recreate,
        precondition: {
          kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
          revision: path.acknowledgement.revision,
        },
      };
  }
}

/** @returns State with a new intent, or no transition when generation/state changed. */
export function persistContentIntent(
  state: MirrorDeviceState,
  path: NotePath,
  generation: number,
  intent: UnresolvedContentMutationIntent,
): MirrorDeviceState | undefined {
  return updatePath(state, path, (entry) => {
    if (
      entry.unresolvedMutation !== null ||
      entry.desired.kind !== MIRROR_DESIRED_STATE_KIND.dirtyPresent ||
      entry.desired.observationGeneration !== generation
    ) {
      return undefined;
    }
    return {
      ...entry,
      unresolvedMutation: {
        intent,
        phase: MIRROR_MUTATION_PHASE.intentPersisted,
      },
    };
  });
}

/** @returns State with reset exact-intent budgets, or no stale-intent transition. */
export function grantIntentRetry(
  state: MirrorDeviceState,
  expected: UnresolvedMutationIntent,
): MirrorDeviceState | undefined {
  return updateExactIntent(state, expected, (entry) => ({
    ...entry,
    unresolvedMutation:
      entry.unresolvedMutation === null
        ? null
        : {
            phase: MIRROR_MUTATION_PHASE.evidenceRequired,
            intent: {
              ...entry.unresolvedMutation.intent,
              mutationAttempts: 0,
              evidenceAttempts: 0,
            },
          },
    blockedReason: null,
  }));
}

/** @returns State with one evidence attempt consumed, or no stale-intent transition. */
export function consumeEvidenceAttempt(
  state: MirrorDeviceState,
  expected: UnresolvedMutationIntent,
): MirrorDeviceState | undefined {
  return updateExactIntent(state, expected, (entry) => ({
    ...entry,
    unresolvedMutation:
      entry.unresolvedMutation === null
        ? null
        : {
            ...entry.unresolvedMutation,
            intent: {
              ...entry.unresolvedMutation.intent,
              evidenceAttempts:
                entry.unresolvedMutation.intent.evidenceAttempts + 1,
            },
          },
  }));
}

/** @returns State with dispatch recorded, or no stale-intent transition. */
export function consumeMutationAttempt(
  state: MirrorDeviceState,
  expected: UnresolvedContentMutationIntent,
): MirrorDeviceState | undefined {
  return updateExactIntent(state, expected, (entry) => ({
    ...entry,
    unresolvedMutation:
      entry.unresolvedMutation === null
        ? null
        : {
            phase: MIRROR_MUTATION_PHASE.dispatched,
            intent: {
              ...entry.unresolvedMutation.intent,
              mutationAttempts:
                entry.unresolvedMutation.intent.mutationAttempts + 1,
            },
          },
  }));
}

/** @returns State in the requested phase, or no transition without an intent. */
export function setIntentPhase(
  state: MirrorDeviceState,
  path: NotePath,
  phase:
    | typeof MIRROR_MUTATION_PHASE.intentPersisted
    | typeof MIRROR_MUTATION_PHASE.evidenceRequired,
): MirrorDeviceState | undefined {
  return updatePath(state, path, (entry) => {
    if (entry.unresolvedMutation === null) return undefined;
    return {
      ...entry,
      unresolvedMutation: { ...entry.unresolvedMutation, phase },
    };
  });
}

/** @returns State with the exact desired generation cleared when still current. */
export function clearDesiredGeneration(
  state: MirrorDeviceState,
  path: NotePath,
  generation: number,
): MirrorDeviceState | undefined {
  return updatePath(state, path, (entry) => {
    if (
      entry.desired.kind !== MIRROR_DESIRED_STATE_KIND.dirtyPresent ||
      entry.desired.observationGeneration !== generation
    ) {
      return entry;
    }
    return {
      ...entry,
      desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
      blockedReason: null,
    };
  });
}

/** @returns State with the path blocked, or no transition for an unknown path. */
export function blockMirrorPath(
  state: MirrorDeviceState,
  path: NotePath,
  reason: MirrorPathBlockReason | null,
): MirrorDeviceState | undefined {
  return updatePath(state, path, (entry) => ({
    ...entry,
    blockedReason: reason,
  }));
}

/** @returns Updated exact intent state, or no transition after identity drift. */
function updateExactIntent(
  state: MirrorDeviceState,
  expected: UnresolvedMutationIntent,
  update: (entry: MirrorPathState) => MirrorPathState,
): MirrorDeviceState | undefined {
  return updatePath(state, expected.path, (entry) =>
    entry.unresolvedMutation?.intent.operationId === expected.operationId
      ? update(entry)
      : undefined,
  );
}

/** @returns Immutably updated path state, or no transition when unavailable. */
function updatePath(
  state: MirrorDeviceState,
  path: NotePath,
  update: (entry: MirrorPathState) => MirrorPathState | undefined,
): MirrorDeviceState | undefined {
  const index = state.paths.findIndex((entry) => entry.path === path);
  if (index < 0) return undefined;
  const current = state.paths[index];
  if (current === undefined) return undefined;
  const updated = update(current);
  if (updated === undefined) return undefined;
  return {
    ...state,
    paths: state.paths.map((entry, entryIndex) =>
      entryIndex === index ? updated : entry,
    ),
  };
}
