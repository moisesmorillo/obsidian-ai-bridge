import { LocalInspectionKind } from "@core/local-vault/local-vault.constants";
import type { ReadOnlyLocalVault } from "@core/local-vault/read-only-local-vault.port";
import { FairMirrorScheduler } from "@core/mirror/fair-mirror-scheduler";
import {
  MAX_MUTATION_ATTEMPTS,
  MAX_MUTATION_EVIDENCE_ATTEMPTS,
  MUTATION_ACTION,
} from "@core/mirror/mirror.constants";
import type {
  ConditionalMutationRequest,
  ContentSha256,
  CurrentNoteState,
  MirrorOperationId,
  MutationAcknowledgement,
  UnresolvedMutationIntent,
} from "@core/mirror/mirror.types";
import { applyMutationAcknowledgement } from "@core/mirror/mirror-acknowledgement";
import {
  MAX_REMOTE_INVENTORY_PAGES,
  MIRROR_COALESCING_QUIET_PERIOD_MILLISECONDS,
  MIRROR_FINAL_MUTATION_RETRY_DELAY_MILLISECONDS,
  MIRROR_MAX_COALESCING_WAIT_MILLISECONDS,
  MIRROR_MUTATION_RETRY_DELAY_MILLISECONDS,
  MIRROR_SYNCHRONIZER_PHASE,
} from "@core/mirror/mirror-autosync.constants";
import {
  inspectBoundedMirrorInventory,
  type MirrorInventoryResult,
} from "@core/mirror/mirror-inventory";
import {
  MAX_MIRROR_TRACKED_PATHS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_GLOBAL_BLOCK_REASON,
  MIRROR_MUTATION_PHASE,
  MIRROR_PATH_BLOCK_REASON,
} from "@core/mirror/mirror-state.constants";
import type {
  MirrorDeviceState,
  MirrorPathState,
  MirrorStateSnapshot,
} from "@core/mirror/mirror-state.types";
import type { MirrorStateOwner } from "@core/mirror/mirror-state-owner";
import type {
  MirrorBootstrapResult,
  MirrorPathJobOutcome,
  MirrorSynchronizerPhase,
  MirrorSynchronizerRuntime,
} from "@core/mirror/mirror-synchronizer.types";
import { REMOTE_BRIDGE_FAILURE } from "@core/mirror/remote-bridge.constants";
import type {
  RemoteBridge,
  RemoteBridgeFailure,
} from "@core/mirror/remote-bridge.types";
import type { NotePath } from "@core/note-path/note-path.types";

const INVENTORY_RESERVATION_KEY = "mirror:inventory";

interface PathRuntimeState {
  readonly firstObservedAt: number;
  readonly lastObservedAt: number;
  readonly generation: number;
  readonly nextRetryAt: number;
  readonly bootstrapInspectionRequired: boolean;
}

/**
 * Core-owned positive autosynchronization coordinator for M3 Slice 5.
 *
 * The synchronizer accepts only validated primitive paths, owns coalescing and finite
 * retry/evidence transitions, and routes every durable change through MirrorStateOwner.
 * It deliberately has no delete/rename authority or host callback knowledge.
 */
export class MirrorSynchronizer {
  private readonly scheduler = new FairMirrorScheduler();
  private readonly pathRuntime = new Map<NotePath, PathRuntimeState>();
  private readonly outcomes = new Map<NotePath, MirrorPathJobOutcome>();
  private observationGeneration = 0;
  private inventory: MirrorInventoryResult | null = null;
  private phase: MirrorSynchronizerPhase = MIRROR_SYNCHRONIZER_PHASE.observing;

  /**
   * @param local - Saved-file read/list capability with M2 eligibility guarantees.
   * @param remote - Conditional remote bridge; every call performs one attempt only.
   * @param stateOwner - Sole durable ledger transition owner.
   * @param runtime - Deterministic time, digest, and operation-identity seams.
   */
  constructor(
    private readonly local: ReadOnlyLocalVault,
    private readonly remote: RemoteBridge,
    private readonly stateOwner: MirrorStateOwner,
    private readonly runtime: MirrorSynchronizerRuntime,
  ) {}

  /** @returns Most recent sanitized outcome for a path, if any. */
  outcome(path: NotePath): MirrorPathJobOutcome | undefined {
    return this.outcomes.get(path);
  }

