import {
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  MUTATION_ACTION,
} from "@core/mirror/mirror.constants";
import type {
  ApplicationRevision,
  MirrorAssociationId,
  MirrorOperationId,
  UnresolvedTombstoneMutationIntent,
} from "@core/mirror/mirror.types";
import {
  MAX_MIRROR_TRACKED_PATHS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_MUTATION_PHASE,
  MIRROR_PATH_BLOCK_REASON,
  MIRROR_RENAME_PHASE,
} from "@core/mirror/mirror-state.constants";
import type {
  MirrorDeviceState,
  MirrorPathState,
  RenameDeferredMirrorState,
} from "@core/mirror/mirror-state.types";
import type { NotePath } from "@core/note-path/note-path.types";

/** Inputs captured atomically when one authoritative runtime delete is observed. */
export interface RuntimeDeleteEvidenceInput {
  readonly path: NotePath;
  readonly observationGeneration: number;
  readonly evidenceId: MirrorOperationId;
  readonly graceDeadlineMilliseconds: number;
}

/** Inputs captured atomically for one destination-first runtime rename. */
export interface RuntimeRenameEvidenceInput {
  readonly sourcePath: NotePath;
  readonly destinationPath: NotePath | null;
  readonly sourceObservationGeneration: number;
  readonly destinationObservationGeneration: number | null;
  readonly renameId: MirrorOperationId;
  readonly graceDeadlineMilliseconds: number;
}

/**
 * Persists delete authority only for an established live association.
 *
 * Startup and inventory absence never call this transition. An unassociated path or
 * first create therefore cannot acquire destructive authority.
 *
 * @param state - Current authoritative device state.
 * @param input - Exact runtime evidence and grace deadline.
 * @returns Updated state, or no transition without authority.
 */
export function recordRuntimeDeleteEvidence(
  state: MirrorDeviceState,
  input: RuntimeDeleteEvidenceInput,
): MirrorDeviceState | undefined {
  if (state.lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.active)
    return undefined;
  const associationId = state.lifecycle.associationId;
  return updatePath(state, input.path, (entry) => {
    if (entry.acknowledgement.kind !== MIRROR_ACKNOWLEDGEMENT_KIND.live) {
      return undefined;
    }
    return {
      ...entry,
      desired: {
        kind: MIRROR_DESIRED_STATE_KIND.runtimeDelete,
        observationGeneration: input.observationGeneration,
        evidenceId: input.evidenceId,
        associationId,
        expectedRevision: entry.acknowledgement.revision,
        graceDeadlineMilliseconds: input.graceDeadlineMilliseconds,
      },
      blockedReason: null,
    };
  });
}

/**
 * Persists a compact rename plan and eligible destination discovery in one save.
 *
 * A destination already acknowledged live is a collision. It is retained, while the
 * source plan is explicitly invalidated so no cleanup can follow that generation.
 *
 * @param state - Current authoritative device state.
 * @param input - Source, destination, lifecycle identity, and grace evidence.
 * @returns Updated state, or no transition when unsafe or over capacity.
 */
