import {
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  CURRENT_NOTE_STATE_KIND,
  MAX_MUTATION_ATTEMPTS,
  MAX_MUTATION_EVIDENCE_ATTEMPTS,
  MUTATION_ACTION,
  MUTATION_EFFECT_CERTAINTY,
} from "@core/mirror/mirror.constants";
import type {
  CurrentNoteState,
  MutationAcknowledgement,
  UnresolvedMutationIntent,
} from "@core/mirror/mirror.types";
import {
  currentStateAcknowledgement,
  currentStateHasExactIntentReceipt,
} from "@core/mirror/mirror-acknowledgement";
import { globalBlockForRemoteFailure } from "@core/mirror/mirror-remote-failure-policy";
import {
  MIRROR_MUTATION_PHASE,
  MIRROR_PATH_BLOCK_REASON,
} from "@core/mirror/mirror-state.constants";
import type {
  MirrorPathBlockReason,
  MirrorUnresolvedMutation,
} from "@core/mirror/mirror-state.types";
import type {
  RemoteBridgeFailure,
  RemoteBridgeMutationResult,
} from "@core/mirror/remote-bridge.types";

/** Closed decisions for resuming one persisted unresolved workflow. */
export const MIRROR_INTENT_RESUME_DECISION = {
  attemptExactContent: "attempt-exact-content",
  inspectEvidence: "inspect-evidence",
  block: "block",
} as const;

/** Closed decisions after inspecting remote evidence for one intent. */
export const MIRROR_INTENT_EVIDENCE_DECISION = {
  acknowledge: "acknowledge",
  diverged: "diverged",
  retryExactContent: "retry-exact-content",
  block: "block",
} as const;

/** Closed decisions after one remote mutation attempt settles. */
export const MIRROR_MUTATION_RESULT_DECISION = {
  acknowledge: "acknowledge",
  retry: "retry",
  recordGlobalFailure: "record-global-failure",
  diverged: "diverged",
  inspectEvidence: "inspect-evidence",
} as const;

/** Next action selected from unresolved phase and durable counters. */
export type MirrorIntentResumeDecision =
  | { readonly kind: typeof MIRROR_INTENT_RESUME_DECISION.attemptExactContent }
  | { readonly kind: typeof MIRROR_INTENT_RESUME_DECISION.inspectEvidence }
  | {
      readonly kind: typeof MIRROR_INTENT_RESUME_DECISION.block;
      readonly reason: MirrorPathBlockReason;
    };

/** Next action selected from exact remote state evidence. */
export type MirrorIntentEvidenceDecision =
  | {
      readonly kind: typeof MIRROR_INTENT_EVIDENCE_DECISION.acknowledge;
      readonly acknowledgement: MutationAcknowledgement;
    }
  | { readonly kind: typeof MIRROR_INTENT_EVIDENCE_DECISION.diverged }
  | {
      readonly kind: typeof MIRROR_INTENT_EVIDENCE_DECISION.retryExactContent;
    }
  | {
      readonly kind: typeof MIRROR_INTENT_EVIDENCE_DECISION.block;
      readonly reason: MirrorPathBlockReason;
    };

/** Next action selected from effect certainty and the pre-attempt durable intent. */
export type MirrorMutationResultDecision =
  | {
      readonly kind: typeof MIRROR_MUTATION_RESULT_DECISION.acknowledge;
      readonly acknowledgement: MutationAcknowledgement;
    }
  | { readonly kind: typeof MIRROR_MUTATION_RESULT_DECISION.retry }
  | {
      readonly kind: typeof MIRROR_MUTATION_RESULT_DECISION.recordGlobalFailure;
      readonly failure: RemoteBridgeFailure;
    }
  | { readonly kind: typeof MIRROR_MUTATION_RESULT_DECISION.diverged }
  | {
      readonly kind: typeof MIRROR_MUTATION_RESULT_DECISION.inspectEvidence;
      readonly failure: RemoteBridgeFailure;
    };

/**
 * Selects the only legal next action for a persisted unresolved workflow.
 *
 * @param unresolved - Durable phase and exact intent counters.
 * @returns Attempt, evidence inspection, or terminal block decision.
 */
