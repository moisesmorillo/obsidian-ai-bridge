import type {
  MirrorAssociationId,
  MirrorWriterId,
} from "@core/mirror/mirror.types";
import {
  HANDOFF_ALIGNMENT_KIND,
  MAX_MIRROR_TRACKED_PATHS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_GLOBAL_BLOCK_REASON,
} from "@core/mirror/mirror-state.constants";
import type {
  HandoffAlignmentInvalidation,
  HandoffAlignmentSnapshot,
  HandoffLocalObservation,
  HandoffPayload,
  HandoffRecord,
  MirrorDeviceState,
  MirrorOrigin,
  MirrorPathState,
  StagedHandoff,
  StagedHandoffEntry,
  TransferableAcknowledgement,
} from "@core/mirror/mirror-state.types";
/** Closed refusal reasons for designation/readiness and explicit activation. */
export const WRITER_ACTIVATION_FAILURE = {
  missingLocalState: "missing-local-state",
  notExplicit: "not-explicit",
  secretMissing: "secret-missing",
  associationMismatch: "association-mismatch",
  designationMismatch: "designation-mismatch",
  originMismatch: "origin-mismatch",
  globallyBlocked: "globally-blocked",
  incompatibleLifecycle: "incompatible-lifecycle",
  associationNotProvenEmpty: "association-not-proven-empty",
  handoffNotAligned: "handoff-not-aligned",
} as const;

/** Typed activation/readiness refusal without secret or remote error details. */
export type WriterActivationFailure =
  (typeof WRITER_ACTIVATION_FAILURE)[keyof typeof WRITER_ACTIVATION_FAILURE];

/** Closed export refusal reasons proving meaningful handoff quiescence. */
export const HANDOFF_EXPORT_FAILURE = {
  notDraining: "not-draining",
  notDrained: "not-drained",
  globallyBlocked: "globally-blocked",
  unresolvedMutation: "unresolved-mutation",
  unsettledDesiredState: "unsettled-desired-state",
  blockedPath: "blocked-path",
} as const;

/** Typed handoff export refusal. */
export type HandoffExportFailure =
  (typeof HANDOFF_EXPORT_FAILURE)[keyof typeof HANDOFF_EXPORT_FAILURE];

/** Closed staging refusal reasons for imported handoff metadata. */
export const HANDOFF_IMPORT_FAILURE = {
  associationMismatch: "association-mismatch",
  originMismatch: "origin-mismatch",
  incompatibleLifecycle: "incompatible-lifecycle",
  existingLocalState: "existing-local-state",
  invalidRecord: "invalid-record",
} as const;

/** Typed handoff import refusal. */
export type HandoffImportFailure =
  (typeof HANDOFF_IMPORT_FAILURE)[keyof typeof HANDOFF_IMPORT_FAILURE];

/** Remote identity/configuration evidence used only for local writer validation. */
export interface WriterDesignationEvidence {
  readonly origin: MirrorOrigin;
  readonly associationId: MirrorAssociationId;
  readonly designatedWriterId: MirrorWriterId;
  readonly secretAvailable: boolean;
}

/** Explicit request to activate a newly provisioned isolated empty association. */
export interface IsolatedAssociationActivationRequest
  extends WriterDesignationEvidence {
  readonly explicitWholeMirrorConsent: boolean;
  readonly isolatedEmptyAssociationConfirmed: boolean;
}

/** Explicit request to activate an aligned imported handoff baseline. */
export interface HandoffActivationRequest extends WriterDesignationEvidence {
  readonly explicitWholeMirrorConsent: boolean;
}

/** @returns Disabled state for a newly generated device identity; no activation is inferred. */
export function createDisabledMirrorState(
  deviceId: MirrorWriterId,
): MirrorDeviceState {
  return {
    deviceId,
    lifecycle: { kind: MIRROR_DEVICE_LIFECYCLE_KIND.disabled },
    globalBlockReason: null,
    paths: [],
    stagedHandoff: null,
  };
}

