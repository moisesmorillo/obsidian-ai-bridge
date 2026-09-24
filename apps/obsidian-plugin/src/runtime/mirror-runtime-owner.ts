import {
  activateIsolatedAssociation,
  createMirrorOperationId,
  FairMirrorScheduler,
  fenceActiveReconciliationForObservationGap,
  fenceMirrorRuntime,
  type LocalReconciliationWriter,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_GLOBAL_BLOCK_REASON,
  MIRROR_PATH_BLOCK_REASON,
  MIRROR_PAUSE_REASON,
  type MirrorAssociationId,
  type MirrorFolderRenameResult,
  type MirrorOrigin,
  type MirrorPathJobOutcome,
  type MirrorStateOwner,
  MirrorSynchronizer,
  type MirrorSynchronizerRuntime,
  markHandoffDrained,
  type NotePath,
  pauseForHandoff,
  pauseMirrorWriter,
  prepareHandoffExport,
  RECONCILIATION_EVENT_KIND,
  RECONCILIATION_OPERATION_PHASE,
  type ReadOnlyLocalVault,
  type ReconciliationAdmissionAction,
  type ReconciliationEventKind,
  ReconciliationObservationGenerationOwner,
  resumeMirrorWriter,
} from "@obsidian-ai-bridge/core";
import type { MirrorPreferencesDecodeResult } from "@obsidian-plugin/configuration/mirror-preferences";
import {
  ObsidianSecretReferenceStore,
  type ObsidianSecretStorageHost,
} from "@obsidian-plugin/configuration/obsidian-secret-store";
import type {
  ReconciliationCandidateList,
  ReconciliationGapActionSelection,
  ReconciliationGapReviewCreationResult,
  ReconciliationObservationGapList,
  ReconciliationReviewDetail,
  ReconciliationUiCommandResult,
  RecoverySelectionList,
} from "@obsidian-plugin/reconciliation/reconciliation-ui.types";
import { FetchRemoteBridge } from "@obsidian-plugin/remote/fetch-remote-bridge";
import type { RemoteFetch } from "@obsidian-plugin/remote/fetch-remote-bridge.types";
import {
  MirrorConnectionAdmissionCoordinator,
  type MirrorRuntimeConnection,
} from "@obsidian-plugin/runtime/mirror-connection-admission";
import type { MirrorEffectDispatchAuthority } from "@obsidian-plugin/runtime/mirror-effect-dispatch-authority";
import {
  MirrorObservationEpochCoordinator,
  type MirrorRuntimeAttachResult,
  type MirrorRuntimeSessionAttachment,
} from "@obsidian-plugin/runtime/mirror-observation-epoch";
import { MirrorReconciliationCoordinator } from "@obsidian-plugin/runtime/mirror-reconciliation-coordinator";
import { MirrorStagedHandoffVerifier } from "@obsidian-plugin/runtime/mirror-staged-handoff-verifier";
import { ReconciliationRuntimeOwner } from "@obsidian-plugin/runtime/reconciliation-runtime-owner";
import {
  createHandoffRecord,
  encodeHandoffRecord,
  WebCryptoHandoffIntegrity,
} from "@obsidian-plugin/state/handoff-codec";
import {
  createMirrorOperationalStatus,
  type MirrorOperationalStatus,
} from "@obsidian-plugin/status/mirror-status";

export type {
  MirrorRuntimeAttachResult,
  MirrorRuntimeSessionAttachment,
} from "@obsidian-plugin/runtime/mirror-observation-epoch";

/** Version of the same-realm runtime-owner structural contract. */
export const MIRROR_RUNTIME_OWNER_VERSION = 5;

/** Construction dependencies retained behind plugin adapter boundaries. */
export interface MirrorRuntimeOwnerDependencies {
  readonly stateOwner: MirrorStateOwner;
  readonly local: ReadOnlyLocalVault;
  readonly localWriter?: LocalReconciliationWriter;
  readonly secretStorage: ObsidianSecretStorageHost;
  readonly runtime: MirrorSynchronizerRuntime;
  readonly fetch?: RemoteFetch | null;
  readonly cryptography?: Crypto;
  /** Explicit runtime recovery probe; production verifies a real SHA-256 operation. */
  readonly probeRuntime?: () => Promise<boolean>;
  /** Single listener/layout authority also guards exact local/remote dispatch boundaries. */
  readonly epochs?: MirrorObservationEpochCoordinator;
  /** Shared exact-operation lease checked by local and Fetch adapters. */
  readonly effectDispatchAuthority?: MirrorEffectDispatchAuthority;
}

/** Closed operational action result suitable for sanitized UI. */
export type MirrorRuntimeActionResult =
  | { readonly kind: "completed" }
  | { readonly kind: "not-ready" }
  | { readonly kind: "failed" };

/** Closed wake result preventing implicit retries after unexpected runtime failure. */
export type MirrorRuntimeSynchronizationResult =
  | { readonly kind: "completed" }
  | { readonly kind: "fenced" };

/** Handoff export result containing only explicit content-free transfer metadata. */
export type MirrorRuntimeHandoffExportResult =
  | { readonly kind: "exported"; readonly encoded: string }
  | { readonly kind: "not-ready" }
  | { readonly kind: "failed" };

/**
 * Same-realm facade composing explicit host lifecycle policy owners.
 *
 * Long-lived core work remains here, while observation epochs, configuration/admission,
 * reconciliation progress and staged handoff verification each have one dedicated
 * semantic owner. The facade routes decisions and retains sanitized outcomes only.
 */
export class MirrorRuntimeOwner {
  /** Structural compatibility identifier validated before a same-realm owner is reused. */
  readonly version = MIRROR_RUNTIME_OWNER_VERSION;
  /** Durable state authority shared by every runtime adapter and application service. */
  readonly stateOwner: MirrorStateOwner;
  private readonly admission = new MirrorConnectionAdmissionCoordinator();
  private readonly epochs: MirrorObservationEpochCoordinator;
  private readonly reconciliation = new MirrorReconciliationCoordinator();
  private readonly scheduler = new FairMirrorScheduler();
  private readonly observations =
    new ReconciliationObservationGenerationOwner();
  private reviewed: ReconciliationRuntimeOwner | null = null;
  private readonly outcomes = new Map<NotePath, MirrorPathJobOutcome>();
  /** Whether normal scheduling and reviewed work may run after the durable startup barrier. */
  private normalSchedulingReady = false;
  /** Whether positive-only bootstrap may run before normal event delivery is activated. */
  private bootstrapSchedulingReady = false;
  /** Exact attached presentation identity used to revoke its lease on delivery failure. */
  private sessionId: string | null = null;
  /** Sticky per-attachment fence preventing lease publication after any lost observation. */
  private observationDeliveryUnavailable = false;
  /** Queue drain captured from the event adapter for the current ready attachment. */
  private startupEventDrain: (() => Promise<boolean>) | null = null;
  /** Delivery activation captured alongside the current attachment's queue drain. */
  private startupEventActivation: (() => boolean) | null = null;
  /** Shares one startup observation drain across concurrent readiness callers. */
  private startupEventBarrier: Promise<boolean> | null = null;
  private readonly handoff: MirrorStagedHandoffVerifier;
  private activeOwnerOperations = 0;

