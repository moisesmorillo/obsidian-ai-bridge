import type {
  ApplicationRevision,
  ContentSha256,
  MirrorAssociationId,
  MirrorWriterId,
  RecoverySnapshotId,
  UnresolvedMutationIntent,
} from "@core/mirror/mirror.types";
import type {
  HANDOFF_ALIGNMENT_KIND,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_GLOBAL_BLOCK_REASON,
  MIRROR_MUTATION_PHASE,
  MIRROR_PATH_BLOCK_REASON,
  MIRROR_PAUSE_REASON,
  MIRROR_RENAME_PHASE,
} from "@core/mirror/mirror-state.constants";
import type { NotePath } from "@core/note-path/note-path.types";

/** Canonical remote-origin binding after strict adapter validation. */
export type MirrorOrigin = string;

/** One device-local association/origin binding; it never contains credentials. */
export interface MirrorBinding {
  readonly associationId: MirrorAssociationId;
  readonly origin: MirrorOrigin;
}

/** Path has never received a confirmed remote generation. */
export interface UnassociatedAcknowledgement {
  readonly kind: typeof MIRROR_ACKNOWLEDGEMENT_KIND.unassociated;
}

/** Last durably confirmed live generation and exact sent-content digest. */
export interface LiveAcknowledgement {
  readonly kind: typeof MIRROR_ACKNOWLEDGEMENT_KIND.live;
  readonly revision: ApplicationRevision;
  readonly contentSha256: ContentSha256;
}

/** Last durably confirmed tombstone and its recoverable snapshot identity. */
export interface TombstoneAcknowledgement {
  readonly kind: typeof MIRROR_ACKNOWLEDGEMENT_KIND.tombstone;
  readonly revision: ApplicationRevision;
  readonly recoveryId: RecoverySnapshotId;
}

/** Exactly one acknowledged remote state for a tracked path. */
export type MirrorAcknowledgement =
  | UnassociatedAcknowledgement
  | LiveAcknowledgement
  | TombstoneAcknowledgement;

/** No coalesced local work is currently retained for the path. */
export interface NoDesiredMirrorState {
  readonly kind: typeof MIRROR_DESIRED_STATE_KIND.none;
}

/** Positive saved-file evidence requiring a later stable read. */
export interface DirtyPresentMirrorState {
  readonly kind: typeof MIRROR_DESIRED_STATE_KIND.dirtyPresent;
  readonly observationGeneration: number;
}

/** Durable post-bootstrap deletion evidence for later Slice 6 orchestration. */
export interface RuntimeDeleteMirrorState {
  readonly kind: typeof MIRROR_DESIRED_STATE_KIND.runtimeDelete;
  readonly observationGeneration: number;
  readonly associationId: MirrorAssociationId;
  readonly expectedRevision: ApplicationRevision;
}

/** Durable rename prerequisite/deferred cleanup metadata without a history. */
export interface RenameDeferredMirrorState {
  readonly kind: typeof MIRROR_DESIRED_STATE_KIND.renameDeferred;
  readonly observationGeneration: number;
  readonly counterpartPath: NotePath;
  readonly phase: (typeof MIRROR_RENAME_PHASE)[keyof typeof MIRROR_RENAME_PHASE];
}

/** At most one coalesced desired/evidence state per tracked path. */
export type MirrorDesiredState =
  | NoDesiredMirrorState
  | DirtyPresentMirrorState
  | RuntimeDeleteMirrorState
  | RenameDeferredMirrorState;

/** Sanitized path-local operational blocker. */
export type MirrorPathBlockReason =
  (typeof MIRROR_PATH_BLOCK_REASON)[keyof typeof MIRROR_PATH_BLOCK_REASON];

/** One unresolved intent and its durable workflow phase, without a request body. */
export interface MirrorUnresolvedMutation {
  readonly intent: UnresolvedMutationIntent;
  readonly phase: (typeof MIRROR_MUTATION_PHASE)[keyof typeof MIRROR_MUTATION_PHASE];
}

/** One bounded, content-free per-path durable ledger entry. */
export interface MirrorPathState {
  readonly path: NotePath;
  readonly acknowledgement: MirrorAcknowledgement;
  readonly unresolvedMutation: MirrorUnresolvedMutation | null;
  readonly desired: MirrorDesiredState;
  readonly blockedReason: MirrorPathBlockReason | null;
}

