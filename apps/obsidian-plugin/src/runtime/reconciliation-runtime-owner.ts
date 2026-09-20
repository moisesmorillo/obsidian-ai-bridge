import {
  ConflictPreservationService,
  createMirrorOperationId,
  type FairMirrorScheduler,
  fenceMirrorRuntime,
  LiveResolutionService,
  type LocalReconciliationWriter,
  LocalReconciliationWriteService,
  type MirrorOperationId,
  type MirrorStateOwner,
  type MirrorSynchronizerRuntime,
  type NotePath,
  normalizeNotePath,
  projectRecoverySelection,
  RECONCILIATION_ACTION,
  RECONCILIATION_EVENT_KIND,
  RECONCILIATION_OPERATION_PHASE,
  type ReadOnlyLocalVault,
  type ReconciliationAdmissionAction,
  ReconciliationEffectExecutor,
  type ReconciliationEventKind,
  type ReconciliationObservationGenerationOwner,
  ReconciliationReviewService,
  type ReconciliationRuntimeIdentity,
  RecoveryRestoreService,
  type RecoverySnapshotId,
  type RecoverySnapshotState,
  type RemoteBridge,
  RemoteTombstoneResolutionService,
  RenameHistoryResolutionService,
  ResolutionCoordinator,
  RevisionedAdoptionService,
  recoverySnapshotStatesEqual,
} from "@obsidian-ai-bridge/core";
import type {
  ReconciliationCandidateList,
  ReconciliationReviewDetail,
  ReconciliationUiCommandResult,
  RecoverySelectionDetail,
  RecoverySelectionList,
} from "@obsidian-plugin/reconciliation/reconciliation-ui.types";

/** Dependencies retained by one connection-generation reviewed reconciliation graph. */
export interface ReconciliationRuntimeOwnerDependencies {
  readonly local: ReadOnlyLocalVault;
  readonly localWriter: LocalReconciliationWriter;
  readonly remote: RemoteBridge;
  readonly stateOwner: MirrorStateOwner;
  readonly runtime: MirrorSynchronizerRuntime;
  readonly observations: ReconciliationObservationGenerationOwner;
  readonly scheduler: FairMirrorScheduler;
  readonly cryptography: Crypto;
  /** @returns Exact current owner/configuration/listener identity. */
  currentIdentity(): ReconciliationRuntimeIdentity;
}

/**
 * Connection-generation M4 application owner with process-local sessions and durable operations.
 *
 * UI consumes only sanitized projections. Policy, preservation, local writes, remote
 * conditional effects, restart progress, and event fencing remain in core services.
 */
export class ReconciliationRuntimeOwner {
  /** Connection-scoped transient review/session authority. */
  private readonly reviews: ReconciliationReviewService;
  /** Durable local-effect preparation, settlement, and successor-event owner. */
  private readonly localWrites: LocalReconciliationWriteService;
  /** One-step-per-turn deferred-history executor. */
  private readonly history: RenameHistoryResolutionService;
  /** Router for ordinary reviewed action executors. */
  private readonly coordinator: ResolutionCoordinator;
  /** Exact actionable recovery metadata from the latest complete process-local query. */
  private readonly recoverySelections = new Map<
    RecoverySnapshotId,
    RecoverySnapshotState
  >();
  /** Connection-lifetime fence for new transient review authority. */
  private attached = true;

  /** @param dependencies - Current connection and owner-scoped shared runtime seams. */
  constructor(
    private readonly dependencies: ReconciliationRuntimeOwnerDependencies,
  ) {
    /** @returns Fresh owner-scoped UUID-v4 identity. */
    const createOperationId = () => this.createOperationId();
    this.reviews = new ReconciliationReviewService(
      dependencies.local,
      dependencies.remote,
      dependencies.stateOwner,
      {
        runtime: { current: () => dependencies.currentIdentity() },
        observations: dependencies.observations,
        hashContent: (content) => dependencies.runtime.hashContent(content),
        createOperationId,
      },
    );
    this.localWrites = new LocalReconciliationWriteService(
      dependencies.localWriter,
      dependencies.stateOwner,
      dependencies.runtime,
      {
        createEffectId: createOperationId,
        listenerEpoch: () => dependencies.currentIdentity().listenerEpoch,
        currentGeneration: (path) => dependencies.observations.current(path),
      },
    );
    const preservation = new ConflictPreservationService(
      dependencies.localWriter,
      dependencies.stateOwner,
      dependencies.runtime,
    );
    const effects = new ReconciliationEffectExecutor(
      dependencies.local,
      dependencies.remote,
      dependencies.stateOwner,
      preservation,
      this.localWrites,
      {
        observations: dependencies.observations,
        hashContent: (content) => dependencies.runtime.hashContent(content),
        /* v8 ignore next -- effect-executor clock behavior is covered at the core boundary. */
        nowMilliseconds: () => dependencies.runtime.nowMilliseconds(),
      },
    );
    this.coordinator = new ResolutionCoordinator(
      effects,
      new LiveResolutionService(effects),
      new RevisionedAdoptionService(effects),
      new RemoteTombstoneResolutionService(effects),
      new RecoveryRestoreService(effects),
    );
    this.history = new RenameHistoryResolutionService(
      dependencies.local,
      dependencies.remote,
      preservation,
      dependencies.stateOwner,
      {
        observations: dependencies.observations,
        hashContent: (content) => dependencies.runtime.hashContent(content),
      },
    );
  }

