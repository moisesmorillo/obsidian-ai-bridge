import type { ReconciliationObservationSource } from "@core/mirror/reconciliation-review.types";
import type { NotePath } from "@core/note-path/note-path.types";

/**
 * Process-local monotonic observation owner used to fence equal-text local events.
 * It is intentionally not a persisted filesystem revision.
 */
export class ReconciliationObservationGenerationOwner
  implements ReconciliationObservationSource
{
  private nextGeneration = 0;
  private readonly generations = new Map<NotePath, number>();

  /**
   * Reuses an existing generation or assigns the first identity for a path.
   * @param path - Path receiving its first sample.
   * @returns Existing or newly allocated positive generation.
   */
  ensure(path: NotePath): number {
    const existing = this.generations.get(path);
    if (existing !== undefined) return existing;
    return this.allocate(path);
  }

  /**
   * Allocates a generation that invalidates all earlier samples for a path.
   * @param path - Path carried by a saved-file event.
   * @returns New generation that invalidates prior samples.
   */
  observe(path: NotePath): number {
    return this.allocate(path);
  }

  /**
   * Reads the current generation without changing it.
   * @param path - Path whose sampled identity is being checked.
   * @returns Current generation or zero before sampling.
   */
  current(path: NotePath): number {
    return this.generations.get(path) ?? 0;
  }

  /**
   * Allocates one generation from the owner-wide sequence.
   * @param path - Path receiving the allocated identity.
   * @returns The allocated positive generation.
   */
  private allocate(path: NotePath): number {
    this.nextGeneration += 1;
    this.generations.set(path, this.nextGeneration);
    return this.nextGeneration;
  }
}
