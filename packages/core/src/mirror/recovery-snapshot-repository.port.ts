import type {
  MutationEffectResult,
  RecoverySnapshotId,
} from "@core/mirror/mirror.types";
import type {
  ObservedPreparedRecoveryGeneration,
  PreparedRecoveryGenerationCandidate,
  RecoveryGenerationObservation,
  RecoveryGenerationObservationPage,
} from "@core/mirror/mirror-storage.types";

/**
 * Storage-agnostic recovery capability separate from current-note mutation policy.
 *
 * Implementations expose create-only preparation and generation-bound CAS; native
 * deletion and unconditional replacement are intentionally unrepresentable.
 */
export interface RecoverySnapshotRepository {
  /** @returns Exact validated recovery data, or `null` only when its key is absent. */
  read(id: RecoverySnapshotId): Promise<RecoveryGenerationObservation | null>;

  /**
   * Creates prepared recovery material only when its exact identity is absent.
   *
   * @returns The exact prepared generation and its CAS capability on confirmation.
   */
  create(
    candidate: PreparedRecoveryGenerationCandidate,
  ): Promise<MutationEffectResult<ObservedPreparedRecoveryGeneration>>;

  /**
   * Scans one bounded page of recovery objects and strips plaintext from metadata.
   *
   * @param cursor - Opaque storage continuation supplied by a previous page.
   * @returns Validated recovery metadata and optional continuation.
   */
  list(cursor?: string): Promise<RecoveryGenerationObservationPage>;
}
