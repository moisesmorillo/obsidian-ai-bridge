import type {
  ConditionalMutationRequest,
  ConditionalMutationResult,
  CurrentNoteState,
} from "@core/mirror/mirror.types";
import type { NotePath } from "@core/note-path/note-path.types";

/**
 * Storage-agnostic current-generation capability for safe M3 note mutations.
 *
 * Implementations translate exact application preconditions to their storage CAS
 * primitive and never expose a replace-any operation.
 */
export interface ConditionalCurrentNoteRepository {
  /** @returns The recognized current state, including absence and legacy blockers. */
  readCurrent(path: NotePath): Promise<CurrentNoteState>;

  /**
   * Applies one exact conditional request.
   *
   * @returns A closed effect result; callers must retain unknown outcomes for exact receipt evidence.
   */
  mutate(
    request: ConditionalMutationRequest,
  ): Promise<ConditionalMutationResult>;
}
