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
import {
  RECONCILIATION_ACTION,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_PRESERVATION_SIDE,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
} from "@core/mirror/reconciliation-state.constants";
import type {
  KeepBothReconciliationAction,
  ReconciliationOperation,
  ReconciliationPathEvidence,
  ReconciliationRemoteLiveEvidence,
} from "@core/mirror/reconciliation-state.types";

/**
 * Executes archive-first live/live Keep local, Use remote, and Keep both actions.
 *
 * The service selects action ordering only. Evidence reads, primitive host writes,
 * remote effect certainty, and durable transitions remain delegated to focused owners.
 */
export class LiveResolutionService {
  /** @param effects - Mechanical evidence/effect executor shared by M4 action services. */
  constructor(private readonly effects: ReconciliationEffectExecutor) {}

  /**
   * Runs one finite exact phase sequence for an admitted live-resolution operation.
   * @param request - Durable operation identity.
   * @returns Completed, attention, or sanitized rejection state.
   */
  async execute(
    request: ReconciliationActionExecutionRequest,
  ): Promise<ReconciliationActionExecutionResult> {
    const operation = this.effects.operation(request.operationId);
    if (operation === undefined)
      return rejectReconciliationAction(this.effects, "operation-not-found");
    switch (operation.action.kind) {
      case RECONCILIATION_ACTION.keepLocal:
        return this.keepLocal(operation);
      case RECONCILIATION_ACTION.useRemote:
        return this.useRemote(operation);
      case RECONCILIATION_ACTION.keepBoth:
        return this.keepBoth(operation, operation.action);
      default:
        return rejectReconciliationAction(this.effects, "wrong-action");
    }
  }

