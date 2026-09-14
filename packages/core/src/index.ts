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
export type { ConditionalCurrentNoteRepository } from "@core/mirror/conditional-current-note-repository.port";
export {
  APPLICATION_ETAG_PREFIX,
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  CONTENT_SHA_256_PATTERN,
  CURRENT_NOTE_STATE_KIND,
  MAX_MIRROR_CURSOR_LENGTH,
  MAX_MIRROR_PAGE_SIZE,
  MAX_MUTATION_ATTEMPTS,
  MAX_MUTATION_EVIDENCE_ATTEMPTS,
  MUTATION_ACTION,
  MUTATION_ACTIONS,
  MUTATION_EFFECT_CERTAINTY,
  RECOVERY_SNAPSHOT_STATE_KIND,
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
  UnresolvedCreateMutationIntent,
  UnresolvedMutationIntent,
  UnresolvedTombstoneMutationIntent,
  UnresolvedUpdateMutationIntent,
  UpdateOperationReceipt,
} from "@core/mirror/mirror.types";
export {
  createApplicationEtag,
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  createRecoverySnapshotId,
  isApplicationEtag,
  isContentSha256,
  isUuidV4,
} from "@core/mirror/mirror-identifiers";
export type { RecoverySnapshotRepository } from "@core/mirror/recovery-snapshot-repository.port";
export {
  decodeNotePath,
  encodeNotePath,
  isNormalizedNotePath,
  normalizeNotePath,
} from "@core/note-path/note-path";
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