  /** @param dependencies - Validated state plus host-independent and adapter seams. */
  constructor(private readonly dependencies: MirrorRuntimeOwnerDependencies) {
    this.stateOwner = dependencies.stateOwner;
    this.epochs =
      dependencies.epochs ?? new MirrorObservationEpochCoordinator();
    this.handoff = new MirrorStagedHandoffVerifier({
      stateOwner: dependencies.stateOwner,
      local: dependencies.local,
      runtime: dependencies.runtime,
      admission: this.admission,
      secretAvailable: () => this.secretAvailable(),
      onChanged: () => this.notify(),
      ...(dependencies.cryptography === undefined
        ? {}
        : { cryptography: dependencies.cryptography }),
    });
  }

  /**
   * Attaches one presentation/listener epoch without replacing long-lived work.
   * @param attachment - Enable-lifetime session identity and notification callback.
   * @returns Whether this session acquired presentation ownership.
   */
  attach(
    attachment: MirrorRuntimeSessionAttachment,
  ): MirrorRuntimeAttachResult {
    const isNewAttachment = this.sessionId !== attachment.id;
    const result = this.epochs.attach(attachment);
    if (result.kind === "attached") {
      if (isNewAttachment) this.observationDeliveryUnavailable = false;
      this.sessionId = attachment.id;
    }
    this.reconcileAdmission();
    this.notify();
    return result;
  }

  /**
   * Detaches host observation and timers while preserving actual work settlement.
   * @param sessionId - Enable-lifetime identity being detached.
   */
  detach(sessionId: string): void {
    if (!this.epochs.detach(sessionId)) return;
    this.sessionId = null;
    const parsedSessionId = createMirrorOperationId(sessionId);
    if (parsedSessionId !== undefined) {
      this.reviewed?.invalidateSession(parsedSessionId);
    }
    this.admission.gate.disable();
    this.normalSchedulingReady = false;
    this.bootstrapSchedulingReady = false;
    void this.classifyObservationGap();
  }

  /**
   * @param sessionId - Enable-lifetime identity to compare.
   * @returns Whether the supplied session owns current host presentation.
   */
  isAttached(sessionId: string): boolean {
    return this.epochs.isAttached(sessionId);
  }

  /**
   * Applies one strict settings snapshot through configuration/admission ownership.
   * @param decoded - Current strict data.json boundary result.
   */
  async applyConfiguration(
    decoded: MirrorPreferencesDecodeResult | { readonly kind: "unavailable" },
  ): Promise<void> {
    const decision = this.admission.applyConfiguration(decoded);
    const current = this.admission.currentConnection();
    const nextOrigin = decision.preferences?.origin ?? null;
    const nextSecretReference = decision.preferences?.secretReference ?? null;
    if (
      decision.connectionChanged &&
      current !== null &&
      (current.origin !== nextOrigin ||
        current.secretReference !== nextSecretReference)
    ) {
      await this.retireConnectionForConfigurationChange();
    }
    if (nextOrigin === null || nextSecretReference === null) {
      await this.retireConnectionForConfigurationChange();
      this.notify();
      return;
    }
    if (this.admission.currentConnection() === null) {
      if (!this.canCreateConnection(nextOrigin)) {
        await this.pauseForConfigurationChange();
        this.reconcileAdmission();
        this.notify();
        return;
      }
      this.createConnection(
        nextOrigin,
        nextSecretReference,
        decision.generation,
      );
    }
    this.reconcileAdmission();
    this.notify();
    if (this.epochs.isLayoutReady()) this.bootstrapSchedulingReady = true;
    if (
      this.epochs.isLayoutReady() &&
      (await this.startAndCompleteAutomaticReconciliation(false))
    ) {
      this.notify();
    }
  }

  /**
   * Fences persisted operations, publishes the lease for positive bootstrap, then drains queued observations before normal scheduling.
   * @param sessionId - Current enable-lifetime session identity.
   * @param drainQueuedEvents - Adapter barrier that persists callbacks captured during classification.
   * @param activateEvents - Adapter action opening delivery after bootstrap ordering is established.
   */
  async onLayoutReady(
    sessionId: string,
    drainQueuedEvents: () => Promise<boolean> = async () => true,
    activateEvents: () => boolean = () => true,
  ): Promise<void> {
    const ready = this.epochs.markLayoutReady(sessionId);
    if (ready.kind !== "ready") return;
    this.startupEventBarrier = null;
    if (
      !(await this.classifyObservationGap()) ||
      this.observationDeliveryUnavailable ||
      this.sessionId !== sessionId
    ) {
      return;
    }
    this.startupEventDrain = drainQueuedEvents;
    this.startupEventActivation = activateEvents;
    if (!this.epochs.publishDispatchLease(sessionId)) return;
    this.reconcileAdmission();
    if (this.admission.currentConnection() === null) return;
    this.bootstrapSchedulingReady = true;
    this.notify();
    const activeWriter =
      this.stateOwner.snapshot().state.lifecycle.kind ===
      MIRROR_DEVICE_LIFECYCLE_KIND.active;
    const bootstrapCompleted = await this.startAutomaticReconciliation(false);
    if (
      this.observationDeliveryUnavailable ||
      (activeWriter && !bootstrapCompleted)
    ) {
      return;
    }
    if (!(await this.completeStartupEventBarrier())) return;
    this.normalSchedulingReady = bootstrapCompleted || !activeWriter;
    if (bootstrapCompleted) this.reviewed?.resumePersisted();
    this.notify();
  }

