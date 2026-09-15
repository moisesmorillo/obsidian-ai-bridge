import {
  MIRROR_COALESCING_QUIET_PERIOD_MILLISECONDS,
  MIRROR_FINAL_MUTATION_RETRY_DELAY_MILLISECONDS,
  MIRROR_MAX_COALESCING_WAIT_MILLISECONDS,
  MIRROR_MUTATION_RETRY_DELAY_MILLISECONDS,
} from "@core/mirror/mirror-autosync.constants";
import { MIRROR_DESIRED_STATE_KIND } from "@core/mirror/mirror-state.constants";
import type { MirrorPathState } from "@core/mirror/mirror-state.types";
import type { NotePath } from "@core/note-path/note-path.types";

/** Ephemeral scheduling facts for one path; none grant durable mutation authority. */
interface PathRuntimeState {
  readonly firstObservedAt: number;
  readonly lastObservedAt: number;
  readonly generation: number;
  readonly nextRetryAt: number;
  readonly bootstrapInspectionRequired: boolean;
}

/**
 * Owns positive-event coalescing, retry deadlines, and bootstrap-inspection markers.
 *
 * Durable desired state remains authoritative. This tracker only answers when admitted
 * work is ready and is safe to rebuild conservatively after restart.
 */
export class MirrorPathRuntime {
  private readonly pathState = new Map<NotePath, PathRuntimeState>();
  private observationGeneration = 0;

  /** @returns A process-local strictly increasing observation generation. */
  nextGeneration(): number {
    this.observationGeneration += 1;
    return this.observationGeneration;
  }

  /**
   * Records one positive observation without weakening a newer in-memory generation.
   *
   * @param path - Observed eligible path.
   * @param generation - Durable desired-state generation for the observation.
   * @param now - Monotonic observation time in milliseconds.
   * @param bootstrapInspectionRequired - Whether remote baseline inspection is required.
   * @param startNewCoalescingWindow - Whether this begins a new quiet/max-wait window.
   */
  recordObservation(
    path: NotePath,
    generation: number,
    now: number,
    bootstrapInspectionRequired: boolean,
    startNewCoalescingWindow: boolean,
  ): void {
    const current = this.pathState.get(path);
    if (
      bootstrapInspectionRequired &&
      current !== undefined &&
      current.generation > generation
    ) {
      this.pathState.set(path, {
        ...current,
        bootstrapInspectionRequired: true,
      });
      return;
    }
    this.pathState.set(path, {
      firstObservedAt: startNewCoalescingWindow
        ? now
        : (current?.firstObservedAt ?? now),
      lastObservedAt: now,
      generation,
      nextRetryAt: current?.nextRetryAt ?? now,
      bootstrapInspectionRequired:
        bootstrapInspectionRequired ||
        current?.bootstrapInspectionRequired === true,
    });
  }

  /** @returns Whether first reconciliation must verify the remote baseline. */
  requiresBootstrapInspection(path: NotePath): boolean {
    return this.pathState.get(path)?.bootstrapInspectionRequired === true;
  }

  /** Clears a completed remote baseline inspection for one path. */
  clearBootstrapInspection(path: NotePath): void {
    const current = this.pathState.get(path);
    if (current === undefined) return;
    this.pathState.set(path, {
      ...current,
      bootstrapInspectionRequired: false,
    });
  }

  /**
   * @param entry - Durable path state under consideration.
   * @param now - Current monotonic time in milliseconds.
   * @returns Whether coalescing or retry policy admits the path now.
   */
  isReady(entry: MirrorPathState, now: number): boolean {
    if (entry.blockedReason !== null) return false;
    const runtime = this.pathState.get(entry.path);
    if (entry.unresolvedMutation !== null) {
      return runtime === undefined || now >= runtime.nextRetryAt;
    }
    if (entry.desired.kind !== MIRROR_DESIRED_STATE_KIND.dirtyPresent) {
      return false;
    }
    if (runtime === undefined) return true;
    return now >= coalescingDeadline(runtime);
  }

  /**
   * @param entries - Durably tracked paths after global admission checks.
   * @param now - Current monotonic time used for conservative unresolved wakeups.
   * @returns Earliest pending deadline, or no wake when no path is schedulable.
   */
  nextWakeAtMilliseconds(
    entries: readonly MirrorPathState[],
    now: number,
  ): number | null {
    const deadlines = entries.flatMap((entry) => {
      if (entry.blockedReason !== null) return [];
      const runtime = this.pathState.get(entry.path);
      if (entry.unresolvedMutation !== null) {
        return [runtime?.nextRetryAt ?? now];
      }
      if (
        entry.desired.kind !== MIRROR_DESIRED_STATE_KIND.dirtyPresent ||
        runtime === undefined
      ) {
        return [];
      }
      return [coalescingDeadline(runtime)];
    });
    return deadlines.length === 0 ? null : Math.min(...deadlines);
  }

  /** Schedules the next finite mutation retry for one consumed attempt count. */
  scheduleRetry(
    path: NotePath,
    generation: number,
    now: number,
    attempts: number,
  ): void {
    const delay =
      attempts <= 1
        ? MIRROR_MUTATION_RETRY_DELAY_MILLISECONDS
        : MIRROR_FINAL_MUTATION_RETRY_DELAY_MILLISECONDS;
    this.pathState.set(path, {
      ...runtimeFor(this.pathState.get(path), generation, now),
      nextRetryAt: now + delay,
    });
  }

  /** Makes evidence inspection ready immediately after an uncertain effect. */
  scheduleImmediate(path: NotePath, generation: number, now: number): void {
    this.pathState.set(path, {
      ...runtimeFor(this.pathState.get(path), generation, now),
      nextRetryAt: now,
    });
  }

  /** Restores an explicitly granted retry budget as immediately ready. */
  recordRetryGrant(path: NotePath, generation: number, now: number): void {
    const current = this.pathState.get(path);
    this.pathState.set(path, {
      firstObservedAt: current?.firstObservedAt ?? now,
      lastObservedAt: current?.lastObservedAt ?? now,
      generation: current?.generation ?? generation,
      nextRetryAt: now,
      bootstrapInspectionRequired:
        current?.bootstrapInspectionRequired ?? false,
    });
  }
}

/** @returns Quiet/max-wait deadline for one positive observation window. */
function coalescingDeadline(runtime: PathRuntimeState): number {
  return Math.min(
    runtime.lastObservedAt + MIRROR_COALESCING_QUIET_PERIOD_MILLISECONDS,
    runtime.firstObservedAt + MIRROR_MAX_COALESCING_WAIT_MILLISECONDS,
  );
}

/**
 * @param current - Existing path runtime state, when available.
 * @param generation - Durable desired generation for a new baseline.
 * @param now - Current monotonic time in milliseconds.
 * @returns Existing runtime state or a conservative immediately-ready baseline.
 */
function runtimeFor(
  current: PathRuntimeState | undefined,
  generation: number,
  now: number,
): PathRuntimeState {
  return (
    current ?? {
      firstObservedAt: now,
      lastObservedAt: now,
      generation,
      nextRetryAt: now,
      bootstrapInspectionRequired: false,
    }
  );
}