/**
 * Validates whether a previously active local writer remains ready.
 *
 * Synced preferences alone cannot pass because valid device-local active state is
 * mandatory. This is an operational safety gate, not an authorization boundary.
 *
 * @param state - Validated device-local state, or missing state after loss/new install.
 * @param evidence - Current local configuration and remote designation evidence.
 * @returns Ready state or one sanitized refusal.
 */
export function evaluateWriterReadiness(
  state: MirrorDeviceState | null,
  evidence: WriterDesignationEvidence,
):
  | { readonly kind: "ready" }
  | {
      readonly kind: "not-ready";
      readonly reason: WriterActivationFailure;
    } {
  if (state === null)
    return notReady(WRITER_ACTIVATION_FAILURE.missingLocalState);
  if (state.globalBlockReason !== null) {
    return notReady(WRITER_ACTIVATION_FAILURE.globallyBlocked);
  }
  if (state.lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.active) {
    return notReady(WRITER_ACTIVATION_FAILURE.incompatibleLifecycle);
  }
  if (!evidence.secretAvailable) {
    return notReady(WRITER_ACTIVATION_FAILURE.secretMissing);
  }
  if (state.lifecycle.origin !== evidence.origin) {
    return notReady(WRITER_ACTIVATION_FAILURE.originMismatch);
  }
  if (state.lifecycle.associationId !== evidence.associationId) {
    return notReady(WRITER_ACTIVATION_FAILURE.associationMismatch);
  }
  if (state.deviceId !== evidence.designatedWriterId) {
    return notReady(WRITER_ACTIVATION_FAILURE.designationMismatch);
  }
  return { kind: "ready" };
}

/**
 * Activates only a newly provisioned isolated empty association.
 *
 * This path cannot adopt an existing association after ledger loss; same-association
 * transfer must use a staged handoff record instead.
 *
 * @param state - Existing disabled device-local state.
 * @param request - Explicit consent, empty-association proof, and designation evidence.
 * @returns Activated state or a typed refusal.
 */
export function activateIsolatedAssociation(
  state: MirrorDeviceState,
  request: IsolatedAssociationActivationRequest,
):
  | { readonly kind: "activated"; readonly state: MirrorDeviceState }
  | {
      readonly kind: "rejected";
      readonly reason: WriterActivationFailure;
    } {
  const commonFailure = activationEvidenceFailure(state, request);
  if (commonFailure !== undefined) return rejected(commonFailure);
  if (state.lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.disabled) {
    return rejected(WRITER_ACTIVATION_FAILURE.incompatibleLifecycle);
  }
  if (state.paths.length > 0 || state.stagedHandoff !== null) {
    return rejected(WRITER_ACTIVATION_FAILURE.incompatibleLifecycle);
  }
  if (!request.isolatedEmptyAssociationConfirmed) {
    return rejected(WRITER_ACTIVATION_FAILURE.associationNotProvenEmpty);
  }
  return {
    kind: "activated",
    state: {
      ...state,
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
        associationId: request.associationId,
        origin: request.origin,
      },
    },
  };
}

/**
 * Durably closes new intake and starts draining an active writer for handoff.
 *
 * @param state - Current device state.
 * @returns Draining state, or `undefined` when this device is not active.
 */
export function pauseForHandoff(
  state: MirrorDeviceState,
): MirrorDeviceState | undefined {
  if (state.lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.active) {
    return undefined;
  }
  return {
    ...state,
    lifecycle: {
      kind: MIRROR_DEVICE_LIFECYCLE_KIND.handoffDraining,
      associationId: state.lifecycle.associationId,
      origin: state.lifecycle.origin,
    },
  };
}

/**
 * Marks handoff drained only after the durable ledger is observably quiescent.
 *
 * A pause, aborted request, timeout, or state read cannot call this transition
 * implicitly. The returned state must itself be persisted before export is allowed.
 *
 * @param state - Durable draining state after pending work processing.
 * @returns Drained state or the first typed quiescence refusal.
 */