  /**
   * Routes a create/modify event to staged invalidation or ordinary core policy.
   * @param path - Immutable eligible saved path from the host event.
   * @throws When local observation persistence fails, so the event adapter revokes its lease.
   */
  async observePresent(
    path: NotePath,
    eventKind: ReconciliationEventKind = RECONCILIATION_EVENT_KIND.modify,
  ): Promise<void> {
    try {
      const generation = this.observations.observe(path);
      if (await this.reviewed?.observeEvent(path, eventKind, generation))
        return;
      if (await this.handoff.observePresent(path)) return;
      const synchronizer = this.admission.currentConnection()?.synchronizer;
      if (synchronizer === undefined) return;
      await this.runOwnerOperation(() => synchronizer.observePresent(path));
    } finally {
      this.assertObservationPersistenceAvailable();
    }
  }

  /**
   * Routes a delete event to staged invalidation or post-bootstrap core policy.
   * @param path - Immutable eligible deleted path from the host event.
   * @throws When local observation persistence fails, so the event adapter revokes its lease.
   */
  async observeDelete(path: NotePath): Promise<void> {
    try {
      const generation = this.observations.observe(path);
      if (
        await this.reviewed?.observeEvent(
          path,
          RECONCILIATION_EVENT_KIND.delete,
          generation,
        )
      ) {
        return;
      }
      if (await this.handoff.observeDelete(path)) return;
      const synchronizer = this.admission.currentConnection()?.synchronizer;
      if (synchronizer === undefined) return;
      await this.runOwnerOperation(() => synchronizer.observeDelete(path));
    } finally {
      this.assertObservationPersistenceAvailable();
    }
  }

  /**
   * Routes a file rename without granting staged state ordinary mutation intent.
   * @param sourcePath - Eligible pre-event path.
   * @param destinationPath - Eligible destination or null when it left scope.
   * @throws When local observation persistence fails, so the event adapter revokes its lease.
   */
  async observeRename(
    sourcePath: NotePath,
    destinationPath: NotePath | null,
  ): Promise<void> {
    try {
      const sourceGeneration = this.observations.observe(sourcePath);
      const sourceReserved = await this.reviewed?.observeEvent(
        sourcePath,
        RECONCILIATION_EVENT_KIND.rename,
        sourceGeneration,
      );
      const destinationReserved =
        destinationPath === null
          ? false
          : await this.reviewed?.observeEvent(
              destinationPath,
              RECONCILIATION_EVENT_KIND.rename,
              this.observations.observe(destinationPath),
            );
      if (sourceReserved || destinationReserved) return;
      if (await this.handoff.observeRename(sourcePath, destinationPath)) return;
      const synchronizer = this.admission.currentConnection()?.synchronizer;
      if (synchronizer === undefined) return;
      await this.runOwnerOperation(async () => {
        if (destinationPath === null) {
          await synchronizer.observeRenameOutOfEligibility(sourcePath);
          return;
        }
        await synchronizer.observeRename(sourcePath, destinationPath);
      });
    } finally {
      this.assertObservationPersistenceAvailable();
    }
  }

  /**
   * Routes folder renames through staged descendants or bounded core expansion.
   * @param oldFolder - Literal pre-event folder prefix.
   * @param newFolder - New eligible prefix or null when it left scope.
   * @returns Bounded core expansion, staged invalidation summary, or no connection.
   * @throws When local observation persistence fails, so the event adapter revokes its lease.
   */
  async observeFolderRename(
    oldFolder: string,
    newFolder: string | null,
  ): Promise<MirrorFolderRenameResult | null> {
    try {
      await this.observeReservedFolderRename(oldFolder, newFolder);
      if (await this.handoff.observeFolderRename(oldFolder, newFolder)) {
        return { planned: 0, deferred: 0, knownDescendants: 0 };
      }
      const synchronizer = this.admission.currentConnection()?.synchronizer;
      if (synchronizer === undefined) return null;
      return await this.runOwnerOperation(() =>
        synchronizer.observeFolderRename(oldFolder, newFolder),
      );
    } finally {
      this.assertObservationPersistenceAvailable();
    }
  }

  /**
   * Revokes observation and effect authority when a host callback cannot be durably delivered.
   *
   * Lease invalidation is synchronous; the durable gap fence is best-effort and must
   * complete before a later epoch can publish a replacement lease.
   *
   * @returns Completion of the durable classification attempt.
   */
  failObservationDelivery(): Promise<void> {
    this.observationDeliveryUnavailable = true;
    if (this.sessionId !== null) {
      this.epochs.invalidateDispatchLease(this.sessionId);
    }
    this.admission.gate.disable();
    this.normalSchedulingReady = false;
    this.bootstrapSchedulingReady = false;
    const presentationId =
      this.sessionId === null
        ? undefined
        : createMirrorOperationId(this.sessionId);
    if (presentationId !== undefined) {
      this.reviewed?.invalidateSession(presentationId);
    }
    this.notify();
    return this.classifyObservationGap().then(() => undefined);
  }

  /**
   * Records a folder callback as successor evidence for every reserved descendant.
   * @param oldFolder - Literal pre-event folder prefix.
   * @param newFolder - Eligible destination prefix or null after scope exit.
   */
  private async observeReservedFolderRename(
    oldFolder: string,
    newFolder: string | null,
  ): Promise<void> {
    if (this.reviewed === null || oldFolder.length === 0) return;
    const affectedPrefixes = [
      `${oldFolder}/`,
      ...(newFolder === null ? [] : [`${newFolder}/`]),
    ];
    const reservedPaths = new Set(
      this.stateOwner
        .snapshot()
        .state.reconciliationOperations.filter(
          (operation) =>
            operation.phase !== RECONCILIATION_OPERATION_PHASE.completed &&
            operation.phase !== RECONCILIATION_OPERATION_PHASE.stale,
        )
        .flatMap((operation) =>
          operation.reservations.map((reservation) => reservation.path),
        )
        .filter((path) =>
          affectedPrefixes.some((prefix) => path.startsWith(prefix)),
        ),
    );
    for (const path of reservedPaths) {
      await this.reviewed.observeEvent(
        path,
        RECONCILIATION_EVENT_KIND.rename,
        this.observations.observe(path),
      );
    }
  }

  /** @returns Positive-bootstrap deadline before queue drain, otherwise normal work deadline for the ready epoch. */
  nextWakeAtMilliseconds(): number | null {
    if (!this.epochs.isLayoutReady() || !this.bootstrapSchedulingReady) {
      return null;
    }
    const synchronizer = this.admission.currentConnection()?.synchronizer;
    if (synchronizer === undefined) return null;
    return this.normalSchedulingReady
      ? synchronizer.nextWakeAtMilliseconds()
      : synchronizer.nextBootstrapPositiveWakeAtMilliseconds();
  }

