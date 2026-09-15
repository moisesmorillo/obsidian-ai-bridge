import type { ReadOnlyLocalVault } from "@core/local-vault/read-only-local-vault.port";
import { FairMirrorScheduler } from "@core/mirror/fair-mirror-scheduler";
import { MIRROR_SYNCHRONIZER_PHASE } from "@core/mirror/mirror-autosync.constants";
import {
  findMirrorPath,
  upsertDirtyPath,
} from "@core/mirror/mirror-autosync-state";
import { MirrorBootstrapCoordinator } from "@core/mirror/mirror-bootstrap";
import { MirrorIntentExecutor } from "@core/mirror/mirror-intent-executor";
import type { MirrorInventoryResult } from "@core/mirror/mirror-inventory";
import { MirrorPathRuntime } from "@core/mirror/mirror-path-runtime";
import { MirrorPathStatusWriter } from "@core/mirror/mirror-path-status";
import { MirrorPositiveReconciler } from "@core/mirror/mirror-positive-reconciler";
import { MIRROR_DESIRED_STATE_KIND } from "@core/mirror/mirror-state.constants";
import type { MirrorStateSnapshot } from "@core/mirror/mirror-state.types";
import type { MirrorStateOwner } from "@core/mirror/mirror-state-owner";
import type {
  MirrorBootstrapResult,
  MirrorPathJobOutcome,
  MirrorSynchronizerPhase,
  MirrorSynchronizerRuntime,
} from "@core/mirror/mirror-synchronizer.types";
import type { RemoteBridge } from "@core/mirror/remote-bridge.types";
import type { NotePath } from "@core/note-path/note-path.types";

/**
 * Public core facade for M3 positive autosynchronization.
 *
 * The facade owns the global lifecycle phase and shared two-slot scheduler. Bootstrap,
 * coalescing, positive reconciliation, and unresolved-intent execution are delegated
 * to focused policy owners that share the same durable `MirrorStateOwner` authority.
 * It deliberately has no delete/rename authority or host callback knowledge.
 */
export class MirrorSynchronizer {
  private readonly scheduler = new FairMirrorScheduler();
  private readonly pathRuntime = new MirrorPathRuntime();
  private readonly outcomes = new Map<NotePath, MirrorPathJobOutcome>();
  private readonly bootstrapCoordinator: MirrorBootstrapCoordinator;
  private readonly intentExecutor: MirrorIntentExecutor;
  private readonly reconciler: MirrorPositiveReconciler;
  private phase: MirrorSynchronizerPhase = MIRROR_SYNCHRONIZER_PHASE.inactive;
  private bootstrapOperation: Promise<MirrorBootstrapResult> | null = null;

  /**
   * @param local - Saved-file read/list capability with M2 eligibility guarantees.
   * @param remote - Conditional remote bridge; every call performs one attempt only.
   * @param stateOwner - Sole durable ledger transition owner.
   * @param runtime - Deterministic time, digest, and operation-identity seams.
   */
  constructor(
    local: ReadOnlyLocalVault,
    remote: RemoteBridge,
    private readonly stateOwner: MirrorStateOwner,
    private readonly runtime: MirrorSynchronizerRuntime,
  ) {
    const status = new MirrorPathStatusWriter(stateOwner, (outcome) =>
      this.outcomes.set(outcome.path, outcome),
    );
    this.intentExecutor = new MirrorIntentExecutor(
      local,
      remote,
      stateOwner,
      runtime,
      this.pathRuntime,
      status,
    );
    this.reconciler = new MirrorPositiveReconciler(
      local,
      remote,
      stateOwner,
      runtime,
      this.pathRuntime,
      this.intentExecutor,
      status,
    );
    this.bootstrapCoordinator = new MirrorBootstrapCoordinator(
      local,
      remote,
      stateOwner,
      this.scheduler,
      runtime,
      this.pathRuntime,
    );
  }

  /** @returns Most recent sanitized outcome for a path, if any. */
  outcome(path: NotePath): MirrorPathJobOutcome | undefined {
    return this.outcomes.get(path);
  }

  /** @returns Most recent bounded inventory result; never deletion evidence. */
  inventoryResult(): MirrorInventoryResult | null {
    return this.bootstrapCoordinator.inventoryResult();
  }

  /** @returns Current core-owned bootstrap/admission phase for status reporting. */
  currentPhase(): MirrorSynchronizerPhase {
    return this.phase;
  }

