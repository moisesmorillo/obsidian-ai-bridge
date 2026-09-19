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
  ReconciliationRemoteLiveEvidence,
} from "@core/mirror/reconciliation-state.types";

/** Executes exact revisioned adoption and safe different-path legacy forks. */
export class RevisionedAdoptionService {
  /** @param effects - Shared mechanical evidence/effect owner. */
  constructor(private readonly effects: ReconciliationEffectExecutor) {}

  /**
   * Executes one admitted adoption-family action without normalizing legacy data.
   * @param request - Durable operation identity.
   * @returns Terminal or attention state after one finite attempt.
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
    if (operation.action.kind === RECONCILIATION_ACTION.adoptRevision) {
      return this.adopt(operation);
    }
    if (operation.action.kind === RECONCILIATION_ACTION.forkLegacy) {
      return this.forkLegacy(operation);
    }
    return rejectReconciliationAction(this.effects, "wrong-action");
  }

  /**
   * Associates one exact same-association format-2 revision after local proof.
   * @param operation - Admitted exact adoption operation.
   * @returns Completed or finite attention result.
   */
  private async adopt(
    operation: ReconciliationNonHistoryOperation,
  ): Promise<ReconciliationActionExecutionResult> {
    const target = targetEvidence(operation);
    if (target?.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.live) {
      return rejectReconciliationAction(this.effects, "evidence-changed");
    }
    const remote = await this.effects.readExactRemote(target);
    if (typeof remote === "string")
      return rejectReconciliationAction(this.effects, "evidence-changed");
    let localEffect: ReconciliationNonHistoryOperation["localEffect"] =
      MUTATION_EFFECT_CERTAINTY.notDispatched;
    if (target.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.absent) {
      const local = await this.effects.readExactLocal(target);
      if (local !== "absent")
        return rejectReconciliationAction(this.effects, "evidence-changed");
      const created = await this.effects.localWrites.createEligible({
        operationId: operation.operationId,
        path: target.path,
        content: remote.content,
      });
      if (created.kind !== "confirmed")
        return projectLocalReconciliationResult(created);
      localEffect = MUTATION_EFFECT_CERTAINTY.confirmed;
    } else if (target.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live) {
      const local = await this.effects.readExactLocal(target);
      if (
        typeof local === "string" ||
        local.contentSha256 !== target.remote.contentSha256
      ) {
        return rejectReconciliationAction(this.effects, "evidence-changed");
      }
    } else {
      /* v8 ignore next -- admitted adoption cannot carry unknown local evidence. */
      return rejectReconciliationAction(this.effects, "evidence-changed");
    }
    const completed = await this.effects.complete(
      operation.operationId,
      [sampledLiveAcknowledgement(target.path, target.remote)],
      localEffect,
      MUTATION_EFFECT_CERTAINTY.notDispatched,
    );
    return completed === undefined
      ? rejectReconciliationAction(this.effects, "persistence-failure")
      : { kind: "completed", snapshot: completed };
  }

  /**
   * Preserves legacy bytes and forks them to an independently absent format-2 path.
   * @param operation - Admitted legacy fork operation.
   * @returns Completed or finite attention result.
   */
  private async forkLegacy(
    operation: ReconciliationNonHistoryOperation,
  ): Promise<ReconciliationActionExecutionResult> {
    const target = targetEvidence(operation);
    const destination =
      operation.destinationPath === null
        ? undefined
        : this.effects.evidence(operation, operation.destinationPath);
    if (
      target?.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy ||
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
    let forkContent: string;
    if (operation.localEffect === MUTATION_EFFECT_CERTAINTY.notDispatched) {
      const remote = await this.effects.readExactRemote(target);
      if (typeof remote === "string") {
        return rejectReconciliationAction(this.effects, "evidence-changed");
      }
      forkContent = remote.content;
      const local = await this.effects.localWrites.createEligible({
        operationId: operation.operationId,
        path: destination.path,
        content: forkContent,
      });
      if (local.kind !== "confirmed") {
        return projectLocalReconciliationResult(local);
      }
    } else {
      const local = await this.effects.readCurrentLocal(
        destination.path,
        target.remote.contentSha256,
      );
      if (local === "changed") {
        return rejectReconciliationAction(this.effects, "evidence-changed");
      }
      forkContent = local.content;
      if (operation.remoteEffect !== MUTATION_EFFECT_CERTAINTY.unknown) {
        const remote = await this.effects.readExactRemote(target);
        if (typeof remote === "string") {
          return rejectReconciliationAction(this.effects, "evidence-changed");
        }
      }
    }
    const mutation = await this.effects.mutateRemote(
      operation.operationId,
      createRequest(operation, destination.path, forkContent),
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
 * Converts one sampled live generation to adoption baseline evidence.
 * @param path - Exact sampled path.
 * @param remote - Exact sampled live generation.
 * @returns Baseline acknowledgement.
 */
function sampledLiveAcknowledgement(
  path: ReconciliationPathEvidence["path"],
  remote: ReconciliationRemoteLiveEvidence,
): MutationAcknowledgement {
  return { path, revision: remote.revision, receipt: remote.receipt };
}

/** @returns Absence-only format-2 create request for the distinct legacy fork path. */
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
