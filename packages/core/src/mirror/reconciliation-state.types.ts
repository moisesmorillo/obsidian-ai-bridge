import type {
  ApplicationRevision,
  ContentOperationReceipt,
  ContentSha256,
  MirrorAssociationId,
  MirrorOperationId,
  MirrorWriterId,
  MutationEffectCertainty,
  RecoverySnapshotState,
  TombstoneOperationReceipt,
} from "@core/mirror/mirror.types";
import type {
  MirrorAcknowledgement,
  MirrorDeviceLifecycle,
  MirrorUnresolvedMutation,
  RenameDeferredMirrorState,
} from "@core/mirror/mirror-state.types";
import type {
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
import type { NotePath } from "@core/note-path/note-path.types";

/** Closed source of explicit operator authority for one admitted M4 operation. */
export type ReconciliationAuthoritySource =
  (typeof RECONCILIATION_AUTHORITY_SOURCE)[keyof typeof RECONCILIATION_AUTHORITY_SOURCE];

/** Closed classification assigned by the future read-only review engine. */
export type ReconciliationClassification =
  (typeof RECONCILIATION_CLASSIFICATION)[keyof typeof RECONCILIATION_CLASSIFICATION];

/** Explicit storage lifetime of a review projection. */
export type ReconciliationReviewRetention =
  (typeof RECONCILIATION_REVIEW_RETENTION)[keyof typeof RECONCILIATION_REVIEW_RETENTION];

/** Durable lifecycle of content-free review metadata. */
export type ReconciliationReviewStatus =
  (typeof RECONCILIATION_REVIEW_STATUS)[keyof typeof RECONCILIATION_REVIEW_STATUS];

/** Durable lifecycle of one admitted reconciliation operation. */
export type ReconciliationOperationPhase =
  (typeof RECONCILIATION_OPERATION_PHASE)[keyof typeof RECONCILIATION_OPERATION_PHASE];

/** Exact stable local absence sampled under one observation generation. */
export interface ReconciliationLocalAbsentEvidence {
  readonly kind: typeof RECONCILIATION_LOCAL_EVIDENCE_KIND.absent;
  readonly stability: typeof RECONCILIATION_LOCAL_STABILITY.stable;
  /** Positive saved-observation generation within the snapshot's listener identity, not a filesystem revision. */
  readonly observationGeneration: number;
}

/** Exact stable local live-content metadata without the sampled note body. */
export interface ReconciliationLocalLiveEvidence {
  readonly kind: typeof RECONCILIATION_LOCAL_EVIDENCE_KIND.live;
  readonly stability: typeof RECONCILIATION_LOCAL_STABILITY.stable;
  /** Positive saved-observation generation; same-text events can still invalidate a review. */
  readonly observationGeneration: number;
  /** Measured UTF-8 bytes, bounded by the note-size policy rather than character count. */
  readonly byteSize: number;
  readonly contentSha256: ContentSha256;
}

/** Non-authoritative local evidence that cannot admit a mutation. */
export interface ReconciliationLocalUnknownEvidence {
  readonly kind: typeof RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown;
  readonly stability: typeof RECONCILIATION_LOCAL_STABILITY.unknown;
}

/** Content-free local evidence retained by a review or confirmed operation. */
export type ReconciliationLocalEvidence =
  | ReconciliationLocalAbsentEvidence
  | ReconciliationLocalLiveEvidence
  | ReconciliationLocalUnknownEvidence;

/** Exact observed remote physical absence, which never represents a tombstone. */
export interface ReconciliationRemoteAbsentEvidence {
  readonly kind: typeof RECONCILIATION_REMOTE_EVIDENCE_KIND.absent;
}

/** Legacy content metadata without conditionable generation identity. */
export interface ReconciliationRemoteLegacyEvidence {
  readonly kind: typeof RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy;
  readonly contentSha256: ContentSha256;
}

/** Exact format-2 live generation metadata and immutable operation receipt. */
export interface ReconciliationRemoteLiveEvidence {
  readonly kind: typeof RECONCILIATION_REMOTE_EVIDENCE_KIND.live;
  readonly associationId: MirrorAssociationId;
  readonly revision: ApplicationRevision;
  readonly contentSha256: ContentSha256;
  readonly receipt: ContentOperationReceipt;
}

/** Exact format-2 tombstone metadata and immutable deletion receipt. */
export interface ReconciliationRemoteTombstoneEvidence {
  readonly kind: typeof RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone;
  readonly associationId: MirrorAssociationId;
  readonly revision: ApplicationRevision;
  readonly deletedRevision: ApplicationRevision;
  readonly recoveryId: MirrorOperationId;
  readonly receipt: TombstoneOperationReceipt;
}

/** Sanitized remote-unavailable evidence carrying no raw transport details. */
export interface ReconciliationRemoteUnavailableEvidence {
  readonly kind: typeof RECONCILIATION_REMOTE_EVIDENCE_KIND.unavailable;
}

/** Content-free remote evidence retained by a review or confirmed operation. */
export type ReconciliationRemoteEvidence =
  | ReconciliationRemoteAbsentEvidence
  | ReconciliationRemoteLegacyEvidence
  | ReconciliationRemoteLiveEvidence
  | ReconciliationRemoteTombstoneEvidence
  | ReconciliationRemoteUnavailableEvidence;

/** Exact M3 work that takes precedence over a review for one sampled path. */
export interface ReconciliationM3PathEvidence {
  /** Exact unresolved M3 intent/phase/budgets, or null when none was sampled. */
  readonly unresolvedMutation: MirrorUnresolvedMutation | null;
  /** Deferred rename evidence, or null; cannot coexist with unresolved mutation in a valid sample. */
  readonly deferredHistory: RenameDeferredMirrorState | null;
}

/** Complete content-free local/baseline/remote identity for one reviewed path. */
export interface ReconciliationPathEvidence {
  readonly path: NotePath;
  readonly local: ReconciliationLocalEvidence;
  readonly baseline: MirrorAcknowledgement;
  readonly remote: ReconciliationRemoteEvidence;
  readonly m3: ReconciliationM3PathEvidence;
}

/** Runtime and configuration authority captured by one immutable review snapshot. */
export interface ReconciliationRuntimeIdentity {
  /** Structural owner version captured by the review, not a persisted-format version. */
  readonly runtimeOwnerVersion: number;
  /** Nonnegative configuration identity; a changed connection setting invalidates prior decisions. */
  readonly configurationGeneration: number;
  /** Positive listener attachment identity; gaps must not reuse prior sampled authority. */
  readonly listenerEpoch: number;
  readonly deviceId: MirrorWriterId;
  readonly designatedWriterId: MirrorWriterId;
  readonly lifecycle: MirrorDeviceLifecycle;
}

/**
 * One authoritative content-free identity for review and operation authority.
 *
 * `paths` contains the target exactly once plus every source, destination, and
 * collision path whose identity can make a later decision stale. Note bodies remain
 * process-local and are never represented here.
 */
export interface ReconciliationReviewSnapshot {
  readonly runtime: ReconciliationRuntimeIdentity;
  readonly targetPath: NotePath;
  readonly paths: readonly ReconciliationPathEvidence[];
  /** Exact selected recovery metadata, or null when this review has no recovery selection. */
  readonly recovery: ReconciliationRecoveryEvidence | null;
}

/** Content-free metadata shared by ephemeral and durable review projections. */
export interface ReconciliationReviewMetadata {
  readonly reviewId: MirrorOperationId;
  readonly classification: ReconciliationClassification;
  readonly status: ReconciliationReviewStatus;
  readonly snapshot: ReconciliationReviewSnapshot;
  /** Operation admitted from this exact immutable snapshot, when one exists. */
  readonly operationId: MirrorOperationId | null;
}

/** Sparse durable review metadata; transient local or remote bodies are excluded. */
export interface ReconciliationReview extends ReconciliationReviewMetadata {
  readonly retention: typeof RECONCILIATION_REVIEW_RETENTION.durable;
}

/**
 * Process-local review sample that may carry bounded transient target-note text.
 *
 * This type is deliberately absent from `MirrorDeviceState` and every persisted
 * codec. Closing the review session discards both sampled text values.
 */
export interface EphemeralReconciliationReview
  extends ReconciliationReviewMetadata {
  readonly retention: typeof RECONCILIATION_REVIEW_RETENTION.ephemeral;
  readonly sessionId: MirrorOperationId;
  readonly sampledLocalText: string | null;
  readonly sampledRemoteText: string | null;
}

/** Keep the exact sampled local bytes as the authoritative original path. */
export interface KeepLocalReconciliationAction {
  readonly kind: typeof RECONCILIATION_ACTION.keepLocal;
}

/** Replace the sampled local bytes with the exact reviewed remote generation. */
export interface UseRemoteReconciliationAction {
  readonly kind: typeof RECONCILIATION_ACTION.useRemote;
}

/** Materialize both versions while explicitly selecting the original-path side. */
export interface KeepBothReconciliationAction {
  readonly kind: typeof RECONCILIATION_ACTION.keepBoth;
  readonly primarySide: (typeof RECONCILIATION_PRESERVATION_SIDE)[keyof typeof RECONCILIATION_PRESERVATION_SIDE];
}

/** Adopt one exact format-2 live generation after an explicit operator decision. */
export interface AdoptRevisionReconciliationAction {
  readonly kind: typeof RECONCILIATION_ACTION.adoptRevision;
}

/** Adopt one exact tombstone only after fresh local-absence evidence. */
export interface AcceptTombstoneReconciliationAction {
  readonly kind: typeof RECONCILIATION_ACTION.acceptTombstone;
}

/** Recreate a tombstoned remote head from exact reviewed local bytes. */
export interface RecreateRemoteReconciliationAction {
  readonly kind: typeof RECONCILIATION_ACTION.recreateRemote;
}

/** Restore one exact recoverable snapshot locally before any later remote decision. */
export interface RestoreRecoveryReconciliationAction {
  readonly kind: typeof RECONCILIATION_ACTION.restoreRecovery;
}

/** Fork legacy bytes to a distinct absent path without mutating the legacy object. */
export interface ForkLegacyReconciliationAction {
  readonly kind: typeof RECONCILIATION_ACTION.forkLegacy;
}

/** Apply one bounded explicit current-state decision to deferred M3 history. */
export interface ResolveHistoryReconciliationAction {
  readonly kind: typeof RECONCILIATION_ACTION.resolveHistory;
}

/** Persist an explicit no-mutation decision where durable deferral is required. */
export interface DeferReconciliationAction {
  readonly kind: typeof RECONCILIATION_ACTION.defer;
}

/** Closed operator actions accepted by the M4 state contract. */
export type ReconciliationAction =
  | KeepLocalReconciliationAction
  | UseRemoteReconciliationAction
  | KeepBothReconciliationAction
  | AdoptRevisionReconciliationAction
  | AcceptTombstoneReconciliationAction
  | RecreateRemoteReconciliationAction
  | RestoreRecoveryReconciliationAction
  | ForkLegacyReconciliationAction
  | ResolveHistoryReconciliationAction
  | DeferReconciliationAction;

/** One operation-owned path reservation with an explicit ledger relationship. */
export interface ReconciliationPathReservation {
  readonly path: NotePath;
  readonly kind: (typeof RECONCILIATION_PATH_REFERENCE_KIND)[keyof typeof RECONCILIATION_PATH_REFERENCE_KIND];
}

/** Exact content-free recovery generation selected for a local-first restore. */
export type ReconciliationRecoveryEvidence = RecoverySnapshotState;

/** Content-free preservation identity and proof progress; only verified state claims a completed safety copy. */
export interface ReconciliationPreservationReceipt {
  readonly operationId: MirrorOperationId;
  readonly originalPath: NotePath;
  readonly side: (typeof RECONCILIATION_PRESERVATION_SIDE)[keyof typeof RECONCILIATION_PRESERVATION_SIDE];
  /** Exact live remote revision; null for local bytes or legacy remote bytes without generation identity. */
  readonly sourceRevision: ApplicationRevision | null;
  readonly contentSha256: ContentSha256;
  /** Generated excluded vault path; it can never be a remote-supplied path. */
  readonly preservationPath: string;
  readonly proofState: (typeof RECONCILIATION_PRESERVATION_PROOF_STATE)[keyof typeof RECONCILIATION_PRESERVATION_PROOF_STATE];
}

/** Sparse durable confirmed action and restart evidence without any note body. */
export interface ReconciliationOperation {
  readonly operationId: MirrorOperationId;
  readonly reviewId: MirrorOperationId;
  readonly authority: ReconciliationAuthoritySource;
  readonly action: ReconciliationAction;
  readonly phase: ReconciliationOperationPhase;
  /** Immutable copy of the exact review identity admitted for this operation. */
  readonly snapshot: ReconciliationReviewSnapshot;
  /** Distinct alternate destination when selected; null uses the target and grants no implicit new-path authority. */
  readonly destinationPath: NotePath | null;
  readonly reservations: readonly ReconciliationPathReservation[];
  readonly preservationReceipts: readonly ReconciliationPreservationReceipt[];
  /** Reviewed successor linked at restore completion; it may later complete but must not be stale. */
  readonly successorOperationId: MirrorOperationId | null;
  /** Local effect knowledge independent of phase; unknown is not permission to retry blindly. */
  readonly localEffect: MutationEffectCertainty;
  /** Remote effect knowledge; a local-first restore must leave this undispatched. */
  readonly remoteEffect: MutationEffectCertainty;
}
