import {
  activateIsolatedAssociation,
  fenceMirrorRuntime,
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
  type ReadOnlyLocalVault,
  resumeMirrorWriter,
} from "@obsidian-ai-bridge/core";
import type { MirrorPreferencesDecodeResult } from "@obsidian-plugin/configuration/mirror-preferences";
import {
  ObsidianSecretReferenceStore,
  type ObsidianSecretStorageHost,
} from "@obsidian-plugin/configuration/obsidian-secret-store";
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
export const MIRROR_RUNTIME_OWNER_VERSION = 2;

/** Construction dependencies retained behind plugin adapter boundaries. */
export interface MirrorRuntimeOwnerDependencies {
  readonly stateOwner: MirrorStateOwner;
  readonly local: ReadOnlyLocalVault;
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
  async observePresent(path: NotePath): Promise<void> {
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
    if (await this.handoff.observeFolderRename(oldFolder, newFolder)) {
      return { planned: 0, deferred: 0, knownDescendants: 0 };
    }
    const synchronizer = this.admission.currentConnection()?.synchronizer;
    if (synchronizer === undefined) return null;
    return this.runOwnerOperation(() =>
      synchronizer.observeFolderRename(oldFolder, newFolder),
    );
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

  private async settleStaleActivation(
    connection: MirrorRuntimeConnection,
  ): Promise<boolean> {
    if (this.admission.isCurrent(connection)) return false;
    this.admission.gate.disable();
    await this.pauseForConfigurationChange();
    this.notify();
    return true;
  }

  private async retireConnectionForConfigurationChange(): Promise<void> {
    this.admission.retireConnection();
    this.reconciliation.invalidate();
    await this.pauseForConfigurationChange();
  }

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

  private canCreateConnection(origin: MirrorOrigin): boolean {
    const lifecycle = this.stateOwner.snapshot().state.lifecycle;
    return (
      lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.disabled ||
      lifecycle.origin === origin
    );
  }

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
    );
    this.admission.publishConnection(remote, synchronizer);
  }

  /** @returns Existing durable association binding, or null before activation. */
  private currentAssociationId(): MirrorAssociationId | null {
    const lifecycle = this.stateOwner.snapshot().state.lifecycle;
    return lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.disabled
      ? null
      : lifecycle.associationId;
  }

  private secretAvailable(): boolean {
    const reference =
      this.admission.currentPreferences()?.secretReference ?? null;
    return (
      new ObsidianSecretReferenceStore(this.dependencies.secretStorage).check(
        reference,
      ).kind === "available"
    );
  }

  private reconcileAdmission(): void {
    this.admission.reconcileAdmission(
      this.stateOwner,
      this.epochs.isLayoutReady(),
      this.secretAvailable(),
    );
  }

  private async fenceRuntimeFailure(): Promise<void> {
    this.admission.fenceRuntime();
    this.reconciliation.invalidate();
    await this.stateOwner.transition((state) => fenceMirrorRuntime(state));
    this.notify();
  }

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

  private captureOutcomes(synchronizer: MirrorSynchronizer): void {
    for (const entry of this.stateOwner.snapshot().state.paths) {
      const outcome = synchronizer.outcome(entry.path);
      if (outcome === undefined) continue;
      this.outcomes.delete(entry.path);
      this.outcomes.set(entry.path, outcome);
    }
  }

  private notify(): void {
    this.epochs.notify();
  }

  private handoffIntegrity(): WebCryptoHandoffIntegrity {
    return this.dependencies.cryptography === undefined
      ? new WebCryptoHandoffIntegrity()
      : new WebCryptoHandoffIntegrity(this.dependencies.cryptography);
  }
}