  /** Stops new process-local UI authority without cancelling durable settlement. */
  detach(): void {
    this.attached = false;
    this.recoverySelections.clear();
    this.reviews.invalidate();
  }

  /**
   * Invalidates one presentation session and discards every transient body it owned.
   * @param sessionId - Exact UI session identity.
   */
  invalidateSession(sessionId: MirrorOperationId): void {
    this.recoverySelections.clear();
    this.reviews.invalidateSession(sessionId);
  }

  /** @returns Bounded sanitized candidate paths for the current connection. */
  async listCandidates(): Promise<ReconciliationCandidateList> {
    if (!this.attached) return { kind: "unavailable" };
    const result = await this.reviews.discover();
    return result.kind === "complete"
      ? { kind: "available", candidates: result.candidates }
      : { kind: "incomplete", candidates: result.candidates };
  }

  /**
   * Creates one exact ephemeral review and returns no sampled body.
   * @param sessionId - Current UI session identity.
   * @param targetPath - Candidate selected by the operator.
   * @param recoveryId - Optional exact recovery selection.
   * @param destinationPath - Optional untrusted destination literal normalized before sampling.
   * @returns Content-free detail or unavailable.
   */
  async createReview(
    sessionId: MirrorOperationId,
    targetPath: NotePath,
    recoveryId: RecoverySnapshotId | null = null,
    destinationPath: string | null = null,
  ): Promise<ReconciliationReviewDetail | null> {
    if (!this.attached) return null;
    let selectedRecovery: RecoverySnapshotState | null = null;
    if (recoveryId !== null) {
      const selected = this.recoverySelections.get(recoveryId);
      if (selected === undefined) return null;
      if (
        !projectRecoverySelection(
          selected,
          this.dependencies.runtime.nowMilliseconds(),
        ).actionable
      ) {
        this.recoverySelections.delete(recoveryId);
        return null;
      }
      selectedRecovery = selected;
    }
    let normalizedDestination: NotePath | null = null;
    if (destinationPath !== null) {
      const normalized = normalizeNotePath(destinationPath);
      if (normalized === undefined) return null;
      normalizedDestination = normalized;
    }
    const result = await this.reviews.createReview({
      sessionId,
      targetPath,
      recoveryId,
      destinationPath: normalizedDestination,
    });
    if (result.kind !== "created") return null;
    if (
      selectedRecovery !== null &&
      (result.review.snapshot.recovery === null ||
        !recoverySnapshotStatesEqual(
          selectedRecovery,
          result.review.snapshot.recovery,
        ) ||
        !projectRecoverySelection(
          result.review.snapshot.recovery,
          this.dependencies.runtime.nowMilliseconds(),
        ).actionable)
    ) {
      this.reviews.closeReview(result.review.reviewId, sessionId);
      this.recoverySelections.delete(selectedRecovery.id);
      return null;
    }
    if (selectedRecovery !== null) {
      this.recoverySelections.delete(selectedRecovery.id);
    }
    return {
      reviewId: result.review.reviewId,
      targetPath: result.review.snapshot.targetPath,
      destinationPath: normalizedDestination ?? null,
      classification: result.review.classification,
      allowedActions: result.review.allowedActions,
      historyCandidates: result.review.allowedActions.includes(
        RECONCILIATION_ACTION.resolveHistory,
      )
        ? result.review.snapshot.paths.map((evidence) => evidence.path)
        : [],
    };
  }

  /** @returns Bounded content-free recovery metadata for explicit selection. */
  async listRecoveries(): Promise<RecoverySelectionList> {
    if (!this.attached) return { kind: "unavailable" };
    const result = await this.reviews.listRecoverySelections();
    const complete = result.kind === "complete";
    this.recoverySelections.clear();
    const recoveries: RecoverySelectionDetail[] = result.recoveries.map(
      (recovery) => {
        const projection = projectRecoverySelection(
          recovery,
          this.dependencies.runtime.nowMilliseconds(),
        );
        if (complete && projection.actionable) {
          this.recoverySelections.set(recovery.id, recovery);
        }
        return {
          id: recovery.id,
          path: recovery.path,
          state: projection.state,
          recoverUntil: projection.recoverUntil,
          actionable: complete && projection.actionable,
        };
      },
    );
    return {
      kind: complete ? "available" : "incomplete",
      recoveries,
    };
  }