  /**
   * Records a positive saved-file observation and collapses prior positive work.
   *
   * New observations never alter an existing unresolved intent or its budgets. A
   * generation increment during a local read or remote PUT invalidates that work's
   * claim to have synchronized the latest desired state.
   *
   * @param path - Eligible validated saved-file path.
   * @returns Post-settlement owner snapshot.
   */
  async observePresent(path: NotePath): Promise<MirrorStateSnapshot> {
    const generation = this.pathRuntime.nextGeneration();
    const now = this.runtime.nowMilliseconds();
    const current = findMirrorPath(this.stateOwner.snapshot().state, path);
    this.pathRuntime.recordObservation(
      path,
      generation,
      now,
      false,
      current?.desired.kind !== MIRROR_DESIRED_STATE_KIND.dirtyPresent,
    );
    const result = await this.stateOwner.transition((state) =>
      upsertDirtyPath(state, path, generation),
    );
    return result.snapshot;
  }

  /**
   * Performs one deduplicated fail-closed bootstrap operation.
   *
   * Positive events may still be recorded while bootstrap is pending. Successful
   * durable admission enables positive reconciliation before reporting inventory
   * necessarily completes.
   *
   * @returns Explicit completion/incompleteness and unassociated remote reporting.
   */
  bootstrap(): Promise<MirrorBootstrapResult> {
    if (this.bootstrapOperation !== null) return this.bootstrapOperation;
    const operation = this.runBootstrap().finally(() => {
      if (this.bootstrapOperation === operation) this.bootstrapOperation = null;
    });
    this.bootstrapOperation = operation;
    return operation;
  }

  /** @returns Focused bootstrap result while retaining facade phase ownership. */
  private async runBootstrap(): Promise<MirrorBootstrapResult> {
    const result = await this.bootstrapCoordinator.run(
      () => {
        this.phase = MIRROR_SYNCHRONIZER_PHASE.bootstrapping;
      },
      () => {
        this.phase = MIRROR_SYNCHRONIZER_PHASE.observing;
      },
    );
    if (result.kind !== "complete") {
      this.phase = MIRROR_SYNCHRONIZER_PHASE.inactive;
    }
    return result;
  }

  /**
   * Returns the next finite coalescing or retry deadline for host timer composition.
   *
   * `null` means admission is closed or no unblocked path needs a wake. The caller
   * schedules one bounded host timer and invokes `synchronizeReady`; it must not poll.
   *
   * @returns Earliest monotonic deadline, or no pending wake.
   */
  nextWakeAtMilliseconds(): number | null {
    const snapshot = this.stateOwner.snapshot();
    if (
      this.phase !== MIRROR_SYNCHRONIZER_PHASE.observing ||
      !snapshot.mutationAdmissionAllowed
    ) {
      return null;
    }
    return this.pathRuntime.nextWakeAtMilliseconds(
      snapshot.state.paths,
      this.runtime.nowMilliseconds(),
    );
  }

  /**
   * Runs every path currently ready under coalescing or retry policy.
   *
   * Jobs enter in lexical order for a stable scan and remain FIFO. At most two execute
   * globally, and duplicate reservations for one path are refused.
   *
   * @returns When all jobs admitted by this pass have settled.
   */
  async synchronizeReady(): Promise<void> {
    const now = this.runtime.nowMilliseconds();
    const snapshot = this.stateOwner.snapshot();
    if (
      this.phase !== MIRROR_SYNCHRONIZER_PHASE.observing ||
      !snapshot.mutationAdmissionAllowed
    ) {
      return;
    }
    const ready = snapshot.state.paths
      .filter(
        (entry) =>
          !this.scheduler.isReserved(entry.path) &&
          this.pathRuntime.isReady(entry, now),
      )
      .toSorted((left, right) => left.path.localeCompare(right.path));
    const completions = ready.flatMap((entry) => {
      const completion = this.scheduler.enqueueAndWait({
        key: entry.path,
        run: () => this.reconciler.run(entry.path),
      });
      return completion === undefined ? [] : [completion];
    });
    await Promise.all(completions);
  }

  /**
   * Grants fresh finite budgets to the exact unresolved reconstructible intent.
   *
   * @param path - Path whose unresolved intent receives an explicit retry grant.
   * @returns Whether the durable grant committed.
   */
  async grantRetry(path: NotePath): Promise<boolean> {
    return this.intentExecutor.grantRetry(path);
  }
}