  /**
   * Runs only current-scan positive bootstrap paths before queue drain, then normal work; fences unexpected local runtime failure.
   * @returns Whether work settled normally or scheduling was fenced.
   */
  async synchronizeReady(): Promise<MirrorRuntimeSynchronizationResult> {
    if (!this.bootstrapSchedulingReady) return { kind: "completed" };
    const synchronizer = this.admission.currentConnection()?.synchronizer;
    if (synchronizer === undefined) return { kind: "completed" };
    try {
      await this.runOwnerOperation(async () => {
        if (this.normalSchedulingReady) {
          await synchronizer.synchronizeReady();
        } else {
          await synchronizer.synchronizeBootstrapPositiveReady();
        }
        this.captureOutcomes(synchronizer);
      });
      return { kind: "completed" };
    } catch {
      await this.fenceRuntimeFailure();
      return { kind: "fenced" };
    }
  }

  /**
   * Explicit positive-only rescan and runtime-fence recovery control.
   * @returns Sanitized completion or readiness result.
   */
  async checkNow(): Promise<MirrorRuntimeActionResult> {
    if (
      !this.epochs.isLayoutReady() ||
      this.admission.currentConnection() === null
    ) {
      return { kind: "not-ready" };
    }
    if (!(await this.recoverRuntimeIfNeeded())) return { kind: "failed" };
    const result = await this.startAndCompleteAutomaticReconciliation(true);
    return result ? { kind: "completed" } : { kind: "failed" };
  }

  /**
   * Explicitly verifies and records authenticated server designation metadata.
   * @returns Sanitized verification result.
   */
  async verifyServerIdentity(): Promise<MirrorRuntimeActionResult> {
    const connection = this.admission.currentConnection();
    if (
      !this.epochs.isLayoutReady() ||
      connection === null ||
      !this.secretAvailable()
    ) {
      return { kind: "not-ready" };
    }
    if (!this.admission.enableForVerification(connection)) {
      return { kind: "not-ready" };
    }
    const description = await connection.remote.describe();
    if (
      description.kind === "failure" ||
      !this.admission.isCurrent(connection)
    ) {
      this.admission.recordServerUnavailable();
      this.reconcileAdmission();
      this.notify();
      return { kind: "failed" };
    }
    this.admission.recordServerIdentity(
      description.value.associationId,
      description.value.writerId,
      this.stateOwner.snapshot().state.deviceId,
      this.currentAssociationId(),
    );
    this.reconcileAdmission();
    this.notify();
    return { kind: "completed" };
  }

  /**
   * Grants fresh finite budgets only to core-approved exhausted intents.
   * @returns Whether any retry budget was granted.
   */
  async retryFailures(): Promise<MirrorRuntimeActionResult> {
    const synchronizer = this.admission.currentConnection()?.synchronizer;
    if (synchronizer === undefined) return { kind: "not-ready" };
    let granted = false;
    for (const entry of this.stateOwner.snapshot().state.paths) {
      if (entry.blockedReason !== MIRROR_PATH_BLOCK_REASON.retryExhausted)
        continue;
      granted = (await synchronizer.grantRetry(entry.path)) || granted;
    }
    this.notify();
    return granted ? { kind: "completed" } : { kind: "not-ready" };
  }

  /**
   * Durably pauses admission while preserving all unresolved durable work.
   * @returns Sanitized durable transition result.
   */
  async pause(): Promise<MirrorRuntimeActionResult> {
    this.admission.gate.disable();
    const result = await this.stateOwner.transition((state) =>
      pauseMirrorWriter(state, MIRROR_PAUSE_REASON.manual),
    );
    this.notify();
    return result.kind === "committed"
      ? { kind: "completed" }
      : { kind: "not-ready" };
  }

  /**
   * Activates a disabled writer after consent and fresh designation verification.
   * @param explicitWholeMirrorConsent - Current explicit plaintext/scope consent.
   * @returns Sanitized activation and reconciliation result.
   */
  async activate(
    explicitWholeMirrorConsent: boolean,
  ): Promise<MirrorRuntimeActionResult> {
    const connection = this.admission.currentConnection();
    if (
      !explicitWholeMirrorConsent ||
      !this.epochs.isLayoutReady() ||
      connection === null ||
      !this.secretAvailable() ||
      !(await this.recoverRuntimeIfNeeded())
    ) {
      return { kind: "not-ready" };
    }
    if (!this.admission.enableForVerification(connection)) {
      return { kind: "not-ready" };
    }
    const description = await connection.remote.describe();
    if (
      description.kind === "failure" ||
      !this.admission.isCurrent(connection)
    ) {
      this.admission.recordServerUnavailable();
      this.reconcileAdmission();
      return { kind: "failed" };
    }
    const localDeviceId = this.stateOwner.snapshot().state.deviceId;
    this.admission.recordServerIdentity(
      description.value.associationId,
      description.value.writerId,
      localDeviceId,
      this.currentAssociationId(),
    );
    const result = await this.stateOwner.transition((state) => {
      if (!this.admission.isCurrent(connection)) return undefined;
      const activated = activateIsolatedAssociation(state, {
        origin: connection.origin,
        associationId: description.value.associationId,
        designatedWriterId: description.value.writerId,
        secretAvailable: true,
        explicitWholeMirrorConsent,
        isolatedEmptyAssociationConfirmed: true,
      });
      return activated.kind === "activated" ? activated.state : undefined;
    });
    if (result.kind !== "committed") {
      this.reconcileAdmission();
      this.notify();
      return { kind: "not-ready" };
    }
    if (await this.settleStaleActivation(connection)) return { kind: "failed" };
    this.reconciliation.invalidate();
    await this.startAutomaticReconciliation(true);
    return { kind: "completed" };
  }

