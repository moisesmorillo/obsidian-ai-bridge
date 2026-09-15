import { MAX_ACTIVE_MIRROR_JOBS } from "@core/mirror/mirror-autosync.constants";

/** One scheduler-owned unit whose promise represents actual resource settlement. */
export interface MirrorScheduledJob {
  /** Stable reservation identity; path jobs use the exact NotePath. */
  readonly key: string;
  /** Runs at most once and settles only after all owned async work is released. */
  readonly run: () => Promise<void>;
}

/**
 * FIFO bounded scheduler with one reservation per key and two global slots.
 *
 * Enqueue order is stable, so a path that becomes dirty again while running joins
 * behind already-ready paths instead of monopolizing a released slot. The scheduler
 * owns reservations through promise settlement; rejected jobs cannot leak slots.
 */
export class FairMirrorScheduler {
  private readonly queued: MirrorScheduledJob[] = [];
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
    if (this.reserved.has(job.key)) return false;
    this.reserved.add(job.key);
    this.queued.push(job);
    this.drain();
    return true;
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
        () => this.settle(job.key),
        () => this.settle(job.key),
      );
    }
  }

  private settle(key: string): void {
    this.activeJobs -= 1;
    this.reserved.delete(key);
    this.drain();
    if (this.activeJobs !== 0 || this.queued.length !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
