import {
  activateIsolatedAssociation,
  activateStagedHandoff,
  alignStagedHandoff,
  type CurrentNoteState,
  type HandoffBaselineEntry,
  type HandoffLocalObservation,
  type HandoffRemoteObservation,
  LocalInspectionKind,
  LocalVaultFailureReason,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_PATH_BLOCK_REASON,
  MIRROR_PAUSE_REASON,
  type MirrorFolderRenameResult,
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
  type RemoteBridge,
  resumeMirrorWriter,
  stageHandoffImport,
} from "@obsidian-ai-bridge/core";
import type {
  MirrorPreferences,
  MirrorPreferencesDecodeResult,
} from "@obsidian-plugin/configuration/mirror-preferences";
import {
  ObsidianSecretReferenceStore,
  type ObsidianSecretStorageHost,
} from "@obsidian-plugin/configuration/obsidian-secret-store";
import { FetchRemoteBridge } from "@obsidian-plugin/remote/fetch-remote-bridge";
import type { RemoteFetch } from "@obsidian-plugin/remote/fetch-remote-bridge.types";
import { MirrorRequestGate } from "@obsidian-plugin/runtime/mirror-request-gate";
import {
  createHandoffRecord,
  decodeHandoffRecord,
  encodeHandoffRecord,
  WebCryptoHandoffIntegrity,
} from "@obsidian-plugin/state/handoff-codec";
import {
  createMirrorOperationalStatus,
  type MirrorConfigurationStatus,
  type MirrorOperationalStatus,
} from "@obsidian-plugin/status/mirror-status";

/** Version of the same-realm runtime-owner structural contract. */
export const MIRROR_RUNTIME_OWNER_VERSION = 1;

/** Session notifications are presentation mechanics and never become runtime policy. */
export interface MirrorRuntimeSessionAttachment {
  readonly id: string;
  /** Called after owner state changes; stale sessions are removed before invocation. */
  readonly onChanged: () => void;
}

/** Construction dependencies retained behind plugin adapter boundaries. */
export interface MirrorRuntimeOwnerDependencies {
  readonly stateOwner: MirrorStateOwner;
  readonly local: ReadOnlyLocalVault;
  readonly secretStorage: ObsidianSecretStorageHost;
  readonly runtime: MirrorSynchronizerRuntime;
  readonly fetch?: RemoteFetch | null;
  readonly cryptography?: Crypto;
}

/** Closed runtime attachment refusal. */
export type MirrorRuntimeAttachResult =
  | { readonly kind: "attached" }
  | { readonly kind: "already-attached" };

/** Closed operational action result suitable for sanitized UI. */
export type MirrorRuntimeActionResult =
  | { readonly kind: "completed" }
  | { readonly kind: "not-ready" }
  | { readonly kind: "failed" };

/** Handoff export result containing only explicit content-free transfer metadata. */
export type MirrorRuntimeHandoffExportResult =
  | { readonly kind: "exported"; readonly encoded: string }
  | { readonly kind: "not-ready" }
  | { readonly kind: "failed" };

/**
 * Authoritative same-JS-host owner for core synchronization and durable settlement.
 *
 * Plugin instances attach only session notifications and official event/timer UI.
 * The owner retains core reservations and exact state settlement across replacement
 * instances. It stores adapters and sanitized metadata, never a bearer or note body.
 */
export class MirrorRuntimeOwner {
  readonly version = MIRROR_RUNTIME_OWNER_VERSION;
  readonly stateOwner: MirrorStateOwner;
  private readonly gate = new MirrorRequestGate();
  private readonly outcomes = new Map<NotePath, MirrorPathJobOutcome>();
  private attachment: MirrorRuntimeSessionAttachment | null = null;
  private configurationStatus: MirrorConfigurationStatus = "unconfigured";
  private preferences: MirrorPreferences | null = null;
  private connection: {
    readonly origin: string;
    readonly secretReference: string;
    readonly remote: RemoteBridge;
    readonly synchronizer: MirrorSynchronizer;
  } | null = null;
  private bootstrapPromise: Promise<void> | null = null;
  private bootstrapComplete = false;
  private layoutReady = false;
  private activeOwnerOperations = 0;
  private configurationGeneration = 0;