  /** @returns Most recent bounded inventory result; never deletion evidence. */
  inventoryResult(): MirrorInventoryResult | null {
    return this.inventory;
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
    const generation = this.nextGeneration();
    const now = this.runtime.nowMilliseconds();
    const current = findPath(this.stateOwner.snapshot().state, path);
    this.recordRuntimeObservation(
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
   * Performs one non-retrying local bootstrap and bounded reporting inventory.
   *
   * Positive events may call observePresent while enumeration is pending. The final
   * batch preserves newer generations. Local failure and remote absence never create
   * destructive evidence.
   *
   * @returns Explicit completion/incompleteness and unassociated remote reporting.
   */
  async bootstrap(): Promise<MirrorBootstrapResult> {
    const initial = this.stateOwner.snapshot();
    if (!initial.mutationAdmissionAllowed) {
      this.phase = MIRROR_SYNCHRONIZER_PHASE.inactive;
      return { kind: "inactive", eligiblePaths: [], inventory: null };
    }
    this.phase = MIRROR_SYNCHRONIZER_PHASE.bootstrapping;
    const description = await this.remote.describe();
    if (description.kind === "failure") {
      await this.applyGlobalRemoteFailure(description.failure);
      this.phase = MIRROR_SYNCHRONIZER_PHASE.inactive;
      return { kind: "inactive", eligiblePaths: [], inventory: null };
    }
    const lifecycle = this.stateOwner.snapshot().state.lifecycle;
    if (
      lifecycle.kind !== "active" ||
      lifecycle.associationId !== description.value.associationId ||
      this.stateOwner.snapshot().state.deviceId !== description.value.writerId
    ) {
      await this.stateOwner.transition((state) => ({
        ...state,
        globalBlockReason: MIRROR_GLOBAL_BLOCK_REASON.designationMismatch,
      }));
      this.phase = MIRROR_SYNCHRONIZER_PHASE.inactive;
      return { kind: "inactive", eligiblePaths: [], inventory: null };
    }
    let inventory: MirrorInventoryResult = {
      kind: "incomplete",
      paths: [],
      pagesRead: MAX_REMOTE_INVENTORY_PAGES,
      reason: "page-budget-exhausted",
    };
    const bootstrapGeneration = this.nextGeneration();
    this.scheduler.enqueue({
      key: INVENTORY_RESERVATION_KEY,
      run: async () => {
        inventory = await inspectBoundedMirrorInventory(this.remote);
        this.inventory = inventory;
      },
    });
    const local = await this.local.list();
    if (local.kind === LocalInspectionKind.ok) {
      const observedAt = this.runtime.nowMilliseconds();
      const generations = local.entries.map((entry) => ({
        path: entry.path,
        generation: bootstrapGeneration,
      }));
      for (const entry of generations) {
        const current = findPath(this.stateOwner.snapshot().state, entry.path);
        this.recordRuntimeObservation(
          entry.path,
          entry.generation,
          observedAt,
          true,
          current?.desired.kind !== MIRROR_DESIRED_STATE_KIND.dirtyPresent,
        );
      }
      await this.stateOwner.transition((state) =>
        mergeBootstrapPaths(state, generations),
      );
    }
    await this.scheduler.whenIdle();
    this.phase = MIRROR_SYNCHRONIZER_PHASE.observing;
    const completedInventory = inventory;
    if (local.kind !== LocalInspectionKind.ok) {
      return {
        kind: "local-incomplete",
        eligiblePaths: [],
        inventory: completedInventory,
      };
    }
    const associated = new Set(
      this.stateOwner
        .snapshot()
        .state.paths.flatMap((entry) =>
          entry.acknowledgement.kind ===
          MIRROR_ACKNOWLEDGEMENT_KIND.unassociated
            ? []
            : [entry.path],
        ),
    );
    return {
      kind: "complete",
      eligiblePaths: local.entries.map((entry) => entry.path),
      inventory: completedInventory,
      unassociatedRemotePaths: completedInventory.paths.filter(
        (path) => !associated.has(path),
      ),
    };
  }

  /**
   * Returns the next finite coalescing or retry deadline for host timer composition.
   *
   * `null` means no unblocked path needs a wake. The caller schedules one bounded
   * host timer and invokes synchronizeReady; it must not poll.
   *
   * @returns Earliest monotonic deadline in milliseconds, or no pending wake.
   */
  nextWakeAtMilliseconds(): number | null {
    const deadlines = this.stateOwner
      .snapshot()
      .state.paths.flatMap((entry) => {
        if (entry.blockedReason !== null) return [];
        const runtime = this.pathRuntime.get(entry.path);
        if (entry.unresolvedMutation !== null) {
          return [runtime?.nextRetryAt ?? this.runtime.nowMilliseconds()];
        }
        if (
          entry.desired.kind !== MIRROR_DESIRED_STATE_KIND.dirtyPresent ||
          runtime === undefined
        ) {
          return [];
        }
        return [
          Math.min(
            runtime.lastObservedAt +
              MIRROR_COALESCING_QUIET_PERIOD_MILLISECONDS,
            runtime.firstObservedAt + MIRROR_MAX_COALESCING_WAIT_MILLISECONDS,
          ),
        ];
      });
    return deadlines.length === 0 ? null : Math.min(...deadlines);
  }

  /**
   * Runs every path currently ready under quiet/max-wait/retry policy.
   *
   * Jobs enter in lexical order for a stable scan and then remain FIFO. At most two
   * execute globally and the scheduler refuses duplicate reservations for one path.
   *
   * @returns When all jobs admitted by this pass have actually settled.
   */
  async synchronizeReady(): Promise<void> {
    const now = this.runtime.nowMilliseconds();
    const state = this.stateOwner.snapshot();
    if (
      this.phase !== MIRROR_SYNCHRONIZER_PHASE.observing ||
      !state.mutationAdmissionAllowed
    ) {
      return;
    }
    const ready = state.state.paths
      .filter((entry) => this.isReady(entry, now))
      .toSorted((left, right) => left.path.localeCompare(right.path));
    for (const entry of ready) {
      this.scheduler.enqueue({
        key: entry.path,
        run: () => this.runPath(entry.path),
      });
    }
    await this.scheduler.whenIdle();
  }

  /**
   * Grants a fresh finite budget to the same unresolved, reconstructible intent.
   *
   * The operation identity, original condition, hash, and action are unchanged; this
   * is never baseline refresh or permission to substitute newer bytes.
   *
   * @param path - Path whose exhausted unresolved intent is explicitly retried.
   * @returns Whether the durable grant committed.
   */
  async grantRetry(path: NotePath): Promise<boolean> {
    const existing = requireIntent(this.stateOwner.snapshot(), path);
    if (existing === undefined) return false;
    const reconstructed = await this.reconstructExactContent(existing);
    if (reconstructed === undefined) return false;
    const result = await this.stateOwner.transition((state) =>
      updateExactIntent(state, existing, (entry) => ({
        ...entry,
        unresolvedMutation:
          entry.unresolvedMutation === null
            ? null
            : {
                phase: MIRROR_MUTATION_PHASE.evidenceRequired,
                intent: {
                  ...entry.unresolvedMutation.intent,
                  mutationAttempts: 0,
                  evidenceAttempts: 0,
                },
              },
        blockedReason: null,
      })),
    );
    if (result.kind !== "committed") return false;
    const current = this.pathRuntime.get(path);
    this.pathRuntime.set(path, {
      firstObservedAt:
        current?.firstObservedAt ?? this.runtime.nowMilliseconds(),
      lastObservedAt: current?.lastObservedAt ?? this.runtime.nowMilliseconds(),
      generation:
        current?.generation ?? desiredGeneration(result.snapshot, path),
      nextRetryAt: this.runtime.nowMilliseconds(),
      bootstrapInspectionRequired:
        current?.bootstrapInspectionRequired ?? false,
    });
    return true;
  }

  private isReady(entry: MirrorPathState, now: number): boolean {
    if (this.scheduler.isReserved(entry.path) || entry.blockedReason !== null) {
      return false;
    }
    if (entry.unresolvedMutation !== null) {
      const runtime = this.pathRuntime.get(entry.path);
      return runtime === undefined || now >= runtime.nextRetryAt;
    }
    if (entry.desired.kind !== MIRROR_DESIRED_STATE_KIND.dirtyPresent) {
      return false;
    }
    const runtime = this.pathRuntime.get(entry.path);
    if (runtime === undefined) return true;
    const readyAt = Math.min(
      runtime.lastObservedAt + MIRROR_COALESCING_QUIET_PERIOD_MILLISECONDS,
      runtime.firstObservedAt + MIRROR_MAX_COALESCING_WAIT_MILLISECONDS,
    );
    return now >= readyAt;
  }

  private async runPath(path: NotePath): Promise<void> {
    const snapshot = this.stateOwner.snapshot();
    if (!snapshot.mutationAdmissionAllowed) return;
    const entry = findPath(snapshot.state, path);
    if (entry === undefined) return;
    if (entry.unresolvedMutation !== null) {
      await this.resumeUnresolved(path, entry.unresolvedMutation.intent);
      return;
    }
    if (entry.desired.kind !== MIRROR_DESIRED_STATE_KIND.dirtyPresent) return;
    await this.reconcilePresent(path, entry.desired.observationGeneration);
  }

  private async reconcilePresent(
    path: NotePath,
    generation: number,
  ): Promise<void> {
    const local = await this.local.read(path);
    if (local.kind !== LocalInspectionKind.ok) {
      this.setOutcome({ kind: "local-unavailable", path });
      return;
    }
    if (desiredGeneration(this.stateOwner.snapshot(), path) !== generation) {
      this.setOutcome({ kind: "stale-read", path });
      return;
    }
    const hash = await this.runtime.hashContent(local.content);
    if (desiredGeneration(this.stateOwner.snapshot(), path) !== generation) {
      this.setOutcome({ kind: "stale-read", path });
      return;
    }
    const current = findPath(this.stateOwner.snapshot().state, path);
    if (current === undefined || current.unresolvedMutation !== null) return;
    const runtime = this.pathRuntime.get(path);
    const inspectFirst =
      runtime?.bootstrapInspectionRequired === true ||
      current.acknowledgement.kind !== MIRROR_ACKNOWLEDGEMENT_KIND.live;
    if (inspectFirst) {
      const observed = await this.remote.inspectNote(path);
      if (observed.kind === "failure") {
        await this.recordRemoteFailure(path, observed.failure);
        return;
      }
      if (!remoteMatchesAcknowledgement(current, observed.value)) {
        await this.blockDiverged(path);
        return;
      }
      this.clearBootstrapInspection(path);
    }
    if (
      current.acknowledgement.kind === MIRROR_ACKNOWLEDGEMENT_KIND.live &&
      current.acknowledgement.contentSha256 === hash
    ) {
      await this.clearDesired(path, generation);
      this.setOutcome({ kind: "unchanged", path });
      return;
    }
    const intent = createContentIntent(
      current,
      this.stateOwner.snapshot().state,
      hash,
      this.runtime.createOperationId(),
    );
    if (intent === undefined) {
      await this.blockDiverged(path);
      return;
    }
    const persisted = await this.stateOwner.transition((state) =>
      updatePath(state, path, (entry) => {
        if (
          entry.unresolvedMutation !== null ||
          entry.desired.kind !== MIRROR_DESIRED_STATE_KIND.dirtyPresent ||
          entry.desired.observationGeneration !== generation
        ) {
          return undefined;
        }
        return {
          ...entry,
          unresolvedMutation: {
            intent,
            phase: MIRROR_MUTATION_PHASE.intentPersisted,
          },
        };
      }),
    );
    if (persisted.kind !== "committed") return;
    await this.attemptMutation(intent, local.content, generation);
  }

  private async resumeUnresolved(
    path: NotePath,
    intent: UnresolvedMutationIntent,
  ): Promise<void> {
    const current = findPath(this.stateOwner.snapshot().state, path);
    if (current?.unresolvedMutation === null || current === undefined) return;
    if (
      current.unresolvedMutation.phase === MIRROR_MUTATION_PHASE.intentPersisted
    ) {
      const reconstructed = await this.reconstructExactContent(intent);
      if (reconstructed === undefined) {
        await this.blockPath(path, MIRROR_PATH_BLOCK_REASON.unresolvedEffect);
        return;
      }
      await this.attemptMutation(
        reconstructed.intent,
        reconstructed.content,
        reconstructed.generation,
      );
      return;
    }
    await this.inspectIntentEvidence(path, intent);
  }

  private async inspectIntentEvidence(
    path: NotePath,
    intent: UnresolvedMutationIntent,
  ): Promise<void> {
    if (intent.evidenceAttempts >= MAX_MUTATION_EVIDENCE_ATTEMPTS) {
      await this.blockPath(path, MIRROR_PATH_BLOCK_REASON.unresolvedEffect);
      return;
    }
    const consumed = await this.stateOwner.transition((state) =>
      updateExactIntent(state, intent, (entry) => ({
        ...entry,
        unresolvedMutation:
          entry.unresolvedMutation === null
            ? null
            : {
                ...entry.unresolvedMutation,
                intent: {
                  ...entry.unresolvedMutation.intent,
                  evidenceAttempts:
                    entry.unresolvedMutation.intent.evidenceAttempts + 1,
                },
              },
      })),
    );
    if (consumed.kind !== "committed") return;
    const observed = await this.remote.inspectNote(path);
    if (observed.kind === "failure") {
      await this.recordRemoteFailure(path, observed.failure);
      return;
    }
    const latest = requireIntent(consumed.snapshot, path);
    if (latest === undefined) return;
    if (stateHasExactIntentReceipt(observed.value, latest)) {
      const acknowledgement = currentStateAcknowledgement(observed.value);
      if (acknowledgement !== undefined) {
        const applied = await this.stateOwner.transition((state) =>
          applyMutationAcknowledgement(state, acknowledgement),
        );
        if (applied.kind === "committed") {
          this.setOutcome({ kind: "acknowledged", path });
        }
      }
      return;
    }
    if (!stateIsOriginalCondition(observed.value, latest)) {
      await this.blockDiverged(path);
      return;
    }
    if (latest.mutationAttempts >= MAX_MUTATION_ATTEMPTS) {
      await this.blockPath(path, MIRROR_PATH_BLOCK_REASON.retryExhausted);
      return;
    }
    const reconstructed = await this.reconstructExactContent(latest);
    if (reconstructed === undefined) {
      await this.blockPath(path, MIRROR_PATH_BLOCK_REASON.unresolvedEffect);
      return;
    }
    await this.setIntentPhase(path, MIRROR_MUTATION_PHASE.intentPersisted);
    this.scheduleRetry(path, latest.mutationAttempts);
    this.setOutcome({ kind: "retry-wait", path });
  }

  private async reconstructExactContent(
    intent: UnresolvedMutationIntent,
  ): Promise<
    | {
        readonly intent: Exclude<
          UnresolvedMutationIntent,
          { readonly action: "tombstone" }
        >;
        readonly content: string;
        readonly generation: number;
      }
    | undefined
  > {
    if (intent.action === MUTATION_ACTION.tombstone) return undefined;
    const before = desiredGeneration(this.stateOwner.snapshot(), intent.path);
    const local = await this.local.read(intent.path);
    if (local.kind !== LocalInspectionKind.ok) return undefined;
    const hash = await this.runtime.hashContent(local.content);
    const after = desiredGeneration(this.stateOwner.snapshot(), intent.path);
    if (before !== after || hash !== intent.contentSha256) return undefined;
    return { intent, content: local.content, generation: after };
  }

  private async attemptMutation(
    intent: Exclude<UnresolvedMutationIntent, { readonly action: "tombstone" }>,
    content: string,
    generation: number,
  ): Promise<void> {
    const path = intent.path;
    if (intent.mutationAttempts >= MAX_MUTATION_ATTEMPTS) {
      await this.blockPath(path, MIRROR_PATH_BLOCK_REASON.retryExhausted);
      return;
    }
    const before = this.stateOwner.snapshot();
    const consumed = await this.stateOwner.commit(before.revision, (state) =>
      updateExactIntent(state, intent, (entry) => ({
        ...entry,
        unresolvedMutation:
          entry.unresolvedMutation === null
            ? null
            : {
                phase: MIRROR_MUTATION_PHASE.dispatched,
                intent: {
                  ...entry.unresolvedMutation.intent,
                  mutationAttempts:
                    entry.unresolvedMutation.intent.mutationAttempts + 1,
                },
              },
      })),
    );
    if (consumed.kind !== "committed") return;
    const result = await this.remote.mutateNote(
      mutationRequest(intent, content),
    );
    if (result.kind === "confirmed") {
      const applied = await this.stateOwner.transition((state) =>
        applyMutationAcknowledgement(state, result.confirmed),
      );
      if (applied.kind === "committed") {
        await this.clearDesired(path, generation);
        this.setOutcome({ kind: "acknowledged", path });
      }
      return;
    }
    if (result.effect === "not-dispatched") {
      await this.setIntentPhase(path, MIRROR_MUTATION_PHASE.intentPersisted);
      this.scheduleRetry(path, intent.mutationAttempts + 1);
      this.setOutcome({ kind: "retry-wait", path });
      return;
    }
    if (
      result.effect === "definitely-refused" &&
      intent.mutationAttempts === 0
    ) {
      if (globalBlockForRemoteFailure(result.failure) !== null) {
        await this.recordRemoteFailure(path, result.failure);
        return;
      }
      await this.blockDiverged(path);
      return;
    }
    await this.setIntentPhase(path, MIRROR_MUTATION_PHASE.evidenceRequired);
    this.pathRuntime.set(path, {
      ...runtimeFor(
        this.pathRuntime.get(path),
        generation,
        this.runtime.nowMilliseconds(),
      ),
      nextRetryAt: this.runtime.nowMilliseconds(),
    });
    await this.recordRemoteFailure(path, result.failure);
  }

  private async recordRemoteFailure(
    path: NotePath,
    failure: RemoteBridgeFailure,
  ): Promise<void> {
    await this.applyGlobalRemoteFailure(failure);
    this.setOutcome({ kind: "remote-failure", path, failure });
  }

  private async applyGlobalRemoteFailure(
    failure: RemoteBridgeFailure,
  ): Promise<void> {
    const reason = globalBlockForRemoteFailure(failure);
    if (reason === null) return;
    await this.stateOwner.transition((state) => ({
      ...state,
      globalBlockReason: reason,
    }));
  }

  private async setIntentPhase(
    path: NotePath,
    phase:
      | typeof MIRROR_MUTATION_PHASE.intentPersisted
      | typeof MIRROR_MUTATION_PHASE.evidenceRequired,
  ): Promise<void> {
    await this.stateOwner.transition((state) =>
      updatePath(state, path, (entry) => {
        if (entry.unresolvedMutation === null) return undefined;
        return {
          ...entry,
          unresolvedMutation: { ...entry.unresolvedMutation, phase },
        };
      }),
    );
  }

  private async clearDesired(
    path: NotePath,
    generation: number,
  ): Promise<void> {
    await this.stateOwner.transition((state) =>
      updatePath(state, path, (entry) => {
        if (
          entry.desired.kind !== MIRROR_DESIRED_STATE_KIND.dirtyPresent ||
          entry.desired.observationGeneration !== generation
        ) {
          return entry;
        }
        return {
          ...entry,
          desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
          blockedReason: null,
        };
      }),
    );
  }

  private async blockDiverged(path: NotePath): Promise<void> {
    await this.blockPath(path, MIRROR_PATH_BLOCK_REASON.diverged);
    this.setOutcome({ kind: "diverged", path });
  }

  private async blockPath(
    path: NotePath,
    reason: MirrorPathState["blockedReason"],
  ): Promise<void> {
    await this.stateOwner.transition((state) =>
      updatePath(state, path, (entry) => ({ ...entry, blockedReason: reason })),
    );
    this.setOutcome({ kind: "blocked", path });
  }

  private scheduleRetry(path: NotePath, attempts: number): void {
    const delay =
      attempts <= 1
        ? MIRROR_MUTATION_RETRY_DELAY_MILLISECONDS
        : MIRROR_FINAL_MUTATION_RETRY_DELAY_MILLISECONDS;
    const current = this.pathRuntime.get(path);
    const now = this.runtime.nowMilliseconds();
    this.pathRuntime.set(path, {
      ...runtimeFor(
        current,
        desiredGeneration(this.stateOwner.snapshot(), path),
        now,
      ),
      nextRetryAt: now + delay,
    });
  }

  private recordRuntimeObservation(
    path: NotePath,
    generation: number,
    now: number,
    bootstrapInspectionRequired: boolean,
    startNewCoalescingWindow: boolean,
  ): void {
    const current = this.pathRuntime.get(path);
    this.pathRuntime.set(path, {
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

  private clearBootstrapInspection(path: NotePath): void {
    const current = this.pathRuntime.get(path);
    if (current === undefined) return;
    this.pathRuntime.set(path, {
      ...current,
      bootstrapInspectionRequired: false,
    });
  }

  private nextGeneration(): number {
    this.observationGeneration += 1;
    return this.observationGeneration;
  }

  private setOutcome(outcome: MirrorPathJobOutcome): void {
    this.outcomes.set(outcome.path, outcome);
  }
}

function mergeBootstrapPaths(
  state: MirrorDeviceState,
  observations: readonly {
    readonly path: NotePath;
    readonly generation: number;
  }[],
): MirrorDeviceState | undefined {
  let next: MirrorDeviceState | undefined = state;
  for (const observation of observations) {
    if (next === undefined) return undefined;
    next = upsertDirtyPath(
      next,
      observation.path,
      observation.generation,
      true,
    );
  }
  return next;
}

function upsertDirtyPath(
  state: MirrorDeviceState,
  path: NotePath,
  generation: number,
  preserveNewer = false,
): MirrorDeviceState | undefined {
  const existing = findPath(state, path);
  if (existing !== undefined) {
    if (
      preserveNewer &&
      existing.desired.kind === MIRROR_DESIRED_STATE_KIND.dirtyPresent &&
      existing.desired.observationGeneration > generation
    ) {
      return state;
    }
    return updatePath(state, path, (entry) => ({
      ...entry,
      desired: {
        kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent,
        observationGeneration: generation,
      },
      blockedReason: entry.blockedReason,
    }));
  }
  if (state.paths.length >= MAX_MIRROR_TRACKED_PATHS) return undefined;
  return {
    ...state,
    paths: [
      ...state.paths,
      {
        path,
        acknowledgement: { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
        unresolvedMutation: null,
        desired: {
          kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent,
          observationGeneration: generation,
        },
        blockedReason: null,
      },
    ],
  };
}

function updatePath(
  state: MirrorDeviceState,
  path: NotePath,
  update: (entry: MirrorPathState) => MirrorPathState | undefined,
): MirrorDeviceState | undefined {
  const index = state.paths.findIndex((entry) => entry.path === path);
  if (index < 0) return undefined;
  const current = state.paths[index];
  if (current === undefined) return undefined;
  const updated = update(current);
  if (updated === undefined) return undefined;
  return {
    ...state,
    paths: state.paths.map((entry, entryIndex) =>
      entryIndex === index ? updated : entry,
    ),
  };
}

function updateExactIntent(
  state: MirrorDeviceState,
  expected: UnresolvedMutationIntent,
  update: (entry: MirrorPathState) => MirrorPathState,
): MirrorDeviceState | undefined {
  return updatePath(state, expected.path, (entry) =>
    entry.unresolvedMutation?.intent.operationId === expected.operationId
      ? update(entry)
      : undefined,
  );
}

function findPath(
  state: MirrorDeviceState,
  path: NotePath,
): MirrorPathState | undefined {
  return state.paths.find((entry) => entry.path === path);
}

function desiredGeneration(
  snapshot: MirrorStateSnapshot,
  path: NotePath,
): number {
  const desired = findPath(snapshot.state, path)?.desired;
  return desired?.kind === MIRROR_DESIRED_STATE_KIND.dirtyPresent
    ? desired.observationGeneration
    : -1;
}

function requireIntent(
  snapshot: MirrorStateSnapshot,
  path: NotePath,
): UnresolvedMutationIntent | undefined {
  return findPath(snapshot.state, path)?.unresolvedMutation?.intent;
}

function createContentIntent(
  path: MirrorPathState,
  device: MirrorDeviceState,
  contentSha256: ContentSha256,
  operationId: MirrorOperationId,
):
  | Exclude<UnresolvedMutationIntent, { readonly action: "tombstone" }>
  | undefined {
  if (device.lifecycle.kind !== "active") return undefined;
  const common = {
    associationId: device.lifecycle.associationId,
    writerId: device.deviceId,
    operationId,
    path: path.path,
    contentSha256,
    mutationAttempts: 0,
    evidenceAttempts: 0,
  };
  switch (path.acknowledgement.kind) {
    case MIRROR_ACKNOWLEDGEMENT_KIND.unassociated:
      return {
        ...common,
        action: MUTATION_ACTION.create,
        precondition: { kind: "absent" },
      };
    case MIRROR_ACKNOWLEDGEMENT_KIND.live:
      return {
        ...common,
        action: MUTATION_ACTION.update,
        precondition: {
          kind: "matching-revision",
          revision: path.acknowledgement.revision,
        },
      };
    case MIRROR_ACKNOWLEDGEMENT_KIND.tombstone:
      return {
        ...common,
        action: MUTATION_ACTION.recreate,
        precondition: {
          kind: "matching-revision",
          revision: path.acknowledgement.revision,
        },
      };
  }
}

function mutationRequest(
  intent: Exclude<UnresolvedMutationIntent, { readonly action: "tombstone" }>,
  content: string,
): ConditionalMutationRequest {
  return { ...intent, content };
}

function remoteMatchesAcknowledgement(
  path: MirrorPathState,
  observed: CurrentNoteState,
): boolean {
  switch (path.acknowledgement.kind) {
    case MIRROR_ACKNOWLEDGEMENT_KIND.unassociated:
      return observed.kind === "absent";
    case MIRROR_ACKNOWLEDGEMENT_KIND.live:
      return (
        observed.kind === "live" &&
        observed.revision === path.acknowledgement.revision &&
        observed.contentSha256 === path.acknowledgement.contentSha256
      );
    case MIRROR_ACKNOWLEDGEMENT_KIND.tombstone:
      return (
        observed.kind === "tombstone" &&
        observed.revision === path.acknowledgement.revision &&
        observed.recoveryId === path.acknowledgement.recoveryId
      );
  }
}

function stateHasExactIntentReceipt(
  state: CurrentNoteState,
  intent: UnresolvedMutationIntent,
): boolean {
  if (state.kind !== "live" && state.kind !== "tombstone") return false;
  const receipt = state.receipt;
  if (
    receipt.action !== intent.action ||
    receipt.associationId !== intent.associationId ||
    receipt.operationId !== intent.operationId ||
    receipt.precondition.kind !== intent.precondition.kind
  ) {
    return false;
  }
  if (
    receipt.precondition.kind === "matching-revision" &&
    (intent.precondition.kind !== "matching-revision" ||
      receipt.precondition.revision !== intent.precondition.revision)
  ) {
    return false;
  }
  return receipt.action === MUTATION_ACTION.tombstone
    ? intent.action === MUTATION_ACTION.tombstone
    : intent.action !== MUTATION_ACTION.tombstone &&
        receipt.contentSha256 === intent.contentSha256;
}

function currentStateAcknowledgement(
  state: CurrentNoteState,
): MutationAcknowledgement | undefined {
  if (state.kind !== "live" && state.kind !== "tombstone") return undefined;
  return { path: state.path, revision: state.revision, receipt: state.receipt };
}

function stateIsOriginalCondition(
  state: CurrentNoteState,
  intent: UnresolvedMutationIntent,
): boolean {
  if (intent.precondition.kind === "absent") return state.kind === "absent";
  if (intent.action === MUTATION_ACTION.recreate) {
    return (
      state.kind === "tombstone" &&
      state.revision === intent.precondition.revision
    );
  }
  return (
    state.kind === "live" && state.revision === intent.precondition.revision
  );
}

function globalBlockForRemoteFailure(
  failure: RemoteBridgeFailure,
): MirrorDeviceState["globalBlockReason"] {
  switch (failure) {
    case REMOTE_BRIDGE_FAILURE.unauthenticated:
    case REMOTE_BRIDGE_FAILURE.missingSecret:
      return MIRROR_GLOBAL_BLOCK_REASON.missingSecret;
    case REMOTE_BRIDGE_FAILURE.forbidden:
      return MIRROR_GLOBAL_BLOCK_REASON.designationMismatch;
    case REMOTE_BRIDGE_FAILURE.incompatibleProtocol:
    case REMOTE_BRIDGE_FAILURE.unsupportedRuntime:
    case REMOTE_BRIDGE_FAILURE.invalidConfiguration:
      return MIRROR_GLOBAL_BLOCK_REASON.configurationUnavailable;
    case REMOTE_BRIDGE_FAILURE.preconditionFailed:
    case REMOTE_BRIDGE_FAILURE.preconditionRequired:
    case REMOTE_BRIDGE_FAILURE.missing:
    case REMOTE_BRIDGE_FAILURE.conflict:
    case REMOTE_BRIDGE_FAILURE.rateLimited:
    case REMOTE_BRIDGE_FAILURE.serverFailed:
    case REMOTE_BRIDGE_FAILURE.malformedResponse:
    case REMOTE_BRIDGE_FAILURE.networkUnavailable:
    case REMOTE_BRIDGE_FAILURE.timedOut:
    case REMOTE_BRIDGE_FAILURE.cancelled:
    case REMOTE_BRIDGE_FAILURE.admissionDenied:
      return null;
  }
}

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