  /**
   * Resumes only the same paused binding after fresh capability/designation proof.
   * @returns Sanitized resume and reconciliation result.
   */
  async resume(): Promise<MirrorRuntimeActionResult> {
    const connection = this.admission.currentConnection();
    if (
      !this.epochs.isLayoutReady() ||
      connection === null ||
      !this.secretAvailable() ||
      !(await this.recoverRuntimeIfNeeded())
    ) {
      return { kind: "not-ready" };
    }
    const persistence = await this.stateOwner.verifyPersistence();
    if (!persistence.persistenceAvailable) return { kind: "failed" };
    if (!this.admission.enableForVerification(connection)) {
      return { kind: "not-ready" };
    }
    const description = await connection.remote.describe();
    if (
      description.kind === "failure" ||
      !this.admission.isCurrent(connection)
    ) {
      this.admission.recordServerUnavailable();
      this.reconcileAdmission();
      return { kind: "failed" };
    }
    this.admission.recordServerIdentity(
      description.value.associationId,
      description.value.writerId,
      this.stateOwner.snapshot().state.deviceId,
      this.currentAssociationId(),
    );
    const result = await this.stateOwner.transition((state) => {
      if (!this.admission.isCurrent(connection)) return undefined;
      const resumed = resumeMirrorWriter(state, {
        origin: connection.origin,
        associationId: description.value.associationId,
        designatedWriterId: description.value.writerId,
        secretAvailable: true,
      });
      return resumed.kind === "resumed" ? resumed.state : undefined;
    });
    if (result.kind !== "committed") {
      this.reconcileAdmission();
      this.notify();
      return { kind: "not-ready" };
    }
    if (await this.settleStaleActivation(connection)) return { kind: "failed" };
    this.reconciliation.invalidate();
    await this.startAutomaticReconciliation(true);
    return { kind: "completed" };
  }

  /**
   * Produces content-free handoff metadata only after real quiescence.
   * @returns Encoded metadata or a sanitized refusal.
   */
  async prepareHandoff(): Promise<MirrorRuntimeHandoffExportResult> {
    this.admission.gate.disable();
    const draining = await this.stateOwner.transition((state) =>
      pauseForHandoff(state),
    );
    if (
      draining.kind !== "committed" &&
      this.stateOwner.snapshot().state.lifecycle.kind !==
        MIRROR_DEVICE_LIFECYCLE_KIND.handoffDraining
    ) {
      return { kind: "not-ready" };
    }
    if (
      this.activeOwnerOperations > 0 ||
      this.admission.gate.activeCount() > 0
    ) {
      return { kind: "not-ready" };
    }
    const drained = await this.stateOwner.transition((state) => {
      const transition = markHandoffDrained(state);
      return transition.kind === "drained" ? transition.state : undefined;
    });
    if (drained.kind !== "committed") return { kind: "not-ready" };
    const prepared = prepareHandoffExport(drained.snapshot.state);
    if (prepared.kind !== "prepared") return { kind: "not-ready" };
    try {
      const record = await createHandoffRecord(
        prepared.payload,
        this.handoffIntegrity(),
      );
      return { kind: "exported", encoded: encodeHandoffRecord(record) };
    } catch {
      return { kind: "failed" };
    } finally {
      this.notify();
    }
  }

  /**
   * Imports, verifies and atomically activates metadata-only handoff state.
   * @param encoded - Strict user-controlled metadata-only handoff JSON.
   * @param explicitWholeMirrorConsent - Current explicit plaintext/scope consent.
   * @returns Sanitized verification and activation result.
   */
  async importHandoff(
    encoded: string,
    explicitWholeMirrorConsent: boolean,
  ): Promise<MirrorRuntimeActionResult> {
    const connection = this.admission.currentConnection();
    if (!this.epochs.isLayoutReady() || connection === null) {
      return { kind: "not-ready" };
    }
    if (!(await this.recoverRuntimeIfNeeded())) return { kind: "failed" };
    let result: Awaited<
      ReturnType<MirrorStagedHandoffVerifier["importAndActivate"]>
    >;
    try {
      result = await this.runOwnerOperation(() =>
        this.handoff.importAndActivate(
          encoded,
          connection,
          explicitWholeMirrorConsent,
        ),
      );
    } catch {
      await this.fenceRuntimeFailure();
      return { kind: "failed" };
    }
    if (result.kind !== "completed") return result;
    if (await this.settleStaleActivation(connection)) {
      return { kind: "not-ready" };
    }
    this.reconciliation.invalidate();
    await this.startAutomaticReconciliation(true);
    return { kind: "completed" };
  }

  /**
   * Lists current M4 candidates only after startup observations are durable and the attached session is fully ready.
   * @param sessionId - Current plugin enable-lifetime UUID.
   * @returns Sanitized bounded candidate projection.
   */
  async listReconciliationCandidates(
    sessionId: string,
  ): Promise<ReconciliationCandidateList> {
    if (!this.reconciliationReady(sessionId)) return { kind: "unavailable" };
    return this.reviewed?.listCandidates() ?? { kind: "unavailable" };
  }

  /**
   * Lists every active gap-fenced operation and its exact bounded reservations.
   * @param sessionId - Current plugin enable-lifetime UUID.
   * @returns Sanitized bounded gap candidates, or unavailable when the session is stale.
   */
  listObservationGaps(sessionId: string): ReconciliationObservationGapList {
    return this.reconciliationReady(sessionId)
      ? (this.reviewed?.listObservationGaps() ?? { kind: "unavailable" })
      : { kind: "unavailable" };
  }

  /**
   * Creates a complete fresh review for one active gap-fenced predecessor.
   * @param sessionId - Current plugin enable-lifetime UUID.
   * @param predecessorOperationId - Exact operation retaining the gap reservations.
   * @returns Sanitized complete-group evidence, or a fail-closed outcome.
   */
  createObservationGapReview(
    sessionId: string,
    predecessorOperationId: import("@obsidian-ai-bridge/core").MirrorOperationId,
  ): Promise<ReconciliationGapReviewCreationResult> {
    const parsed = createMirrorOperationId(sessionId);
    if (!this.reconciliationReady(sessionId) || parsed === undefined) {
      return Promise.resolve({ kind: "unavailable" });
    }
    return (
      this.reviewed?.createGapGroupReview(parsed, predecessorOperationId) ??
      Promise.resolve({ kind: "unavailable" })
    );
  }

  /**
   * Closes one transient gap review without changing durable reservations.
   * @param sessionId - Exact process-local presentation owner.
   * @param reviewId - Complete gap-group review identity.
   * @returns Nothing; unsubmitted bodies are discarded.
   */
  closeObservationGapReview(
    sessionId: string,
    reviewId: import("@obsidian-ai-bridge/core").MirrorOperationId,
  ): void {
    const parsed = createMirrorOperationId(sessionId);
    if (parsed !== undefined) {
      this.reviewed?.closeGapGroupReview(parsed, reviewId);
    }
  }