  /** @param dependencies - Validated state plus host-independent and adapter seams. */
  constructor(private readonly dependencies: MirrorRuntimeOwnerDependencies) {
    this.stateOwner = dependencies.stateOwner;
  }

  /**
   * Attaches one plugin UI/listener session without replacing the runtime owner.
   * @param attachment - Current enable-lifetime notification attachment.
   * @returns Whether this session acquired presentation ownership.
   */
  attach(
    attachment: MirrorRuntimeSessionAttachment,
  ): MirrorRuntimeAttachResult {
    if (this.attachment !== null && this.attachment.id !== attachment.id) {
      return { kind: "already-attached" };
    }
    this.attachment = attachment;
    this.reconcileGate();
    this.notify();
    return { kind: "attached" };
  }

  /**
   * Detaches one UI/listener session and aborts only host-owned waits.
   * Durable intents and real admission reservations survive until settlement.
   * @param sessionId - Enable-lifetime identity being detached.
   */
  detach(sessionId: string): void {
    if (this.attachment?.id !== sessionId) return;
    this.attachment = null;
    this.layoutReady = false;
    this.gate.disable();
  }

  /**
   * @param sessionId - Enable-lifetime identity to compare.
   * @returns Whether the supplied plugin session still owns current presentation.
   */
  isAttached(sessionId: string): boolean {
    return this.attachment?.id === sessionId;
  }

  /**
   * Applies a strict settings snapshot without changing an in-flight connection.
   *
   * @param decoded - Current data.json boundary result.
   */
  async applyConfiguration(
    decoded: MirrorPreferencesDecodeResult | { readonly kind: "unavailable" },
  ): Promise<void> {
    const next = configurationFromDecode(decoded);
    if (
      !sameConnectionConfiguration(
        this.configurationStatus,
        this.preferences,
        next.status,
        next.preferences,
      )
    ) {
      this.configurationGeneration += 1;
    }
    this.configurationStatus = next.status;
    this.preferences = next.preferences;
    if (next.preferences === null) {
      await this.retireConnectionForConfigurationChange();
      this.notify();
      return;
    }
    const origin = next.preferences.origin;
    const secretReference = next.preferences.secretReference;
    if (origin === null || secretReference === null) {
      await this.retireConnectionForConfigurationChange();
      this.notify();
      return;
    }
    if (
      this.connection !== null &&
      (this.connection.origin !== origin ||
        this.connection.secretReference !== secretReference)
    ) {
      await this.retireConnectionForConfigurationChange();
    }
    if (this.connection === null) {
      if (!this.canCreateConnection(origin)) {
        this.gate.disable();
        await this.pauseForConfigurationChange();
        this.notify();
        return;
      }
      this.connection = this.createConnection(origin, secretReference);
    }
    this.reconcileGate();
    this.notify();
    if (this.layoutReady) await this.startAutomaticBootstrap();
  }

  /**
   * Marks the current attached session's official layout-ready boundary.
   * @param sessionId - Enable-lifetime identity receiving the host callback.
   * @returns After any admitted automatic bootstrap settles.
   */
  async onLayoutReady(sessionId: string): Promise<void> {
    if (!this.isAttached(sessionId)) return;
    this.layoutReady = true;
    await this.startAutomaticBootstrap();
  }

  /**
   * Records one immutable eligible create/modify snapshot.
   * @param path - Eligible saved path captured synchronously by the host adapter.
   * @returns After durable positive observation admission settles.
   */
  async observePresent(path: NotePath): Promise<void> {
    const synchronizer = this.connection?.synchronizer;
    if (synchronizer === undefined) return;
    await this.runOwnerOperation(async () => {
      await synchronizer.observePresent(path);
    });
  }

