import type {
  SyncContinueInventoryInput,
  SyncInventoryResult,
  SyncMutationRequest,
  SyncMutationResult,
  SyncReadChangesInput,
  SyncReadChangesResult,
  SyncReadCurrentInput,
  SyncReadCurrentResult,
  SyncReadInventoryPageInput,
  SyncReadInventoryPageResult,
  SyncReadRecoveryInput,
  SyncReadRecoveryResult,
  SyncReadVersionInput,
  SyncReadVersionResult,
  SyncResumeOperationInput,
  SyncResumeOperationResult,
  SyncStartInventoryInput,
} from "@core/sync/sync-store.types";

/**
 * Storage-independent contract for protocol-major-one versioned note state.
 *
 * Implementations validate branded identities/cursors at the boundary and return
 * typed failures; they expose neither generic bucket access nor backend handles.
 */
export interface SyncStore {
  /** Reads a path head, distinguishing verified never-seen absence from a tombstone.
   * @param input Validated vault and canonical path to observe.
   * @returns Current state or an explicit typed failure.
   */
  readCurrent(input: SyncReadCurrentInput): Promise<SyncReadCurrentResult>;

  /** Conditionally publishes a new revision and returns only verified committed success.
   * @param request Exact parent, payload digest, operation identity, and target state.
   * @returns Committed revision and feed position, or a typed non-success result.
   */
  mutate(request: SyncMutationRequest): Promise<SyncMutationResult>;

  /** Reads one immutable live or tombstone version by its revision identity.
   * @param input Validated vault and exact immutable revision identity.
   * @returns Present version, absent version, or typed failure.
   */
  readVersion(input: SyncReadVersionInput): Promise<SyncReadVersionResult>;

  /** Reads immutable recovery bytes by the operation that created the tombstone.
   * @param input Validated vault and exact tombstone operation identity.
   * @returns Present recovery, absent recovery, or typed failure.
   */
  readRecovery(input: SyncReadRecoveryInput): Promise<SyncReadRecoveryResult>;

  /** Returns at most 100 metadata-only change events and a vault-bound continuation.
   * @param input Validated vault and opaque protocol checkpoint cursor.
   * @returns One bounded event page or typed cursor/storage failure.
   */
  readChanges(input: SyncReadChangesInput): Promise<SyncReadChangesResult>;

  /** Creates or resumes the exact inventory identified by the input scan ID.
   * @param input Validated vault and stable inventory identity.
   * @returns Resumable progress, a verified complete handle, or typed failure.
   */
  startInventory(input: SyncStartInventoryInput): Promise<SyncInventoryResult>;

  /** Performs one bounded continuation step without exposing partial entries as complete.
   * @param input Vault and scan identity returned for this exact inventory.
   * @returns Resumable progress, a verified complete handle, or typed failure.
   */
  continueInventory(
    input: SyncContinueInventoryInput,
  ): Promise<SyncInventoryResult>;

  /** Pages evidence only for a complete handle and marks finality after count/root verification.
   * @param input Complete vault-bound handle and opaque verified-evidence cursor.
   * @returns At most 16 verified summaries, a final marker, or typed failure.
   */
  readInventoryPage(
    input: SyncReadInventoryPageInput,
  ): Promise<SyncReadInventoryPageResult>;

  /** Resumes one exact mutation operation without converting pending/unknown evidence to success.
   * @param input Validated vault and original stable operation identity.
   * @returns Verified committed result or a pending/unknown/failure outcome.
   */
  resumeOperation(
    input: SyncResumeOperationInput,
  ): Promise<SyncResumeOperationResult>;
}
