import type { LocalReconciliationCommandResult } from "@core/mirror/local-reconciliation-write-service.types";
import { MUTATION_EFFECT_CERTAINTY } from "@core/mirror/mirror.constants";
import type {
  ReconciliationActionExecutionRequest,
  ReconciliationActionExecutionResult,
} from "@core/mirror/reconciliation-action-execution.types";
import {
  projectLocalReconciliationResult,
  projectReconciliationPreservation,
  rejectReconciliationAction,
} from "@core/mirror/reconciliation-action-result";
import type { ReconciliationEffectExecutor } from "@core/mirror/reconciliation-effect-executor";
import {
  RECONCILIATION_ACTION,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_OPERATION_PHASE,
} from "@core/mirror/reconciliation-state.constants";
import type {
  ReconciliationOperation,
  ReconciliationPathEvidence,
} from "@core/mirror/reconciliation-state.types";

/** Executes exact recovery selection as a local-only first restored-path fence. */
export class RecoveryRestoreService {
  /** @param effects - Shared evidence, preservation, local-write, and durable-state owner. */
  constructor(private readonly effects: ReconciliationEffectExecutor) {}

  /**
   * Restores one exact prepared or unexpired sealed snapshot without remote mutation.
   * @param request - Durable restore operation identity.
   * @returns Restored-pending-review, attention, or sanitized rejection state.
   */
  async execute(
    request: ReconciliationActionExecutionRequest,
  ): Promise<ReconciliationActionExecutionResult> {
    const operation = this.effects.operation(request.operationId);
    if (operation === undefined)
      return rejectReconciliationAction(this.effects, "operation-not-found");
    if (operation.action.kind !== RECONCILIATION_ACTION.restoreRecovery) {
      return rejectReconciliationAction(this.effects, "wrong-action");
    }
    const recovery = operation.snapshot.recovery;
    const destination = destinationEvidence(operation);
    if (recovery === null || destination === undefined) {
      return rejectReconciliationAction(this.effects, "recovery-unavailable");
    }
    if (
      operation.phase ===
        RECONCILIATION_OPERATION_PHASE.restoredPendingReview &&
      operation.localEffect === MUTATION_EFFECT_CERTAINTY.confirmed
    ) {
      const current = await this.effects.readCurrentLocal(
        destination.path,
        recovery.contentSha256,
      );
      return current === "changed"
        ? rejectReconciliationAction(this.effects, "evidence-changed")
        : {
            kind: "restored-pending-review",
            snapshot: this.effects.stateOwner.snapshot(),
          };
    }
    const preserved = await this.effects.preserveRequired(
      operation.operationId,
    );
    if (preserved !== "verified") {
      const failure = projectReconciliationPreservation(
        this.effects,
        preserved,
      );
      if (failure !== undefined) return failure;
    }
    const exactRecovery = await this.effects.readExactRecovery(operation);
    if (exactRecovery === "expired")
      return rejectReconciliationAction(this.effects, "recovery-expired");
    if (exactRecovery === "unavailable") {
      return rejectReconciliationAction(this.effects, "recovery-unavailable");
    }
    if (exactRecovery === "changed")
      return rejectReconciliationAction(this.effects, "evidence-changed");
    const currentLocal = await this.effects.readExactLocal(destination);
    let result: LocalReconciliationCommandResult;
    if (destination.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.absent) {
      if (currentLocal !== "absent")
        return rejectReconciliationAction(this.effects, "evidence-changed");
      result = await this.effects.localWrites.createEligible({
        operationId: operation.operationId,
        path: destination.path,
        content: exactRecovery.content,
      });
    } else if (
      destination.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live &&
      typeof currentLocal !== "string"
    ) {
      result = await this.effects.localWrites.replaceEligible({
        operationId: operation.operationId,
        path: destination.path,
        expectedContent: currentLocal.content,
        replacementContent: exactRecovery.content,
      });
    } else {
      /* v8 ignore next -- admitted restore destinations have absent or live evidence. */
      return rejectReconciliationAction(this.effects, "evidence-changed");
    }
    if (result.kind === "confirmed") {
      return { kind: "restored-pending-review", snapshot: result.snapshot };
    }
    return projectLocalReconciliationResult(result);
  }
}

/** @returns Immutable selected destination evidence, including in-place restore. */
function destinationEvidence(
  operation: ReconciliationOperation,
): ReconciliationPathEvidence | undefined {
  const path = operation.destinationPath ?? operation.snapshot.targetPath;
  return operation.snapshot.paths.find((evidence) => evidence.path === path);
}