  /**
   * Atomically submits all target-scoped gap successors or the no-effect settlement.
   * @param sessionId - Exact current plugin enable-lifetime UUID.
   * @param reviewId - Complete fresh group review identity.
   * @param actions - Every child action, or an empty list for exact no-effect settlement.
   * @returns Sanitized outcome after one serialized durable commit.
   */
  submitObservationGapReview(
    sessionId: string,
    reviewId: import("@obsidian-ai-bridge/core").MirrorOperationId,
    actions: readonly ReconciliationGapActionSelection[],
  ): Promise<ReconciliationUiCommandResult> {
    const parsed = createMirrorOperationId(sessionId);
    if (!this.reconciliationReady(sessionId) || parsed === undefined) {
      return Promise.resolve({ kind: "unavailable" });
    }
    return (
      this.reviewed?.submitGapGroup(parsed, reviewId, actions) ??
      Promise.resolve({ kind: "unavailable" })
    );
  }

  /**
   * Creates one content-free M4 detail for the current session.
   * @param sessionId - Current plugin enable-lifetime UUID.
   * @param path - Candidate path selected by the operator.
   * @param recoveryId - Optional exact recovery identity.
   * @param destinationPath - Optional untrusted destination literal sampled after normalization.
   * @returns Sanitized detail or null when stale/unavailable.
   */
  createReconciliationReview(
    sessionId: string,
    path: NotePath,
    recoveryId:
      | import("@obsidian-ai-bridge/core").RecoverySnapshotId
      | null = null,
    destinationPath: string | null = null,
  ): Promise<ReconciliationReviewDetail | null> {
    const parsed = createMirrorOperationId(sessionId);
    if (!this.reconciliationReady(sessionId) || parsed === undefined) {
      return Promise.resolve(null);
    }
    return (
      this.reviewed?.createReview(parsed, path, recoveryId, destinationPath) ??
      Promise.resolve(null)
    );
  }

  /**
   * Lists bounded recovery metadata for explicit operator selection.
   * @param sessionId - Current plugin enable-lifetime UUID.
   * @returns Sanitized recovery rows, or an empty list when unavailable.
   */
  listRecoverySelections(sessionId: string): Promise<RecoverySelectionList> {
    return this.reconciliationReady(sessionId)
      ? (this.reviewed?.listRecoveries() ??
          Promise.resolve({ kind: "unavailable" }))
      : Promise.resolve({ kind: "unavailable" });
  }

  /**
   * Returns one explicitly requested literal preview for a current review.
   * @param sessionId - Current plugin enable-lifetime UUID.
   * @param reviewId - Pending review identity.
   * @param side - Selected local or remote sample.
   * @returns Bounded inert text or null.
   */
  reconciliationPreview(
    sessionId: string,
    reviewId: import("@obsidian-ai-bridge/core").MirrorOperationId,
    side: "local" | "remote",
  ): string | null {
    const parsed = createMirrorOperationId(sessionId);
    return parsed === undefined
      ? null
      : (this.reviewed?.preview(parsed, reviewId, side) ?? null);
  }

  /**
   * Closes one pending review and discards transient samples.
   * @param sessionId - Current plugin enable-lifetime UUID.
   * @param reviewId - Pending review identity.
   */
  closeReconciliationReview(
    sessionId: string,
    reviewId: import("@obsidian-ai-bridge/core").MirrorOperationId,
  ): void {
    const parsed = createMirrorOperationId(sessionId);
    if (parsed !== undefined) this.reviewed?.closeReview(parsed, reviewId);
  }

  /**
   * Submits one exact M4 decision from the current presentation session.
   * @param sessionId - Current plugin enable-lifetime UUID.
   * @param reviewId - Ephemeral review identity.
   * @param action - Closed typed operator action.
   * @param destinationPath - Optional literal destination.
   * @returns Sanitized command result.
   */
  submitReconciliation(
    sessionId: string,
    reviewId: import("@obsidian-ai-bridge/core").MirrorOperationId,
    action: ReconciliationAdmissionAction,
    destinationPath?: NotePath | null,
  ): Promise<ReconciliationUiCommandResult> {
    const parsed = createMirrorOperationId(sessionId);
    if (!this.reconciliationReady(sessionId) || parsed === undefined) {
      return Promise.resolve({ kind: "unavailable" });
    }
    return (
      this.reviewed?.submit(parsed, reviewId, action, destinationPath) ??
      Promise.resolve({ kind: "unavailable" })
    );
  }

  /** @returns Current sanitized status projection for UI and commands. */
  status(): MirrorOperationalStatus {
    const connection = this.admission.currentConnection();
    return createMirrorOperationalStatus(
      this.admission.currentConfigurationStatus(),
      this.stateOwner.snapshot(),
      connection?.synchronizer.currentPhase() ?? null,
      this.outcomes,
      this.admission.currentServerIdentity(),
    );
  }

  /**
   * @param sessionId - Exact attached plugin session identity.
   * @returns Whether the session may query or submit M4 reviewed work.
   */
  private reconciliationReady(sessionId: string): boolean {
    return (
      this.epochs.isAttached(sessionId) &&
      this.epochs.isLayoutReady() &&
      this.normalSchedulingReady &&
      this.reviewed !== null &&
      this.admission.currentServerIdentity().kind === "matched" &&
      this.stateOwner.snapshot().mutationAdmissionAllowed
    );
  }

  /**
   * Durably fences every active operation before a fresh listener epoch may dispatch.
   *
   * @returns Whether the current state is persistent and all gap classification was committed.
   */
  private async classifyObservationGap(): Promise<boolean> {
    if (!this.stateOwner.snapshot().persistenceAvailable) return false;
    const committed = await this.stateOwner.transitionIfChanged(
      fenceActiveReconciliationForObservationGap,
    );
    return (
      committed.kind === "committed" && committed.snapshot.persistenceAvailable
    );
  }

