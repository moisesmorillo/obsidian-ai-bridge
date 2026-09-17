import { MAX_ACTIVE_MIRROR_JOBS } from "@core/mirror/mirror-autosync.constants";

/** One scheduler-owned unit whose promise represents actual resource settlement. */
export interface MirrorScheduledJob {
  /** Stable primary identity used for FIFO admission and caller diagnostics. */
  readonly key: string;
  /**
   * Complete reservation set. Multi-path work supplies lexical distinct paths;
   * ordinary jobs omit this field and reserve only `key`.
   */
  readonly reservationKeys?: readonly string[];
  /** Runs at most once and settles only after all owned async work is released. */
  readonly run: () => Promise<void>;
}

/** Internal queued job paired with its caller-visible settlement signal. */
interface QueuedMirrorJob extends MirrorScheduledJob {
  /** Resolves the caller-visible completion after successful owned settlement. */
  readonly resolveCompletion: () => void;
  /** Rejects caller-visible completion while still releasing every reservation. */
  readonly rejectCompletion: (reason: Error) => void;
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
    const completion = this.enqueueAndWait(job);
    if (completion === undefined) return false;
    void completion.catch(() => undefined);
    return true;
  }

  /**
   * Admits one job and exposes settlement of that job without waiting for unrelated work.
   *
   * @param job - Complete job and stable reservation identity.
   * @returns Job settlement, or `undefined` when the key is already reserved.
   */
  enqueueAndWait(job: MirrorScheduledJob): Promise<void> | undefined {
    const reservationKeys = normalizedReservationKeys(job);
    if (reservationKeys.some((key) => this.reserved.has(key))) return undefined;
    const completion = Promise.withResolvers<void>();
    reservationKeys.forEach((key) => {
      this.reserved.add(key);
    });
    this.queued.push({
      ...job,
      reservationKeys,
      resolveCompletion: completion.resolve,
      rejectCompletion: completion.reject,
    });
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

  /** Starts queued jobs in FIFO order up to the global limit while retaining their pre-acquired path reservations. */
  private drain(): void {
    while (this.activeJobs < MAX_ACTIVE_MIRROR_JOBS && this.queued.length > 0) {
      const job = this.queued.shift();
      if (job === undefined) break;
      this.activeJobs += 1;
      void job.run().then(
        () => this.settle(job, null),
        () => this.settle(job, new Error("Mirror scheduled job failed.")),
      );
    }
  }

  /** Releases all job reservations after fulfillment/rejection, admits the next jobs and resolves waiters only at idle. */
  private settle(job: QueuedMirrorJob, failure: Error | null): void {
    this.activeJobs -= 1;
    for (const key of normalizedReservationKeys(job)) this.reserved.delete(key);
    if (failure === null) job.resolveCompletion();
    else job.rejectCompletion(failure);
    this.drain();
    if (this.activeJobs !== 0 || this.queued.length !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

/** @returns Validated lexical reservations, falling back to the primary key. */
function normalizedReservationKeys(job: MirrorScheduledJob): readonly string[] {
  const keys = job.reservationKeys ?? [job.key];
  if (
    keys.length === 0 ||
    !keys.includes(job.key) ||
    new Set(keys).size !== keys.length ||
    keys.some(
      (key, index) =>
        index > 0 && (keys[index - 1]?.localeCompare(key) ?? -1) > 0,
    )
  ) {
    throw new Error(
      "Mirror reservations must be distinct and lexically ordered.",
    );
  }
  return [...keys];
}