export function markHandoffDrained(
  state: MirrorDeviceState,
):
  | { readonly kind: "drained"; readonly state: MirrorDeviceState }
  | { readonly kind: "rejected"; readonly reason: HandoffExportFailure } {
  if (state.lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.handoffDraining) {
    return { kind: "rejected", reason: HANDOFF_EXPORT_FAILURE.notDraining };
  }
  const failure = handoffQuiescenceFailure(state);
  if (failure !== undefined) return { kind: "rejected", reason: failure };
  return {
    kind: "drained",
    state: {
      ...state,
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.handoffDrained,
        associationId: state.lifecycle.associationId,
        origin: state.lifecycle.origin,
      },
    },
  };
}

/**
 * Produces content-free export metadata only after durable quiescence checks.
 *
 * @param state - Durably drained old-writer state.
 * @returns Checksum-ready payload or the first meaningful quiescence refusal.
 */
export function prepareHandoffExport(state: MirrorDeviceState):
  | { readonly kind: "prepared"; readonly payload: HandoffPayload }
  | {
      readonly kind: "rejected";
      readonly reason: HandoffExportFailure;
    } {
  if (state.lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.handoffDrained) {
    return { kind: "rejected", reason: HANDOFF_EXPORT_FAILURE.notDrained };
  }
  const failure = handoffQuiescenceFailure(state);
  if (failure !== undefined) return { kind: "rejected", reason: failure };
  return {
    kind: "prepared",
    payload: {
      associationId: state.lifecycle.associationId,
      origin: state.lifecycle.origin,
      entries: state.paths.flatMap((entry) => {
        if (
          entry.acknowledgement.kind ===
          MIRROR_ACKNOWLEDGEMENT_KIND.unassociated
        ) {
          return [];
        }
        return [{ path: entry.path, acknowledgement: entry.acknowledgement }];
      }),
    },
  };
}

/**
 * Stages a verified handoff without overwriting active or pre-existing local state.
 *
 * @param state - Disabled new-device state with no local ledger.
 * @param record - Strictly decoded and checksum-verified handoff record.
 * @param expected - Locally configured association and origin.
 * @returns Staged non-authoritative baseline or a typed refusal.
 */
export function stageHandoffImport(
  state: MirrorDeviceState,
  record: HandoffRecord,
  expected: Pick<WriterDesignationEvidence, "associationId" | "origin">,
):
  | { readonly kind: "staged"; readonly state: MirrorDeviceState }
  | {
      readonly kind: "rejected";
      readonly reason: HandoffImportFailure;
    } {
  if (
    record.entries.length > MAX_MIRROR_TRACKED_PATHS ||
    new Set(record.entries.map((entry) => entry.path)).size !==
      record.entries.length ||
    hasDuplicateRecoveryIds(record.entries)
  ) {
    return { kind: "rejected", reason: HANDOFF_IMPORT_FAILURE.invalidRecord };
  }
  if (record.associationId !== expected.associationId) {
    return {
      kind: "rejected",
      reason: HANDOFF_IMPORT_FAILURE.associationMismatch,
    };
  }
  if (record.origin !== expected.origin) {
    return { kind: "rejected", reason: HANDOFF_IMPORT_FAILURE.originMismatch };
  }
  if (state.lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.disabled) {
    return {
      kind: "rejected",
      reason: HANDOFF_IMPORT_FAILURE.incompatibleLifecycle,
    };
  }
  if (state.paths.length > 0 || state.stagedHandoff !== null) {
    return {
      kind: "rejected",
      reason: HANDOFF_IMPORT_FAILURE.existingLocalState,
    };
  }
  return {
    kind: "staged",
    state: {
      ...state,
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged,
        associationId: record.associationId,
        origin: record.origin,
      },
      stagedHandoff: {
        associationId: record.associationId,
        origin: record.origin,
        checksum: record.checksum,
        entries: record.entries.map((entry) => ({
          ...entry,
          localAlignment: HANDOFF_ALIGNMENT_KIND.pending,
          remoteVerification: HANDOFF_ALIGNMENT_KIND.pending,
          observationGeneration: 0,
        })),
      },
    },
  };
}

