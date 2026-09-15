import {
  decideIntentEvidence,
  decideIntentResume,
  decideMutationResult,
  MIRROR_INTENT_EVIDENCE_DECISION,
  MIRROR_INTENT_RESUME_DECISION,
  MIRROR_MUTATION_RESULT_DECISION,
} from "@core/mirror/mirror-intent-policy";
import {
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  type CreateOperationReceipt,
  CURRENT_NOTE_STATE_KIND,
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  MAX_MUTATION_ATTEMPTS,
  MAX_MUTATION_EVIDENCE_ATTEMPTS,
  MIRROR_MUTATION_PHASE,
  MIRROR_PATH_BLOCK_REASON,
  MUTATION_ACTION,
  MUTATION_EFFECT_CERTAINTY,
  type MutationAcknowledgement,
  normalizeNotePath,
  REMOTE_BRIDGE_FAILURE,
  type UnresolvedCreateMutationIntent,
} from "@obsidian-ai-bridge/core";
import { describe, expect, it } from "vitest";

const ASSOCIATION = required(
  createMirrorAssociationId("11111111-1111-4111-8111-111111111111"),
);
const WRITER = required(
  createMirrorWriterId("22222222-2222-4222-8222-222222222222"),
);
const OPERATION = required(
  createMirrorOperationId("33333333-3333-4333-8333-333333333333"),
);
const OTHER_OPERATION = required(
  createMirrorOperationId("44444444-4444-4444-8444-444444444444"),
);
const REVISION = required(
  createApplicationRevision("55555555-5555-4555-8555-555555555555"),
);
const HASH = required(createContentSha256("aa".repeat(32)));
const PATH = required(normalizeNotePath("notes/policy.md"));

const BASE_INTENT: UnresolvedCreateMutationIntent = {
  action: MUTATION_ACTION.create,
  associationId: ASSOCIATION,
  writerId: WRITER,
  operationId: OPERATION,
  path: PATH,
  precondition: { kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent },
  contentSha256: HASH,
  mutationAttempts: 0,
  evidenceAttempts: 0,
};

const RECEIPT: CreateOperationReceipt = {
  action: MUTATION_ACTION.create,
  associationId: ASSOCIATION,
  operationId: OPERATION,
  precondition: { kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent },
  contentSha256: HASH,
};
const ACKNOWLEDGEMENT: MutationAcknowledgement = {
  path: PATH,
  revision: REVISION,
  receipt: RECEIPT,
};

