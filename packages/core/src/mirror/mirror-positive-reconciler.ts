import { LocalInspectionKind } from "@core/local-vault/local-vault.constants";
import type { ReadOnlyLocalVault } from "@core/local-vault/read-only-local-vault.port";
import { currentStateMatchesPathAcknowledgement } from "@core/mirror/mirror-acknowledgement";
import {
  createContentIntent,
  desiredGeneration,
  findMirrorPath,
  persistContentIntent,
} from "@core/mirror/mirror-autosync-state";
import type { MirrorIntentExecutor } from "@core/mirror/mirror-intent-executor";
import type { MirrorPathRuntime } from "@core/mirror/mirror-path-runtime";
import type { MirrorPathStatusWriter } from "@core/mirror/mirror-path-status";
import { applyGlobalRemoteFailure } from "@core/mirror/mirror-remote-failure-policy";
import {
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
} from "@core/mirror/mirror-state.constants";
import type { MirrorStateOwner } from "@core/mirror/mirror-state-owner";
import type { MirrorSynchronizerRuntime } from "@core/mirror/mirror-synchronizer.types";
import type { RemoteBridge } from "@core/mirror/remote-bridge.types";
import type { NotePath } from "@core/note-path/note-path.types";

/**
 * Reconciles one admitted positive path from saved local content to a durable intent.
 *
 * Existing unresolved workflows delegate immediately to `MirrorIntentExecutor`; this
 * owner handles only local read stability, baseline comparison, and new intent creation.
 */
export class MirrorPositiveReconciler {
  constructor(
    private readonly local: ReadOnlyLocalVault,
    private readonly remote: RemoteBridge,
    private readonly stateOwner: MirrorStateOwner,
    private readonly runtime: MirrorSynchronizerRuntime,
    private readonly pathRuntime: MirrorPathRuntime,
    private readonly intentExecutor: MirrorIntentExecutor,
    private readonly status: MirrorPathStatusWriter,
  ) {}

  /** Reconciles the current durable work for one scheduler-owned path. */
  async run(path: NotePath): Promise<void> {
    const snapshot = this.stateOwner.snapshot();
    if (!snapshot.mutationAdmissionAllowed) return;
    const entry = findMirrorPath(snapshot.state, path);
    if (entry === undefined) return;
    if (entry.unresolvedMutation !== null) {
      await this.intentExecutor.resume(path);
      return;
    }
    if (entry.desired.kind !== MIRROR_DESIRED_STATE_KIND.dirtyPresent) return;
    await this.reconcilePresent(path, entry.desired.observationGeneration);
  }

  /** Reads stable saved content, verifies baseline evidence, and persists one intent. */
  private async reconcilePresent(
    path: NotePath,
    generation: number,
  ): Promise<void> {
    const local = await this.local.read(path);
    if (local.kind !== LocalInspectionKind.ok) {
      this.status.record({ kind: "local-unavailable", path });
      return;
    }
    if (desiredGeneration(this.stateOwner.snapshot(), path) !== generation) {
      this.status.record({ kind: "stale-read", path });
      return;
    }
    const hash = await this.runtime.hashContent(local.content);
    if (desiredGeneration(this.stateOwner.snapshot(), path) !== generation) {
      this.status.record({ kind: "stale-read", path });
      return;
    }
    const current = findMirrorPath(this.stateOwner.snapshot().state, path);
    if (current === undefined || current.unresolvedMutation !== null) return;
    const inspectFirst =
      this.pathRuntime.requiresBootstrapInspection(path) ||
      current.acknowledgement.kind !== MIRROR_ACKNOWLEDGEMENT_KIND.live;
    if (inspectFirst) {
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
      if (!currentStateMatchesPathAcknowledgement(current, observed.value)) {
        await this.status.blockDiverged(path);
        return;
      }
      this.pathRuntime.clearBootstrapInspection(path);
    }
    if (
      current.acknowledgement.kind === MIRROR_ACKNOWLEDGEMENT_KIND.live &&
      current.acknowledgement.contentSha256 === hash
    ) {
      await this.status.clearDesired(path, generation);
      this.status.record({ kind: "unchanged", path });
      return;
    }
    const intent = createContentIntent(
      current,
      this.stateOwner.snapshot().state,
      hash,
      this.runtime.createOperationId(),
    );
    if (intent === undefined) {
      await this.status.blockDiverged(path);
      return;
    }
    const persisted = await this.stateOwner.transition((state) =>
      persistContentIntent(state, path, generation, intent),
    );
    if (persisted.kind !== "committed") return;
    await this.intentExecutor.attempt(intent, local.content, generation);
  }
}