/**
 * Applies one complete local-inventory and remote-verification handoff snapshot.
 *
 * Every staged path must occur exactly once in both evidence collections. The
 * transition validates and indexes the collections once, rejects stale local
 * generations atomically, and produces one state for one owner save.
 *
 * @param state - Current staged state.
 * @param snapshot - Complete local and remote evidence for the staged baseline.
 * @returns Updated staged state, or `undefined` when any evidence is incomplete,
 * duplicated, stale, or incompatible with the transferred acknowledgement kind.
 */
export function alignStagedHandoff(
  state: MirrorDeviceState,
  snapshot: HandoffAlignmentSnapshot,
): MirrorDeviceState | undefined {
  const staged = requireStagedHandoff(state);
  if (staged === undefined) return undefined;
  if (
    snapshot.local.length !== staged.entries.length ||
    snapshot.remote.length !== staged.entries.length
  ) {
    return undefined;
  }
  const localByPath = new Map(
    snapshot.local.map((observation) => [observation.path, observation]),
  );
  const remoteByPath = new Map(
    snapshot.remote.map((observation) => [observation.path, observation]),
  );
  if (
    localByPath.size !== snapshot.local.length ||
    remoteByPath.size !== snapshot.remote.length
  ) {
    return undefined;
  }
  const entries: StagedHandoffEntry[] = [];
  let hasMismatch = false;
  for (const entry of staged.entries) {
    const local = localByPath.get(entry.path);
    const remote = remoteByPath.get(entry.path);
    if (
      local === undefined ||
      remote === undefined ||
      local.kind !== entry.acknowledgement.kind ||
      !isCurrentObservationGeneration(entry, local.observationGeneration)
    ) {
      return undefined;
    }
    const localAlignment = localObservationMatches(entry, local)
      ? HANDOFF_ALIGNMENT_KIND.matched
      : HANDOFF_ALIGNMENT_KIND.mismatch;
    const remoteVerification = acknowledgementsEqual(
      entry.acknowledgement,
      remote.acknowledgement,
    )
      ? HANDOFF_ALIGNMENT_KIND.matched
      : HANDOFF_ALIGNMENT_KIND.mismatch;
    if (
      localAlignment === HANDOFF_ALIGNMENT_KIND.mismatch ||
      remoteVerification === HANDOFF_ALIGNMENT_KIND.mismatch
    ) {
      hasMismatch = true;
    }
    entries.push({
      ...entry,
      localAlignment,
      remoteVerification,
      observationGeneration: local.observationGeneration,
    });
  }
  return updatedStagedState(state, staged, entries, hasMismatch);
}

/**
 * Invalidates selected staged alignments from one collapsed local event batch.
 *
 * @param state - Current staged state.
 * @param invalidations - Unique paths with strictly newer local generations.
 * @returns Updated state for one owner save, or `undefined` when the batch is
 * empty, duplicated, stale, unknown, or incompatible with staged lifecycle.
 */
