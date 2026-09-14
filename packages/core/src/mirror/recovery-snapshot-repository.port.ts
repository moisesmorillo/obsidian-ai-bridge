import type {
  RecoveryMutationResult,
  RecoveryPreparationRequest,
  RecoveryPurgeRequest,
  RecoverySealRequest,
  RecoverySnapshotId,
  RecoverySnapshotState,
} from "@core/mirror/mirror.types";

/**
 * Storage-agnostic recovery capability separate from current-note mutation.
 *
 * Implementations preserve prepared material on uncertain or refused transitions;
 * they never use physical deletion as a recovery-state transition.
 */
export interface RecoverySnapshotRepository {
  /** @returns Validated recovery metadata, or `null` only when its identity is absent. */
  read(id: RecoverySnapshotId): Promise<RecoverySnapshotState | null>;

  /** Prepares recovery material before the corresponding current head is tombstoned. */
  prepare(request: RecoveryPreparationRequest): Promise<RecoveryMutationResult>;

  /** Seals a prepared snapshot only with the supplied matching recovery generation. */
  seal(request: RecoverySealRequest): Promise<RecoveryMutationResult>;

  /** Replaces only an eligible expired recovery body with its retained purged marker. */
  purge(request: RecoveryPurgeRequest): Promise<RecoveryMutationResult>;
}
