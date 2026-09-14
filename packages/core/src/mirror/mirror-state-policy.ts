import type {
  ContentSha256,
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
  MIRROR_PAUSE_REASON,
} from "@core/mirror/mirror-state.constants";
import type {
  HandoffPayload,
  HandoffRecord,
  MirrorDeviceState,
  MirrorOrigin,
  MirrorPathState,
  StagedHandoffEntry,
  TransferableAcknowledgement,
} from "@core/mirror/mirror-state.types";
import type { NotePath } from "@core/note-path/note-path.types";

/** Closed refusal reasons for designation/readiness and explicit activation. */
export const WRITER_ACTIVATION_FAILURE = {
  missingLocalState: "missing-local-state",
  notExplicit: "not-explicit",
  secretMissing: "secret-missing",
  associationMismatch: "association-mismatch",
  designationMismatch: "designation-mismatch",
  originMismatch: "origin-mismatch",
  incompatibleLifecycle: "incompatible-lifecycle",
  associationNotProvenEmpty: "association-not-proven-empty",
  handoffNotAligned: "handoff-not-aligned",
} as const;

/** Typed activation/readiness refusal without secret or remote error details. */
export type WriterActivationFailure =
  (typeof WRITER_ACTIVATION_FAILURE)[keyof typeof WRITER_ACTIVATION_FAILURE];

/** Closed export refusal reasons proving meaningful handoff quiescence. */
export const HANDOFF_EXPORT_FAILURE = {
  notPausedForHandoff: "not-paused-for-handoff",
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
      globalBlockReason: null,
    },
  };
}

/**
 * Durably pauses an active writer for handoff without dropping path evidence.
 *
 * @param state - Current device state.
 * @returns Paused state, or `undefined` when this device is not active.
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
      kind: MIRROR_DEVICE_LIFECYCLE_KIND.paused,
      associationId: state.lifecycle.associationId,
      origin: state.lifecycle.origin,
      reason: MIRROR_PAUSE_REASON.handoff,
    },
  };
}

/**
 * Produces content-free export metadata only after durable quiescence checks.
 *
 * @param state - Paused old-writer state.
 * @returns Checksum-ready payload or the first meaningful quiescence refusal.
 */
