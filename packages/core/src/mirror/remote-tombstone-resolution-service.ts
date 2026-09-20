import {
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  MUTATION_ACTION,
  MUTATION_EFFECT_CERTAINTY,
} from "@core/mirror/mirror.constants";
import type {
  ConditionalMutationRequest,
  MutationAcknowledgement,
} from "@core/mirror/mirror.types";
import type {
  ReconciliationActionExecutionRequest,
  ReconciliationActionExecutionResult,
} from "@core/mirror/reconciliation-action-execution.types";
import {
  projectLocalReconciliationResult,
  projectReconciliationPreservation,
  projectRemoteReconciliationResult,
  rejectReconciliationAction,
} from "@core/mirror/reconciliation-action-result";
import type { ReconciliationEffectExecutor } from "@core/mirror/reconciliation-effect-executor";
import { isNonHistoryReconciliationOperation } from "@core/mirror/reconciliation-operation";
import {
  RECONCILIATION_ACTION,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
} from "@core/mirror/reconciliation-state.constants";
import type {
  ReconciliationNonHistoryOperation,
  ReconciliationPathEvidence,
  ReconciliationRemoteTombstoneEvidence,
} from "@core/mirror/reconciliation-state.types";

/** Executes explicit absent-only tombstone adoption, recreation, and safe local copying. */
export class RemoteTombstoneResolutionService {
  /** @param effects - Shared evidence, preservation, local-write, and remote-settlement owner. */
  constructor(private readonly effects: ReconciliationEffectExecutor) {}

  /**
   * Executes one admitted tombstone decision without any local delete or rename capability.
   * @param request - Durable operation identity.
   * @returns Completed, attention, or sanitized rejection state.
   */
  async execute(
    request: ReconciliationActionExecutionRequest,
  ): Promise<ReconciliationActionExecutionResult> {
    const operation = this.effects.operation(request.operationId);
    if (operation === undefined)
      return rejectReconciliationAction(this.effects, "operation-not-found");
    if (!isNonHistoryReconciliationOperation(operation)) {
      return rejectReconciliationAction(this.effects, "wrong-action");
    }
    switch (operation.action.kind) {
      case RECONCILIATION_ACTION.acceptTombstone:
        return this.accept(operation);
      case RECONCILIATION_ACTION.recreateRemote:
        return this.recreate(operation);
      case RECONCILIATION_ACTION.keepBoth:
        return this.copyAndDefer(operation);
      default:
        return rejectReconciliationAction(this.effects, "wrong-action");
    }
  }

  /**
   * Records one exact tombstone baseline only after current local absence remains proven.
   * @param operation - Admitted tombstone acceptance operation.
   * @returns Completed or finite attention result.
   */
  private async accept(
    operation: ReconciliationNonHistoryOperation,
  ): Promise<ReconciliationActionExecutionResult> {
    const target = targetEvidence(operation);
    if (
      target?.local.kind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.absent ||
      target.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone
    ) {
      return rejectReconciliationAction(this.effects, "evidence-changed");
    }
    const [local, remote] = await Promise.all([
      this.effects.readExactLocal(target),
      this.effects.readExactRemote(target),
    ]);
    if (local !== "absent" || remote !== "non-content") {
      return rejectReconciliationAction(this.effects, "evidence-changed");
    }
    const completed = await this.effects.complete(
      operation.operationId,
      [sampledTombstoneAcknowledgement(target.path, target.remote)],
      MUTATION_EFFECT_CERTAINTY.notDispatched,
      MUTATION_EFFECT_CERTAINTY.notDispatched,
    );
    return completed === undefined
      ? rejectReconciliationAction(this.effects, "persistence-failure")
      : { kind: "completed", snapshot: completed };
  }

