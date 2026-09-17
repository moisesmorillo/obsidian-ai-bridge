import { LocalInspectionKind } from "@core/local-vault/local-vault.constants";
import type { ReadOnlyLocalVault } from "@core/local-vault/read-only-local-vault.port";
import {
  MAX_MUTATION_ATTEMPTS,
  MUTATION_ACTION,
} from "@core/mirror/mirror.constants";
import type {
  ConditionalMutationRequest,
  UnresolvedContentMutationIntent,
  UnresolvedMutationIntent,
  UnresolvedTombstoneMutationIntent,
} from "@core/mirror/mirror.types";
import { applyMutationAcknowledgement } from "@core/mirror/mirror-acknowledgement";
import {
  consumeEvidenceAttempt,
  consumeMutationAttempt,
  desiredGeneration,
  findMirrorPath,
  grantIntentRetry,
  requireIntent,
  setIntentPhase,
} from "@core/mirror/mirror-autosync-state";
import {
  decideIntentEvidence,
  decideIntentResume,
  decideMutationResult,
  MIRROR_INTENT_EVIDENCE_DECISION,
  MIRROR_INTENT_RESUME_DECISION,
  MIRROR_MUTATION_RESULT_DECISION,
} from "@core/mirror/mirror-intent-policy";
import type { MirrorPathRuntime } from "@core/mirror/mirror-path-runtime";
import type { MirrorPathStatusWriter } from "@core/mirror/mirror-path-status";
import { applyGlobalRemoteFailure } from "@core/mirror/mirror-remote-failure-policy";
import {
  MIRROR_MUTATION_PHASE,
  MIRROR_PATH_BLOCK_REASON,
} from "@core/mirror/mirror-state.constants";
import type { MirrorStateOwner } from "@core/mirror/mirror-state-owner";
import type { MirrorSynchronizerRuntime } from "@core/mirror/mirror-synchronizer.types";
import type {
  RemoteBridge,
  RemoteBridgeFailure,
} from "@core/mirror/remote-bridge.types";
import type { NotePath } from "@core/note-path/note-path.types";

/**
 * Executes durable unresolved content and recovery-first tombstone intents.
 *
 * The executor consumes attempt/evidence budgets before remote calls, delegates every
 * decision row to `mirror-intent-policy`, and never substitutes newer content for an
 * existing operation identity.
 */
export class MirrorIntentExecutor {
  /** Shares persistence, finite scheduling and status owners across content and tombstone intent execution. */
  constructor(
    private readonly local: ReadOnlyLocalVault,
    private readonly remote: RemoteBridge,
    private readonly stateOwner: MirrorStateOwner,
    private readonly runtime: MirrorSynchronizerRuntime,
    private readonly pathRuntime: MirrorPathRuntime,
    private readonly status: MirrorPathStatusWriter,
  ) {}

  /**
   * Grants a fresh finite budget to the same reconstructible unresolved intent.
   *
   * @returns Whether the exact durable grant committed.
   */
  async grantRetry(path: NotePath): Promise<boolean> {
    const existing = requireIntent(this.stateOwner.snapshot(), path);
    if (existing === undefined) return false;
    if (
      existing.action !== MUTATION_ACTION.tombstone &&
      (await this.reconstructExactContent(existing)) === undefined
    ) {
      return false;
    }
    const result = await this.stateOwner.transition((state) =>
      grantIntentRetry(state, existing),
    );
    if (result.kind !== "committed") return false;
    this.pathRuntime.recordRetryGrant(
      path,
      desiredGeneration(result.snapshot, path),
      this.runtime.nowMilliseconds(),
    );
    return true;
  }