export function decideIntentResume(
  unresolved: MirrorUnresolvedMutation,
): MirrorIntentResumeDecision {
  switch (unresolved.phase) {
    case MIRROR_MUTATION_PHASE.intentPersisted:
      return { kind: MIRROR_INTENT_RESUME_DECISION.attemptExactContent };
    case MIRROR_MUTATION_PHASE.dispatched:
    case MIRROR_MUTATION_PHASE.evidenceRequired:
    case MIRROR_MUTATION_PHASE.recoveryPreparation:
    case MIRROR_MUTATION_PHASE.tombstoneCommit:
      if (
        unresolved.intent.evidenceAttempts >= MAX_MUTATION_EVIDENCE_ATTEMPTS
      ) {
        return {
          kind: MIRROR_INTENT_RESUME_DECISION.block,
          reason: MIRROR_PATH_BLOCK_REASON.unresolvedEffect,
        };
      }
      return { kind: MIRROR_INTENT_RESUME_DECISION.inspectEvidence };
  }
  const exhaustivePhase: never = unresolved.phase;
  return exhaustivePhase;
}

/**
 * Classifies inspected remote state against one original durable intent.
 *
 * Reconstructibility remains an executor concern because it requires local I/O; the
 * `retry-exact-content` row explicitly requires reconstruction before any retry.
 *
 * @param state - Validated remote state inspected for the path.
 * @param intent - Latest durable intent after consuming evidence budget.
 * @returns Acknowledgement, retry prerequisite, divergence, or terminal block.
 */
export function decideIntentEvidence(
  state: CurrentNoteState,
  intent: UnresolvedMutationIntent,
): MirrorIntentEvidenceDecision {
  if (currentStateHasExactIntentReceipt(state, intent)) {
    const acknowledgement = currentStateAcknowledgement(state);
    if (acknowledgement !== undefined) {
      return {
        kind: MIRROR_INTENT_EVIDENCE_DECISION.acknowledge,
        acknowledgement,
      };
    }
  }
  if (!stateIsOriginalCondition(state, intent)) {
    return { kind: MIRROR_INTENT_EVIDENCE_DECISION.diverged };
  }
  if (intent.mutationAttempts >= MAX_MUTATION_ATTEMPTS) {
    return {
      kind: MIRROR_INTENT_EVIDENCE_DECISION.block,
      reason: MIRROR_PATH_BLOCK_REASON.retryExhausted,
    };
  }
  return { kind: MIRROR_INTENT_EVIDENCE_DECISION.retryExactContent };
}

/**
 * Classifies one mutation settlement without mutating counters or durable phase.
 *
 * @param result - Validated bridge result with conservative effect certainty.
 * @param intent - Pre-attempt intent; its counters identify first-attempt refusal.
 * @returns Exhaustive next action for the mutation settlement.
 */
export function decideMutationResult(
  result: RemoteBridgeMutationResult<MutationAcknowledgement>,
  intent: UnresolvedMutationIntent,
): MirrorMutationResultDecision {
  if (result.kind === MUTATION_EFFECT_CERTAINTY.confirmed) {
    return {
      kind: MIRROR_MUTATION_RESULT_DECISION.acknowledge,
      acknowledgement: result.confirmed,
    };
  }
  switch (result.effect) {
    case MUTATION_EFFECT_CERTAINTY.notDispatched:
      return { kind: MIRROR_MUTATION_RESULT_DECISION.retry };
    case MUTATION_EFFECT_CERTAINTY.definitelyRefused:
      if (intent.mutationAttempts === 0) {
        return globalBlockForRemoteFailure(result.failure) === null
          ? { kind: MIRROR_MUTATION_RESULT_DECISION.diverged }
          : {
              kind: MIRROR_MUTATION_RESULT_DECISION.recordGlobalFailure,
              failure: result.failure,
            };
      }
      return {
        kind: MIRROR_MUTATION_RESULT_DECISION.inspectEvidence,
        failure: result.failure,
      };
    case MUTATION_EFFECT_CERTAINTY.unknown:
      return {
        kind: MIRROR_MUTATION_RESULT_DECISION.inspectEvidence,
        failure: result.failure,
      };
  }
}

/** @returns Whether current evidence still equals the intent's original condition. */
function stateIsOriginalCondition(
  state: CurrentNoteState,
  intent: UnresolvedMutationIntent,
): boolean {
  if (
    intent.precondition.kind === CONDITIONAL_MUTATION_PRECONDITION_KIND.absent
  ) {
    return state.kind === CURRENT_NOTE_STATE_KIND.absent;
  }
  if (intent.action === MUTATION_ACTION.recreate) {
    return (
      state.kind === CURRENT_NOTE_STATE_KIND.tombstone &&
      state.revision === intent.precondition.revision
    );
  }
  return (
    state.kind === CURRENT_NOTE_STATE_KIND.live &&
    state.revision === intent.precondition.revision
  );
}