export function recordRuntimeRenameEvidence(
  state: MirrorDeviceState,
  input: RuntimeRenameEvidenceInput,
): MirrorDeviceState | undefined {
  if (state.lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.active)
    return undefined;
  const source = findPath(state, input.sourcePath);
  if (source?.acknowledgement.kind !== MIRROR_ACKNOWLEDGEMENT_KIND.live) {
    return undefined;
  }

  let paths = state.paths.map((entry) =>
    invalidatedByLifecyclePath(entry, input.sourcePath, input.renameId),
  );
  paths = paths.map((entry) =>
    input.destinationPath === null
      ? entry
      : invalidatedByLifecyclePath(
          entry,
          input.destinationPath,
          input.renameId,
        ),
  );

  if (input.destinationPath !== null) {
    const destination = paths.find(
      (entry) => entry.path === input.destinationPath,
    );
    if (destination === undefined) {
      if (paths.length >= MAX_MIRROR_TRACKED_PATHS) return undefined;
      paths = [
        ...paths,
        {
          path: input.destinationPath,
          acknowledgement: { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
          unresolvedMutation: null,
          desired: {
            kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent,
            observationGeneration: requireDestinationGeneration(input),
          },
          blockedReason: null,
        },
      ];
    } else if (
      destination.acknowledgement.kind === MIRROR_ACKNOWLEDGEMENT_KIND.live
    ) {
      return replaceSourcePlan(
        state,
        input,
        MIRROR_RENAME_PHASE.invalidated,
        paths,
        state.lifecycle.associationId,
        source.acknowledgement.revision,
      );
    } else {
      paths = paths.map((entry) =>
        entry.path === input.destinationPath
          ? {
              ...entry,
              desired: {
                kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent,
                observationGeneration: requireDestinationGeneration(input),
              },
              blockedReason: null,
            }
          : entry,
      );
    }
  }

  return replaceSourcePlan(
    state,
    input,
    input.destinationPath === null
      ? MIRROR_RENAME_PHASE.sourceCleanupRequired
      : MIRROR_RENAME_PHASE.destinationRequired,
    paths,
    state.lifecycle.associationId,
    source.acknowledgement.revision,
  );
}

/**
 * Invalidates cleanup plans involving a later source or destination observation.
 *
 * @param state - Current authoritative device state.
 * @param path - Path with newer lifecycle evidence.
 * @param exceptRenameId - Current plan identity exempt from self-invalidation.
 * @returns State retaining stale plans as explicit invalidated work.
 */
export function invalidateRenamePlansForPath(
  state: MirrorDeviceState,
  path: NotePath,
  exceptRenameId?: MirrorOperationId,
): MirrorDeviceState {
  return {
    ...state,
    paths: state.paths.map((entry) =>
      invalidatedByLifecyclePath(entry, path, exceptRenameId),
    ),
  };
}

/**
 * Records the exact persisted destination ACK that makes source cleanup admissible.
 *
 * @param state - Current authoritative device state.
 * @param sourcePath - Source holding the rename plan.
 * @param renameId - Exact plan identity.
 * @param destinationRevision - Durable destination live generation.
 * @returns Updated plan, or no transition after any dependency drift.
 */
export function recordRenameDestinationAcknowledgement(
  state: MirrorDeviceState,
  sourcePath: NotePath,
  renameId: MirrorOperationId,
  destinationRevision: ApplicationRevision,
): MirrorDeviceState | undefined {
  const source = findPath(state, sourcePath);
  if (
    source?.desired.kind !== MIRROR_DESIRED_STATE_KIND.renameDeferred ||
    source.desired.renameId !== renameId ||
    source.desired.phase !== MIRROR_RENAME_PHASE.destinationRequired ||
    source.desired.destinationPath === null
  ) {
    return undefined;
  }
  const destination = findPath(state, source.desired.destinationPath);
  if (
    destination?.acknowledgement.kind !== MIRROR_ACKNOWLEDGEMENT_KIND.live ||
    destination.acknowledgement.revision !== destinationRevision ||
    destination.unresolvedMutation !== null ||
    destination.desired.kind !== MIRROR_DESIRED_STATE_KIND.none
  ) {
    return undefined;
  }
  return updatePath(state, sourcePath, (entry) => ({
    ...entry,
    desired: {
      ...source.desired,
      phase: MIRROR_RENAME_PHASE.sourceCleanupRequired,
      destinationAcknowledgedRevision: destinationRevision,
    },
  }));
}

/**
 * Marks one stale rename plan as visible deferred cleanup without deleting it.
 *
 * @param state - Current authoritative device state.
 * @param sourcePath - Source holding the plan.
 * @param renameId - Exact plan identity.
 * @returns Updated state, or no transition when the plan changed.
 */
export function invalidateRenamePlan(
  state: MirrorDeviceState,
  sourcePath: NotePath,
  renameId: MirrorOperationId,
): MirrorDeviceState | undefined {
  return updatePath(state, sourcePath, (entry) => {
    if (
      entry.desired.kind !== MIRROR_DESIRED_STATE_KIND.renameDeferred ||
      entry.desired.renameId !== renameId
    ) {
      return undefined;
    }
    return {
      ...entry,
      desired: { ...entry.desired, phase: MIRROR_RENAME_PHASE.invalidated },
      blockedReason: MIRROR_PATH_BLOCK_REASON.renameDeferred,
    };
  });
}

/**
 * Creates one fresh deletion mutation from current live ACK and durable evidence.
 *
 * @param state - Current authoritative device state.
 * @param path - Source path to tombstone.
 * @param evidenceIdentity - Exact persisted delete or rename authority.
 * @param operationId - Fresh deletion operation identity.
 * @returns Updated state, or no transition after authority drift.
 */
export function persistTombstoneIntent(
  state: MirrorDeviceState,
  path: NotePath,
  evidenceIdentity: MirrorOperationId,
  operationId: MirrorOperationId,
): MirrorDeviceState | undefined {
  if (state.lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.active)
    return undefined;
  const associationId = state.lifecycle.associationId;
  return updatePath(state, path, (entry) => {
    if (
      entry.acknowledgement.kind !== MIRROR_ACKNOWLEDGEMENT_KIND.live ||
      entry.unresolvedMutation !== null ||
      !evidenceMatches(entry, evidenceIdentity)
    ) {
      return undefined;
    }
    const intent: UnresolvedTombstoneMutationIntent = {
      action: MUTATION_ACTION.tombstone,
      associationId,
      writerId: state.deviceId,
      operationId,
      path,
      precondition: {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
        revision: entry.acknowledgement.revision,
      },
      mutationAttempts: 0,
      evidenceAttempts: 0,
    };
    return {
      ...entry,
      unresolvedMutation: {
        intent,
        phase: MIRROR_MUTATION_PHASE.recoveryPreparation,
      },
    };
  });
}

/** @returns Identity of currently durable destructive evidence, when present. */
export function destructiveEvidenceIdentity(
  entry: MirrorPathState,
): MirrorOperationId | undefined {
  switch (entry.desired.kind) {
    case MIRROR_DESIRED_STATE_KIND.runtimeDelete:
      return entry.desired.evidenceId;
    case MIRROR_DESIRED_STATE_KIND.renameDeferred:
      return entry.desired.renameId;
    case MIRROR_DESIRED_STATE_KIND.none:
    case MIRROR_DESIRED_STATE_KIND.dirtyPresent:
      return undefined;
  }
}

/** @returns Whether the path still holds the exact observed deletion authority. */
function evidenceMatches(
  entry: MirrorPathState,
  evidenceIdentity: MirrorOperationId,
): boolean {
  return destructiveEvidenceIdentity(entry) === evidenceIdentity;
}

/**
 * Replaces only the known source entry with one fully bound rename plan.
 *
 * @param state - Current authoritative device state.
 * @param input - Exact rename evidence.
 * @param phase - Initial durable rename phase.
 * @param paths - Ledger with dependency invalidations and destination discovery.
 * @param associationId - Active association captured with the evidence.
 * @param sourceRevision - Exact source generation captured with the evidence.
 * @returns State containing the source plan.
 */
function replaceSourcePlan(
  state: MirrorDeviceState,
  input: RuntimeRenameEvidenceInput,
  phase: RenameDeferredMirrorState["phase"],
  paths: readonly MirrorPathState[],
  associationId: MirrorAssociationId,
  sourceRevision: ApplicationRevision,
): MirrorDeviceState {
  const plan: RenameDeferredMirrorState = {
    kind: MIRROR_DESIRED_STATE_KIND.renameDeferred,
    observationGeneration: input.sourceObservationGeneration,
    renameId: input.renameId,
    associationId,
    sourcePath: input.sourcePath,
    destinationPath: input.destinationPath,
    sourceExpectedRevision: sourceRevision,
    destinationObservationGeneration: input.destinationObservationGeneration,
    destinationAcknowledgedRevision: null,
    graceDeadlineMilliseconds: input.graceDeadlineMilliseconds,
    phase,
  };
  return {
    ...state,
    paths: paths.map((entry) =>
      entry.path === input.sourcePath
        ? {
            ...entry,
            desired: plan,
            blockedReason:
              phase === MIRROR_RENAME_PHASE.invalidated
                ? MIRROR_PATH_BLOCK_REASON.renameDeferred
                : null,
          }
        : entry,
    ),
  };
}

/** @returns The required destination generation for an eligible rename. */
function requireDestinationGeneration(
  input: RuntimeRenameEvidenceInput,
): number {
  if (input.destinationObservationGeneration === null) {
    throw new Error(
      "Eligible rename destination requires an observation generation.",
    );
  }
  return input.destinationObservationGeneration;
}

/**
 * Invalidates a prior plan whose source or destination received newer evidence.
 *
 * @param entry - Candidate source entry holding a plan.
 * @param path - Path with newer lifecycle evidence.
 * @param exceptRenameId - Plan exempt from self-invalidation.
 * @returns Original entry or its explicitly invalidated replacement.
 */
function invalidatedByLifecyclePath(
  entry: MirrorPathState,
  path: NotePath,
  exceptRenameId?: MirrorOperationId,
): MirrorPathState {
  if (
    entry.desired.kind !== MIRROR_DESIRED_STATE_KIND.renameDeferred ||
    entry.desired.renameId === exceptRenameId ||
    (entry.desired.sourcePath !== path &&
      entry.desired.destinationPath !== path)
  ) {
    return entry;
  }
  return {
    ...entry,
    desired: { ...entry.desired, phase: MIRROR_RENAME_PHASE.invalidated },
    blockedReason: MIRROR_PATH_BLOCK_REASON.renameDeferred,
  };
}

/** @returns The exact durable path entry, when tracked. */
function findPath(
  state: MirrorDeviceState,
  path: NotePath,
): MirrorPathState | undefined {
  return state.paths.find((entry) => entry.path === path);
}

/**
 * Applies one exact path transition without mutating the existing ledger.
 *
 * @param state - Current authoritative device state.
 * @param path - Exact entry to update.
 * @param update - Pure path transition.
 * @returns Updated state, or no transition when the path/update is unavailable.
 */
function updatePath(
  state: MirrorDeviceState,
  path: NotePath,
  update: (entry: MirrorPathState) => MirrorPathState | undefined,
): MirrorDeviceState | undefined {
  const index = state.paths.findIndex((entry) => entry.path === path);
  const current = state.paths[index];
  if (index < 0 || current === undefined) return undefined;
  const updated = update(current);
  if (updated === undefined) return undefined;
  return {
    ...state,
    paths: state.paths.map((entry, entryIndex) =>
      entryIndex === index ? updated : entry,
    ),
  };
}