  /** Resumes the exact unresolved workflow currently persisted for one path. */
  async resume(path: NotePath): Promise<void> {
    const unresolved = findMirrorPath(
      this.stateOwner.snapshot().state,
      path,
    )?.unresolvedMutation;
    if (unresolved === null || unresolved === undefined) return;
    const decision = decideIntentResume(unresolved);
    switch (decision.kind) {
      case MIRROR_INTENT_RESUME_DECISION.block:
        await this.status.block(path, decision.reason);
        return;
      case MIRROR_INTENT_RESUME_DECISION.inspectEvidence:
        await this.inspectEvidence(path, unresolved.intent);
        return;
      case MIRROR_INTENT_RESUME_DECISION.attemptExactContent: {
        if (unresolved.intent.action === MUTATION_ACTION.tombstone) {
          await this.attemptTombstone(
            unresolved.intent,
            desiredGeneration(this.stateOwner.snapshot(), path),
          );
          return;
        }
        const reconstructed = await this.reconstructExactContent(
          unresolved.intent,
        );
        if (reconstructed === undefined) {
          await this.status.block(
            path,
            MIRROR_PATH_BLOCK_REASON.unresolvedEffect,
          );
          return;
        }
        await this.attempt(
          reconstructed.intent,
          reconstructed.content,
          reconstructed.generation,
        );
      }
    }
  }

  /** Attempts one already-persisted content intent under current admission. */
  async attempt(
    intent: UnresolvedContentMutationIntent,
    content: string,
    generation: number,
  ): Promise<void> {
    await this.attemptRequest(
      intent,
      mutationRequest(intent, content),
      generation,
    );
  }

  /** Attempts one recovery-first tombstone under the shared finite effect policy. */
  async attemptTombstone(
    intent: UnresolvedTombstoneMutationIntent,
    generation: number,
  ): Promise<void> {
    await this.attemptRequest(intent, intent, generation);
  }

  /** Executes one exact persisted request without creating a parallel retry engine. */
  private async attemptRequest(
    intent: UnresolvedMutationIntent,
    request: ConditionalMutationRequest,
    generation: number,
  ): Promise<void> {
    const path = intent.path;
    if (!this.stateOwner.snapshot().mutationAdmissionAllowed) return;
    if (intent.mutationAttempts >= MAX_MUTATION_ATTEMPTS) {
      await this.status.block(path, MIRROR_PATH_BLOCK_REASON.retryExhausted);
      return;
    }
    const before = this.stateOwner.snapshot();
    const consumed = await this.stateOwner.commit(before.revision, (state) =>
      consumeMutationAttempt(state, intent),
    );
    if (consumed.kind !== "committed") return;
    const result = await this.remote.mutateNote(request);
    const decision = decideMutationResult(result, intent);
    switch (decision.kind) {
      case MIRROR_MUTATION_RESULT_DECISION.acknowledge: {
        const applied = await this.stateOwner.transition((state) =>
          applyMutationAcknowledgement(state, decision.acknowledgement),
        );
        if (applied.kind === "committed") {
          await this.status.clearDesired(path, generation);
          this.status.record({ kind: "acknowledged", path });
        }
        return;
      }
      case MIRROR_MUTATION_RESULT_DECISION.retry:
        await this.setPhase(path, MIRROR_MUTATION_PHASE.intentPersisted);
        this.pathRuntime.scheduleRetry(
          path,
          generation,
          this.runtime.nowMilliseconds(),
          intent.mutationAttempts + 1,
        );
        this.status.record({ kind: "retry-wait", path });
        return;
      case MIRROR_MUTATION_RESULT_DECISION.recordGlobalFailure:
        await this.recordRemoteFailure(path, decision.failure);
        return;
      case MIRROR_MUTATION_RESULT_DECISION.diverged:
        await this.status.blockDiverged(path);
        return;
      case MIRROR_MUTATION_RESULT_DECISION.inspectEvidence:
        await this.setPhase(path, MIRROR_MUTATION_PHASE.evidenceRequired);
        this.pathRuntime.scheduleImmediate(
          path,
          generation,
          this.runtime.nowMilliseconds(),
        );
        await this.recordRemoteFailure(path, decision.failure);
    }
  }