  /**
   * Preserves exact live local bytes before conditionally recreating the tombstoned head.
   * @param operation - Admitted tombstone recreation operation.
   * @returns Completed or finite attention result.
   */
  private async recreate(
    operation: ReconciliationNonHistoryOperation,
  ): Promise<ReconciliationActionExecutionResult> {
    const target = targetEvidence(operation);
    if (
      target?.local.kind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.live ||
      target.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone
    ) {
      return rejectReconciliationAction(this.effects, "evidence-changed");
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
    const local = await this.effects.readExactLocal(target);
    if (typeof local === "string")
      return rejectReconciliationAction(this.effects, "evidence-changed");
    if (operation.remoteEffect !== MUTATION_EFFECT_CERTAINTY.unknown) {
      const remote = await this.effects.readExactRemote(target);
      if (remote !== "non-content")
        return rejectReconciliationAction(this.effects, "evidence-changed");
    }
    const mutation = await this.effects.mutateRemote(
      operation.operationId,
      recreateRequest(operation, target.remote, local.content),
      { aggregateEffect: true, recordAcknowledgement: false },
    );
    if (mutation.kind !== "confirmed")
      return projectRemoteReconciliationResult(mutation);
    const completed = await this.effects.complete(
      operation.operationId,
      [mutation.acknowledgement],
      MUTATION_EFFECT_CERTAINTY.notDispatched,
      MUTATION_EFFECT_CERTAINTY.confirmed,
    );
    return completed === undefined
      ? rejectReconciliationAction(this.effects, "persistence-failure")
      : { kind: "completed", snapshot: completed };
  }

  /**
   * Copies live local bytes to an absent eligible path while leaving the tombstone unresolved.
   * @param operation - Admitted tombstone Keep both operation.
   * @returns Completed or finite attention result.
   */
  private async copyAndDefer(
    operation: ReconciliationNonHistoryOperation,
  ): Promise<ReconciliationActionExecutionResult> {
    const target = targetEvidence(operation);
    const destination =
      operation.destinationPath === null
        ? undefined
        : this.effects.evidence(operation, operation.destinationPath);
    if (
      target?.local.kind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.live ||
      target.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone ||
      destination?.local.kind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.absent ||
      destination.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.absent
    ) {
      return rejectReconciliationAction(this.effects, "evidence-changed");
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
    const local = await this.effects.readExactLocal(target);
    if (typeof local === "string") {
      return rejectReconciliationAction(this.effects, "evidence-changed");
    }
    let copyContent: string;
    if (operation.localEffect === MUTATION_EFFECT_CERTAINTY.notDispatched) {
      const remote = await this.effects.readExactRemote(target);
      if (remote !== "non-content") {
        return rejectReconciliationAction(this.effects, "evidence-changed");
      }
      copyContent = local.content;
      const localCopy = await this.effects.localWrites.createEligible({
        operationId: operation.operationId,
        path: destination.path,
        content: copyContent,
      });
      if (localCopy.kind !== "confirmed") {
        return projectLocalReconciliationResult(localCopy);
      }
    } else {
      const localCopy = await this.effects.readCurrentLocal(
        destination.path,
        target.local.contentSha256,
      );
      if (localCopy === "changed") {
        return rejectReconciliationAction(this.effects, "evidence-changed");
      }
      copyContent = localCopy.content;
      if (operation.remoteEffect !== MUTATION_EFFECT_CERTAINTY.unknown) {
        const remote = await this.effects.readExactRemote(target);
        if (remote !== "non-content") {
          return rejectReconciliationAction(this.effects, "evidence-changed");
        }
      }
    }
    const mutation = await this.effects.mutateRemote(
      operation.operationId,
      createRequest(operation, destination.path, copyContent),
      { aggregateEffect: true, recordAcknowledgement: false },
    );
    if (mutation.kind !== "confirmed")
      return projectRemoteReconciliationResult(mutation);
    const completed = await this.effects.complete(
      operation.operationId,
      [mutation.acknowledgement],
      MUTATION_EFFECT_CERTAINTY.confirmed,
      MUTATION_EFFECT_CERTAINTY.confirmed,
    );
    return completed === undefined
      ? rejectReconciliationAction(this.effects, "persistence-failure")
      : { kind: "completed", snapshot: completed };
  }
}

/** @returns Immutable target evidence. */
function targetEvidence(
  operation: ReconciliationNonHistoryOperation,
): ReconciliationPathEvidence | undefined {
  return operation.snapshot.paths.find(
    (evidence) => evidence.path === operation.snapshot.targetPath,
  );
}

/**
 * Converts one sampled tombstone to baseline evidence.
 * @param path - Exact sampled path.
 * @param remote - Exact sampled tombstone generation.
 * @returns Baseline acknowledgement.
 */
function sampledTombstoneAcknowledgement(
  path: ReconciliationPathEvidence["path"],
  remote: ReconciliationRemoteTombstoneEvidence,
): MutationAcknowledgement {
  return { path, revision: remote.revision, receipt: remote.receipt };
}

/** @returns Exact tombstone-revision recreation request. */
function recreateRequest(
  operation: ReconciliationNonHistoryOperation,
  remote: ReconciliationRemoteTombstoneEvidence,
  content: string,
): ConditionalMutationRequest {
  return {
    action: MUTATION_ACTION.recreate,
    associationId: remote.associationId,
    writerId: operation.snapshot.runtime.deviceId,
    operationId: operation.operationId,
    path: operation.snapshot.targetPath,
    precondition: {
      kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
      revision: remote.revision,
    },
    content,
  };
}

/** @returns Absence-only create request for the explicit alternate path. */
function createRequest(
  operation: ReconciliationNonHistoryOperation,
  path: ReconciliationPathEvidence["path"],
  content: string,
): ConditionalMutationRequest {
  const lifecycle = operation.snapshot.runtime.lifecycle;
  /* v8 ignore next -- consistent active operations cannot retain a disabled lifecycle. */
  if (lifecycle.kind === "disabled") {
    throw new Error(
      "An admitted operation cannot have disabled lifecycle evidence.",
    );
  }
  return {
    action: MUTATION_ACTION.create,
    associationId: lifecycle.associationId,
    writerId: operation.snapshot.runtime.deviceId,
    operationId: operation.operationId,
    path,
    precondition: { kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent },
    content,
  };
}