/** Device has not been explicitly activated and owns no association authority. */
export interface DisabledMirrorLifecycle {
  readonly kind: typeof MIRROR_DEVICE_LIFECYCLE_KIND.disabled;
}

/** Explicitly activated designated writer bound to one association and origin. */
export interface ActiveMirrorLifecycle extends MirrorBinding {
  readonly kind: typeof MIRROR_DEVICE_LIFECYCLE_KIND.active;
}

/** Durable pause for a previously bound writer; pause never discards its ledger. */
export interface PausedMirrorLifecycle extends MirrorBinding {
  readonly kind: typeof MIRROR_DEVICE_LIFECYCLE_KIND.paused;
  readonly reason: (typeof MIRROR_PAUSE_REASON)[keyof typeof MIRROR_PAUSE_REASON];
}

/** Handoff intake is closed while previously admitted work is still draining. */
export interface HandoffDrainingMirrorLifecycle extends MirrorBinding {
  readonly kind: typeof MIRROR_DEVICE_LIFECYCLE_KIND.handoffDraining;
}

/** Durable proof that handoff quiescence checks completed after intake closed. */
export interface HandoffDrainedMirrorLifecycle extends MirrorBinding {
  readonly kind: typeof MIRROR_DEVICE_LIFECYCLE_KIND.handoffDrained;
}

/** Imported baseline is staged and grants no writer authority. */
export interface HandoffStagedMirrorLifecycle extends MirrorBinding {
  readonly kind: typeof MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged;
}

/** Closed device-local lifecycle that alone determines whether activation exists. */
export type MirrorDeviceLifecycle =
  | DisabledMirrorLifecycle
  | ActiveMirrorLifecycle
  | PausedMirrorLifecycle
  | HandoffDrainingMirrorLifecycle
  | HandoffDrainedMirrorLifecycle
  | HandoffStagedMirrorLifecycle;

/** Sanitized global blocker persisted without raw errors or responses. */
export type MirrorGlobalBlockReason =
  (typeof MIRROR_GLOBAL_BLOCK_REASON)[keyof typeof MIRROR_GLOBAL_BLOCK_REASON];

/** Handoff entries transfer only established live or tombstone acknowledgements. */
export type TransferableAcknowledgement =
  | LiveAcknowledgement
  | TombstoneAcknowledgement;

/** One content-free handoff baseline entry. */
export interface HandoffBaselineEntry {
  readonly path: NotePath;
  readonly acknowledgement: TransferableAcknowledgement;
}

/** Metadata payload covered by a handoff integrity checksum. */
export interface HandoffPayload extends MirrorBinding {
  readonly entries: readonly HandoffBaselineEntry[];
}

/** Explicit content-free handoff record suitable for user-controlled transfer. */
export interface HandoffRecord extends HandoffPayload {
  readonly checksum: ContentSha256;
}

/** Local and future-remote verification evidence for one transferred acknowledgement. */
export interface StagedHandoffEntry extends HandoffBaselineEntry {
  readonly localAlignment: (typeof HANDOFF_ALIGNMENT_KIND)[keyof typeof HANDOFF_ALIGNMENT_KIND];
  readonly remoteVerification: (typeof HANDOFF_ALIGNMENT_KIND)[keyof typeof HANDOFF_ALIGNMENT_KIND];
  readonly observationGeneration: number;
}

/** Imported baseline retained without granting activation until every entry aligns. */
export interface StagedHandoff extends MirrorBinding {
  readonly entries: readonly StagedHandoffEntry[];
  readonly checksum: ContentSha256;
}

/** Complete core-owned durable state saved outside synced plugin data. */
export interface MirrorDeviceState {
  readonly deviceId: MirrorWriterId;
  readonly lifecycle: MirrorDeviceLifecycle;
  readonly globalBlockReason: MirrorGlobalBlockReason | null;
  readonly paths: readonly MirrorPathState[];
  readonly stagedHandoff: StagedHandoff | null;
}

/** Version token and conservative runtime admission view published by the state owner. */
export interface MirrorStateSnapshot {
  readonly revision: number;
  readonly state: MirrorDeviceState;
  readonly persistenceAvailable: boolean;
  readonly mutationAdmissionAllowed: boolean;
}
