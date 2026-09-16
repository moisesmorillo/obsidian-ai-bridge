import {
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_GLOBAL_BLOCK_REASON,
  type MirrorAssociationId,
  type MirrorOrigin,
  type MirrorStateOwner,
  type MirrorSynchronizer,
  type MirrorWriterId,
  type RemoteBridge,
  recoverMirrorRuntime,
} from "@obsidian-ai-bridge/core";
import type {
  MirrorPreferences,
  MirrorPreferencesDecodeResult,
} from "@obsidian-plugin/configuration/mirror-preferences";
import { MirrorRequestGate } from "@obsidian-plugin/runtime/mirror-request-gate";
import type {
  MirrorConfigurationStatus,
  MirrorServerIdentityStatus,
} from "@obsidian-plugin/status/mirror-status";

/** One published transport/core connection owned by a configuration generation. */
export interface MirrorRuntimeConnection {
  readonly id: number;
  readonly generation: number;
  readonly origin: MirrorOrigin;
  readonly secretReference: string;
  readonly remote: RemoteBridge;
  readonly synchronizer: MirrorSynchronizer;
}

/** Configuration update decision consumed by the same-realm facade. */
export interface MirrorConnectionConfigurationDecision {
  readonly status: MirrorConfigurationStatus;
  readonly preferences: MirrorPreferences | null;
  readonly generation: number;
  readonly connectionChanged: boolean;
}

/**
 * Owns configuration identity, connection publication, request admission and runtime
 * fencing. The facade performs adapter construction but does not reinterpret whether
 * a captured connection still belongs to current configuration.
 */
export class MirrorConnectionAdmissionCoordinator {
  readonly gate = new MirrorRequestGate();
  private configurationStatus: MirrorConfigurationStatus = "unconfigured";
  private preferences: MirrorPreferences | null = null;
  private generation = 0;
  private nextConnectionId = 0;
  private connection: MirrorRuntimeConnection | null = null;
  private serverIdentity: MirrorServerIdentityStatus = { kind: "unknown" };

  /**
   * Applies one strict decoded preference snapshot and advances identity on change.
   * @param decoded - Current strict plugin-data boundary result.
   * @returns Configuration and connection-generation decision.
   */
  applyConfiguration(
    decoded: MirrorPreferencesDecodeResult | { readonly kind: "unavailable" },
  ): MirrorConnectionConfigurationDecision {
    const next = configurationFromDecode(decoded);
    const connectionChanged = !sameConnectionConfiguration(
      this.configurationStatus,
      this.preferences,
      next.status,
      next.preferences,
    );
    if (connectionChanged) this.generation += 1;
    this.configurationStatus = next.status;
    this.preferences = next.preferences;
    if (connectionChanged) this.serverIdentity = { kind: "unknown" };
    return { ...next, generation: this.generation, connectionChanged };
  }

  /**
   * Publishes an adapter connection only for current complete preferences.
   * @param remote - Current conditional transport adapter.
   * @param synchronizer - Core synchronizer sharing the same transport.
   * @returns Published identity, or null when preferences are incomplete.
   */
  publishConnection(
    remote: RemoteBridge,
    synchronizer: MirrorSynchronizer,
  ): MirrorRuntimeConnection | null {
    const origin = this.preferences?.origin;
    const secretReference = this.preferences?.secretReference;
    if (
      origin === null ||
      origin === undefined ||
      secretReference === null ||
      secretReference === undefined
    ) {
      return null;
    }
    const connection: MirrorRuntimeConnection = {
      id: ++this.nextConnectionId,
      generation: this.generation,
      origin,
      secretReference,
      remote,
      synchronizer,
    };
    this.connection = connection;
    return connection;
  }

  /** Retires current admission and connection identity without touching in-flight settlement. */
  retireConnection(): void {
    this.gate.disable();
    this.connection = null;
    this.serverIdentity = { kind: "unknown" };
  }

  /** @returns Current published connection, if configuration is complete. */
  currentConnection(): MirrorRuntimeConnection | null {
    return this.connection;
  }

