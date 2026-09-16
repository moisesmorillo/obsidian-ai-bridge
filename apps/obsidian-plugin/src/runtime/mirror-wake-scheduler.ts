/** Narrow core wake surface consumed by the host timer adapter. */
export interface MirrorWakeSource {
  /** @returns Earliest finite monotonic deadline, or no admissible work. */
  nextWakeAtMilliseconds(): number | null;
  /** Runs work and explicitly reports whether future scheduling remains admissible. */
  synchronizeReady(): Promise<
    { readonly kind: "completed" } | { readonly kind: "fenced" }
  >;
}

/** Injectable one-shot host timer mechanics for deterministic tests. */
export interface MirrorTimerHost {
  /** @returns Monotonic host time in milliseconds. */
  nowMilliseconds(): number;
  /** Schedules one callback and returns its opaque host handle. */
  setTimeout(callback: () => void, delayMilliseconds: number): number;
  /** Cancels one previously scheduled callback. */
  clearTimeout(handle: number): void;
}

/** Minimum delay preventing a stale equal/past deadline from producing a busy loop. */
export const MINIMUM_MIRROR_WAKE_DELAY_MILLISECONDS = 1;

/**
 * Composes exactly one host timeout over core-owned finite deadlines.
 *
 * Retry, coalescing, deletion grace, and evidence policy remain in core. Detaching
 * cancels only the host callback; work already admitted keeps its real settlement.
 */
export class MirrorWakeScheduler {
  private handle: number | null = null;
  private running = false;
  private attached = true;

  /**
   * @param source - Existing core deadline and ready-work facade.
   * @param host - One-shot timer mechanics.
   * @param onSettled - Notification used to refresh sanitized session status.
   */
  constructor(
    private readonly source: MirrorWakeSource,
    private readonly host: MirrorTimerHost,
    private readonly onSettled: () => void,
  ) {}

  /** Reconciles the one host timer with the current earliest finite core deadline. */
  reconcile(): void {
    if (!this.attached || this.running) return;
    this.cancelScheduled();
    const deadline = this.source.nextWakeAtMilliseconds();
    if (deadline === null || !Number.isFinite(deadline)) return;
    const delay = Math.max(
      MINIMUM_MIRROR_WAKE_DELAY_MILLISECONDS,
      Math.ceil(deadline - this.host.nowMilliseconds()),
    );
    this.handle = this.host.setTimeout(() => {
      this.handle = null;
      if (!this.attached) return;
      this.running = true;
      void this.source
        .synchronizeReady()
        .then((result) => {
          this.running = false;
          if (!this.attached) return;
          this.onSettled();
          if (result.kind === "completed") this.reconcile();
        })
        .catch(() => {
          this.running = false;
          if (!this.attached) return;
          this.onSettled();
        });
    }, delay);
  }

  /** Detaches future host callbacks without claiming active core work was cancelled. */
  detach(): void {
    this.attached = false;
    this.cancelScheduled();
  }

  private cancelScheduled(): void {
    if (this.handle === null) return;
    this.host.clearTimeout(this.handle);
    this.handle = null;
  }
}

/** Browser/Obsidian one-shot timer adapter using monotonic `performance.now`. */
export class BrowserMirrorTimerHost implements MirrorTimerHost {
  /** @inheritdoc */
  nowMilliseconds(): number {
    return performance.now();
  }

  /** @inheritdoc */
  setTimeout(callback: () => void, delayMilliseconds: number): number {
    return window.setTimeout(callback, delayMilliseconds);
  }

  /** @inheritdoc */
  clearTimeout(handle: number): void {
    window.clearTimeout(handle);
  }
}
