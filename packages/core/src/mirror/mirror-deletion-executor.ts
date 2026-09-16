import {
  LocalInspectionKind,
  LocalVaultFailureReason,
} from "@core/local-vault/local-vault.constants";
import type { ReadOnlyLocalVault } from "@core/local-vault/read-only-local-vault.port";
import { MUTATION_ACTION } from "@core/mirror/mirror.constants";
import type { RecoverySnapshotId } from "@core/mirror/mirror.types";
import { currentStateMatchesPathAcknowledgement } from "@core/mirror/mirror-acknowledgement";
import {
  findMirrorPath,
  upsertDirtyPath,
} from "@core/mirror/mirror-autosync-state";
import type { MirrorIntentExecutor } from "@core/mirror/mirror-intent-executor";
import {
  destructiveEvidenceIdentity,
  invalidateRenamePlansForPath,
  persistTombstoneIntent,
} from "@core/mirror/mirror-lifecycle-state";
import type { MirrorPathRuntime } from "@core/mirror/mirror-path-runtime";
import type { MirrorPathStatusWriter } from "@core/mirror/mirror-path-status";
import { applyGlobalRemoteFailure } from "@core/mirror/mirror-remote-failure-policy";
import {
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_RENAME_PHASE,
} from "@core/mirror/mirror-state.constants";
import type {
  MirrorPathState,
  RenameDeferredMirrorState,
  RuntimeDeleteMirrorState,
} from "@core/mirror/mirror-state.types";
import type { MirrorStateOwner } from "@core/mirror/mirror-state-owner";
import type { MirrorSynchronizerRuntime } from "@core/mirror/mirror-synchronizer.types";
import type { RemoteBridge } from "@core/mirror/remote-bridge.types";
import type { NotePath } from "@core/note-path/note-path.types";

/**
 * Owns grace, exact-absence, remote-generation, and recovery-first tombstone policy.
 *
 * The executor can only consume already durable destructive evidence. It never
 * derives authority from startup, inventory, or a failed local read.
 */
export class MirrorDeletionExecutor {
  constructor(
    private readonly local: ReadOnlyLocalVault,
    private readonly remote: RemoteBridge,
    private readonly stateOwner: MirrorStateOwner,
    private readonly runtime: MirrorSynchronizerRuntime,
    private readonly pathRuntime: MirrorPathRuntime,
    private readonly intentExecutor: MirrorIntentExecutor,
    private readonly status: MirrorPathStatusWriter,
  ) {}

