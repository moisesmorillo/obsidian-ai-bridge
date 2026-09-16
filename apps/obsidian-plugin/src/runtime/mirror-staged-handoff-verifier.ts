import {
  alignAndActivateStagedHandoff,
  type CurrentNoteState,
  type HandoffBaselineEntry,
  type HandoffLocalObservation,
  type HandoffRemoteObservation,
  invalidateHandoffAlignments,
  LocalInspectionKind,
  LocalVaultFailureReason,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  type MirrorStateOwner,
  type MirrorSynchronizerRuntime,
  type NotePath,
  type ReadOnlyLocalVault,
  stageHandoffImport,
} from "@obsidian-ai-bridge/core";
import type {
  MirrorConnectionAdmissionCoordinator,
  MirrorRuntimeConnection,
} from "@obsidian-plugin/runtime/mirror-connection-admission";
import {
  decodeHandoffRecord,
  WebCryptoHandoffIntegrity,
} from "@obsidian-plugin/state/handoff-codec";

/** Sanitized staged handoff operation result. */
export type MirrorStagedHandoffResult =
  | { readonly kind: "completed" }
  | { readonly kind: "not-ready" }
  | { readonly kind: "failed" };

/** Dependencies kept behind the staged handoff verification policy boundary. */
export interface MirrorStagedHandoffVerifierDependencies {
  readonly stateOwner: MirrorStateOwner;
  readonly local: ReadOnlyLocalVault;
  readonly runtime: MirrorSynchronizerRuntime;
  readonly cryptography?: Crypto;
  readonly admission: MirrorConnectionAdmissionCoordinator;
  readonly secretAvailable: () => boolean;
  readonly onChanged: () => void;
}

/**
 * Owns staged-handoff observation generations, evidence sampling and atomic activation.
 *
 * Vault observations during staging never become ordinary mirror intents. Relevant
 * transferred paths instead receive a strictly newer durable generation, invalidating
 * any sampled evidence without retaining note content.
 */
export class MirrorStagedHandoffVerifier {
  private nextGeneration: number;
  private activationCompletion: Promise<void> | null = null;

  /** @param dependencies - Durable state, adapter seams and admission owner. */
  constructor(
    private readonly dependencies: MirrorStagedHandoffVerifierDependencies,
  ) {
    this.nextGeneration = maximumStagedGeneration(dependencies.stateOwner);
  }

  /**
   * Invalidates a relevant staged create or modify observation.
   * @param path - Eligible observed path.
   * @returns Whether staged lifecycle consumed the event.
   */
  async observePresent(path: NotePath): Promise<boolean> {
    await this.awaitActivationCommit();
    return this.invalidateObservedPaths([path]);
  }

  /**
   * Invalidates a relevant staged deletion observation.
   * @param path - Eligible observed path.
   * @returns Whether staged lifecycle consumed the event.
   */
  async observeDelete(path: NotePath): Promise<boolean> {
    await this.awaitActivationCommit();
    return this.invalidateObservedPaths([path]);
  }

  /**
   * Invalidates transferred source/destination identities touched by a file rename.
   * @param sourcePath - Eligible pre-event path.
   * @param destinationPath - Eligible destination or null when it left scope.
   * @returns Whether staged lifecycle consumed the event.
   */
  async observeRename(
    sourcePath: NotePath,
    destinationPath: NotePath | null,
  ): Promise<boolean> {
    await this.awaitActivationCommit();
    return this.invalidateObservedPaths(
      destinationPath === null ? [sourcePath] : [sourcePath, destinationPath],
    );
  }

  /**
   * Invalidates every transferred descendant touched by one folder rename.
   * @param oldFolder - Literal pre-event folder prefix.
   * @param newFolder - New eligible prefix or null when it left scope.
   * @returns Whether staged lifecycle consumed the event.
   */
  async observeFolderRename(
    oldFolder: string,
    newFolder: string | null,
  ): Promise<boolean> {
    await this.awaitActivationCommit();
    const staged = this.dependencies.stateOwner.snapshot().state.stagedHandoff;
    if (staged === null) return false;
    const oldPrefix = `${oldFolder}/`;
    const paths = new Set<NotePath>();
    for (const entry of staged.entries) {
      if (entry.path.startsWith(oldPrefix)) paths.add(entry.path);
      if (newFolder === null) continue;
      const destinationPrefix = `${newFolder}/`;
      if (entry.path.startsWith(destinationPrefix)) paths.add(entry.path);
    }
    await this.invalidateCurrentStagedPaths(paths);
    return true;
  }