  /** @returns Current strict preference projection. */
  currentPreferences(): MirrorPreferences | null {
    return this.preferences;
  }

  /** @returns Current configuration readiness classification. */
  currentConfigurationStatus(): MirrorConfigurationStatus {
    return this.configurationStatus;
  }

  /**
   * @param generation - Captured strict configuration generation.
   * @returns Whether that generation remains authoritative.
   */
  isGenerationCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  /**
   * @param connection - Captured connection identity.
   * @returns Whether that connection remains authoritative.
   */
  isCurrent(connection: MirrorRuntimeConnection): boolean {
    return (
      connection === this.connection &&
      connection.generation === this.generation
    );
  }

  /**
   * Enables verification requests only for a current ready connection.
   * @param connection - Captured connection requesting admission.
   * @returns Whether verification admission was opened.
   */
  enableForVerification(connection: MirrorRuntimeConnection): boolean {
    if (!this.isCurrent(connection)) return false;
    this.gate.enable();
    return true;
  }

  /**
   * Reconciles request admission from lifecycle, attachment and local capability state.
   * @param stateOwner - Durable lifecycle and global-block authority.
   * @param layoutReady - Whether the current observation epoch reached layout readiness.
   * @param secretAvailable - Fresh native-secret reference evidence.
   */
  reconcileAdmission(
    stateOwner: MirrorStateOwner,
    layoutReady: boolean,
    secretAvailable: boolean,
  ): void {
    const connection = this.connection;
    const lifecycle = stateOwner.snapshot().state.lifecycle;
    const lifecycleAllows =
      lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.active ||
      lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.disabled ||
      lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.paused ||
      lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged;
    if (
      layoutReady &&
      connection !== null &&
      this.isCurrent(connection) &&
      this.preferences?.origin === connection.origin &&
      this.preferences.secretReference === connection.secretReference &&
      secretAvailable &&
      lifecycleAllows &&
      stateOwner.snapshot().state.globalBlockReason !==
        MIRROR_GLOBAL_BLOCK_REASON.runtimeUnavailable
    ) {
      this.gate.enable();
      return;
    }
    this.gate.disable();
  }

  /**
   * Records one sanitized authenticated server identity comparison.
   * @param associationId - Authenticated server association.
   * @param designatedWriterId - Authenticated server writer designation.
   * @param localDeviceId - Current device-local identity.
   * @param localAssociationId - Existing durable binding, or null before activation.
   */
  recordServerIdentity(
    associationId: MirrorAssociationId,
    designatedWriterId: MirrorWriterId,
    localDeviceId: MirrorWriterId,
    localAssociationId: MirrorAssociationId | null,
  ): void {
    const associationMatches =
      localAssociationId === null || associationId === localAssociationId;
    this.serverIdentity = {
      kind:
        designatedWriterId === localDeviceId && associationMatches
          ? "matched"
          : "mismatch",
      associationId,
      designatedWriterId,
    };
  }

  /** Records that current authenticated identity could not be obtained. */
  recordServerUnavailable(): void {
    this.serverIdentity = { kind: "unavailable" };
  }

  /** @returns Current sanitized server identity projection. */
  currentServerIdentity(): MirrorServerIdentityStatus {
    return this.serverIdentity;
  }

  /** Closes request admission immediately before a durable runtime fence is saved. */
  fenceRuntime(): void {
    this.gate.disable();
  }

  /**
   * Clears only a durable runtime fence after explicit capability recovery.
   * @param stateOwner - Serialized durable state authority.
   * @returns Whether the runtime fence is absent after the transition.
   */
  async recoverRuntime(stateOwner: MirrorStateOwner): Promise<boolean> {
    const result = await stateOwner.transition((state) =>
      recoverMirrorRuntime(state),
    );
    return (
      result.kind === "committed" ||
      stateOwner.snapshot().state.globalBlockReason !==
        MIRROR_GLOBAL_BLOCK_REASON.runtimeUnavailable
    );
  }
}

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