export function invalidateHandoffAlignments(
  state: MirrorDeviceState,
  invalidations: readonly HandoffAlignmentInvalidation[],
): MirrorDeviceState | undefined {
  const staged = requireStagedHandoff(state);
  if (
    staged === undefined ||
    invalidations.length === 0 ||
    invalidations.length > staged.entries.length
  ) {
    return undefined;
  }
  const generationByPath = new Map(
    invalidations.map((entry) => [entry.path, entry.observationGeneration]),
  );
  if (generationByPath.size !== invalidations.length) return undefined;
  const stagedByPath = new Map(
    staged.entries.map((entry) => [entry.path, entry]),
  );
  for (const [path, observationGeneration] of generationByPath) {
    const current = stagedByPath.get(path);
    if (
      current === undefined ||
      !Number.isSafeInteger(observationGeneration) ||
      observationGeneration <= current.observationGeneration
    ) {
      return undefined;
    }
  }
  let hasMismatch = false;
  const entries = staged.entries.map((entry) => {
    const observationGeneration = generationByPath.get(entry.path);
    const updated =
      observationGeneration === undefined
        ? entry
        : {
            ...entry,
            localAlignment: HANDOFF_ALIGNMENT_KIND.pending,
            observationGeneration,
          };
    if (
      updated.localAlignment === HANDOFF_ALIGNMENT_KIND.mismatch ||
      updated.remoteVerification === HANDOFF_ALIGNMENT_KIND.mismatch
    ) {
      hasMismatch = true;
    }
    return updated;
  });
  return updatedStagedState(state, staged, entries, hasMismatch);
}

/**
 * Activates a staged baseline only after every local observation and future remote
 * verification aligned, while current designation/secret evidence still matches.
 *
 * @param state - Device with a staged imported baseline.
 * @param request - Explicit consent and current designation evidence.
 * @returns Activated writer ledger or a typed refusal.
 */
export function activateStagedHandoff(
  state: MirrorDeviceState,
  request: HandoffActivationRequest,
):
  | { readonly kind: "activated"; readonly state: MirrorDeviceState }
  | {
      readonly kind: "rejected";
      readonly reason: WriterActivationFailure;
    } {
  const commonFailure = activationEvidenceFailure(state, request);
  if (commonFailure !== undefined) return rejected(commonFailure);
  if (
    state.lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged ||
    state.stagedHandoff === null
  ) {
    return rejected(WRITER_ACTIVATION_FAILURE.incompatibleLifecycle);
  }
  if (
    state.lifecycle.associationId !== request.associationId ||
    state.stagedHandoff.associationId !== request.associationId
  ) {
    return rejected(WRITER_ACTIVATION_FAILURE.associationMismatch);
  }
  if (
    state.lifecycle.origin !== request.origin ||
    state.stagedHandoff.origin !== request.origin
  ) {
    return rejected(WRITER_ACTIVATION_FAILURE.originMismatch);
  }
  if (
    state.stagedHandoff.entries.some(
      (entry) =>
        entry.localAlignment !== HANDOFF_ALIGNMENT_KIND.matched ||
        entry.remoteVerification !== HANDOFF_ALIGNMENT_KIND.matched,
    )
  ) {
    return rejected(WRITER_ACTIVATION_FAILURE.handoffNotAligned);
  }
  return {
    kind: "activated",
    state: {
      ...state,
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
        associationId: request.associationId,
        origin: request.origin,
      },
      paths: state.stagedHandoff.entries.map(handoffEntryToPathState),
      stagedHandoff: null,
    },
  };
}

/** @returns Whether the current durable state is allowed to dispatch a mutation. */
export function isDurableMutationAdmissionAllowed(
  state: MirrorDeviceState,
): boolean {
  return (
    state.lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.active &&
    state.globalBlockReason === null
  );
}

function activationEvidenceFailure(
  state: MirrorDeviceState,
  request: HandoffActivationRequest,
): WriterActivationFailure | undefined {
  if (state.globalBlockReason !== null) {
    return WRITER_ACTIVATION_FAILURE.globallyBlocked;
  }
  if (!request.explicitWholeMirrorConsent)
    return WRITER_ACTIVATION_FAILURE.notExplicit;
  if (!request.secretAvailable) return WRITER_ACTIVATION_FAILURE.secretMissing;
  if (state.deviceId !== request.designatedWriterId) {
    return WRITER_ACTIVATION_FAILURE.designationMismatch;
  }
  return undefined;
}