  /**
   * Preserves sampled remote bytes before conditionally publishing exact local bytes.
   * @param operation - Admitted Keep local operation.
   * @returns Completed or finite attention result.
   */
  private async keepLocal(
    operation: ReconciliationOperation,
  ): Promise<ReconciliationActionExecutionResult> {
    const target = targetEvidence(operation);
    if (
      target?.local.kind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.live ||
      (target.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.live &&
        target.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.absent)
    ) {
      return rejectReconciliationAction(this.effects, "evidence-changed");
    }
    if (target.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live) {
      const preserved = await this.effects.preserveRequired(
        operation.operationId,
      );
      const preservationFailure = projectReconciliationPreservation(
        this.effects,
        preserved,
      );
      if (preservationFailure !== undefined) return preservationFailure;
    }
    const local = await this.effects.readExactLocal(target);
    if (typeof local === "string")
      return rejectReconciliationAction(this.effects, "evidence-changed");
    if (operation.remoteEffect !== MUTATION_EFFECT_CERTAINTY.unknown) {
      const remote = await this.effects.readExactRemote(target);
      const remoteChanged =
        target.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live
          ? typeof remote === "string"
          : remote !== "non-content";
      if (remoteChanged)
        return rejectReconciliationAction(this.effects, "evidence-changed");
    }
    const remoteRequest =
      target.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live
        ? updateRequest(operation, target.remote, local.content)
        : createRequest(operation, target.path, local.content);
    const mutation = await this.effects.mutateRemote(
      operation.operationId,
      remoteRequest,
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
   * Preserves sampled local bytes, writes exact remote bytes locally, then adopts the sampled revision.
   * @param operation - Admitted Use remote operation.
   * @returns Completed or finite attention result.
   */
  private async useRemote(
    operation: ReconciliationOperation,
  ): Promise<ReconciliationActionExecutionResult> {
    const target = targetEvidence(operation);
    if (target?.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.live) {
      return rejectReconciliationAction(this.effects, "evidence-changed");
    }
    const preserved = await this.effects.preserveRequired(
      operation.operationId,
    );
    const preservationFailure = projectReconciliationPreservation(
      this.effects,
      preserved,
    );
    if (preservationFailure !== undefined) return preservationFailure;
    const remote = await this.effects.readExactRemote(target);
    if (typeof remote === "string")
      return rejectReconciliationAction(this.effects, "evidence-changed");
    let localEffect = operation.localEffect;
    if (target.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.absent) {
      const result = await this.effects.localWrites.createEligible({
        operationId: operation.operationId,
        path: target.path,
        content: remote.content,
      });
      if (result.kind !== "confirmed")
        return projectLocalReconciliationResult(result);
      localEffect = MUTATION_EFFECT_CERTAINTY.confirmed;
    } else if (target.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live) {
      if (target.local.contentSha256 !== target.remote.contentSha256) {
        const local = await this.effects.readExactLocal(target);
        if (typeof local === "string")
          return rejectReconciliationAction(this.effects, "evidence-changed");
        const result = await this.effects.localWrites.replaceEligible({
          operationId: operation.operationId,
          path: target.path,
          expectedContent: local.content,
          replacementContent: remote.content,
        });
        if (result.kind !== "confirmed")
          return projectLocalReconciliationResult(result);
        localEffect = MUTATION_EFFECT_CERTAINTY.confirmed;
      }
    } else {
      /* v8 ignore next -- admitted Use remote operations cannot carry unknown local evidence. */
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
   * Materializes the competitor at the absent destination before resolving the original path.
   * @param operation - Admitted Keep both operation.
   * @param action - Exact primary-side choice.
   * @returns Completed or finite attention result.
   */
  private async keepBoth(
    operation: ReconciliationOperation,
    action: KeepBothReconciliationAction,
  ): Promise<ReconciliationActionExecutionResult> {
    const target = targetEvidence(operation);
    const destination =
      operation.destinationPath === null
        ? undefined
        : this.effects.evidence(operation, operation.destinationPath);
    if (
      target?.local.kind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.live ||
      target.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.live ||
      destination?.local.kind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.absent ||
      destination.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.absent
    ) {
      return rejectReconciliationAction(this.effects, "evidence-changed");
    }
    const preserved = await this.effects.preserveRequired(
      operation.operationId,
    );
    const preservationFailure = projectReconciliationPreservation(
      this.effects,
      preserved,
    );
    if (preservationFailure !== undefined) return preservationFailure;
    const primaryIsLocal =
      action.primarySide === RECONCILIATION_PRESERVATION_SIDE.local;
    const copyHash = primaryIsLocal
      ? target.remote.contentSha256
      : target.local.contentSha256;
    let competitor: string;
    let originalLocalContent: string | undefined;
    let targetReplacementComplete = false;

    if (operation.localEffect === MUTATION_EFFECT_CERTAINTY.notDispatched) {
      if (primaryIsLocal) {
        const remote = await this.effects.readExactRemote(target);
        if (typeof remote === "string") {
          return rejectReconciliationAction(this.effects, "evidence-changed");
        }
        competitor = remote.content;
      } else {
        const local = await this.effects.readExactLocal(target);
        if (typeof local === "string") {
          return rejectReconciliationAction(this.effects, "evidence-changed");
        }
        competitor = local.content;
        originalLocalContent = local.content;
      }
      const localCopy = await this.effects.localWrites.createEligible({
        operationId: operation.operationId,
        path: destination.path,
        content: competitor,
      });
      if (localCopy.kind !== "confirmed") {
        return projectLocalReconciliationResult(localCopy);
      }
    } else {
      const localCopy = await this.effects.readCurrentLocal(
        destination.path,
        copyHash,
      );
      if (localCopy === "changed") {
        return rejectReconciliationAction(this.effects, "evidence-changed");
      }
      competitor = localCopy.content;
    }

    let remoteContent: string | undefined;
    if (primaryIsLocal) {
      const local = await this.effects.readExactLocal(target);
      if (typeof local === "string") {
        return rejectReconciliationAction(this.effects, "evidence-changed");
      }
      originalLocalContent = local.content;
      if (operation.remoteEffect !== MUTATION_EFFECT_CERTAINTY.unknown) {
        const remote = await this.effects.readExactRemote(target);
        if (typeof remote === "string") {
          return rejectReconciliationAction(this.effects, "evidence-changed");
        }
      }
    } else {
      const remote = await this.effects.readExactRemote(target);
      if (typeof remote === "string") {
        return rejectReconciliationAction(this.effects, "evidence-changed");
      }
      remoteContent = remote.content;
      if (operation.remoteEffect === MUTATION_EFFECT_CERTAINTY.confirmed) {
        const replaced = await this.effects.readCurrentLocal(
          target.path,
          target.remote.contentSha256,
        );
        if (replaced !== "changed") {
          targetReplacementComplete = true;
        } else {
          const local = await this.effects.readExactLocal(target);
          if (typeof local === "string") {
            return rejectReconciliationAction(this.effects, "evidence-changed");
          }
          originalLocalContent = local.content;
        }
      } else if (originalLocalContent === undefined) {
        const local = await this.effects.readExactLocal(target);
        if (typeof local === "string") {
          return rejectReconciliationAction(this.effects, "evidence-changed");
        }
        originalLocalContent = local.content;
      }
    }

    const destinationMutation = await this.effects.mutateRemote(
      operation.operationId,
      createRequest(operation, destination.path, competitor),
      {
        aggregateEffect:
          action.primarySide === RECONCILIATION_PRESERVATION_SIDE.remote,
        recordAcknowledgement: false,
      },
    );
    if (destinationMutation.kind !== "confirmed") {
      return projectRemoteReconciliationResult(destinationMutation);
    }
    if (!primaryIsLocal) {
      if (!targetReplacementComplete) {
        if (originalLocalContent === undefined || remoteContent === undefined) {
          return rejectReconciliationAction(this.effects, "evidence-changed");
        }
        const replaced = await this.effects.localWrites.replaceEligible({
          operationId: operation.operationId,
          path: target.path,
          expectedContent: originalLocalContent,
          replacementContent: remoteContent,
        });
        if (replaced.kind !== "confirmed") {
          return projectLocalReconciliationResult(replaced);
        }
      }
      const completed = await this.effects.complete(
        operation.operationId,
        [
          destinationMutation.acknowledgement,
          sampledLiveAcknowledgement(target.path, target.remote),
        ],
        MUTATION_EFFECT_CERTAINTY.confirmed,
        MUTATION_EFFECT_CERTAINTY.confirmed,
      );
      return completed === undefined
        ? rejectReconciliationAction(this.effects, "persistence-failure")
        : { kind: "completed", snapshot: completed };
    }
    if (originalLocalContent === undefined) {
      return rejectReconciliationAction(this.effects, "evidence-changed");
    }
    const originalMutation = await this.effects.mutateRemote(
      operation.operationId,
      updateRequest(operation, target.remote, originalLocalContent),
      { aggregateEffect: true, recordAcknowledgement: false },
    );
    if (originalMutation.kind !== "confirmed") {
      return projectRemoteReconciliationResult(originalMutation);
    }
    const completed = await this.effects.complete(
      operation.operationId,
      [destinationMutation.acknowledgement, originalMutation.acknowledgement],
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
  operation: ReconciliationOperation,
): ReconciliationPathEvidence | undefined {
  return operation.snapshot.paths.find(
    (evidence) => evidence.path === operation.snapshot.targetPath,
  );
}

/** @returns Conditional update request bound to sampled live revision and operation identity. */
function updateRequest(
  operation: ReconciliationOperation,
  remote: ReconciliationRemoteLiveEvidence,
  content: string,
): ConditionalMutationRequest {
  return {
    action: MUTATION_ACTION.update,
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

/** @returns Absence-only create request for an admitted new destination. */
function createRequest(
  operation: ReconciliationOperation,
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

/**
 * Converts one sampled live generation to baseline evidence.
 * @param path - Exact sampled path.
 * @param remote - Exact sampled live generation.
 * @returns Baseline acknowledgement.
 */
function sampledLiveAcknowledgement(
  path: ReconciliationPathEvidence["path"],
  remote: ReconciliationRemoteLiveEvidence,
): MutationAcknowledgement {
  return {
    path,
    revision: remote.revision,
    receipt: remote.receipt,
  };
}