  /**
   * Records post-bootstrap runtime deletion evidence only.
   * @param path - Eligible deleted path captured synchronously by the host adapter.
   * @returns After core deletion-evidence admission settles.
   */
  async observeDelete(path: NotePath): Promise<void> {
    const synchronizer = this.connection?.synchronizer;
    if (synchronizer === undefined) return;
    await this.runOwnerOperation(async () => {
      await synchronizer.observeDelete(path);
    });
  }

  /**
   * Records one immutable file rename observation.
   * @param sourcePath - Eligible old identity captured from the host callback.
   * @param destinationPath - Eligible new identity, or null when excluded.
   * @returns After core rename-evidence admission settles.
   */
  async observeRename(
    sourcePath: NotePath,
    destinationPath: NotePath | null,
  ): Promise<void> {
    const synchronizer = this.connection?.synchronizer;
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
   * Records one folder rename from the core's bounded pre-event tracked index.
   * @param oldFolder - Immutable old folder path.
   * @param newFolder - Immutable eligible destination, or null when excluded/deleted.
   * @returns Bounded expansion result or null when no synchronizer exists.
   */
  async observeFolderRename(
    oldFolder: string,
    newFolder: string | null,
  ): Promise<MirrorFolderRenameResult | null> {
    const synchronizer = this.connection?.synchronizer;
    if (synchronizer === undefined) return null;
    return this.runOwnerOperation(() =>
      synchronizer.observeFolderRename(oldFolder, newFolder),
    );
  }

  /** @returns Earliest core-owned finite wake for the current compatible connection. */
  nextWakeAtMilliseconds(): number | null {
    return this.connection?.synchronizer.nextWakeAtMilliseconds() ?? null;
  }

  /**
   * Runs currently ready core work while retaining owner lifetime through settlement.
   * @returns After every path admitted by this wake has actually settled.
   */
  async synchronizeReady(): Promise<void> {
    const synchronizer = this.connection?.synchronizer;
    if (synchronizer === undefined) return;
    await this.runOwnerOperation(async () => {
      await synchronizer.synchronizeReady();
      this.captureOutcomes(synchronizer);
    });
  }

  /**
   * Explicit bounded positive rescan; it never derives deletion from absence.
   * @returns Sanitized completion/readiness result.
   */
  async checkNow(): Promise<MirrorRuntimeActionResult> {
    if (!this.layoutReady || this.connection === null) {
      return { kind: "not-ready" };
    }
    await this.runBootstrap(true);
    return this.bootstrapComplete ? { kind: "completed" } : { kind: "failed" };
  }

  /**
   * Grants a fresh finite budget only to core-approved exhausted intents.
   * @returns Whether any reconstructible intent received a durable retry grant.
   */
  async retryFailures(): Promise<MirrorRuntimeActionResult> {
    const synchronizer = this.connection?.synchronizer;
    if (synchronizer === undefined) return { kind: "not-ready" };
    let granted = false;
    for (const entry of this.stateOwner.snapshot().state.paths) {
      if (entry.blockedReason !== MIRROR_PATH_BLOCK_REASON.retryExhausted) {
        continue;
      }
      granted = (await synchronizer.grantRetry(entry.path)) || granted;
    }
    this.notify();
    return granted ? { kind: "completed" } : { kind: "not-ready" };
  }

  /**
   * Durably pauses admission while preserving every unresolved intent and ACK.
   * @returns Sanitized durable transition result.
   */
  async pause(): Promise<MirrorRuntimeActionResult> {
    this.gate.disable();
    const result = await this.stateOwner.transition((state) =>
      pauseMirrorWriter(state, MIRROR_PAUSE_REASON.manual),
    );
    this.notify();
    return result.kind === "committed"
      ? { kind: "completed" }
      : { kind: "not-ready" };
  }

  /**
   * Activates a disabled writer only after explicit consent and fresh designation.
   * @returns Sanitized activation/bootstrap result.
   */
  async activate(): Promise<MirrorRuntimeActionResult> {
    if (!this.layoutReady || this.connection === null) {
      return { kind: "not-ready" };
    }
    const secretAvailable = this.secretAvailable();
    if (!secretAvailable) return { kind: "not-ready" };
    const configurationGeneration = this.configurationGeneration;
    const connection = this.connection;
    this.gate.enable();
    const description = await connection.remote.describe();
    if (
      description.kind === "failure" ||
      !this.connectionIsCurrent(connection, configurationGeneration)
    ) {
      this.reconcileGate();
      return { kind: "failed" };
    }
    const result = await this.stateOwner.transition((state) => {
      if (!this.connectionIsCurrent(connection, configurationGeneration)) {
        return undefined;
      }
      const activated = activateIsolatedAssociation(state, {
        origin: connection.origin,
        associationId: description.value.associationId,
        designatedWriterId: description.value.writerId,
        secretAvailable,
        explicitWholeMirrorConsent: true,
        isolatedEmptyAssociationConfirmed: true,
      });
      return activated.kind === "activated" ? activated.state : undefined;
    });
    if (result.kind !== "committed") {
      this.reconcileGate();
      this.notify();
      return { kind: "not-ready" };
    }
    if (await this.settleStaleActivation(connection, configurationGeneration)) {
      return { kind: "failed" };
    }
    await this.startAutomaticBootstrap();
    return { kind: "completed" };
  }

  /**
   * Resumes only the same paused origin/association after fresh verification.
   * @returns Sanitized persistence/designation/bootstrap result.
   */
  async resume(): Promise<MirrorRuntimeActionResult> {
    if (
      !this.layoutReady ||
      this.connection === null ||
      !this.secretAvailable()
    ) {
      return { kind: "not-ready" };
    }
    const persistence = await this.stateOwner.verifyPersistence();
    if (!persistence.persistenceAvailable) return { kind: "failed" };
    const configurationGeneration = this.configurationGeneration;
    const connection = this.connection;
    this.gate.enable();
    const description = await connection.remote.describe();
    if (
      description.kind === "failure" ||
      !this.connectionIsCurrent(connection, configurationGeneration)
    ) {
      this.reconcileGate();
      return { kind: "failed" };
    }
    const result = await this.stateOwner.transition((state) => {
      if (!this.connectionIsCurrent(connection, configurationGeneration)) {
        return undefined;
      }
      const resumed = resumeMirrorWriter(state, {
        origin: connection.origin,
        associationId: description.value.associationId,
        designatedWriterId: description.value.writerId,
        secretAvailable: true,
      });
      return resumed.kind === "resumed" ? resumed.state : undefined;
    });
    if (result.kind !== "committed") {
      this.reconcileGate();
      this.notify();
      return { kind: "not-ready" };
    }
    if (await this.settleStaleActivation(connection, configurationGeneration)) {
      return { kind: "failed" };
    }
    this.bootstrapComplete = false;
    await this.startAutomaticBootstrap();
    return { kind: "completed" };
  }

  /**
   * Produces an explicit content-free handoff export only after real quiescence.
   * @returns Encoded metadata or a sanitized refusal.
   */
  async prepareHandoff(): Promise<MirrorRuntimeHandoffExportResult> {
    this.gate.disable();
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
    if (this.activeOwnerOperations > 0 || this.gate.activeCount() > 0) {
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
   * Explicitly imports, verifies, aligns, and activates content-free handoff metadata.
   * Local text is hashed transiently and never included in the imported record/state.
   * @param encoded - Untrusted explicit user-controlled handoff JSON.
   * @returns Sanitized verification and activation result.
   */
  async importHandoff(encoded: string): Promise<MirrorRuntimeActionResult> {
    if (
      !this.layoutReady ||
      this.connection === null ||
      !this.secretAvailable()
    ) {
      return { kind: "not-ready" };
    }
    let decoded: Awaited<ReturnType<typeof decodeHandoffRecord>>;
    try {
      decoded = await decodeHandoffRecord(encoded, this.handoffIntegrity());
    } catch {
      return { kind: "failed" };
    }
    if (decoded.kind !== "valid") return { kind: "failed" };
    const configurationGeneration = this.configurationGeneration;
    const connection = this.connection;
    this.gate.enable();
    const description = await connection.remote.describe();
    if (
      description.kind === "failure" ||
      !this.connectionIsCurrent(connection, configurationGeneration) ||
      description.value.associationId !== decoded.record.associationId ||
      description.value.writerId !== this.stateOwner.snapshot().state.deviceId
    ) {
      this.reconcileGate();
      return { kind: "not-ready" };
    }
    const staged = await this.stateOwner.transition((state) => {
      if (!this.connectionIsCurrent(connection, configurationGeneration)) {
        return undefined;
      }
      const transition = stageHandoffImport(state, decoded.record, {
        origin: connection.origin,
        associationId: description.value.associationId,
      });
      return transition.kind === "staged" ? transition.state : undefined;
    });
    if (staged.kind !== "committed") return { kind: "not-ready" };
    const evidence = await this.collectHandoffEvidence(
      decoded.record.entries,
      connection,
    );
    if (evidence === null) return { kind: "failed" };
    const aligned = await this.stateOwner.transition((state) => {
      if (!this.connectionIsCurrent(connection, configurationGeneration)) {
        return undefined;
      }
      return alignStagedHandoff(state, evidence);
    });
    if (aligned.kind !== "committed") return { kind: "not-ready" };
    const activated = await this.stateOwner.transition((state) => {
      if (!this.connectionIsCurrent(connection, configurationGeneration)) {
        return undefined;
      }
      const transition = activateStagedHandoff(state, {
        origin: connection.origin,
        associationId: description.value.associationId,
        designatedWriterId: description.value.writerId,
        secretAvailable: true,
        explicitWholeMirrorConsent: true,
      });
      return transition.kind === "activated" ? transition.state : undefined;
    });
    if (activated.kind !== "committed") return { kind: "not-ready" };
    if (await this.settleStaleActivation(connection, configurationGeneration)) {
      return { kind: "not-ready" };
    }
    this.bootstrapComplete = false;
    await this.startAutomaticBootstrap();
    return { kind: "completed" };
  }

  /** @returns Current sanitized status projection for UI and commands. */
  status(): MirrorOperationalStatus {
    return createMirrorOperationalStatus(
      this.configurationStatus,
      this.stateOwner.snapshot(),
      this.connection?.synchronizer.currentPhase() ?? null,
      this.outcomes,
    );
  }

  private async startAutomaticBootstrap(): Promise<void> {
    if (!this.layoutReady || this.connection === null) return;
    if (
      this.preferences?.origin !== this.connection.origin ||
      this.preferences.secretReference !== this.connection.secretReference
    ) {
      this.gate.disable();
      this.notify();
      return;
    }
    const state = this.stateOwner.snapshot().state;
    const secretAvailable = this.secretAvailable();
    if (!secretAvailable) {
      this.gate.disable();
      await this.pauseForConfigurationChange();
      this.notify();
      return;
    }
    if (
      state.lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.active ||
      state.lifecycle.origin !== this.connection.origin
    ) {
      this.reconcileGate();
      this.notify();
      return;
    }
    this.gate.enable();
    const inheritedBootstrap = this.bootstrapPromise;
    await this.runBootstrap(false);
    if (
      inheritedBootstrap !== null &&
      !this.bootstrapComplete &&
      connectionCanBootstrap(
        this.connection?.origin ?? null,
        this.stateOwner,
        this.secretAvailable(),
      )
    ) {
      await this.runBootstrap(false);
    }
  }

  private async runBootstrap(force: boolean): Promise<void> {
    if (this.connection === null || (!force && this.bootstrapComplete)) return;
    if (this.bootstrapPromise !== null) return this.bootstrapPromise;
    const connection = this.connection;
    const configurationGeneration = this.configurationGeneration;
    const synchronizer = connection.synchronizer;
    const operation = this.runOwnerOperation(async () => {
      const result = await synchronizer.bootstrap();
      if (
        connection === this.connection &&
        configurationGeneration === this.configurationGeneration
      ) {
        this.bootstrapComplete = result.kind === "complete";
        this.captureOutcomes(synchronizer);
      }
    }).finally(() => {
      if (this.bootstrapPromise === operation) this.bootstrapPromise = null;
    });
    this.bootstrapPromise = operation;
    return operation;
  }

  /**
   * @param connection - Connection captured by one multi-step operation.
   * @param generation - Configuration generation captured with that connection.
   * @returns Whether both still designate the current strict configuration.
   */
  private connectionIsCurrent(
    connection: NonNullable<MirrorRuntimeOwner["connection"]>,
    generation: number,
  ): boolean {
    return (
      generation === this.configurationGeneration &&
      connection === this.connection
    );
  }

  /**
   * Pauses a late committed activation before it can bootstrap under new settings.
   * @param connection - Connection that supplied activation evidence.
   * @param generation - Configuration generation for that evidence.
   * @returns Whether stale activation was durably fenced.
   */
  private async settleStaleActivation(
    connection: NonNullable<MirrorRuntimeOwner["connection"]>,
    generation: number,
  ): Promise<boolean> {
    if (this.connectionIsCurrent(connection, generation)) return false;
    this.gate.disable();
    await this.pauseForConfigurationChange();
    this.notify();
    return true;
  }

  private async retireConnectionForConfigurationChange(): Promise<void> {
    this.gate.disable();
    await this.pauseForConfigurationChange();
    this.connection = null;
    this.bootstrapComplete = false;
  }

  private async pauseForConfigurationChange(): Promise<void> {
    const lifecycle = this.stateOwner.snapshot().state.lifecycle;
    if (lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.active) return;
    await this.stateOwner.transition((state) =>
      pauseMirrorWriter(state, MIRROR_PAUSE_REASON.manual),
    );
  }

  private canCreateConnection(origin: string): boolean {
    const lifecycle = this.stateOwner.snapshot().state.lifecycle;
    return (
      lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.disabled ||
      lifecycle.origin === origin
    );
  }

  private createConnection(
    origin: string,
    secretReference: string,
  ): NonNullable<MirrorRuntimeOwner["connection"]> {
    const generation = this.configurationGeneration;
    const remote = new FetchRemoteBridge({
      origin,
      secretReference,
      secretStorage: this.dependencies.secretStorage,
      admission: {
        admit: async () =>
          generation === this.configurationGeneration
            ? this.gate.admit()
            : undefined,
      },
      cancellation: {
        register: (controller) => {
          if (generation !== this.configurationGeneration) {
            controller.abort();
            return () => undefined;
          }
          return this.gate.register(controller);
        },
      },
      ...(this.dependencies.fetch === undefined
        ? {}
        : { fetch: this.dependencies.fetch }),
      ...(this.dependencies.cryptography === undefined
        ? {}
        : { crypto: this.dependencies.cryptography }),
    });
    return {
      origin,
      secretReference,
      remote,
      synchronizer: new MirrorSynchronizer(
        this.dependencies.local,
        remote,
        this.stateOwner,
        this.dependencies.runtime,
      ),
    };
  }

  private secretAvailable(): boolean {
    const reference = this.preferences?.secretReference ?? null;
    return (
      new ObsidianSecretReferenceStore(this.dependencies.secretStorage).check(
        reference,
      ).kind === "available"
    );
  }

  private reconcileGate(): void {
    const state = this.stateOwner.snapshot().state;
    const preferences = this.preferences;
    const connection = this.connection;
    if (
      this.attachment !== null &&
      preferences?.origin !== null &&
      preferences?.origin !== undefined &&
      preferences.secretReference !== null &&
      connection !== null &&
      connection.origin === preferences.origin &&
      connection.secretReference === preferences.secretReference &&
      this.secretAvailable() &&
      (state.lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.active ||
        state.lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.disabled ||
        state.lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.paused)
    ) {
      this.gate.enable();
      return;
    }
    this.gate.disable();
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
      if (outcome !== undefined) {
        this.outcomes.delete(entry.path);
        this.outcomes.set(entry.path, outcome);
      }
    }
  }

  private notify(): void {
    this.attachment?.onChanged();
  }

  private handoffIntegrity(): WebCryptoHandoffIntegrity {
    return this.dependencies.cryptography === undefined
      ? new WebCryptoHandoffIntegrity()
      : new WebCryptoHandoffIntegrity(this.dependencies.cryptography);
  }

  private async collectHandoffEvidence(
    entries: readonly HandoffBaselineEntry[],
    connection: NonNullable<MirrorRuntimeOwner["connection"]>,
  ): Promise<{
    readonly local: readonly HandoffLocalObservation[];
    readonly remote: readonly HandoffRemoteObservation[];
  } | null> {
    const local: HandoffLocalObservation[] = [];
    const remote: HandoffRemoteObservation[] = [];
    for (const entry of entries) {
      if (entry.acknowledgement.kind === MIRROR_ACKNOWLEDGEMENT_KIND.live) {
        const read = await this.dependencies.local.read(entry.path);
        if (read.kind !== LocalInspectionKind.ok) return null;
        local.push({
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          path: entry.path,
          contentSha256: await this.dependencies.runtime.hashContent(
            read.content,
          ),
          observationGeneration: 0,
        });
      } else {
        const read = await this.dependencies.local.read(entry.path);
        local.push({
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
          path: entry.path,
          isAbsent:
            read.kind === LocalInspectionKind.failed &&
            read.reason === LocalVaultFailureReason.missingFile,
          observationGeneration: 0,
        });
      }
      const observed = await connection.remote.inspectNote(entry.path);
      if (observed.kind === "failure") return null;
      remote.push({
        path: entry.path,
        acknowledgement: stateToAcknowledgement(observed.value),
      });
    }
    return { local, remote };
  }
}

/**
 * @param connectionOrigin - Current compatible connection origin, when present.
 * @param stateOwner - Durable lifecycle source.
 * @param secretAvailable - Fresh native-secret availability evidence.
 * @returns Whether a replacement session may restart a failed inherited bootstrap.
 */
function connectionCanBootstrap(
  connectionOrigin: string | null,
  stateOwner: MirrorStateOwner,
  secretAvailable: boolean,
): boolean {
  if (connectionOrigin === null || !secretAvailable) return false;
  const lifecycle = stateOwner.snapshot().state.lifecycle;
  return (
    lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.active &&
    lifecycle.origin === connectionOrigin
  );
}

/**
 * @param currentStatus - Current strict decode classification.
 * @param current - Current validated preferences, when available.
 * @param nextStatus - Incoming strict decode classification.
 * @param next - Incoming validated preferences, when available.
 * @returns Whether both snapshots have the same connection-relevant identity.
 */
function sameConnectionConfiguration(
  currentStatus: MirrorConfigurationStatus,
  current: MirrorPreferences | null,
  nextStatus: MirrorConfigurationStatus,
  next: MirrorPreferences | null,
): boolean {
  return (
    currentStatus === nextStatus &&
    current?.origin === next?.origin &&
    current?.secretReference === next?.secretReference
  );
}

function configurationFromDecode(
  decoded: MirrorPreferencesDecodeResult | { readonly kind: "unavailable" },
): {
  readonly status: MirrorConfigurationStatus;
  readonly preferences: MirrorPreferences | null;
} {
  if (decoded.kind === "valid") {
    const configured =
      decoded.preferences.origin !== null &&
      decoded.preferences.secretReference !== null;
    return {
      status: configured ? "configured" : "unconfigured",
      preferences: decoded.preferences,
    };
  }
  if (decoded.kind === "missing") {
    return {
      status: "unconfigured",
      preferences: {
        origin: null,
        loopbackHttpOrigin: null,
        secretReference: null,
      },
    };
  }
  return { status: "invalid", preferences: null };
}

function stateToAcknowledgement(
  state: CurrentNoteState,
): HandoffRemoteObservation["acknowledgement"] {
  switch (state.kind) {
    case "live":
      return {
        kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
        revision: state.revision,
        contentSha256: state.contentSha256,
      };
    case "tombstone":
      return {
        kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
        revision: state.revision,
        recoveryId: state.recoveryId,
      };
    case "absent":
    case "legacy":
      return null;
  }
}
