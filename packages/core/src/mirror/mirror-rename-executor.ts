import { findMirrorPath } from "@core/mirror/mirror-autosync-state";
import type { MirrorDeletionExecutor } from "@core/mirror/mirror-deletion-executor";
import type { MirrorIntentExecutor } from "@core/mirror/mirror-intent-executor";
import {
  invalidateRenamePlan,
  recordRenameDestinationAcknowledgement,
} from "@core/mirror/mirror-lifecycle-state";
import type { MirrorPathStatusWriter } from "@core/mirror/mirror-path-status";
import type { MirrorPositiveReconciler } from "@core/mirror/mirror-positive-reconciler";
import {
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_RENAME_PHASE,
} from "@core/mirror/mirror-state.constants";
import type { RenameDeferredMirrorState } from "@core/mirror/mirror-state.types";
import type { MirrorStateOwner } from "@core/mirror/mirror-state-owner";
import type { NotePath } from "@core/note-path/note-path.types";

/**
 * Owns destination-first rename prerequisites and exact dependent source cleanup.
 *
 * The two paths are reserved by the caller. This owner still rechecks durable
 * generations after every await because local observations can supersede a plan.
 */
export class MirrorRenameExecutor {
  constructor(
    private readonly stateOwner: MirrorStateOwner,
    private readonly reconciler: MirrorPositiveReconciler,
    private readonly intentExecutor: MirrorIntentExecutor,
    private readonly deletionExecutor: MirrorDeletionExecutor,
    private readonly status: MirrorPathStatusWriter,
  ) {}

  /** Advances one durable rename plan without claiming cross-path atomicity. */
  async run(sourcePath: NotePath): Promise<void> {
    let plan = currentPlan(this.stateOwner, sourcePath);
    if (plan === undefined) return;
    const source = findMirrorPath(this.stateOwner.snapshot().state, sourcePath);
    if (source !== undefined && source.unresolvedMutation !== null) {
      await this.intentExecutor.resume(sourcePath);
      plan = currentPlan(this.stateOwner, sourcePath);
      if (plan === undefined || plan.phase === MIRROR_RENAME_PHASE.invalidated)
        return;
      if (
        findMirrorPath(this.stateOwner.snapshot().state, sourcePath)
          ?.unresolvedMutation !== null
      ) {
        this.status.record({ kind: "rename-deferred", path: sourcePath });
        return;
      }
    }

    if (plan.phase === MIRROR_RENAME_PHASE.destinationRequired) {
      const destinationPath = plan.destinationPath;
      if (destinationPath === null) return;
      await this.reconciler.run(destinationPath);
      const latest = currentPlan(this.stateOwner, sourcePath);
      if (
        latest === undefined ||
        latest.renameId !== plan.renameId ||
        latest.phase !== MIRROR_RENAME_PHASE.destinationRequired
      ) {
        return;
      }
      const destination = findMirrorPath(
        this.stateOwner.snapshot().state,
        destinationPath,
      );
      if (
        destination?.blockedReason !== undefined &&
        destination.blockedReason !== null
      ) {
        await this.stateOwner.transition((state) =>
          invalidateRenamePlan(state, sourcePath, latest.renameId),
        );
        this.status.record({ kind: "rename-deferred", path: sourcePath });
        return;
      }
      if (
        destination?.acknowledgement.kind !==
          MIRROR_ACKNOWLEDGEMENT_KIND.live ||
        destination.unresolvedMutation !== null ||
        destination.desired.kind !== MIRROR_DESIRED_STATE_KIND.none
      ) {
        this.status.record({ kind: "rename-deferred", path: sourcePath });
        return;
      }
      const destinationRevision = destination.acknowledgement.revision;
      const prerequisite = await this.stateOwner.transition((state) =>
        recordRenameDestinationAcknowledgement(
          state,
          sourcePath,
          latest.renameId,
          destinationRevision,
        ),
      );
      if (prerequisite.kind !== "committed") return;
      this.status.record({
        kind: "rename-destination-acknowledged",
        path: sourcePath,
      });
      plan = currentPlan(this.stateOwner, sourcePath);
      if (plan === undefined) return;
    }

    if (plan.phase !== MIRROR_RENAME_PHASE.sourceCleanupRequired) return;
    if (!destinationDependencyMatches(this.stateOwner, plan)) {
      await this.stateOwner.transition((state) =>
        invalidateRenamePlan(state, sourcePath, plan.renameId),
      );
      this.status.record({ kind: "rename-deferred", path: sourcePath });
      return;
    }
    await this.deletionExecutor.run(sourcePath);
  }
}

/** @returns The source's current rename plan, if it still owns one. */
function currentPlan(
  stateOwner: MirrorStateOwner,
  sourcePath: NotePath,
): RenameDeferredMirrorState | undefined {
  const desired = findMirrorPath(
    stateOwner.snapshot().state,
    sourcePath,
  )?.desired;
  return desired?.kind === MIRROR_DESIRED_STATE_KIND.renameDeferred
    ? desired
    : undefined;
}

/** @returns Whether the exact persisted destination prerequisite still holds. */
function destinationDependencyMatches(
  stateOwner: MirrorStateOwner,
  plan: RenameDeferredMirrorState,
): boolean {
  if (plan.destinationPath === null) return true;
  const destination = findMirrorPath(
    stateOwner.snapshot().state,
    plan.destinationPath,
  );
  return (
    destination?.acknowledgement.kind === MIRROR_ACKNOWLEDGEMENT_KIND.live &&
    destination.acknowledgement.revision ===
      plan.destinationAcknowledgedRevision &&
    destination.unresolvedMutation === null &&
    destination.desired.kind === MIRROR_DESIRED_STATE_KIND.none
  );
}
