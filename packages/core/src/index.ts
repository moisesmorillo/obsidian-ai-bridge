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