describe("mirror intent decision policy", () => {
  it.each([
    {
      phase: MIRROR_MUTATION_PHASE.intentPersisted,
      evidenceAttempts: MAX_MUTATION_EVIDENCE_ATTEMPTS,
      expected: { kind: MIRROR_INTENT_RESUME_DECISION.attemptExactContent },
    },
    {
      phase: MIRROR_MUTATION_PHASE.dispatched,
      evidenceAttempts: 0,
      expected: { kind: MIRROR_INTENT_RESUME_DECISION.inspectEvidence },
    },
    {
      phase: MIRROR_MUTATION_PHASE.evidenceRequired,
      evidenceAttempts: MAX_MUTATION_EVIDENCE_ATTEMPTS,
      expected: {
        kind: MIRROR_INTENT_RESUME_DECISION.block,
        reason: MIRROR_PATH_BLOCK_REASON.unresolvedEffect,
      },
    },
    {
      phase: MIRROR_MUTATION_PHASE.recoveryPreparation,
      evidenceAttempts: 0,
      expected: { kind: MIRROR_INTENT_RESUME_DECISION.inspectEvidence },
    },
    {
      phase: MIRROR_MUTATION_PHASE.tombstoneCommit,
      evidenceAttempts: MAX_MUTATION_EVIDENCE_ATTEMPTS,
      expected: {
        kind: MIRROR_INTENT_RESUME_DECISION.block,
        reason: MIRROR_PATH_BLOCK_REASON.unresolvedEffect,
      },
    },
  ])(
    "maps $phase with $evidenceAttempts evidence attempts",
    ({ phase, evidenceAttempts, expected }) => {
      expect(
        decideIntentResume({
          phase,
          intent: { ...BASE_INTENT, evidenceAttempts },
        }),
      ).toEqual(expected);
    },
  );

  it("maps exact receipt, original condition, exhausted budget, and divergence", () => {
    expect(
      decideIntentEvidence(
        {
          kind: CURRENT_NOTE_STATE_KIND.live,
          path: PATH,
          revision: REVISION,
          contentSha256: HASH,
          receipt: RECEIPT,
        },
        BASE_INTENT,
      ),
    ).toEqual({
      kind: MIRROR_INTENT_EVIDENCE_DECISION.acknowledge,
      acknowledgement: ACKNOWLEDGEMENT,
    });
    expect(
      decideIntentEvidence(
        { kind: CURRENT_NOTE_STATE_KIND.absent, path: PATH },
        BASE_INTENT,
      ),
    ).toEqual({ kind: MIRROR_INTENT_EVIDENCE_DECISION.retryExactContent });
    expect(
      decideIntentEvidence(
        { kind: CURRENT_NOTE_STATE_KIND.absent, path: PATH },
        { ...BASE_INTENT, mutationAttempts: MAX_MUTATION_ATTEMPTS },
      ),
    ).toEqual({
      kind: MIRROR_INTENT_EVIDENCE_DECISION.block,
      reason: MIRROR_PATH_BLOCK_REASON.retryExhausted,
    });
    expect(
      decideIntentEvidence(
        {
          kind: CURRENT_NOTE_STATE_KIND.live,
          path: PATH,
          revision: REVISION,
          contentSha256: HASH,
          receipt: { ...RECEIPT, operationId: OTHER_OPERATION },
        },
        BASE_INTENT,
      ),
    ).toEqual({ kind: MIRROR_INTENT_EVIDENCE_DECISION.diverged });
  });

  it("classifies non-dispatch, first refusal, repeated refusal, and uncertainty", () => {
    expect(
      decideMutationResult(
        {
          kind: "failure",
          failure: REMOTE_BRIDGE_FAILURE.networkUnavailable,
          effect: MUTATION_EFFECT_CERTAINTY.notDispatched,
        },
        BASE_INTENT,
      ),
    ).toEqual({ kind: MIRROR_MUTATION_RESULT_DECISION.retry });
    expect(
      decideMutationResult(
        {
          kind: "failure",
          failure: REMOTE_BRIDGE_FAILURE.forbidden,
          effect: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
        },
        BASE_INTENT,
      ),
    ).toEqual({
      kind: MIRROR_MUTATION_RESULT_DECISION.recordGlobalFailure,
      failure: REMOTE_BRIDGE_FAILURE.forbidden,
    });
    expect(
      decideMutationResult(
        {
          kind: "failure",
          failure: REMOTE_BRIDGE_FAILURE.conflict,
          effect: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
        },
        BASE_INTENT,
      ),
    ).toEqual({ kind: MIRROR_MUTATION_RESULT_DECISION.diverged });
    expect(
      decideMutationResult(
        {
          kind: "failure",
          failure: REMOTE_BRIDGE_FAILURE.conflict,
          effect: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
        },
        { ...BASE_INTENT, mutationAttempts: 1 },
      ),
    ).toEqual({
      kind: MIRROR_MUTATION_RESULT_DECISION.inspectEvidence,
      failure: REMOTE_BRIDGE_FAILURE.conflict,
    });
    expect(
      decideMutationResult(
        {
          kind: "failure",
          failure: REMOTE_BRIDGE_FAILURE.timedOut,
          effect: MUTATION_EFFECT_CERTAINTY.unknown,
        },
        BASE_INTENT,
      ),
    ).toEqual({
      kind: MIRROR_MUTATION_RESULT_DECISION.inspectEvidence,
      failure: REMOTE_BRIDGE_FAILURE.timedOut,
    });
  });

  it("acknowledges a confirmed mutation", () => {
    expect(
      decideMutationResult(
        {
          kind: MUTATION_EFFECT_CERTAINTY.confirmed,
          confirmed: ACKNOWLEDGEMENT,
        },
        BASE_INTENT,
      ),
    ).toEqual({
      kind: MIRROR_MUTATION_RESULT_DECISION.acknowledge,
      acknowledgement: ACKNOWLEDGEMENT,
    });
  });
});

/**
 * Returns a present fixture value.
 *
 * @param value - Candidate fixture value.
 * @returns Present fixture value.
 * @throws When fixture construction unexpectedly fails.
 */
function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Expected valid fixture value.");
  return value;
}