  /** Consumes one evidence budget and applies the exhaustive evidence decision. */
  private async inspectEvidence(
    path: NotePath,
    intent: UnresolvedMutationIntent,
  ): Promise<void> {
    const consumed = await this.stateOwner.transition((state) =>
      consumeEvidenceAttempt(state, intent),
    );
    if (consumed.kind !== "committed") return;
    const observed = await this.remote.inspectNote(path);
    if (observed.kind === "failure") {
      await this.recordRemoteFailure(path, observed.failure);
      return;
    }
    const latest = requireIntent(consumed.snapshot, path);
    if (latest === undefined) return;
    const decision = decideIntentEvidence(observed.value, latest);
    switch (decision.kind) {
      case MIRROR_INTENT_EVIDENCE_DECISION.acknowledge: {
        const applied = await this.stateOwner.transition((state) =>
          applyMutationAcknowledgement(state, decision.acknowledgement),
        );
        if (applied.kind === "committed") {
          this.status.record({ kind: "acknowledged", path });
        }
        return;
      }
      case MIRROR_INTENT_EVIDENCE_DECISION.diverged:
        await this.status.blockDiverged(path);
        return;
      case MIRROR_INTENT_EVIDENCE_DECISION.block:
        await this.status.block(path, decision.reason);
        return;
      case MIRROR_INTENT_EVIDENCE_DECISION.retryExactContent: {
        if (latest.action === MUTATION_ACTION.tombstone) {
          await this.setPhase(path, MIRROR_MUTATION_PHASE.intentPersisted);
          this.pathRuntime.scheduleRetry(
            path,
            desiredGeneration(this.stateOwner.snapshot(), path),
            this.runtime.nowMilliseconds(),
            latest.mutationAttempts,
          );
          this.status.record({ kind: "retry-wait", path });
          return;
        }
        const reconstructed = await this.reconstructExactContent(latest);
        if (reconstructed === undefined) {
          await this.status.block(
            path,
            MIRROR_PATH_BLOCK_REASON.unresolvedEffect,
          );
          return;
        }
        await this.setPhase(path, MIRROR_MUTATION_PHASE.intentPersisted);
        this.pathRuntime.scheduleRetry(
          path,
          reconstructed.generation,
          this.runtime.nowMilliseconds(),
          latest.mutationAttempts,
        );
        this.status.record({ kind: "retry-wait", path });
      }
    }
  }

  /**
   * Reconstructs exact content without substituting a newer desired generation.
   *
   * @returns Exact content and generation, or no safe reconstruction.
   */
  private async reconstructExactContent(
    intent: UnresolvedMutationIntent,
  ): Promise<
    | {
        readonly intent: UnresolvedContentMutationIntent;
        readonly content: string;
        readonly generation: number;
      }
    | undefined
  > {
    if (intent.action === MUTATION_ACTION.tombstone) return undefined;
    const before = desiredGeneration(this.stateOwner.snapshot(), intent.path);
    const local = await this.local.read(intent.path);
    if (local.kind !== LocalInspectionKind.ok) return undefined;
    const hash = await this.runtime.hashContent(local.content);
    const after = desiredGeneration(this.stateOwner.snapshot(), intent.path);
    if (before !== after || hash !== intent.contentSha256) return undefined;
    return { intent, content: local.content, generation: after };
  }

  /** Records global admission consequences and a sanitized path outcome. */
  private async recordRemoteFailure(
    path: NotePath,
    failure: RemoteBridgeFailure,
  ): Promise<void> {
    await applyGlobalRemoteFailure(this.stateOwner, failure);
    this.status.record({ kind: "remote-failure", path, failure });
  }

  /** Persists one unresolved workflow phase when the path still has an intent. */
  private async setPhase(
    path: NotePath,
    phase:
      | typeof MIRROR_MUTATION_PHASE.intentPersisted
      | typeof MIRROR_MUTATION_PHASE.evidenceRequired,
  ): Promise<void> {
    await this.stateOwner.transition((state) =>
      setIntentPhase(state, path, phase),
    );
  }
}

/** @returns Transient content request for one exact persisted intent. */
function mutationRequest(
  intent: UnresolvedContentMutationIntent,
  content: string,
): ConditionalMutationRequest {
  return { ...intent, content };
}
