import type {
  ApplicationRevision,
  ContentSha256,
  MirrorAssociationId,
  MirrorOperationId,
  MutationEffectCertainty,
  RecoverySnapshotId,
} from "@core/mirror/mirror.types";
import type { MirrorAcknowledgement } from "@core/mirror/mirror-state.types";
import type {
  RECONCILIATION_ACTION,
  RECONCILIATION_AUTHORITY_SOURCE,
  RECONCILIATION_CLASSIFICATION,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
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

/** Exact local absence sampled under one observation generation. */
export interface ReconciliationLocalAbsentEvidence {
  readonly kind: typeof RECONCILIATION_LOCAL_EVIDENCE_KIND.absent;
  readonly observationGeneration: number;
}

/** Exact stable local live-content metadata without the sampled note body. */
export interface ReconciliationLocalLiveEvidence {
  readonly kind: typeof RECONCILIATION_LOCAL_EVIDENCE_KIND.live;
  readonly observationGeneration: number;
  readonly contentSha256: ContentSha256;
}

/** Non-authoritative local evidence that cannot admit a mutation. */
export interface ReconciliationLocalUnknownEvidence {
  readonly kind: typeof RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown;
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

/** Exact format-2 live generation metadata from the current association. */
export interface ReconciliationRemoteLiveEvidence {
  readonly kind: typeof RECONCILIATION_REMOTE_EVIDENCE_KIND.live;
  readonly associationId: MirrorAssociationId;
  readonly revision: ApplicationRevision;
  readonly contentSha256: ContentSha256;
}

/** Exact format-2 tombstone metadata without recovery or note content. */
export interface ReconciliationRemoteTombstoneEvidence {
  readonly kind: typeof RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone;
  readonly associationId: MirrorAssociationId;
  readonly revision: ApplicationRevision;
  readonly recoveryId: RecoverySnapshotId;
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

/** Exact content-free evidence tuple copied into an admitted operation. */
export interface ReconciliationEvidence {
  readonly local: ReconciliationLocalEvidence;
  readonly baseline: MirrorAcknowledgement;
  readonly remote: ReconciliationRemoteEvidence;
}

/** Content-free metadata shared by ephemeral and durable review projections. */
export interface ReconciliationReviewMetadata {
  readonly reviewId: MirrorOperationId;
  readonly targetPath: NotePath;
  readonly relatedPaths: readonly NotePath[];
  readonly classification: ReconciliationClassification;
  readonly status: ReconciliationReviewStatus;
  readonly evidence: ReconciliationEvidence;
  /** Operation admitted from this exact review, when one exists. */
  readonly operationId: MirrorOperationId | null;
}

/** Sparse durable review metadata; transient local or remote bodies are excluded. */
export interface ReconciliationReview extends ReconciliationReviewMetadata {
  readonly retention: typeof RECONCILIATION_REVIEW_RETENTION.durable;
}

/**
 * Process-local review sample that may carry bounded transient note text.
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

/** Exact recovery snapshot identity selected for a local-first restore. */
export interface ReconciliationRecoveryEvidence {
  readonly recoveryId: RecoverySnapshotId;
  readonly revision: ApplicationRevision;
  readonly contentSha256: ContentSha256;
}

/** Content-free proof that one competing side is reserved or durably preserved. */
export interface ReconciliationPreservationReceipt {
  readonly operationId: MirrorOperationId;
  readonly originalPath: NotePath;
  readonly side: (typeof RECONCILIATION_PRESERVATION_SIDE)[keyof typeof RECONCILIATION_PRESERVATION_SIDE];
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
  readonly sourcePath: NotePath;
  readonly destinationPath: NotePath | null;
  readonly reservations: readonly ReconciliationPathReservation[];
  readonly evidence: ReconciliationEvidence;
  readonly recovery: ReconciliationRecoveryEvidence | null;
  readonly preservationReceipts: readonly ReconciliationPreservationReceipt[];
  readonly localEffect: MutationEffectCertainty;
  readonly remoteEffect: MutationEffectCertainty;
}