  /**
   * Returns literal transient preview text only after explicit operator request.
   * @param sessionId - Exact UI session identity.
   * @param reviewId - Exact pending review identity.
   * @param side - Selected sample side.
   * @returns Bounded inert text or null when stale.
   */
  preview(
    sessionId: MirrorOperationId,
    reviewId: MirrorOperationId,
    side: "local" | "remote",
  ): string | null {
    return this.attached
      ? this.reviews.preview(reviewId, sessionId, side)
      : null;
  }

  /**
   * Closes one pending review and clears its transient bodies.
   * @param sessionId - Exact UI session identity.
   * @param reviewId - Exact pending review identity.
   */
  closeReview(sessionId: MirrorOperationId, reviewId: MirrorOperationId): void {
    this.reviews.closeReview(reviewId, sessionId);
  }

  /**
   * Revalidates and admits one typed decision, then schedules one finite execution turn.
   * @param sessionId - Exact UI session identity.
   * @param reviewId - Exact ephemeral review identity.
   * @param action - Closed operator action.
   * @param destinationPath - Optional literal destination supplied by UI.
   * @returns Sanitized admission result.
   */
  async submit(
    sessionId: MirrorOperationId,
    reviewId: MirrorOperationId,
    action: ReconciliationAdmissionAction,
    destinationPath?: NotePath | null,
  ): Promise<ReconciliationUiCommandResult> {
    if (!this.attached) return { kind: "unavailable" };
    const result = await this.reviews.admit({
      sessionId,
      reviewId,
      action,
      ...(destinationPath === undefined ? {} : { destinationPath }),
    });
    if (result.kind !== "admitted") {
      return {
        kind: result.reason === "stale-review" ? "stale" : "failed",
      };
    }
    this.schedule(result.operation.operationId);
    return {
      kind:
        result.operation.phase === RECONCILIATION_OPERATION_PHASE.completed
          ? "completed"
          : "admitted",
    };
  }

  /**
   * Offers one already-generated eligible host event to M4 before ordinary M3 routing.
   * @param path - Event path.
   * @param kind - Closed event kind.
   * @param generation - Owner-scoped monotonic generation.
   * @returns Whether an active reserved M4 operation retained the event.
   */
  async observeEvent(
    path: NotePath,
    kind: ReconciliationEventKind,
    generation: number,
  ): Promise<boolean> {
    /* v8 ignore next -- history event ownership is exercised by the core service; this is a capability-free delegation. */
    if (await this.history.observeReservedEvent(path)) return true;
    return this.localWrites.observeReservedEvent(path, kind, generation);
  }

  /** Schedules one finite resume turn for every persisted active operation. */
  resumePersisted(): void {
    for (const operation of this.dependencies.stateOwner.snapshot().state
      .reconciliationOperations) {
      if (
        operation.phase !== RECONCILIATION_OPERATION_PHASE.completed &&
        operation.phase !== RECONCILIATION_OPERATION_PHASE.stale
      ) {
        this.schedule(operation.operationId);
      }
    }
  }

  /** @returns Closed event constants for host adapters without duplicating literals. */
  static eventKinds(): typeof RECONCILIATION_EVENT_KIND {
    return RECONCILIATION_EVENT_KIND;
  }

  /** Schedules one operation under its complete lexical durable reservation set. */
  private schedule(operationId: MirrorOperationId): void {
    const operation = this.dependencies.stateOwner
      .snapshot()
      .state.reconciliationOperations.find(
        (candidate) => candidate.operationId === operationId,
      );
    if (
      operation === undefined ||
      operation.reservations.length === 0 ||
      operation.phase === RECONCILIATION_OPERATION_PHASE.completed ||
      operation.phase === RECONCILIATION_OPERATION_PHASE.stale
    ) {
      return;
    }
    const reservationKeys = operation.reservations
      .map((reservation) => reservation.path)
      .toSorted((left, right) => left.localeCompare(right));
    const key = reservationKeys[0];
    /* v8 ignore next -- validated admitted operations always own at least one reservation. */
    if (key === undefined) return;
    let continueHistory = false;
    const completion = this.dependencies.scheduler.enqueueAndWait({
      key,
      reservationKeys,
      run: async () => {
        const current = this.dependencies.stateOwner
          .snapshot()
          .state.reconciliationOperations.find(
            (candidate) => candidate.operationId === operationId,
          );
        if (current?.action.kind === RECONCILIATION_ACTION.resolveHistory) {
          const result = await this.history.execute({ operationId });
          continueHistory = result.kind === "progressed";
          return;
        }
        await this.coordinator.execute({ operationId });
      },
    });
    if (completion === undefined) return;
    void completion.then(
      () => {
        if (continueHistory) this.schedule(operationId);
      },
      async () => {
        await this.dependencies.stateOwner.transition(fenceMirrorRuntime);
      },
    );
  }

  /** @returns Fresh validated UUID-v4 or fails closed when runtime identity is unavailable. */
  private createOperationId(): MirrorOperationId {
    const id = createMirrorOperationId(
      this.dependencies.cryptography.randomUUID(),
    );
    if (id === undefined) throw new Error("Runtime identity unavailable.");
    return id;
  }
}