  /**
   * Verifies and atomically activates an imported metadata-only handoff.
   * @param encoded - Strict user-controlled handoff JSON.
   * @param connection - Current authenticated connection identity.
   * @param explicitWholeMirrorConsent - Current explicit plaintext/scope consent.
   * @returns Sanitized verification result.
   */
  async importAndActivate(
    encoded: string,
    connection: MirrorRuntimeConnection,
    explicitWholeMirrorConsent: boolean,
  ): Promise<MirrorStagedHandoffResult> {
    if (!explicitWholeMirrorConsent || !this.dependencies.secretAvailable()) {
      return { kind: "not-ready" };
    }
    let decoded: Awaited<ReturnType<typeof decodeHandoffRecord>>;
    try {
      decoded = await decodeHandoffRecord(encoded, this.integrity());
    } catch {
      return { kind: "failed" };
    }
    if (decoded.kind !== "valid") return { kind: "failed" };
    if (!this.dependencies.admission.enableForVerification(connection)) {
      return { kind: "not-ready" };
    }
    const description = await connection.remote.describe();
    if (description.kind === "failure") {
      this.dependencies.admission.recordServerUnavailable();
      return { kind: "not-ready" };
    }
    const localDeviceId =
      this.dependencies.stateOwner.snapshot().state.deviceId;
    this.dependencies.admission.recordServerIdentity(
      description.value.associationId,
      description.value.writerId,
      localDeviceId,
      decoded.record.associationId,
    );
    if (
      !this.dependencies.admission.isCurrent(connection) ||
      description.value.associationId !== decoded.record.associationId ||
      description.value.writerId !== localDeviceId
    ) {
      return { kind: "not-ready" };
    }
    const initialObservationGeneration = this.allocateGeneration();
    const staged = await this.dependencies.stateOwner.transition((state) => {
      if (!this.dependencies.admission.isCurrent(connection)) return undefined;
      const transition = stageHandoffImport(state, decoded.record, {
        origin: connection.origin,
        associationId: description.value.associationId,
        initialObservationGeneration,
      });
      return transition.kind === "staged" ? transition.state : undefined;
    });
    if (staged.kind !== "committed") return { kind: "not-ready" };
    this.dependencies.onChanged();
    const evidence = await this.collectEvidence(
      decoded.record.entries,
      connection,
    );
    if (evidence === null) return { kind: "failed" };
    const activation = Promise.withResolvers<void>();
    this.activationCompletion = activation.promise;
    let activationOutcome: "activated" | "not-activated" | null = null;
    let activated: Awaited<ReturnType<MirrorStateOwner["transition"]>>;
    try {
      activated = await this.dependencies.stateOwner.transition((state) => {
        if (!this.dependencies.admission.isCurrent(connection))
          return undefined;
        const transition = alignAndActivateStagedHandoff(state, evidence, {
          origin: connection.origin,
          associationId: description.value.associationId,
          designatedWriterId: description.value.writerId,
          secretAvailable: true,
          explicitWholeMirrorConsent,
        });
        activationOutcome = transition?.kind ?? null;
        return transition?.state;
      });
    } finally {
      this.activationCompletion = null;
      activation.resolve();
    }
    this.dependencies.onChanged();
    if (activated.kind !== "committed" || activationOutcome !== "activated") {
      return { kind: "not-ready" };
    }
    return { kind: "completed" };
  }

  private async awaitActivationCommit(): Promise<void> {
    const completion = this.activationCompletion;
    if (completion !== null) await completion;
  }

  private async invalidateObservedPaths(
    paths: readonly NotePath[],
  ): Promise<boolean> {
    const state = this.dependencies.stateOwner.snapshot().state;
    if (state.lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged) {
      return false;
    }
    const stagedPaths = new Set(
      state.stagedHandoff?.entries.map((entry) => entry.path) ?? [],
    );
    await this.invalidateCurrentStagedPaths(
      new Set(paths.filter((path) => stagedPaths.has(path))),
    );
    return true;
  }

  private async invalidateCurrentStagedPaths(
    paths: ReadonlySet<NotePath>,
  ): Promise<void> {
    if (paths.size === 0) return;
    const invalidations = [...paths].map((path) => ({
      path,
      observationGeneration: this.allocateGeneration(),
    }));
    await this.dependencies.stateOwner.transition((state) =>
      invalidateHandoffAlignments(state, invalidations),
    );
    this.dependencies.onChanged();
  }

  private async collectEvidence(
    entries: readonly HandoffBaselineEntry[],
    connection: MirrorRuntimeConnection,
  ): Promise<{
    readonly local: readonly HandoffLocalObservation[];
    readonly remote: readonly HandoffRemoteObservation[];
  } | null> {
    const local: HandoffLocalObservation[] = [];
    const remote: HandoffRemoteObservation[] = [];
    for (const entry of entries) {
      const observationGeneration = currentGeneration(
        this.dependencies.stateOwner,
        entry.path,
      );
      if (observationGeneration === null) return null;
      const read = await this.dependencies.local.read(entry.path);
      if (entry.acknowledgement.kind === MIRROR_ACKNOWLEDGEMENT_KIND.live) {
        if (read.kind !== LocalInspectionKind.ok) return null;
        local.push({
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          path: entry.path,
          contentSha256: await this.dependencies.runtime.hashContent(
            read.content,
          ),
          observationGeneration,
        });
      } else {
        local.push({
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
          path: entry.path,
          isAbsent:
            read.kind === LocalInspectionKind.failed &&
            read.reason === LocalVaultFailureReason.missingFile,
          observationGeneration,
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

  private allocateGeneration(): number {
    if (this.nextGeneration >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Handoff observation generation exhausted.");
    }
    this.nextGeneration += 1;
    return this.nextGeneration;
  }

  private integrity(): WebCryptoHandoffIntegrity {
    return this.dependencies.cryptography === undefined
      ? new WebCryptoHandoffIntegrity()
      : new WebCryptoHandoffIntegrity(this.dependencies.cryptography);
  }
}

function maximumStagedGeneration(stateOwner: MirrorStateOwner): number {
  return Math.max(
    0,
    ...(stateOwner
      .snapshot()
      .state.stagedHandoff?.entries.map(
        (entry) => entry.observationGeneration,
      ) ?? []),
  );
}

function currentGeneration(
  stateOwner: MirrorStateOwner,
  path: NotePath,
): number | null {
  return (
    stateOwner
      .snapshot()
      .state.stagedHandoff?.entries.find((entry) => entry.path === path)
      ?.observationGeneration ?? null
  );
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
