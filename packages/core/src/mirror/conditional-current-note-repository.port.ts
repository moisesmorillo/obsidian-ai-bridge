import type { MutationEffectResult } from "@core/mirror/mirror.types";
import type {
  CurrentGenerationObservation,
  CurrentGenerationObservationPage,
  LiveCurrentGenerationCandidate,
  StoredLiveCurrentGeneration,
} from "@core/mirror/mirror-storage.types";
import type { NotePath } from "@core/note-path/note-path.types";

/**
 * Storage-agnostic current-generation capability beneath application mutation policy.
 *
 * Reads retain opaque generation-bound replacement capabilities. Implementations
 * expose no replace-any operation and keep storage validators private.
 */
export interface ConditionalCurrentNoteRepository {
  /** @returns One exact recognized observation, including plaintext only for readable states. */
  read(path: NotePath): Promise<CurrentGenerationObservation>;

  /**
   * Attempts an atomic create-only write for an application-assembled live generation.
   *
   * @returns Exact successful storage metadata or conservative effect certainty.
   */
  create(
    path: NotePath,
    candidate: LiveCurrentGenerationCandidate,
  ): Promise<MutationEffectResult<StoredLiveCurrentGeneration>>;

  /**
   * Scans one bounded storage page and validates every recognized current object.
   *
   * @param cursor - Opaque storage continuation supplied by a previous page.
   * @returns Metadata states before application visibility filtering.
   */
  list(cursor?: string): Promise<CurrentGenerationObservationPage>;
}
