import type { ReadOnlyLocalVault } from "@core/local-vault/read-only-local-vault.port";
import { FairMirrorScheduler } from "@core/mirror/fair-mirror-scheduler";
import { MIRROR_SYNCHRONIZER_PHASE } from "@core/mirror/mirror-autosync.constants";
import { findMirrorPath } from "@core/mirror/mirror-autosync-state";
import { MirrorBootstrapCoordinator } from "@core/mirror/mirror-bootstrap";
import { MirrorDeletionExecutor } from "@core/mirror/mirror-deletion-executor";
import { MirrorIntentExecutor } from "@core/mirror/mirror-intent-executor";
import type { MirrorInventoryResult } from "@core/mirror/mirror-inventory";
import { MirrorLifecyclePlanner } from "@core/mirror/mirror-lifecycle-planner";
import { MirrorPathRuntime } from "@core/mirror/mirror-path-runtime";
import { MirrorPathStatusWriter } from "@core/mirror/mirror-path-status";
import { MirrorPositiveReconciler } from "@core/mirror/mirror-positive-reconciler";
import { MirrorRenameExecutor } from "@core/mirror/mirror-rename-executor";
import { MIRROR_DESIRED_STATE_KIND } from "@core/mirror/mirror-state.constants";
import type {
  MirrorPathState,
  MirrorStateSnapshot,
} from "@core/mirror/mirror-state.types";
import type { MirrorStateOwner } from "@core/mirror/mirror-state-owner";
import type {
  MirrorBootstrapProgressObserver,
  MirrorBootstrapResult,
  MirrorDeleteObservationResult,
  MirrorFolderRenameResult,
  MirrorPathJobOutcome,
  MirrorRenameObservationResult,
  MirrorSynchronizerPhase,
  MirrorSynchronizerRuntime,
} from "@core/mirror/mirror-synchronizer.types";
import { isReconciliationPathReserved } from "@core/mirror/reconciliation-state-validation";
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
  private readonly deletionExecutor: MirrorDeletionExecutor;
  private readonly intentExecutor: MirrorIntentExecutor;
  private readonly lifecyclePlanner: MirrorLifecyclePlanner;
  private readonly reconciler: MirrorPositiveReconciler;
  private readonly renameExecutor: MirrorRenameExecutor;
  private phase: MirrorSynchronizerPhase = MIRROR_SYNCHRONIZER_PHASE.inactive;
  private bootstrapOperation: Promise<MirrorBootstrapResult> | null = null;
  private readonly bootstrapObservers =
    new Set<MirrorBootstrapProgressObserver>();

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
    this.pathRuntime.initializeDestructiveGrace(
      stateOwner.snapshot().state.paths,
      runtime.nowMilliseconds(),
    );
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
    this.deletionExecutor = new MirrorDeletionExecutor(
      local,
      remote,
      stateOwner,
      runtime,
      this.pathRuntime,
      this.intentExecutor,
      status,
    );
    this.renameExecutor = new MirrorRenameExecutor(
      stateOwner,
      this.reconciler,
      this.intentExecutor,
      this.deletionExecutor,
      status,
    );
    this.lifecyclePlanner = new MirrorLifecyclePlanner(
      stateOwner,
      runtime,
      this.pathRuntime,
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
    await this.lifecyclePlanner.observePresent(path);
    return this.stateOwner.snapshot();
  }

  /**
   * Accepts one origin-agnostic post-bootstrap runtime delete observation.
   *
   * Obsidian exposes no reliable human/local/iCloud origin flag. Every runtime event
   * therefore uses the same authority rule, while pre-bootstrap calls fail closed.
   *
   * @param path - Exact eligible path carried by the runtime event.
   * @returns Whether durable deletion authority was committed.
   */
  async observeDelete(path: NotePath): Promise<MirrorDeleteObservationResult> {
    if (this.phase !== MIRROR_SYNCHRONIZER_PHASE.observing) {
      return { kind: "inactive" };
    }
    return this.lifecyclePlanner.observeDelete(path);
  }

  /**
   * Persists one eligible rename plan before destination or cleanup dispatch.
   *
   * @param sourcePath - Previously observed eligible source identity.
   * @param destinationPath - Newly observed eligible destination identity.
   * @returns Durable plan admission outcome.
   */
  async observeRename(
    sourcePath: NotePath,
    destinationPath: NotePath,
  ): Promise<MirrorRenameObservationResult> {
    if (this.phase !== MIRROR_SYNCHRONIZER_PHASE.observing) {
      return { kind: "inactive" };
    }
    return this.lifecyclePlanner.observeRename(sourcePath, destinationPath);
  }

  /**
   * Records an eligible source moving to a destination that must never be read.
   *
   * @param sourcePath - Previously observed eligible source identity.
   * @returns Durable cleanup-evidence admission outcome.
   */
  async observeRenameOutOfEligibility(
    sourcePath: NotePath,
  ): Promise<MirrorRenameObservationResult> {
    if (this.phase !== MIRROR_SYNCHRONIZER_PHASE.observing) {
      return { kind: "inactive" };
    }
    return this.lifecyclePlanner.observeRename(sourcePath, null);
  }

  /**
   * Expands only pre-event indexed descendants; it performs no body/network work.
   *
   * @param oldFolder - Literal pre-event folder prefix without a trailing slash.
   * @param newFolder - Eligible destination prefix, or `null` when excluded.
   * @returns Bounded expansion and deferral counts.
   */
  async observeFolderRename(
    oldFolder: string,
    newFolder: string | null,
  ): Promise<MirrorFolderRenameResult> {
    if (this.phase !== MIRROR_SYNCHRONIZER_PHASE.observing) {
      return { planned: 0, deferred: 0, knownDescendants: 0 };
    }
    return this.lifecyclePlanner.observeFolderRename(oldFolder, newFolder);
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
  bootstrap(
    observer?: MirrorBootstrapProgressObserver,
  ): Promise<MirrorBootstrapResult> {
    if (observer !== undefined) {
      this.bootstrapObservers.add(observer);
      if (
        this.bootstrapOperation !== null &&
        this.phase === MIRROR_SYNCHRONIZER_PHASE.observing
      ) {
        observer.onPositiveAdmission();
      }
    }
    if (this.bootstrapOperation !== null) return this.bootstrapOperation;
    const operation = this.runBootstrap().finally(() => {
      if (this.bootstrapOperation === operation) {
        this.bootstrapOperation = null;
        this.bootstrapObservers.clear();
      }
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
        for (const observer of this.bootstrapObservers) {
          observer.onPositiveAdmission();
        }
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
      snapshot.state.paths.filter(
        (entry) => !isM3EntryReserved(snapshot, entry),
      ),
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
          !isM3EntryReserved(snapshot, entry) &&
          this.pathRuntime.isReady(entry, now),
      )
      .toSorted(
        (left, right) =>
          pathJobPriority(left) - pathJobPriority(right) ||
          left.path.localeCompare(right.path),
      );
    const completions = ready.flatMap((entry) => {
      const reservationKeys =
        entry.desired.kind === MIRROR_DESIRED_STATE_KIND.renameDeferred &&
        entry.desired.destinationPath !== null
          ? [entry.path, entry.desired.destinationPath].toSorted(
              (left, right) => left.localeCompare(right),
            )
          : [entry.path];
      const completion = this.scheduler.enqueueAndWait({
        key: entry.path,
        reservationKeys,
        run: () => this.runPath(entry.path),
      });
      return completion === undefined ? [] : [completion];
    });
    await Promise.all(completions);
  }

  /** Runs one scheduler-owned path through its current semantic policy owner. */
  private async runPath(path: NotePath): Promise<void> {
    const snapshot = this.stateOwner.snapshot();
    const entry = findMirrorPath(snapshot.state, path);
    if (entry === undefined || isM3EntryReserved(snapshot, entry)) return;
    switch (entry.desired.kind) {
      case MIRROR_DESIRED_STATE_KIND.runtimeDelete:
        await this.deletionExecutor.run(path);
        return;
      case MIRROR_DESIRED_STATE_KIND.renameDeferred:
        await this.renameExecutor.run(path);
        return;
      case MIRROR_DESIRED_STATE_KIND.none:
      case MIRROR_DESIRED_STATE_KIND.dirtyPresent:
        await this.reconciler.run(path);
    }
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

/** @returns Whether active M4 ownership reserves this source or rename destination. */
function isM3EntryReserved(
  snapshot: MirrorStateSnapshot,
  entry: MirrorPathState,
): boolean {
  if (isReconciliationPathReserved(snapshot.state, entry.path)) return true;
  return (
    entry.desired.kind === MIRROR_DESIRED_STATE_KIND.renameDeferred &&
    entry.desired.destinationPath !== null &&
    isReconciliationPathReserved(snapshot.state, entry.desired.destinationPath)
  );
}

/** @returns Scheduler priority that lets a rename own its destination reservation. */
function pathJobPriority(entry: MirrorPathState): number {
  return entry.desired.kind === MIRROR_DESIRED_STATE_KIND.renameDeferred
    ? 0
    : 1;
}