function handoffQuiescenceFailure(
  state: MirrorDeviceState,
): HandoffExportFailure | undefined {
  if (state.globalBlockReason !== null) {
    return HANDOFF_EXPORT_FAILURE.globallyBlocked;
  }
  for (const pathState of state.paths) {
    if (pathState.unresolvedMutation !== null) {
      return HANDOFF_EXPORT_FAILURE.unresolvedMutation;
    }
    if (pathState.desired.kind !== MIRROR_DESIRED_STATE_KIND.none) {
      return HANDOFF_EXPORT_FAILURE.unsettledDesiredState;
    }
    if (pathState.blockedReason !== null) {
      return HANDOFF_EXPORT_FAILURE.blockedPath;
    }
  }
  return undefined;
}

function hasDuplicateRecoveryIds(
  entries: readonly {
    readonly acknowledgement: TransferableAcknowledgement;
  }[],
): boolean {
  const recoveryIds = entries.flatMap((entry) =>
    entry.acknowledgement.kind === MIRROR_ACKNOWLEDGEMENT_KIND.tombstone
      ? [entry.acknowledgement.recoveryId]
      : [],
  );
  return new Set(recoveryIds).size !== recoveryIds.length;
}

function isCurrentObservationGeneration(
  entry: StagedHandoffEntry,
  observationGeneration: number,
): boolean {
  return (
    Number.isSafeInteger(observationGeneration) &&
    observationGeneration >= 0 &&
    observationGeneration >= entry.observationGeneration
  );
}

function handoffEntryToPathState(entry: StagedHandoffEntry): MirrorPathState {
  return {
    path: entry.path,
    acknowledgement: entry.acknowledgement,
    unresolvedMutation: null,
    desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
    blockedReason: null,
  };
}

function requireStagedHandoff(
  state: MirrorDeviceState,
): StagedHandoff | undefined {
  if (
    state.lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged ||
    state.stagedHandoff === null
  ) {
    return undefined;
  }
  return state.stagedHandoff;
}

function localObservationMatches(
  entry: StagedHandoffEntry,
  observation: HandoffLocalObservation,
): boolean {
  if (entry.acknowledgement.kind === MIRROR_ACKNOWLEDGEMENT_KIND.live) {
    return (
      observation.kind === MIRROR_ACKNOWLEDGEMENT_KIND.live &&
      entry.acknowledgement.contentSha256 === observation.contentSha256
    );
  }
  return (
    observation.kind === MIRROR_ACKNOWLEDGEMENT_KIND.tombstone &&
    observation.isAbsent
  );
}

function updatedStagedState(
  state: MirrorDeviceState,
  staged: StagedHandoff,
  entries: readonly StagedHandoffEntry[],
  hasMismatch: boolean,
): MirrorDeviceState {
  return {
    ...state,
    globalBlockReason:
      state.globalBlockReason !== null &&
      state.globalBlockReason !== MIRROR_GLOBAL_BLOCK_REASON.handoffMismatch
        ? state.globalBlockReason
        : hasMismatch
          ? MIRROR_GLOBAL_BLOCK_REASON.handoffMismatch
          : null,
    stagedHandoff: { ...staged, entries },
  };
}

function acknowledgementsEqual(
  expected: TransferableAcknowledgement,
  observed: TransferableAcknowledgement | null,
): boolean {
  if (observed === null || expected.kind !== observed.kind) return false;
  if (expected.revision !== observed.revision) return false;
  if (expected.kind === MIRROR_ACKNOWLEDGEMENT_KIND.live) {
    return (
      observed.kind === MIRROR_ACKNOWLEDGEMENT_KIND.live &&
      expected.contentSha256 === observed.contentSha256
    );
  }
  return (
    observed.kind === MIRROR_ACKNOWLEDGEMENT_KIND.tombstone &&
    expected.recoveryId === observed.recoveryId
  );
}

function notReady(reason: WriterActivationFailure): {
  readonly kind: "not-ready";
  readonly reason: WriterActivationFailure;
} {
  return { kind: "not-ready", reason };
}

function rejected(reason: WriterActivationFailure): {
  readonly kind: "rejected";
  readonly reason: WriterActivationFailure;
} {
  return { kind: "rejected", reason };
}
