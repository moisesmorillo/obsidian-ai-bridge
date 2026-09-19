import {
  activateIsolatedAssociation,
  createMirrorOperationId,
  FairMirrorScheduler,
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
  type ReconciliationAction,
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
export const MIRROR_RUNTIME_OWNER_VERSION = 4;

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
  readonly version = MIRROR_RUNTIME_OWNER_VERSION;
  readonly stateOwner: MirrorStateOwner;
  private readonly admission = new MirrorConnectionAdmissionCoordinator();
  private readonly epochs = new MirrorObservationEpochCoordinator();
  private readonly reconciliation = new MirrorReconciliationCoordinator();
  private readonly scheduler = new FairMirrorScheduler();
  private readonly observations =
    new ReconciliationObservationGenerationOwner();
  private reviewed: ReconciliationRuntimeOwner | null = null;
  private readonly outcomes = new Map<NotePath, MirrorPathJobOutcome>();
  private readonly handoff: MirrorStagedHandoffVerifier;
  private activeOwnerOperations = 0;

  /** @param dependencies - Validated state plus host-independent and adapter seams. */
  constructor(private readonly dependencies: MirrorRuntimeOwnerDependencies) {
    this.stateOwner = dependencies.stateOwner;
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
    const result = this.epochs.attach(attachment);
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
    const parsedSessionId = createMirrorOperationId(sessionId);
    if (parsedSessionId !== undefined) {
      this.reviewed?.invalidateSession(parsedSessionId);
    }
    this.admission.gate.disable();
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
    if (this.epochs.isLayoutReady()) {
      await this.startAutomaticReconciliation(false);
    }
  }

  /**
   * Accepts layout readiness once and reconciles the new listener epoch.
   * @param sessionId - Current enable-lifetime session identity.
   */
  async onLayoutReady(sessionId: string): Promise<void> {
    const ready = this.epochs.markLayoutReady(sessionId);
    if (ready.kind !== "ready") return;
    this.reconcileAdmission();
    await this.startAutomaticReconciliation(false);
  }

  /**
   * Routes a create/modify event to staged invalidation or ordinary core policy.
   * @param path - Immutable eligible saved path from the host event.
   */
  async observePresent(
    path: NotePath,
    eventKind: ReconciliationEventKind = RECONCILIATION_EVENT_KIND.modify,
  ): Promise<void> {
    const generation = this.observations.observe(path);
    if (await this.reviewed?.observeEvent(path, eventKind, generation)) return;
    if (await this.handoff.observePresent(path)) return;
    const synchronizer = this.admission.currentConnection()?.synchronizer;
    if (synchronizer === undefined) return;
    await this.runOwnerOperation(() => synchronizer.observePresent(path));
  }

  /**
   * Routes a delete event to staged invalidation or post-bootstrap core policy.
   * @param path - Immutable eligible deleted path from the host event.
   */
  async observeDelete(path: NotePath): Promise<void> {
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
  }

  /**
   * Routes a file rename without granting staged state ordinary mutation intent.
   * @param sourcePath - Eligible pre-event path.
   * @param destinationPath - Eligible destination or null when it left scope.
   */
  async observeRename(
    sourcePath: NotePath,
    destinationPath: NotePath | null,
  ): Promise<void> {
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
  }

  /**
   * Routes folder renames through staged descendants or bounded core expansion.
   * @param oldFolder - Literal pre-event folder prefix.
   * @param newFolder - New eligible prefix or null when it left scope.
   * @returns Bounded core expansion, staged invalidation summary, or no connection.
   */
  async observeFolderRename(
    oldFolder: string,
    newFolder: string | null,
  ): Promise<MirrorFolderRenameResult | null> {
    await this.observeReservedFolderRename(oldFolder, newFolder);
    if (await this.handoff.observeFolderRename(oldFolder, newFolder)) {
      return { planned: 0, deferred: 0, knownDescendants: 0 };
    }
    const synchronizer = this.admission.currentConnection()?.synchronizer;
    if (synchronizer === undefined) return null;
    return this.runOwnerOperation(() =>
      synchronizer.observeFolderRename(oldFolder, newFolder),
    );
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

  /** @returns Earliest wake only while the current observation epoch is ready. */
  nextWakeAtMilliseconds(): number | null {
    if (!this.epochs.isLayoutReady()) return null;
    return (
      this.admission
        .currentConnection()
        ?.synchronizer.nextWakeAtMilliseconds() ?? null
    );
  }

  /**
   * Runs ready work or durably fences an unexpected local runtime failure.
   * @returns Whether work settled normally or scheduling was fenced.
   */
  async synchronizeReady(): Promise<MirrorRuntimeSynchronizationResult> {
    const synchronizer = this.admission.currentConnection()?.synchronizer;
    if (synchronizer === undefined) return { kind: "completed" };
    try {
      await this.runOwnerOperation(async () => {
        await synchronizer.synchronizeReady();
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
    const result = await this.startAutomaticReconciliation(true);
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
   * Lists current M4 candidates only for the attached layout-ready session.
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
    action: ReconciliationAction,
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
      this.reviewed !== null &&
      this.admission.currentServerIdentity().kind === "matched" &&
      this.stateOwner.snapshot().mutationAdmissionAllowed
    );
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
    const remote = new FetchRemoteBridge({
      origin,
      secretReference,
      secretStorage: this.dependencies.secretStorage,
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
            currentIdentity: () => this.reconciliationIdentity(generation),
          });
    this.admission.publishConnection(remote, synchronizer);
    this.reviewed?.resumePersisted();
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
