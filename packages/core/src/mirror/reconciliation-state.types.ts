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
  HISTORY_CLEANUP_STEP_KIND,
  HISTORY_CLEANUP_STEP_PHASE,
  HISTORY_DECISION_KIND,
  HISTORY_PROGRESS_KIND,
  HISTORY_REMOTE_EFFECT_KIND,
  LEGACY_V3_LOCAL_EFFECT_RECOVERY_STATE,
  LOCAL_EFFECT_OBSERVATION_KIND,
  RECONCILIATION_ACTION,
  RECONCILIATION_AUTHORITY_SOURCE,
  RECONCILIATION_CLASSIFICATION,
  RECONCILIATION_EFFECT_DISPATCH_KIND,
  RECONCILIATION_EVENT_KIND,
  RECONCILIATION_GAP_REVIEW_KIND,
  RECONCILIATION_GAP_REVIEW_STATUS,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_LOCAL_STABILITY,
  RECONCILIATION_OBSERVATION_COVERAGE,
  RECONCILIATION_OPERATION_PHASE,
  RECONCILIATION_PATH_REFERENCE_KIND,
  RECONCILIATION_PRESERVATION_PROOF_STATE,
  RECONCILIATION_PRESERVATION_SCOPE,
  RECONCILIATION_PRESERVATION_SIDE,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
  RECONCILIATION_REVIEW_RETENTION,
  RECONCILIATION_REVIEW_STATUS,
} from "@core/mirror/reconciliation-state.constants";
import type { NotePath } from "@core/note-path/note-path.types";

/** Closed source of explicit operator authority for one admitted M4 operation. */
export type ReconciliationAuthoritySource =
  (typeof RECONCILIATION_AUTHORITY_SOURCE)[keyof typeof RECONCILIATION_AUTHORITY_SOURCE];

/** Closed classification assigned by the content-free read-only review engine. */
export type ReconciliationClassification =
  (typeof RECONCILIATION_CLASSIFICATION)[keyof typeof RECONCILIATION_CLASSIFICATION];

/** Explicit storage lifetime of a review projection. */
export type ReconciliationReviewRetention =
  (typeof RECONCILIATION_REVIEW_RETENTION)[keyof typeof RECONCILIATION_REVIEW_RETENTION];

/** Durable lifecycle of content-free review metadata. */
export type ReconciliationReviewStatus =
  (typeof RECONCILIATION_REVIEW_STATUS)[keyof typeof RECONCILIATION_REVIEW_STATUS];

/** Durable coverage authority for an active reviewed operation. */
export type ReconciliationObservationCoverage =
  (typeof RECONCILIATION_OBSERVATION_COVERAGE)[keyof typeof RECONCILIATION_OBSERVATION_COVERAGE];

/** Exact local or remote effect class selecting one M4 dispatch phase. */
export type ReconciliationEffectDispatchKind =
  (typeof RECONCILIATION_EFFECT_DISPATCH_KIND)[keyof typeof RECONCILIATION_EFFECT_DISPATCH_KIND];

/** Closed status of a predecessor-linked gap-group review. */
export type ReconciliationGapReviewStatus =
  (typeof RECONCILIATION_GAP_REVIEW_STATUS)[keyof typeof RECONCILIATION_GAP_REVIEW_STATUS];

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

