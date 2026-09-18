import type { LiveResolutionService } from "@core/mirror/live-resolution-service";
import type { MirrorStateSnapshot } from "@core/mirror/mirror-state.types";
import type {
  ReconciliationActionExecutionRequest,
  ReconciliationActionExecutionResult,
} from "@core/mirror/reconciliation-action-execution.types";
import {
  RECONCILIATION_ACTION,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
} from "@core/mirror/reconciliation-state.constants";
import type { ReconciliationOperation } from "@core/mirror/reconciliation-state.types";
import type { RecoveryRestoreService } from "@core/mirror/recovery-restore-service";
import type { RemoteTombstoneResolutionService } from "@core/mirror/remote-tombstone-resolution-service";
import type { RevisionedAdoptionService } from "@core/mirror/revisioned-adoption-service";

/** Read-only operation lookup used by the phase-routing coordinator. */
export interface ReconciliationOperationSource {
  /** @returns Active operation by exact identity, or undefined after release. */
  operation(
    operationId: ReconciliationActionExecutionRequest["operationId"],
  ): ReconciliationOperation | undefined;
  /** @returns Latest authoritative state for sanitized coordinator rejection. */
  snapshot(): MirrorStateSnapshot;
}

/**
 * Routes admitted M4 actions to focused policy services without implementing their
 * evidence, preservation, local-write, tombstone, adoption, or restore matrices.
 */
export class ResolutionCoordinator {
  /**
   * @param operations - Active operation lookup and current-state source.
   * @param live - Live/live action owner.
   * @param adoption - Revisioned adoption and legacy-fork owner.
   * @param tombstones - Remote tombstone decision owner.
   * @param restore - Local-first recovery restore owner.
   */
  constructor(
    private readonly operations: ReconciliationOperationSource,
    private readonly live: LiveResolutionService,
    private readonly adoption: RevisionedAdoptionService,
    private readonly tombstones: RemoteTombstoneResolutionService,
    private readonly restore: RecoveryRestoreService,
  ) {}

  /**
   * Routes one finite execution attempt from its durable action discriminant.
   * @param request - Exact admitted operation identity.
   * @returns Action-specific durable result.
   */
  execute(
    request: ReconciliationActionExecutionRequest,
  ): Promise<ReconciliationActionExecutionResult> {
    const operation = this.operations.operation(request.operationId);
    if (operation === undefined) {
      return Promise.resolve({
        kind: "rejected",
        reason: "operation-not-found",
        snapshot: this.operations.snapshot(),
      });
    }
    switch (operation.action.kind) {
      case RECONCILIATION_ACTION.keepLocal:
      case RECONCILIATION_ACTION.useRemote:
        return this.live.execute(request);
      case RECONCILIATION_ACTION.keepBoth: {
        const target = operation.snapshot.paths.find(
          (evidence) => evidence.path === operation.snapshot.targetPath,
        );
        return target?.remote.kind ===
          RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone
          ? this.tombstones.execute(request)
          : this.live.execute(request);
      }
      case RECONCILIATION_ACTION.adoptRevision:
      case RECONCILIATION_ACTION.forkLegacy:
        return this.adoption.execute(request);
      case RECONCILIATION_ACTION.acceptTombstone:
      case RECONCILIATION_ACTION.recreateRemote:
        return this.tombstones.execute(request);
      case RECONCILIATION_ACTION.restoreRecovery:
        return this.restore.execute(request);
      case RECONCILIATION_ACTION.resolveHistory:
      case RECONCILIATION_ACTION.defer:
        return Promise.resolve({
          kind: "rejected",
          reason: "wrong-action",
          snapshot: this.operations.snapshot(),
        });
    }
  }
}