  /**
   * Drains callbacks accumulated during bootstrap before enabling ordinary event scheduling.
   *
   * @returns Whether queued observations were committed and live event delivery is active.
   */
  private completeStartupEventBarrier(): Promise<boolean> {
    const sessionId = this.sessionId;
    if (
      sessionId === null ||
      !this.epochs.isAttached(sessionId) ||
      !this.epochs.isLayoutReady()
    ) {
      return Promise.resolve(false);
    }
    if (this.startupEventBarrier !== null) {
      return this.startupEventBarrier.then(
        (completed) =>
          completed &&
          this.epochs.isAttached(sessionId) &&
          this.epochs.isLayoutReady(),
      );
    }

    const drain = this.startupEventDrain;
    const activate = this.startupEventActivation;
    if (drain === null && activate === null) return Promise.resolve(true);
    if (drain === null || activate === null) {
      this.epochs.invalidateDispatchLease(sessionId);
      this.admission.gate.disable();
      this.normalSchedulingReady = false;
      this.bootstrapSchedulingReady = false;
      return Promise.resolve(false);
    }
    this.startupEventBarrier = this.drainAndActivateStartupEvents(
      sessionId,
      drain,
      activate,
    );
    return this.startupEventBarrier;
  }

  /**
   * Persists startup callbacks once and activates delivery only for their owning listener session.
   * @param sessionId - Session that owns the captured queue callbacks.
   * @param drain - Persistence barrier captured when this session became ready.
   * @param activate - Event-delivery activation captured for the same session.
   * @returns Whether the same session still owns a ready dispatch lease.
   */
  private async drainAndActivateStartupEvents(
    sessionId: string,
    drain: () => Promise<boolean>,
    activate: () => boolean,
  ): Promise<boolean> {
    if (!(await drain()) || !activate()) {
      if (this.epochs.isAttached(sessionId)) {
        this.epochs.invalidateDispatchLease(sessionId);
        this.admission.gate.disable();
        this.normalSchedulingReady = false;
        this.bootstrapSchedulingReady = false;
      }
      return false;
    }
    return this.epochs.isAttached(sessionId) && this.epochs.isLayoutReady();
  }

  /**
   * Completes positive bootstrap, drains startup observations and resumes only current-lease operations.
   *
   * @param force - Whether a previously completed identity should bootstrap again.
   * @returns Whether bootstrap, queued-event persistence and listener activation all completed.
   */
  private async startAndCompleteAutomaticReconciliation(
    force: boolean,
  ): Promise<boolean> {
    this.bootstrapSchedulingReady = this.epochs.isLayoutReady();
    if (!(await this.startAutomaticReconciliation(force))) return false;
    if (!(await this.completeStartupEventBarrier())) return false;
    this.normalSchedulingReady = true;
    this.reviewed?.resumePersisted();
    this.notify();
    return true;
  }

  /**
   * Starts/joins M3 positive-only bootstrap for the current ready epoch and binding; this is not M4 reviewed reconciliation.
   *
   * @param force - Whether a previously completed identity should bootstrap again.
   * @returns Whether bootstrap completed; false includes failed or unavailable readiness.
   */
  private async startAutomaticReconciliation(force: boolean): Promise<boolean> {
    const attachmentEpoch = this.epochs.readyEpoch();
    const connection = this.admission.currentConnection();
    if (attachmentEpoch === null || connection === null) return false;
    const state = this.stateOwner.snapshot().state;
    if (!this.secretAvailable()) {
      await this.pauseForConfigurationChange();
      this.reconcileAdmission();
      this.notify();
      return false;
    }
    if (
      state.lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.active ||
      state.lifecycle.origin !== connection.origin
    ) {
      this.reconcileAdmission();
      this.notify();
      return false;
    }
    this.reconcileAdmission();
    /**
     * Rejects progress from a detached epoch, retired connection or no-longer-active lifecycle.
     *
     * @returns Whether the captured connection and epoch remain active.
     */
    const isCurrent = () =>
      this.epochs.readyEpoch() === attachmentEpoch &&
      this.admission.isCurrent(connection) &&
      this.stateOwner.snapshot().state.lifecycle.kind ===
        MIRROR_DEVICE_LIFECYCLE_KIND.active;
    try {
      const result = await this.runOwnerOperation(() =>
        this.reconciliation.reconcile({
          attachmentEpoch,
          configurationGeneration: connection.generation,
          connectionId: connection.id,
          synchronizer: connection.synchronizer,
          force,
          isCurrent,
          onPositiveAdmission: () => this.notify(),
          onSettled: () => {
            this.captureOutcomes(connection.synchronizer);
            this.notify();
          },
        }),
      );
      return result.kind === "complete";
    } catch {
      await this.fenceRuntimeFailure();
      return false;
    }
  }

  /**
   * Closes admission and pauses if configuration changed while activation committed; never leaves stale activation running.
   *
   * @returns Whether the connection was stale and admission was closed; false when still current.
   */
  private async settleStaleActivation(
    connection: MirrorRuntimeConnection,
  ): Promise<boolean> {
    if (this.admission.isCurrent(connection)) return false;
    this.admission.gate.disable();
    await this.pauseForConfigurationChange();
    this.notify();
    return true;
  }

  /** Retires connection identity and bootstrap completion while preserving old in-flight settlement and pausing active state. */
  private async retireConnectionForConfigurationChange(): Promise<void> {
    this.normalSchedulingReady = false;
    this.bootstrapSchedulingReady = false;
    this.dependencies.effectDispatchAuthority?.setConfigurationGeneration(null);
    this.reviewed?.detach();
    this.reviewed = null;
    this.admission.retireConnection();
    this.reconciliation.invalidate();
    await this.pauseForConfigurationChange();
  }

  /** Durably pauses only an active writer; disabled and handoff lifecycle authority remain unchanged. */
  private async pauseForConfigurationChange(): Promise<void> {
    if (
      this.stateOwner.snapshot().state.lifecycle.kind !==
      MIRROR_DEVICE_LIFECYCLE_KIND.active
    ) {
      return;
    }
    await this.stateOwner.transition((state) =>
      pauseMirrorWriter(state, MIRROR_PAUSE_REASON.manual),
    );
  }

  /**
   * Allows initial connection or the existing durable origin only; settings cannot silently rebind an established mirror.
   *
   * @returns Whether the requested origin is allowed by the durable lifecycle.
   */
  private canCreateConnection(origin: MirrorOrigin): boolean {
    const lifecycle = this.stateOwner.snapshot().state.lifecycle;
    return (
      lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.disabled ||
      lifecycle.origin === origin
    );
  }

