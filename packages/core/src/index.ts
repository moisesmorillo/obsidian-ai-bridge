export { createIdentifier } from "@core/identifier/identifier";
export type { Identifier } from "@core/identifier/identifier.types";
export {
  evaluateLocalNote,
  evaluateLocalNotePath,
  evaluateLocalNoteSize,
} from "@core/local-vault/local-eligibility";
export { LocalInspectionService } from "@core/local-vault/local-inspection-service";
export type { LocalInspector } from "@core/local-vault/local-inspection-service.types";
export {
  LocalInspectionKind,
  LocalSkipReason,
  LocalVaultFailureReason,
} from "@core/local-vault/local-vault.constants";
export type {
  LocalActiveInspectionResult,
  LocalEligibilityPolicy,
  LocalFailure,
  LocalListResult,
  LocalNoteEligibility,
  LocalNoteEntry,
  LocalPathEligibility,
  LocalPathFailureReason,
  LocalReadFailureReason,
  LocalReadResult,
  LocalSizeEligibility,
  LocalSkippedCounts,
  LocalSkipReasonCode,
  LocalVaultFailureReasonCode,
} from "@core/local-vault/local-vault.types";
export type { ReadOnlyLocalVault } from "@core/local-vault/read-only-local-vault.port";
export {
  currentPreservationNamespaceOverlapsConfig,
  isCurrentReconciliationPreservationNamespacePath,
  isReconciliationPreservationNamespacePath,
  LEGACY_RECONCILIATION_PRESERVATION_ROOT,
  RECONCILIATION_PRESERVATION_ROOT,
  RECONCILIATION_PRESERVATION_ROOTS,
} from "@core/local-vault/reconciliation-preservation-namespace";
export type { ConditionalCurrentNoteRepository } from "@core/mirror/conditional-current-note-repository.port";
export type { ConflictPreservationCryptography } from "@core/mirror/conflict-preservation-service";
export { ConflictPreservationService } from "@core/mirror/conflict-preservation-service";
export type {
  ConflictPreservationRejection,
  ConflictPreservationRequest,
  ConflictPreservationResult,
} from "@core/mirror/conflict-preservation-service.types";
export {
  CurrentGenerationService,
  isValidCurrentNoteContent,
} from "@core/mirror/current-generation-service";
export {
  classifyReconciliation,
  isReconciliationReviewable,
} from "@core/mirror/divergence-classifier";
export type { MirrorScheduledJob } from "@core/mirror/fair-mirror-scheduler";
export { FairMirrorScheduler } from "@core/mirror/fair-mirror-scheduler";
export { LiveResolutionService } from "@core/mirror/live-resolution-service";
export type {
  LocalReconciliationObservationRuntime,
  LocalReconciliationWriteCryptography,
} from "@core/mirror/local-reconciliation-write-service";
export { LocalReconciliationWriteService } from "@core/mirror/local-reconciliation-write-service";
export type {
  AuthorizedCreateEligibleRequest,
  AuthorizedReplaceEligibleRequest,
  LocalReconciliationCommandRejection,
  LocalReconciliationCommandResult,
} from "@core/mirror/local-reconciliation-write-service.types";
export {
  LOCAL_RECONCILIATION_DISPATCH_MODE,
  LOCAL_RECONCILIATION_FAILURE,
  LOCAL_RECONCILIATION_REFUSAL,
  LOCAL_RECONCILIATION_WRITE_OUTCOME,
} from "@core/mirror/local-reconciliation-writer.constants";
export type { LocalReconciliationWriter } from "@core/mirror/local-reconciliation-writer.port";
export type {
  ConfirmedLocalReconciliationWrite,
  CreateEligibleLocalRequest,
  CreatePreservationLocalRequest,
  FailedLocalReconciliationWrite,
  LocalReconciliationDispatchMode,
  LocalReconciliationWriteResult,
  ReconciliationPreservationPath,
  RefusedLocalReconciliationWrite,
  ReplaceEligibleLocalRequest,
} from "@core/mirror/local-reconciliation-writer.types";
export {
  APPLICATION_ETAG_PATTERN,
  APPLICATION_ETAG_PREFIX,
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  CONTENT_SHA_256_PATTERN,
  CURRENT_CONTENT_RESULT_KIND,
  CURRENT_NOTE_STATE_KIND,
  MAX_MIRROR_CURSOR_LENGTH,
  MAX_MIRROR_PAGE_SIZE,
  MAX_MUTATION_ATTEMPTS,
  MAX_MUTATION_EVIDENCE_ATTEMPTS,
  MUTATION_ACTION,
  MUTATION_ACTIONS,
  MUTATION_EFFECT_CERTAINTY,
  RECOVERY_CONTENT_RESULT_KIND,
  RECOVERY_MAINTENANCE_RESULT_KIND,
  RECOVERY_RETENTION_MILLISECONDS,
  RECOVERY_SNAPSHOT_STATE_KIND,
  TOMBSTONE_WORKFLOW_STAGE_KIND,
  UUID_V4_PATTERN,
} from "@core/mirror/mirror.constants";
export type {
  AbsentCurrentNoteState,
  AbsentPrecondition,
  ApplicationEtag,
  ApplicationRevision,
  ConditionalCreateRequest,
  ConditionalMutationPrecondition,
  ConditionalMutationRequest,
  ConditionalMutationResult,
  ConditionalRecreateRequest,
  ConditionalTombstoneRequest,
  ConditionalUpdateRequest,
  ContentMutationAction,
  ContentOperationReceipt,
  ContentSha256,
  CreateOperationReceipt,
  CurrentGenerationState,
  CurrentNoteState,
  LegacyCurrentNoteState,
  LiveCurrentNoteState,
  MatchingRevisionPrecondition,
  MirrorAssociationId,
  MirrorOperationId,
  MirrorWriterId,
  MutationAcknowledgement,
  MutationAction,
  MutationEffectCertainty,
  MutationEffectResult,
  NotePage,
  OperationReceipt,
  PreparedRecoverySnapshotState,
  PurgedRecoverySnapshotState,
  RecoveryMutationResult,
  RecoveryPage,
  RecoveryPreparationRequest,
  RecoveryPurgeRequest,
  RecoverySealRequest,
  RecoverySnapshotId,
  RecoverySnapshotState,
  SealedRecoverySnapshotState,
  TombstoneCurrentNoteState,
  TombstoneOperationReceipt,
  UnresolvedContentMutationIntent,
  UnresolvedCreateMutationIntent,
  UnresolvedMutationIntent,
  UnresolvedTombstoneMutationIntent,
  UnresolvedUpdateMutationIntent,
  UpdateOperationReceipt,
} from "@core/mirror/mirror.types";
export { applyMutationAcknowledgement } from "@core/mirror/mirror-acknowledgement";
export type {
  ConditionalContentWriteRequest,
  ConfirmedTombstoneSealRequest,
  ConfirmedTombstoneTransition,
  ContentMutationAcknowledgement,
  CurrentContentMutationResult,
  CurrentContentResult,
  MirrorClock,
  MirrorGenerationCryptography,
  RecoveryContentResult,
  RecoveryMaintenanceResult,
  RecoveryPreparationProofResult,
  TombstoneMutationResult,
} from "@core/mirror/mirror-application.types";
export {
  MAX_ACTIVE_MIRROR_JOBS,
  MAX_REMOTE_INVENTORY_PAGES,
  MIRROR_BOOTSTRAP_INCOMPLETE_REASON,
  MIRROR_COALESCING_QUIET_PERIOD_MILLISECONDS,
  MIRROR_DELETION_GRACE_MILLISECONDS,
  MIRROR_FINAL_MUTATION_RETRY_DELAY_MILLISECONDS,
  MIRROR_INVENTORY_INCOMPLETE_REASON,
  MIRROR_MAX_COALESCING_WAIT_MILLISECONDS,
  MIRROR_MUTATION_RETRY_DELAY_MILLISECONDS,
  MIRROR_SYNCHRONIZER_PHASE,
} from "@core/mirror/mirror-autosync.constants";
export {
  createApplicationEtag,
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  createRecoverySnapshotId,
  formatApplicationEtag,
  isApplicationEtag,
  isContentSha256,
  isUuidV4,
  parseApplicationEtag,
} from "@core/mirror/mirror-identifiers";
export type {
  CompleteMirrorInventory,
  CompleteRecoveryInventory,
  IncompleteMirrorInventory,
  IncompleteRecoveryInventory,
  MirrorInventoryResult,
  RecoveryInventoryResult,
} from "@core/mirror/mirror-inventory";
export {
  inspectBoundedMirrorInventory,
  inspectBoundedRecoveryInventory,
} from "@core/mirror/mirror-inventory";
export {
  HANDOFF_ALIGNMENT_KIND,
  MAX_MIRROR_TRACKED_PATHS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_DEVICE_STATE_V2_VERSION,
  MIRROR_DEVICE_STATE_V3_VERSION,
  MIRROR_DEVICE_STATE_V4_VERSION,
  MIRROR_DEVICE_STATE_VERSION,
  MIRROR_GLOBAL_BLOCK_REASON,
  MIRROR_MUTATION_PHASE,
  MIRROR_PATH_BLOCK_REASON,
  MIRROR_PAUSE_REASON,
  MIRROR_RENAME_PHASE,
} from "@core/mirror/mirror-state.constants";
export type {
  ActiveMirrorLifecycle,
  DirtyPresentMirrorState,
  DisabledMirrorLifecycle,
  HandoffAlignmentInvalidation,
  HandoffAlignmentSnapshot,
  HandoffBaselineEntry,
  HandoffDrainedMirrorLifecycle,
  HandoffDrainingMirrorLifecycle,
  HandoffLiveLocalObservation,
  HandoffLocalObservation,
  HandoffPayload,
  HandoffRecord,
  HandoffRemoteObservation,
  HandoffStagedMirrorLifecycle,
  HandoffTombstoneLocalObservation,
  LiveAcknowledgement,
  MirrorAcknowledgement,
  MirrorBinding,
  MirrorDesiredState,
  MirrorDeviceLifecycle,
  MirrorDeviceState,
  MirrorDeviceStateV2,
  MirrorDeviceStateV3,
  MirrorDeviceStateV4,
  MirrorGlobalBlockReason,
  MirrorOrigin,
  MirrorPathBlockReason,
  MirrorPathState,
  MirrorStateSnapshot,
  MirrorUnresolvedMutation,
  NoDesiredMirrorState,
  PausedMirrorLifecycle,
  RenameDeferredMirrorState,
  RuntimeDeleteMirrorState,
  StagedHandoff,
  StagedHandoffEntry,
  TombstoneAcknowledgement,
  TransferableAcknowledgement,
  UnassociatedAcknowledgement,
} from "@core/mirror/mirror-state.types";
export type { MirrorStateCommitResult } from "@core/mirror/mirror-state-owner";
export { MirrorStateOwner } from "@core/mirror/mirror-state-owner";
export type {
  HandoffActivationRequest,
  HandoffExportFailure,
  HandoffImportFailure,
  HandoffStageRequest,
  IsolatedAssociationActivationRequest,
  WriterActivationFailure,
  WriterDesignationEvidence,
} from "@core/mirror/mirror-state-policy";
export {
  activateIsolatedAssociation,
  activateStagedHandoff,
  alignAndActivateStagedHandoff,
  alignStagedHandoff,
  createDisabledMirrorState,
  evaluateWriterReadiness,
  fenceMirrorRuntime,
  HANDOFF_EXPORT_FAILURE,
  HANDOFF_IMPORT_FAILURE,
  invalidateHandoffAlignments,
  isDurableMutationAdmissionAllowed,
  markHandoffDrained,
  pauseForHandoff,
  pauseMirrorWriter,
  prepareHandoffExport,
  recoverMirrorRuntime,
  resumeMirrorWriter,
  stageHandoffImport,
  WRITER_ACTIVATION_FAILURE,
} from "@core/mirror/mirror-state-policy";
export type {
  MirrorStateSaveResult,
  MirrorStateStore,
  MirrorStateStoreFailure,
} from "@core/mirror/mirror-state-store.port";
export { MIRROR_STATE_STORE_FAILURE } from "@core/mirror/mirror-state-store.port";
export {
  isMirrorDeviceStateConsistent,
  isMirrorDeviceStateV2Consistent,
  isMirrorDeviceStateV3Consistent,
  isMirrorDeviceStateV4Consistent,
} from "@core/mirror/mirror-state-validation";
export type {
  AbsentCurrentGenerationObservation,
  CurrentGenerationObservation,
  CurrentGenerationObservationPage,
  CurrentGenerationReplacement,
  LegacyCurrentGenerationObservation,
  LiveCurrentGenerationCandidate,
  LiveCurrentGenerationObservation,
  ObservedPreparedRecoveryGeneration,
  ObservedPurgedRecoveryGeneration,
  ObservedSealedRecoveryGeneration,
  PreparedRecoveryGenerationCandidate,
  PurgedRecoveryGenerationCandidate,
  RecoveryGenerationObservation,
  RecoveryGenerationObservationPage,
  RecoveryGenerationReplacement,
  SealedRecoveryGenerationCandidate,
  StoredLiveCurrentGeneration,
  StoredTombstoneCurrentGeneration,
  TombstoneCurrentGenerationCandidate,
  TombstoneCurrentGenerationObservation,
} from "@core/mirror/mirror-storage.types";
export { MirrorSynchronizer } from "@core/mirror/mirror-synchronizer";
export type {
  MirrorBootstrapIncompleteReason,
  MirrorBootstrapProgressObserver,
  MirrorBootstrapResult,
  MirrorDeleteObservationResult,
  MirrorFolderRenameResult,
  MirrorPathJobOutcome,
  MirrorRenameObservationResult,
  MirrorSynchronizerPhase,
  MirrorSynchronizerRuntime,
} from "@core/mirror/mirror-synchronizer.types";
export type {
  ReconciliationActionExecutionRejection,
  ReconciliationActionExecutionRequest,
  ReconciliationActionExecutionResult,
} from "@core/mirror/reconciliation-action-execution.types";
export {
  allowedReconciliationActions,
  isReconciliationActionAllowed,
  reconciliationAuthorityForAction,
} from "@core/mirror/reconciliation-decision-policy";
export { isReconciliationEffectDispatchAllowed } from "@core/mirror/reconciliation-effect-dispatch-policy";
export type {
  ExactLocalReconciliationContent,
  ExactRecoveryReconciliationContent,
  ExactRemoteReconciliationContent,
  ReconciliationEffectRuntime,
  ReconciliationRemoteMutationOptions,
  ReconciliationRemoteMutationSettlement,
} from "@core/mirror/reconciliation-effect-executor";
export { ReconciliationEffectExecutor } from "@core/mirror/reconciliation-effect-executor";
export { ReconciliationObservationGenerationOwner } from "@core/mirror/reconciliation-observation";
export {
  fenceActiveReconciliationForObservationGap,
  isGapFencedReconciliationOperation,
} from "@core/mirror/reconciliation-observation-gap";
export {
  isHistoryReconciliationOperation,
  isNonHistoryReconciliationOperation,
  isRefinedHistoryReconciliationOperation,
} from "@core/mirror/reconciliation-operation";
export {
  createReconciliationPreservationPath,
  isReconciliationPreservationPath,
} from "@core/mirror/reconciliation-preservation-path";
export type { RequiredReconciliationPreservation } from "@core/mirror/reconciliation-preservation-policy";
export { requiredReconciliationPreservations } from "@core/mirror/reconciliation-preservation-policy";
export type {
  RecoverySelectionProjection,
  RecoverySelectionState,
} from "@core/mirror/reconciliation-recovery-selection";
export {
  isRecoverySnapshotExpired,
  projectRecoverySelection,
  RECOVERY_SELECTION_STATE,
  recoverySnapshotStatesEqual,
} from "@core/mirror/reconciliation-recovery-selection";
export type {
  ReconciliationAdmissionRequest,
  ReconciliationAdmissionResult,
  ReconciliationAllowedAction,
  ReconciliationDiscoveryResult,
  ReconciliationObservationSource,
  ReconciliationRemoteReader,
  ReconciliationReviewDependencies,
  ReconciliationReviewFailure,
  ReconciliationReviewQuery,
  ReconciliationReviewRequest,
  ReconciliationReviewResult,
  ReconciliationRuntimeIdentitySource,
} from "@core/mirror/reconciliation-review.types";
export { ReconciliationReviewService } from "@core/mirror/reconciliation-review-service";
export { staleOrphanedReconciliationReviews } from "@core/mirror/reconciliation-startup";
export {
  HISTORY_CLEANUP_STEP_KIND,
  HISTORY_CLEANUP_STEP_PHASE,
  HISTORY_DECISION_KIND,
  HISTORY_PROGRESS_KIND,
  HISTORY_REMOTE_EFFECT_KIND,
  LEGACY_V3_LOCAL_EFFECT_RECOVERY_STATE,
  LOCAL_EFFECT_OBSERVATION_KIND,
  MAX_RECONCILIATION_GAP_GROUP_REVIEWS,
  MAX_RECONCILIATION_OPERATIONS,
  MAX_RECONCILIATION_PRESERVATION_RECEIPTS,
  MAX_RECONCILIATION_REVIEWS,
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
export type {
  AcceptTombstoneReconciliationAction,
  AdoptRevisionReconciliationAction,
  DeferReconciliationAction,
  EphemeralReconciliationReview,
  ExecuteCleanupHistoryAdmissionDecision,
  ForkLegacyReconciliationAction,
  HistoryAdmissionDecision,
  HistoryCleanupStep,
  HistoryDecision,
  HistoryRemoteEffect,
  HistoryStepPreservationReceipt,
  IdentifiedLocalEffectObservation,
  KeepBothReconciliationAction,
  KeepLocalReconciliationAction,
  LegacyV3HistoryProgress,
  LocalEffectObservation,
  LocalEffectSuccessorRange,
  ReconciliationAction,
  ReconciliationAdmissionAction,
  ReconciliationAuthoritySource,
  ReconciliationClassification,
  ReconciliationEffectDispatchKind,
  ReconciliationEventKind,
  ReconciliationGapGroupReview,
  ReconciliationGapReviewStatus,
  ReconciliationHistoryOperation,
  ReconciliationLocalEvidence,
  ReconciliationM3PathEvidence,
  ReconciliationNonHistoryOperation,
  ReconciliationObservationCoverage,
  ReconciliationOperation,
  ReconciliationOperationPhase,
  ReconciliationOperationPhaseV3,
  ReconciliationOperationV3,
  ReconciliationOperationV4,
  ReconciliationPathEvidence,
  ReconciliationPathReservation,
  ReconciliationPreservationReceipt,
  ReconciliationPreservationReceiptV3,
  ReconciliationRecoveryEvidence,
  ReconciliationRemoteEvidence,
  ReconciliationReview,
  ReconciliationReviewMetadata,
  ReconciliationReviewRetention,
  ReconciliationReviewSnapshot,
  ReconciliationReviewStatus,
  ReconciliationRuntimeIdentity,
  RecreateRemoteReconciliationAction,
  RefinedHistoryProgress,
  ResolveHistoryAdmissionAction,
  ResolveHistoryReconciliationAction,
  RestoreRecoveryReconciliationAction,
  UseRemoteReconciliationAction,
} from "@core/mirror/reconciliation-state.types";
export {
  projectMirrorDeviceStateV3ToV4,
  projectMirrorDeviceStateV4ToV5,
} from "@core/mirror/reconciliation-state-migration";
export {
  isReconciliationPathReserved,
  isReconciliationStateConsistent,
  isReconciliationStateV4Consistent,
  reconciliationReviewSnapshotsEqual,
} from "@core/mirror/reconciliation-state-validation";
export type { ReconciliationV3LocalEffectRecoveryDependencies } from "@core/mirror/reconciliation-v3-local-effect-recovery";
export { ReconciliationV3LocalEffectRecoveryService } from "@core/mirror/reconciliation-v3-local-effect-recovery";
export type { ReconciliationV3LocalEffectRecoveryResult } from "@core/mirror/reconciliation-v3-local-effect-recovery.types";
export { RecoveryRestoreService } from "@core/mirror/recovery-restore-service";
export { RecoveryService } from "@core/mirror/recovery-service";
export type { RecoverySnapshotRepository } from "@core/mirror/recovery-snapshot-repository.port";
export { REMOTE_BRIDGE_FAILURE } from "@core/mirror/remote-bridge.constants";
export type {
  RemoteBridge,
  RemoteBridgeDescription,
  RemoteBridgeFailure,
  RemoteBridgeMutationResult,
  RemoteBridgeResult,
  RemoteNoteContent,
  RemoteRecoveryContent,
  RemoteRequestAdmission,
  RemoteRequestPermit,
} from "@core/mirror/remote-bridge.types";
export { RemoteTombstoneResolutionService } from "@core/mirror/remote-tombstone-resolution-service";
export type { RenameHistoryGroupResult } from "@core/mirror/rename-history-group-policy";
export { RenameHistoryGroupPolicy } from "@core/mirror/rename-history-group-policy";
export type {
  RenameHistoryResolutionRequest,
  RenameHistoryResolutionResult,
} from "@core/mirror/rename-history-resolution.types";
export type { RenameHistoryResolutionRuntime } from "@core/mirror/rename-history-resolution-service";
export { RenameHistoryResolutionService } from "@core/mirror/rename-history-resolution-service";
export type { ReconciliationOperationSource } from "@core/mirror/resolution-coordinator";
export { ResolutionCoordinator } from "@core/mirror/resolution-coordinator";
export { RevisionedAdoptionService } from "@core/mirror/revisioned-adoption-service";
export {
  decodeNotePath,
  encodeNotePath,
  isNormalizedNotePath,
  normalizeNotePath,
} from "@core/note-path/note-path";
export { BASE64URL_PATTERN } from "@core/note-path/note-path.constants";
export type { NotePath } from "@core/note-path/note-path.types";
export { VaultNoteService } from "@core/vault/note-service";
export type { NoteService } from "@core/vault/note-service.types";
export { MAX_NOTE_SIZE_BYTES } from "@core/vault/vault.constants";
export {
  NotePayloadTooLargeError,
  StoredNoteTooLargeError,
} from "@core/vault/vault.errors";
export type { WriteNoteResult } from "@core/vault/vault.types";
export type { VaultRepository } from "@core/vault/vault-repository.port";