export function prepareHandoffExport(state: MirrorDeviceState):
  | { readonly kind: "prepared"; readonly payload: HandoffPayload }
  | {
      readonly kind: "rejected";
      readonly reason: HandoffExportFailure;
    } {
  if (
    state.lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.paused ||
    state.lifecycle.reason !== MIRROR_PAUSE_REASON.handoff
  ) {
    return {
      kind: "rejected",
      reason: HANDOFF_EXPORT_FAILURE.notPausedForHandoff,
    };
  }
  if (state.globalBlockReason !== null) {
    return { kind: "rejected", reason: HANDOFF_EXPORT_FAILURE.globallyBlocked };
  }
  for (const pathState of state.paths) {
    if (pathState.unresolvedMutation !== null) {
      return {
        kind: "rejected",
        reason: HANDOFF_EXPORT_FAILURE.unresolvedMutation,
      };
    }
    if (pathState.desired.kind !== MIRROR_DESIRED_STATE_KIND.none) {
      return {
        kind: "rejected",
        reason: HANDOFF_EXPORT_FAILURE.unsettledDesiredState,
      };
    }
    if (pathState.blockedReason !== null) {
      return { kind: "rejected", reason: HANDOFF_EXPORT_FAILURE.blockedPath };
    }
  }
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
      record.entries.length
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
      globalBlockReason: null,
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
 * Records future remote-state verification without performing a network request.
 *
 * @param state - Current staged state.
 * @param path - Transferred path whose remote generation was inspected.
 * @param observed - Strictly validated remote live/tombstone metadata, or null for mismatch.
 * @returns Updated staged state, or `undefined` for an incompatible/path request.
 */
export function verifyHandoffRemotePath(
  state: MirrorDeviceState,
  path: NotePath,
  observed: TransferableAcknowledgement | null,
): MirrorDeviceState | undefined {
  return updateStagedEntry(state, path, (entry) => ({
    ...entry,
    remoteVerification: acknowledgementsEqual(entry.acknowledgement, observed)
      ? HANDOFF_ALIGNMENT_KIND.matched
      : HANDOFF_ALIGNMENT_KIND.mismatch,
  }));
}

/**
 * Records a saved-content observation for one transferred live acknowledgement.
 *
 * Tombstones never accept content observations. A mismatch remains staged and
 * blocked; it never turns stale local text into mutation authority.
 *
 * @param state - Current staged state.
 * @param path - Transferred path being checked.
 * @param contentSha256 - Digest of the current stable saved content.
 * @param observationGeneration - Local generation captured around the saved read.
 * @returns Updated staged state, or `undefined` for an incompatible/path-kind request.
 */
export function alignHandoffLivePath(
  state: MirrorDeviceState,
  path: NotePath,
  contentSha256: ContentSha256,
  observationGeneration: number,
): MirrorDeviceState | undefined {
  return updateStagedEntry(state, path, (entry) => {
    if (entry.acknowledgement.kind !== MIRROR_ACKNOWLEDGEMENT_KIND.live) {
      return undefined;
    }
    return {
      ...entry,
      localAlignment:
        entry.acknowledgement.contentSha256 === contentSha256
          ? HANDOFF_ALIGNMENT_KIND.matched
          : HANDOFF_ALIGNMENT_KIND.mismatch,
      observationGeneration,
    };
  });
}

/**
 * Records an exact local-absence observation for one transferred tombstone.
 *
 * @param state - Current staged state.
 * @param path - Transferred tombstoned path being checked.
 * @param isAbsent - Whether the exact path was verified absent after host checks.
 * @param observationGeneration - Local event generation surrounding verification.
 * @returns Updated staged state, or `undefined` for an incompatible/path-kind request.
 */
export function alignHandoffTombstonePath(
  state: MirrorDeviceState,
  path: NotePath,
  isAbsent: boolean,
  observationGeneration: number,
): MirrorDeviceState | undefined {
  return updateStagedEntry(state, path, (entry) => {
    if (entry.acknowledgement.kind !== MIRROR_ACKNOWLEDGEMENT_KIND.tombstone) {
      return undefined;
    }
    return {
      ...entry,
      localAlignment: isAbsent
        ? HANDOFF_ALIGNMENT_KIND.matched
        : HANDOFF_ALIGNMENT_KIND.mismatch,
      observationGeneration,
    };
  });
}

/**
 * Invalidates prior alignment when a newer local observation arrives.
 *
 * @param state - Current staged state.
 * @param path - Changed transferred path.
 * @param observationGeneration - Strictly newer local event generation.
 * @returns Updated state, or `undefined` when the path/generation is incompatible.
 */
export function invalidateHandoffAlignment(
  state: MirrorDeviceState,
  path: NotePath,
  observationGeneration: number,
): MirrorDeviceState | undefined {
  return updateStagedEntry(state, path, (entry) => {
    if (observationGeneration <= entry.observationGeneration) return undefined;
    return {
      ...entry,
      localAlignment: HANDOFF_ALIGNMENT_KIND.pending,
      observationGeneration,
    };
  });
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
      globalBlockReason: null,
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
  if (!request.explicitWholeMirrorConsent)
    return WRITER_ACTIVATION_FAILURE.notExplicit;
  if (!request.secretAvailable) return WRITER_ACTIVATION_FAILURE.secretMissing;
  if (state.deviceId !== request.designatedWriterId) {
    return WRITER_ACTIVATION_FAILURE.designationMismatch;
  }
  return undefined;
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

function updateStagedEntry(
  state: MirrorDeviceState,
  path: NotePath,
  update: (entry: StagedHandoffEntry) => StagedHandoffEntry | undefined,
): MirrorDeviceState | undefined {
  if (
    state.lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged ||
    state.stagedHandoff === null
  ) {
    return undefined;
  }
  const index = state.stagedHandoff.entries.findIndex(
    (entry) => entry.path === path,
  );
  if (index < 0) return undefined;
  const current = state.stagedHandoff.entries[index];
  if (current === undefined) return undefined;
  const updated = update(current);
  if (updated === undefined) return undefined;
  const entries = state.stagedHandoff.entries.map((entry, entryIndex) =>
    entryIndex === index ? updated : entry,
  );
  const hasMismatch = entries.some(
    (entry) =>
      entry.localAlignment === HANDOFF_ALIGNMENT_KIND.mismatch ||
      entry.remoteVerification === HANDOFF_ALIGNMENT_KIND.mismatch,
  );
  return {
    ...state,
    globalBlockReason: hasMismatch
      ? MIRROR_GLOBAL_BLOCK_REASON.handoffMismatch
      : state.globalBlockReason === MIRROR_GLOBAL_BLOCK_REASON.handoffMismatch
        ? null
        : state.globalBlockReason,
    stagedHandoff: {
      ...state.stagedHandoff,
      entries,
    },
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