  /** Attempts one due runtime-delete or rename-source cleanup workflow. */
  async run(path: NotePath): Promise<void> {
    let entry = findMirrorPath(this.stateOwner.snapshot().state, path);
    let destructive = destructiveDesired(entry);
    if (entry === undefined || destructive === undefined) return;

    if (entry.unresolvedMutation !== null) {
      await this.intentExecutor.resume(path);
      entry = findMirrorPath(this.stateOwner.snapshot().state, path);
      if (entry === undefined) return;
      if (
        entry.acknowledgement.kind === MIRROR_ACKNOWLEDGEMENT_KIND.tombstone &&
        entry.unresolvedMutation === null
      ) {
        await this.recordRecoveryState(path, entry.acknowledgement.recoveryId);
        return;
      }
      destructive = destructiveDesired(entry);
      if (entry.unresolvedMutation !== null || destructive === undefined)
        return;
    }

    if (
      !this.pathRuntime.destructiveGraceElapsed(
        path,
        destructive.graceDeadlineMilliseconds,
        this.runtime.nowMilliseconds(),
      )
    ) {
      return;
    }
    const local = await this.local.read(path);
    if (local.kind === LocalInspectionKind.ok) {
      await this.cancelForRecreation(path);
      return;
    }
    if (local.reason !== LocalVaultFailureReason.missingFile) {
      this.status.record({ kind: "local-unavailable", path });
      return;
    }

    const observed = await this.remote.inspectNote(path);
    if (observed.kind === "failure") {
      await applyGlobalRemoteFailure(this.stateOwner, observed.failure);
      this.status.record({
        kind: "remote-failure",
        path,
        failure: observed.failure,
      });
      return;
    }
    const latest = findMirrorPath(this.stateOwner.snapshot().state, path);
    const latestDestructive = destructiveDesired(latest);
    if (
      latest === undefined ||
      latestDestructive === undefined ||
      latest.acknowledgement.kind !== MIRROR_ACKNOWLEDGEMENT_KIND.live ||
      !currentStateMatchesPathAcknowledgement(latest, observed.value)
    ) {
      await this.status.blockDiverged(path);
      return;
    }

    const evidenceIdentity = destructiveEvidenceIdentity(latest);
    if (evidenceIdentity === undefined) return;
    const operationId = this.runtime.createOperationId();
    const persisted = await this.stateOwner.transition((state) =>
      persistTombstoneIntent(state, path, evidenceIdentity, operationId),
    );
    if (persisted.kind !== "committed") return;
    const intent = findMirrorPath(persisted.snapshot.state, path)
      ?.unresolvedMutation?.intent;
    if (intent?.action !== MUTATION_ACTION.tombstone) return;
    await this.intentExecutor.attemptTombstone(
      intent,
      latestDestructive.observationGeneration,
    );

    const settled = findMirrorPath(this.stateOwner.snapshot().state, path);
    if (
      settled?.acknowledgement.kind === MIRROR_ACKNOWLEDGEMENT_KIND.tombstone &&
      settled.unresolvedMutation === null
    ) {
      await this.recordRecoveryState(path, settled.acknowledgement.recoveryId);
    }
  }

  /** Converts a recreation observed during grace into ordinary positive work. */
  private async cancelForRecreation(path: NotePath): Promise<void> {
    const generation = this.pathRuntime.nextGeneration();
    const committed = await this.stateOwner.transition((state) =>
      upsertDirtyPath(
        invalidateRenamePlansForPath(state, path),
        path,
        generation,
      ),
    );
    if (committed.kind !== "committed") return;
    this.pathRuntime.recordObservation(
      path,
      generation,
      this.runtime.nowMilliseconds(),
      false,
      true,
    );
    this.status.record({ kind: "deletion-cancelled", path });
  }

  /** Reports retention separately from the already durable tombstone ACK. */
  private async recordRecoveryState(
    path: NotePath,
    recoveryId: RecoverySnapshotId,
  ): Promise<void> {
    const recovery = await this.remote.inspectRecovery(recoveryId);
    if (recovery.kind === "failure") {
      this.status.record({
        kind: "deletion-acknowledged",
        path,
        recoveryStatus: "unknown",
      });
      return;
    }
    this.status.record({
      kind: "deletion-acknowledged",
      path,
      recoveryStatus: recovery.value?.kind ?? "unknown",
    });
  }
}

type DestructiveDesired =
  | RuntimeDeleteMirrorState
  | (RenameDeferredMirrorState & {
      readonly phase: typeof MIRROR_RENAME_PHASE.sourceCleanupRequired;
    });

/**
 * @param entry - Candidate path entry.
 * @returns Durable destructive evidence only when source cleanup is admissible.
 */
function destructiveDesired(
  entry: MirrorPathState | undefined,
): DestructiveDesired | undefined {
  if (entry?.desired.kind === MIRROR_DESIRED_STATE_KIND.runtimeDelete) {
    return entry.desired;
  }
  if (
    entry?.desired.kind === MIRROR_DESIRED_STATE_KIND.renameDeferred &&
    entry.desired.phase === MIRROR_RENAME_PHASE.sourceCleanupRequired
  ) {
    return {
      ...entry.desired,
      phase: MIRROR_RENAME_PHASE.sourceCleanupRequired,
    };
  }
  return undefined;
}