/** Completed/stale full-reservation review used only to close a listener-gap predecessor. */
export interface ReconciliationGapGroupReview {
  readonly kind: typeof RECONCILIATION_GAP_REVIEW_KIND.gapGroup;
  readonly reviewId: MirrorOperationId;
  readonly predecessorOperationId: MirrorOperationId;
  readonly status: ReconciliationGapReviewStatus;
  readonly snapshot: ReconciliationReviewSnapshot;
  /** Exact ordinary review identities atomically admitted as replacement owners. */
  readonly childReviewIds: readonly MirrorOperationId[];
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
  /** Action kinds derived from the exact snapshot; presentation must not invent buttons. */
  readonly allowedActions: readonly ReconciliationAction["kind"][];
  readonly sampledLocalText: string | null;
  readonly sampledRemoteText: string | null;
  /** Linked active predecessor when this complete sample resolves an uncovered listener interval. */
  readonly gapPredecessorId?: MirrorOperationId;
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

/** Retain the exact grouped current paths independently and clear only reviewed blockers. */
export interface RetainIndependentHistoryDecision {
  readonly kind: typeof HISTORY_DECISION_KIND.retainIndependent;
}

/** Keep the exact grouped deferred blockers for a later fresh review. */
export interface DeferHistoryDecision {
  readonly kind: typeof HISTORY_DECISION_KIND.deferHistory;
}

/** Execute only the exact evidence-derived former-source cleanup plan. */
export interface ExecuteCleanupHistoryDecision {
  readonly kind: typeof HISTORY_DECISION_KIND.executeCleanupPlan;
  /** Existing lexical group member derived by admission policy, never free-form UI input. */
  readonly canonicalPath: NotePath | null;
}

/** Process-local cleanup selection submitted from one bounded review projection. */
export interface ExecuteCleanupHistoryAdmissionDecision {
  readonly kind: typeof HISTORY_DECISION_KIND.executeCleanupPlan;
  /** Candidate selected from the current review projection and revalidated during admission. */
  readonly selectedCandidatePath: NotePath;
}

/** Closed process-local history choice accepted before durable policy derivation. */
export type HistoryAdmissionDecision =
  | RetainIndependentHistoryDecision
  | DeferHistoryDecision
  | ExecuteCleanupHistoryAdmissionDecision;

/** Closed durable operator decision for one complete deferred-history group. */
export type HistoryDecision =
  | RetainIndependentHistoryDecision
  | DeferHistoryDecision
  | ExecuteCleanupHistoryDecision;

/** Apply one bounded explicit current-state decision to deferred M3 history. */
export interface ResolveHistoryReconciliationAction {
  readonly kind: typeof RECONCILIATION_ACTION.resolveHistory;
  readonly decision: HistoryDecision;
}

/** Process-local history request whose canonical decision is derived only during admission. */
export interface ResolveHistoryAdmissionAction {
  readonly kind: typeof RECONCILIATION_ACTION.resolveHistory;
  readonly decision: HistoryAdmissionDecision;
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

/** Closed action submitted for admission before history policy derives durable fields. */
export type ReconciliationAdmissionAction =
  | Exclude<ReconciliationAction, ResolveHistoryReconciliationAction>
  | ResolveHistoryAdmissionAction;

/** One operation-owned path reservation with an explicit ledger relationship. */
export interface ReconciliationPathReservation {
  readonly path: NotePath;
  readonly kind: (typeof RECONCILIATION_PATH_REFERENCE_KIND)[keyof typeof RECONCILIATION_PATH_REFERENCE_KIND];
}

/** Exact content-free recovery generation selected for a local-first restore. */
export type ReconciliationRecoveryEvidence = RecoverySnapshotState;

/** Fields shared by operation- and step-scoped preservation receipts. */
export interface ReconciliationPreservationReceiptBase {
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

/** Existing one-operation/one-side preservation identity for non-history actions. */
export interface OperationScopedPreservationReceipt
  extends ReconciliationPreservationReceiptBase {
  readonly scope: typeof RECONCILIATION_PRESERVATION_SCOPE.operation;
}

/** Step-scoped history preservation identity preventing same-side collisions. */
export interface HistoryStepPreservationReceipt
  extends ReconciliationPreservationReceiptBase {
  readonly scope: typeof RECONCILIATION_PRESERVATION_SCOPE.historyStep;
  readonly stepId: MirrorOperationId;
}

/** Content-free preservation identity and proof progress. */
export type ReconciliationPreservationReceipt =
  | OperationScopedPreservationReceipt
  | HistoryStepPreservationReceipt;

/** Closed eligible Vault event kind persisted without bodies. */
export type ReconciliationEventKind =
  (typeof RECONCILIATION_EVENT_KIND)[keyof typeof RECONCILIATION_EVENT_KIND];

/** Bounded successor event range observed after local-effect preparation. */
export interface LocalEffectSuccessorRange {
  readonly firstGeneration: number;
  readonly latestGeneration: number;
  readonly eventKinds: readonly ReconciliationEventKind[];
}

/** Exact prepared or proven synthetic local-effect identity. */
export interface IdentifiedLocalEffectObservation {
  readonly kind:
    | typeof LOCAL_EFFECT_OBSERVATION_KIND.prepared
    | typeof LOCAL_EFFECT_OBSERVATION_KIND.confirmed
    | typeof LOCAL_EFFECT_OBSERVATION_KIND.recoveredV3;
  readonly effectId: MirrorOperationId;
  readonly path: NotePath;
  readonly expectedHash: ContentSha256;
  readonly listenerEpoch: number;
  readonly beforeGeneration: number;
  readonly postconditionHash: ContentSha256 | null;
  readonly successor: LocalEffectSuccessorRange | null;
}

/** Event fence retained for an operation that has no plugin local-write effect. */
export interface NoLocalEffectObservation {
  readonly kind: typeof LOCAL_EFFECT_OBSERVATION_KIND.notRequired;
  readonly path: NotePath;
  readonly listenerEpoch: number;
  readonly beforeGeneration: number;
  readonly successor: LocalEffectSuccessorRange | null;
}

/** Durable synthetic local-effect observation state. */
export type LocalEffectObservation =
  | NoLocalEffectObservation
  | { readonly kind: typeof LOCAL_EFFECT_OBSERVATION_KIND.notStarted }
  | {
      readonly kind: typeof LOCAL_EFFECT_OBSERVATION_KIND.legacyV3Unfenced;
      /** Exact pre-projection v3 phase restored only after postcondition recovery. */
      readonly priorPhase: ReconciliationOperationPhaseV3;
      /** Startup recovery progress; blocked evidence is never retried automatically. */
      readonly recoveryState: (typeof LEGACY_V3_LOCAL_EFFECT_RECOVERY_STATE)[keyof typeof LEGACY_V3_LOCAL_EFFECT_RECOVERY_STATE];
    }
  | IdentifiedLocalEffectObservation;

/** Exact confirmed history tombstone evidence bound to the cleanup step UUID. */
export interface ConfirmedHistoryRemoteEffect {
  readonly kind: typeof HISTORY_REMOTE_EFFECT_KIND.confirmedExactTombstoneReceipt;
  readonly revision: ApplicationRevision;
  readonly receipt: TombstoneOperationReceipt;
}

/** Closed effect certainty for one remote-only history cleanup step. */
export type HistoryRemoteEffect =
  | { readonly kind: typeof HISTORY_REMOTE_EFFECT_KIND.notDispatched }
  | { readonly kind: typeof HISTORY_REMOTE_EFFECT_KIND.definitelyRefused }
  | { readonly kind: typeof HISTORY_REMOTE_EFFECT_KIND.unknown }
  | ConfirmedHistoryRemoteEffect;

/** One deterministic former-source cleanup step owned by its parent operation. */
export interface HistoryCleanupStep {
  readonly stepId: MirrorOperationId;
  readonly kind: typeof HISTORY_CLEANUP_STEP_KIND.remoteFormerSourceCleanup;
  readonly sourcePath: NotePath;
  readonly prerequisitePath: NotePath | null;
  readonly sourceRevision: ApplicationRevision;
  readonly sourceContentSha256: ContentSha256;
  readonly prerequisiteRevision: ApplicationRevision | null;
  readonly localAbsenceGeneration: number;
  readonly phase: (typeof HISTORY_CLEANUP_STEP_PHASE)[keyof typeof HISTORY_CLEANUP_STEP_PHASE];
  readonly remoteEffect: HistoryRemoteEffect;
}

/** Refined history decision and bounded ordered cleanup ledger retained by current v5 operations. */
export interface RefinedHistoryProgress {
  readonly kind: typeof HISTORY_PROGRESS_KIND.refined;
  readonly decision: HistoryDecision;
  readonly steps: readonly HistoryCleanupStep[];
  readonly nextStepIndex: number | null;
}

/** Preserved v3 aggregate history state that remains non-dispatchable after migration. */
export interface LegacyV3HistoryProgress {
  readonly kind: typeof HISTORY_PROGRESS_KIND.legacyV3Unrefined;
  readonly aggregateLocalEffect: MutationEffectCertainty;
  readonly aggregateRemoteEffect: MutationEffectCertainty;
}

/** Common identity, snapshot, reservation and review linkage for every v5 operation. */
export interface ReconciliationOperationBase {
  /** Observation proof independent from phase, effects and numeric listener epoch. */
  readonly observationCoverage: ReconciliationObservationCoverage;
  /** Ordinary operations atomically admitted as reviewed successors across a listener gap. */
  readonly gapSuccessorOperationIds: readonly MirrorOperationId[];
  readonly operationId: MirrorOperationId;
  readonly reviewId: MirrorOperationId;
  readonly authority: ReconciliationAuthoritySource;
  readonly phase: ReconciliationOperationPhase;
  readonly snapshot: ReconciliationReviewSnapshot;
  readonly destinationPath: NotePath | null;
  readonly reservations: readonly ReconciliationPathReservation[];
  readonly preservationReceipts: readonly ReconciliationPreservationReceipt[];
  /** Exact reviewed operation receiving a restored path or durable successor-event fence. */
  readonly successorOperationId: MirrorOperationId | null;
}

/** All non-history actions retain aggregate effect certainty and exact local observation fencing. */
export interface ReconciliationNonHistoryOperation
  extends ReconciliationOperationBase {
  readonly action: Exclude<
    ReconciliationAction,
    ResolveHistoryReconciliationAction
  >;
  readonly localEffect: MutationEffectCertainty;
  readonly remoteEffect: MutationEffectCertainty;
  readonly localEffectObservation: LocalEffectObservation;
}

/** Refined history operation; its ordered steps are the sole remote-effect authority. */
export interface ReconciliationHistoryOperation
  extends ReconciliationOperationBase {
  readonly action: ResolveHistoryReconciliationAction;
  readonly historyProgress: RefinedHistoryProgress;
}

/** Historical kind-only history action preserved without inventing an operator decision. */
export interface LegacyV3HistoryAction {
  readonly kind: typeof RECONCILIATION_ACTION.resolveHistory;
}

/** Migrated v3 history operation preserved as an explicit non-dispatchable attention blocker. */
export interface LegacyV3HistoryOperation extends ReconciliationOperationBase {
  readonly action: LegacyV3HistoryAction;
  readonly historyProgress: LegacyV3HistoryProgress;
}

/** Sparse durable confirmed action and restart evidence without any note body. */
export type ReconciliationOperation =
  | ReconciliationNonHistoryOperation
  | ReconciliationHistoryOperation
  | LegacyV3HistoryOperation;

/** Frozen v4 operation shape accepted only by the v4 decoder and v4→v5 migration. */
export type ReconciliationOperationV4 =
  | Omit<
      ReconciliationNonHistoryOperation,
      "observationCoverage" | "gapSuccessorOperationIds"
    >
  | Omit<
      ReconciliationHistoryOperation,
      "observationCoverage" | "gapSuccessorOperationIds"
    >
  | Omit<
      LegacyV3HistoryOperation,
      "observationCoverage" | "gapSuccessorOperationIds"
    >;

/** Frozen version-3 operation-scoped receipt shape used only by forward migration. */
export type ReconciliationPreservationReceiptV3 = Omit<
  OperationScopedPreservationReceipt,
  "scope"
>;

/** Frozen version-3 operation phase set before successor-event fencing existed. */
export type ReconciliationOperationPhaseV3 = Exclude<
  ReconciliationOperationPhase,
  typeof RECONCILIATION_OPERATION_PHASE.successorReviewRequired
>;

/** Frozen version-3 operation shape used only by the strict historical decoder. */
export interface ReconciliationOperationV3 {
  readonly operationId: MirrorOperationId;
  readonly reviewId: MirrorOperationId;
  readonly authority: ReconciliationAuthoritySource;
  readonly action:
    | LegacyV3HistoryAction
    | Exclude<ReconciliationAction, ResolveHistoryReconciliationAction>;
  readonly phase: ReconciliationOperationPhaseV3;
  readonly snapshot: ReconciliationReviewSnapshot;
  readonly destinationPath: NotePath | null;
  readonly reservations: readonly ReconciliationPathReservation[];
  readonly preservationReceipts: readonly ReconciliationPreservationReceiptV3[];
  readonly successorOperationId: MirrorOperationId | null;
  readonly localEffect: MutationEffectCertainty;
  readonly remoteEffect: MutationEffectCertainty;
}