  /** Composes Fetch and core synchronization behind generation-checked admission without replacing the durable state owner. */
  private createConnection(
    origin: MirrorOrigin,
    secretReference: string,
    generation: number,
  ): void {
    this.dependencies.effectDispatchAuthority?.setConfigurationGeneration(
      generation,
    );
    const remote = new FetchRemoteBridge({
      origin,
      secretReference,
      secretStorage: this.dependencies.secretStorage,
      ...(this.dependencies.effectDispatchAuthority === undefined
        ? {}
        : {
            effectDispatchAuthority: this.dependencies.effectDispatchAuthority,
          }),
      admission: {
        admit: async () =>
          this.admission.isGenerationCurrent(generation)
            ? this.admission.gate.admit()
            : undefined,
      },
      cancellation: {
        register: (controller) => {
          if (!this.admission.isGenerationCurrent(generation)) {
            controller.abort();
            return () => undefined;
          }
          return this.admission.gate.register(controller);
        },
      },
      ...(this.dependencies.fetch === undefined
        ? {}
        : { fetch: this.dependencies.fetch }),
      ...(this.dependencies.cryptography === undefined
        ? {}
        : { crypto: this.dependencies.cryptography }),
    });
    const synchronizer = new MirrorSynchronizer(
      this.dependencies.local,
      remote,
      this.stateOwner,
      this.dependencies.runtime,
      this.scheduler,
    );
    this.reviewed?.detach();
    this.reviewed =
      this.dependencies.localWriter === undefined
        ? null
        : new ReconciliationRuntimeOwner({
            local: this.dependencies.local,
            localWriter: this.dependencies.localWriter,
            remote,
            stateOwner: this.stateOwner,
            runtime: this.dependencies.runtime,
            observations: this.observations,
            scheduler: this.scheduler,
            cryptography: this.dependencies.cryptography ?? globalThis.crypto,
            isNormalSchedulingReady: () => this.normalSchedulingReady,
            currentIdentity: () => this.reconciliationIdentity(generation),
          });
    this.admission.publishConnection(remote, synchronizer);
  }

  /**
   * @param configurationGeneration - Exact active connection generation.
   * @returns Current identity used to stale every sampled M4 decision dimension.
   */
  private reconciliationIdentity(
    configurationGeneration: number,
  ): import("@obsidian-ai-bridge/core").ReconciliationRuntimeIdentity {
    const state = this.stateOwner.snapshot().state;
    const server = this.admission.currentServerIdentity();
    return {
      runtimeOwnerVersion: MIRROR_RUNTIME_OWNER_VERSION,
      configurationGeneration,
      listenerEpoch: this.epochs.readyEpoch() ?? 0,
      deviceId: state.deviceId,
      designatedWriterId:
        server.kind === "matched" || server.kind === "mismatch"
          ? server.designatedWriterId
          : state.deviceId,
      lifecycle: state.lifecycle,
    };
  }

  /** @returns Existing durable association binding, or null before activation. */
  private currentAssociationId(): MirrorAssociationId | null {
    const lifecycle = this.stateOwner.snapshot().state.lifecycle;
    return lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.disabled
      ? null
      : lifecycle.associationId;
  }

  /**
   * Checks the current native secret reference without exposing bearer bytes to the owner or status UI.
   *
   * @returns Whether the configured native secret currently exists.
   */
  private secretAvailable(): boolean {
    const reference =
      this.admission.currentPreferences()?.secretReference ?? null;
    return (
      new ObsidianSecretReferenceStore(this.dependencies.secretStorage).check(
        reference,
      ).kind === "available"
    );
  }

  /** Delegates request-gate readiness to the admission owner using current lifecycle, layout and secret evidence. */
  private reconcileAdmission(): void {
    this.admission.reconcileAdmission(
      this.stateOwner,
      this.epochs.isLayoutReady(),
      this.secretAvailable(),
    );
  }

  /** Immediately closes admission, invalidates bootstrap completion and persists a runtime blocker before notifying UI. */
  private async fenceRuntimeFailure(): Promise<void> {
    this.admission.fenceRuntime();
    this.reconciliation.invalidate();
    await this.stateOwner.transition((state) => fenceMirrorRuntime(state));
    this.notify();
  }

  /**
   * Clears only the runtime-unavailable fence after the configured capability probe succeeds; preserves other blockers.
   *
   * @returns Whether runtime capability recovery succeeded or was unnecessary.
   */
  private async recoverRuntimeIfNeeded(): Promise<boolean> {
    if (
      this.stateOwner.snapshot().state.globalBlockReason !==
      MIRROR_GLOBAL_BLOCK_REASON.runtimeUnavailable
    ) {
      return true;
    }
    const available = await (this.dependencies.probeRuntime?.() ??
      Promise.resolve(true));
    if (!available) return false;
    const recovered = await this.admission.recoverRuntime(this.stateOwner);
    if (!recovered) return false;
    this.reconciliation.invalidate();
    this.reconcileAdmission();
    this.notify();
    return true;
  }

  /** Refuses to acknowledge an event sink callback after any durable observation write failed. */
  private assertObservationPersistenceAvailable(): void {
    if (!this.stateOwner.snapshot().persistenceAvailable) {
      throw new Error("Observation persistence is unavailable.");
    }
  }

  /**
   * Counts owner-lifetime work until actual promise settlement so handoff cannot drain during detached session work.
   *
   * @param operation - Owner-scoped asynchronous work counted through settlement.
   * @returns The operation result, retaining rejection after work accounting settles.
   */
  private async runOwnerOperation<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    this.activeOwnerOperations += 1;
    try {
      return await operation();
    } finally {
      this.activeOwnerOperations -= 1;
      this.notify();
    }
  }

  /** Retains latest available content-free per-path outcomes for status without changing durable ACKs or blockers. */
  private captureOutcomes(synchronizer: MirrorSynchronizer): void {
    for (const entry of this.stateOwner.snapshot().state.paths) {
      const outcome = synchronizer.outcome(entry.path);
      if (outcome === undefined) continue;
      this.outcomes.delete(entry.path);
      this.outcomes.set(entry.path, outcome);
    }
  }

  /** Notifies only the currently attached observation/presentation epoch. */
  private notify(): void {
    this.epochs.notify();
  }

  /**
   * Selects the injected or host Web Crypto provider for content-free handoff checksums.
   *
   * @returns A checksum integrity adapter using the selected crypto provider.
   */
  private handoffIntegrity(): WebCryptoHandoffIntegrity {
    return this.dependencies.cryptography === undefined
      ? new WebCryptoHandoffIntegrity()
      : new WebCryptoHandoffIntegrity(this.dependencies.cryptography);
  }
}
