import { MAX_ACTIVE_MIRROR_JOBS } from "@core/mirror/mirror-autosync.constants";

/** One scheduler-owned unit whose promise represents actual resource settlement. */
export interface MirrorScheduledJob {
  /** Stable reservation identity; path jobs use the exact NotePath. */
  readonly key: string;
  /** Runs at most once and settles only after all owned async work is released. */
  readonly run: () => Promise<void>;
}

/** Internal queued job paired with its caller-visible settlement signal. */
interface QueuedMirrorJob extends MirrorScheduledJob {
  /** Resolves the caller-visible completion after the owned job settles. */
  readonly resolveCompletion: () => void;
}

/**
 * FIFO bounded scheduler with one reservation per key and two global slots.
 *
 * Enqueue order is stable, so a path that becomes dirty again while running joins
 * behind already-ready paths instead of monopolizing a released slot. The scheduler
 * owns reservations through promise settlement; rejected jobs cannot leak slots.
 */
export class FairMirrorScheduler {
  private readonly queued: QueuedMirrorJob[] = [];
  private readonly reserved = new Set<string>();
  private readonly idleWaiters = new Set<() => void>();
  private activeJobs = 0;

  /** @returns Number of jobs whose asynchronous work has not settled. */
  activeCount(): number {
    return this.activeJobs;
  }

  /**
   * @param key - Reservation identity to inspect.
   * @returns Whether a queued or active job owns the supplied reservation key.
   */
  isReserved(key: string): boolean {
    return this.reserved.has(key);
  }

  /**
   * Admits one job unless the same key is already queued or active.
   *
   * @param job - Complete job and stable reservation identity.
   * @returns Whether the job was admitted.
   */
  enqueue(job: MirrorScheduledJob): boolean {
    return this.enqueueAndWait(job) !== undefined;
  }

  /**
   * Admits one job and exposes settlement of that job without waiting for unrelated work.
   *
   * @param job - Complete job and stable reservation identity.
   * @returns Job settlement, or `undefined` when the key is already reserved.
   */
  enqueueAndWait(job: MirrorScheduledJob): Promise<void> | undefined {
    if (this.reserved.has(job.key)) return undefined;
    const completion = Promise.withResolvers<void>();
    this.reserved.add(job.key);
    this.queued.push({ ...job, resolveCompletion: completion.resolve });
    this.drain();
    return completion.promise;
  }

  /** @returns A promise resolved when all currently admitted jobs have settled. */
  whenIdle(): Promise<void> {
    if (this.activeJobs === 0 && this.queued.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private drain(): void {
    while (this.activeJobs < MAX_ACTIVE_MIRROR_JOBS && this.queued.length > 0) {
      const job = this.queued.shift();
      if (job === undefined) break;
      this.activeJobs += 1;
      void job.run().then(
        () => this.settle(job),
        () => this.settle(job),
      );
    }
  }

  private settle(job: QueuedMirrorJob): void {
    this.activeJobs -= 1;
    this.reserved.delete(job.key);
    job.resolveCompletion();
    this.drain();
    if (this.activeJobs !== 0 || this.queued.length !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
