import {
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  createRecoverySnapshotId,
  HISTORY_CLEANUP_STEP_KIND,
  HISTORY_CLEANUP_STEP_PHASE,
  HISTORY_DECISION_KIND,
  HISTORY_PROGRESS_KIND,
  HISTORY_REMOTE_EFFECT_KIND,
  isNonHistoryReconciliationOperation,
  LOCAL_EFFECT_OBSERVATION_KIND,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_RENAME_PHASE,
  type MirrorDeviceState,
  type MirrorDeviceStateV3,
  MUTATION_ACTION,
  MUTATION_EFFECT_CERTAINTY,
  normalizeNotePath,
  projectMirrorDeviceStateV3ToV4,
  RECONCILIATION_ACTION,
  RECONCILIATION_AUTHORITY_SOURCE,
  RECONCILIATION_CLASSIFICATION,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_LOCAL_STABILITY,
  RECONCILIATION_OPERATION_PHASE,
  RECONCILIATION_PATH_REFERENCE_KIND,
  RECONCILIATION_PRESERVATION_PROOF_STATE,
  RECONCILIATION_PRESERVATION_SIDE,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
  RECONCILIATION_REVIEW_RETENTION,
  RECONCILIATION_REVIEW_STATUS,
  RECOVERY_SNAPSHOT_STATE_KIND,
  type ReconciliationOperationV3,
  type ReconciliationRemoteEvidence,
} from "@obsidian-ai-bridge/core";
import {
  decodeMirrorDeviceState,
  encodeMirrorDeviceState,
  MAX_MIRROR_DEVICE_STATE_BYTES,
} from "@obsidian-plugin/state/device-state-codec";
import { migrateMirrorDeviceStateV3ToV4 } from "@obsidian-plugin/state/device-state-migration";
import {
  decodeMirrorDeviceStateV3,
  encodeMirrorDeviceStateV3,
} from "@obsidian-plugin/state/device-state-v3.codec";
import { createReconciliationOperationalStatus } from "@obsidian-plugin/status/reconciliation-status";
import { describe, expect, it } from "vitest";

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid fixture.");
  return value;
}

const DEVICE = required(
  createMirrorWriterId("11111111-1111-4111-8111-111111111111"),
);
const ASSOCIATION = required(
  createMirrorAssociationId("22222222-2222-4222-8222-222222222222"),
);
const REVIEW = required(
  createMirrorOperationId("33333333-3333-4333-8333-333333333333"),
);
const OPERATION = required(
  createMirrorOperationId("44444444-4444-4444-8444-444444444444"),
);
const REVISION = required(
  createApplicationRevision("55555555-5555-4555-8555-555555555555"),
);
const RECOVERY = required(
  createRecoverySnapshotId("66666666-6666-4666-8666-666666666666"),
);
const EFFECT = required(
  createMirrorOperationId("77777777-7777-4777-8777-777777777777"),
);
const HASH = required(createContentSha256("ab".repeat(32)));
const PATH = required(normalizeNotePath("notes/reviewed.md"));
const DESTINATION = required(normalizeNotePath("notes/current.md"));
const STEP = required(
  createMirrorOperationId("88888888-8888-4888-8888-888888888888"),
);

function baseState(): MirrorDeviceState {
  return {
    deviceId: DEVICE,
    lifecycle: {
      kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
      associationId: ASSOCIATION,
      origin: "https://bridge.example",
    },
    globalBlockReason: null,
    paths: [
      {
        path: PATH,
        acknowledgement: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision: REVISION,
          contentSha256: HASH,
        },
        unresolvedMutation: null,
        desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
        blockedReason: null,
      },
    ],
    stagedHandoff: null,
    reconciliationReviews: [],
    reconciliationOperations: [],
  };
}

function stateWithOperation(): MirrorDeviceState {
  const snapshot = {
    runtime: {
      runtimeOwnerVersion: 3,
      configurationGeneration: 1,
      listenerEpoch: 1,
      deviceId: DEVICE,
      designatedWriterId: DEVICE,
      lifecycle: baseState().lifecycle,
    },
    targetPath: PATH,
    paths: [
      {
        path: PATH,
        local: {
          kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.live,
          stability: RECONCILIATION_LOCAL_STABILITY.stable,
          observationGeneration: 1,
          byteSize: 1,
          contentSha256: HASH,
        },
        baseline: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision: REVISION,
          contentSha256: HASH,
        },
        remote: {
          kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
          associationId: ASSOCIATION,
          revision: REVISION,
          contentSha256: HASH,
          receipt: {
            action: MUTATION_ACTION.create,
            associationId: ASSOCIATION,
            operationId: RECOVERY,
            precondition: { kind: "absent" },
            contentSha256: HASH,
          },
        },
        m3: { unresolvedMutation: null, deferredHistory: null },
      },
    ],
    recovery: null,
  } as const;
  return {
    ...baseState(),
    reconciliationReviews: [
      {
        retention: RECONCILIATION_REVIEW_RETENTION.durable,
        reviewId: REVIEW,
        classification: RECONCILIATION_CLASSIFICATION.bothChanged,
        status: RECONCILIATION_REVIEW_STATUS.staged,
        snapshot,
        operationId: OPERATION,
      },
    ],
    reconciliationOperations: [
      {
        operationId: OPERATION,
        reviewId: REVIEW,
        authority: RECONCILIATION_AUTHORITY_SOURCE.reconciliationDecision,
        action: { kind: RECONCILIATION_ACTION.keepLocal },
        phase: RECONCILIATION_OPERATION_PHASE.preserving,
        snapshot,
        destinationPath: null,
        reservations: [
          {
            path: PATH,
            kind: RECONCILIATION_PATH_REFERENCE_KIND.tracked,
          },
        ],
        preservationReceipts: [
          {
            scope: "operation",
            operationId: OPERATION,
            originalPath: PATH,
            side: RECONCILIATION_PRESERVATION_SIDE.remote,
            sourceRevision: REVISION,
            contentSha256: HASH,
            preservationPath: `.ai-bridge-conflicts/${OPERATION}/remote.md`,
            proofState: RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
          },
        ],
        successorOperationId: null,
        localEffectObservation: {
          kind: LOCAL_EFFECT_OBSERVATION_KIND.notStarted,
        },
        localEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
        remoteEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
      },
    ],
  };
}

function stateWithHistoryOperation(): MirrorDeviceState {
  const ordinary = stateWithOperation();
  const snapshot = required(ordinary.reconciliationOperations[0]).snapshot;
  const sourceEvidence = required(snapshot.paths[0]);
  const deferredHistory = {
    kind: MIRROR_DESIRED_STATE_KIND.renameDeferred,
    observationGeneration: 1,
    renameId: RECOVERY,
    associationId: ASSOCIATION,
    sourcePath: PATH,
    destinationPath: DESTINATION,
    sourceExpectedRevision: REVISION,
    destinationObservationGeneration: 1,
    destinationAcknowledgedRevision: REVISION,
    graceDeadlineMilliseconds: 1,
    phase: MIRROR_RENAME_PHASE.sourceCleanupRequired,
  } as const;
  const historySnapshot = {
    ...snapshot,
    paths: [
      {
        ...sourceEvidence,
        local: {
          kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.absent,
          stability: RECONCILIATION_LOCAL_STABILITY.stable,
          observationGeneration: 1,
        },
        m3: { unresolvedMutation: null, deferredHistory },
      },
      {
        ...sourceEvidence,
        path: DESTINATION,
        m3: { unresolvedMutation: null, deferredHistory: null },
      },
    ],
  };
  const decision = {
    kind: HISTORY_DECISION_KIND.executeCleanupPlan,
    canonicalPath: DESTINATION,
  } as const;
  return {
    ...ordinary,
    paths: [
      {
        ...required(ordinary.paths[0]),
        desired: deferredHistory,
        blockedReason: "rename-deferred",
      },
      {
        ...required(ordinary.paths[0]),
        path: DESTINATION,
      },
    ],
    reconciliationReviews: [
      {
        ...required(ordinary.reconciliationReviews[0]),
        classification: RECONCILIATION_CLASSIFICATION.deferredHistory,
        snapshot: historySnapshot,
      },
    ],
    reconciliationOperations: [
      {
        operationId: OPERATION,
        reviewId: REVIEW,
        authority: RECONCILIATION_AUTHORITY_SOURCE.historyDecision,
        action: { kind: RECONCILIATION_ACTION.resolveHistory, decision },
        phase: RECONCILIATION_OPERATION_PHASE.admitted,
        snapshot: historySnapshot,
        destinationPath: null,
        reservations: [
          {
            path: DESTINATION,
            kind: RECONCILIATION_PATH_REFERENCE_KIND.tracked,
          },
          { path: PATH, kind: RECONCILIATION_PATH_REFERENCE_KIND.tracked },
        ],
        preservationReceipts: [],
        successorOperationId: null,
        historyProgress: {
          kind: HISTORY_PROGRESS_KIND.refined,
          decision,
          steps: [
            {
              stepId: STEP,
              kind: HISTORY_CLEANUP_STEP_KIND.remoteFormerSourceCleanup,
              sourcePath: PATH,
              prerequisitePath: DESTINATION,
              sourceRevision: REVISION,
              sourceContentSha256: HASH,
              prerequisiteRevision: REVISION,
              localAbsenceGeneration: 1,
              phase: HISTORY_CLEANUP_STEP_PHASE.pending,
              remoteEffect: {
                kind: MUTATION_EFFECT_CERTAINTY.notDispatched,
              },
            },
          ],
          nextStepIndex: 0,
        },
      },
    ],
  };
}

function stateWithOperationV3(): MirrorDeviceStateV3 {
  const state = stateWithOperation();
  const operation = required(state.reconciliationOperations[0]);
  if (!isNonHistoryReconciliationOperation(operation)) {
    throw new Error("Expected ordinary fixture operation.");
  }
  const { localEffectObservation: _observation, ...ordinary } = operation;
  return {
    ...state,
    reconciliationOperations: [
      {
        ...ordinary,
        phase: RECONCILIATION_OPERATION_PHASE.preserving,
        preservationReceipts: ordinary.preservationReceipts.map(
          ({ scope: _scope, ...receipt }) => receipt,
        ),
      },
    ],
  };
}

type CorruptState = (raw: ReturnType<typeof JSON.parse>) => void;

describe("version-4 device-state codec and frozen version-3 compatibility", () => {
  it("classifies frozen decoder boundaries without interpreting malformed storage", async () => {
    await expect(decodeMirrorDeviceStateV3(null)).resolves.toEqual({
      kind: "missing",
    });
    await expect(decodeMirrorDeviceStateV3(42)).resolves.toEqual({
      kind: "corrupt",
    });
    await expect(decodeMirrorDeviceStateV3("{")).resolves.toEqual({
      kind: "corrupt",
    });
    await expect(
      decodeMirrorDeviceStateV3("x".repeat(MAX_MIRROR_DEVICE_STATE_BYTES + 1)),
    ).resolves.toEqual({ kind: "corrupt" });
    await expect(
      decodeMirrorDeviceStateV3(
        JSON.stringify({
          format: "obsidian-ai-bridge-device-state",
          version: 99,
        }),
      ),
    ).resolves.toEqual({ kind: "unsupported-version", version: 99 });
    const inconsistent = stateWithOperationV3();
    expect(() =>
      encodeMirrorDeviceStateV3({
        ...inconsistent,
        paths: [...inconsistent.paths, ...inconsistent.paths],
      }),
    ).toThrow("invariant");
  });

  it("migrates an unfenced started version-3 local effect to explicit attention", async () => {
    const current = stateWithOperationV3();
    const currentOperation = required(current.reconciliationOperations[0]);
    const v3: MirrorDeviceStateV3 = {
      ...current,
      reconciliationReviews: current.reconciliationReviews.map((review) => ({
        ...review,
        status: RECONCILIATION_REVIEW_STATUS.completed,
      })),
      reconciliationOperations: [
        {
          ...currentOperation,
          action: { kind: RECONCILIATION_ACTION.useRemote },
          phase: RECONCILIATION_OPERATION_PHASE.completed,
          preservationReceipts: currentOperation.preservationReceipts.map(
            (receipt) => ({
              ...receipt,
              side: RECONCILIATION_PRESERVATION_SIDE.local,
              sourceRevision: null,
              preservationPath: `.ai-bridge-conflicts/${OPERATION}/local.md`,
            }),
          ),
          localEffect: MUTATION_EFFECT_CERTAINTY.unknown,
        },
      ],
    };

    const encoded = encodeMirrorDeviceStateV3(v3);
    await expect(decodeMirrorDeviceStateV3(encoded)).resolves.toEqual({
      kind: "valid",
      state: v3,
    });
    const migrated = migrateMirrorDeviceStateV3ToV4(v3);
    expect(migrated).toMatchObject({
      reconciliationReviews: [{ status: RECONCILIATION_REVIEW_STATUS.staged }],
      reconciliationOperations: [
        {
          phase: RECONCILIATION_OPERATION_PHASE.blocked,
          localEffectObservation: {
            kind: LOCAL_EFFECT_OBSERVATION_KIND.legacyV3Unfenced,
          },
          localEffect: MUTATION_EFFECT_CERTAINTY.unknown,
        },
      ],
    });
    expect(createReconciliationOperationalStatus(migrated)).toMatchObject({
      pendingReviews: 1,
      activeOperations: 1,
      attentionOperations: 1,
    });
  });

  it("projects every frozen action channel without inventing local-effect evidence", () => {
    const actions: readonly ReconciliationOperationV3["action"][] = [
      { kind: RECONCILIATION_ACTION.useRemote },
      {
        kind: RECONCILIATION_ACTION.keepBoth,
        primarySide: RECONCILIATION_PRESERVATION_SIDE.local,
      },
      { kind: RECONCILIATION_ACTION.adoptRevision },
      { kind: RECONCILIATION_ACTION.restoreRecovery },
      { kind: RECONCILIATION_ACTION.forkLegacy },
      { kind: RECONCILIATION_ACTION.keepLocal },
      { kind: RECONCILIATION_ACTION.acceptTombstone },
      { kind: RECONCILIATION_ACTION.recreateRemote },
      { kind: RECONCILIATION_ACTION.defer },
      { kind: RECONCILIATION_ACTION.resolveHistory },
    ];
    const initial = stateWithOperationV3();
    const operation = required(initial.reconciliationOperations[0]);

    const observations = actions.map((action) => {
      const projected = projectMirrorDeviceStateV3ToV4({
        ...initial,
        reconciliationOperations: [{ ...operation, action }],
      });
      const result = required(projected.reconciliationOperations[0]);
      return "localEffectObservation" in result
        ? result.localEffectObservation.kind
        : result.historyProgress.kind;
    });

    expect(observations).toEqual([
      LOCAL_EFFECT_OBSERVATION_KIND.notStarted,
      LOCAL_EFFECT_OBSERVATION_KIND.notStarted,
      LOCAL_EFFECT_OBSERVATION_KIND.notStarted,
      LOCAL_EFFECT_OBSERVATION_KIND.notStarted,
      LOCAL_EFFECT_OBSERVATION_KIND.notStarted,
      LOCAL_EFFECT_OBSERVATION_KIND.notRequired,
      LOCAL_EFFECT_OBSERVATION_KIND.notRequired,
      LOCAL_EFFECT_OBSERVATION_KIND.notRequired,
      LOCAL_EFFECT_OBSERVATION_KIND.notRequired,
      "legacy-v3-history-unrefined",
    ]);
  });

  it("round-trips refined, no-effect, and migrated legacy history authority", async () => {
    const history = stateWithHistoryOperation();
    await expect(
      decodeMirrorDeviceState(encodeMirrorDeviceState(history)),
    ).resolves.toEqual({ kind: "valid", state: history });

    const operation = required(history.reconciliationOperations[0]);
    if (
      !("historyProgress" in operation) ||
      operation.historyProgress.kind !== HISTORY_PROGRESS_KIND.refined ||
      !("decision" in operation.action)
    ) {
      throw new Error("Expected refined history operation.");
    }
    const retainDecision = {
      kind: HISTORY_DECISION_KIND.retainIndependent,
    } as const;
    const retained: MirrorDeviceState = {
      ...history,
      reconciliationReviews: [
        {
          ...required(history.reconciliationReviews[0]),
          status: RECONCILIATION_REVIEW_STATUS.completed,
        },
      ],
      reconciliationOperations: [
        {
          ...operation,
          action: {
            kind: RECONCILIATION_ACTION.resolveHistory,
            decision: retainDecision,
          },
          phase: RECONCILIATION_OPERATION_PHASE.completed,
          historyProgress: {
            kind: HISTORY_PROGRESS_KIND.refined,
            decision: retainDecision,
            steps: [],
            nextStepIndex: null,
          },
        },
      ],
    };
    await expect(
      decodeMirrorDeviceState(encodeMirrorDeviceState(retained)),
    ).resolves.toEqual({ kind: "valid", state: retained });

    const historySource = required(history.paths[0]);
    const confirmed: MirrorDeviceState = {
      ...history,
      paths: [
        {
          ...historySource,
          acknowledgement: {
            kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
            revision: REVISION,
            recoveryId: STEP,
          },
          desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
          blockedReason: null,
        },
        required(history.paths[1]),
      ],
      reconciliationReviews: [
        {
          ...required(history.reconciliationReviews[0]),
          status: RECONCILIATION_REVIEW_STATUS.completed,
        },
      ],
      reconciliationOperations: [
        {
          ...operation,
          action: operation.action,
          phase: RECONCILIATION_OPERATION_PHASE.completed,
          historyProgress: {
            ...operation.historyProgress,
            steps: operation.historyProgress.steps.map((step) => ({
              ...step,
              phase: HISTORY_CLEANUP_STEP_PHASE.completed,
              remoteEffect: {
                kind: HISTORY_REMOTE_EFFECT_KIND.confirmedExactTombstoneReceipt,
                revision: REVISION,
                receipt: {
                  action: MUTATION_ACTION.tombstone,
                  associationId: ASSOCIATION,
                  operationId: STEP,
                  precondition: {
                    kind: "matching-revision",
                    revision: REVISION,
                  },
                },
              },
            })),
            nextStepIndex: null,
          },
        },
      ],
    };
    await expect(
      decodeMirrorDeviceState(encodeMirrorDeviceState(confirmed)),
    ).resolves.toEqual({ kind: "valid", state: confirmed });

    const v3History: MirrorDeviceStateV3 = {
      ...history,
      reconciliationOperations: [
        {
          operationId: operation.operationId,
          reviewId: operation.reviewId,
          authority: operation.authority,
          action: { kind: RECONCILIATION_ACTION.resolveHistory },
          phase: RECONCILIATION_OPERATION_PHASE.admitted,
          snapshot: operation.snapshot,
          destinationPath: operation.destinationPath,
          reservations: operation.reservations,
          preservationReceipts: [],
          successorOperationId: null,
          localEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
          remoteEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
        },
      ],
    };
    await expect(
      decodeMirrorDeviceStateV3(encodeMirrorDeviceStateV3(v3History)),
    ).resolves.toEqual({ kind: "valid", state: v3History });
    const legacy = projectMirrorDeviceStateV3ToV4(v3History);
    await expect(
      decodeMirrorDeviceState(encodeMirrorDeviceState(legacy)),
    ).resolves.toEqual({ kind: "valid", state: legacy });
  });

  it("round-trips prepared and remote-only local-event fences", async () => {
    const initial = stateWithOperation();
    const operation = required(initial.reconciliationOperations[0]);
    if (!isNonHistoryReconciliationOperation(operation)) {
      throw new Error("Expected ordinary operation.");
    }
    const remoteOnly: MirrorDeviceState = {
      ...initial,
      reconciliationOperations: [
        {
          ...operation,
          localEffectObservation: {
            kind: LOCAL_EFFECT_OBSERVATION_KIND.notRequired,
            path: PATH,
            listenerEpoch: 1,
            beforeGeneration: 1,
            successor: null,
          },
        },
      ],
    };
    await expect(
      decodeMirrorDeviceState(encodeMirrorDeviceState(remoteOnly)),
    ).resolves.toEqual({ kind: "valid", state: remoteOnly });

    const prepared: MirrorDeviceState = {
      ...initial,
      reconciliationOperations: [
        {
          ...operation,
          action: { kind: RECONCILIATION_ACTION.useRemote },
          phase: RECONCILIATION_OPERATION_PHASE.mutatingLocal,
          preservationReceipts: operation.preservationReceipts.map(
            (receipt) => ({
              ...receipt,
              side: RECONCILIATION_PRESERVATION_SIDE.local,
              sourceRevision: null,
              preservationPath: `.ai-bridge-conflicts/${OPERATION}/local.md`,
            }),
          ),
          localEffectObservation: {
            kind: LOCAL_EFFECT_OBSERVATION_KIND.prepared,
            effectId: EFFECT,
            path: PATH,
            expectedHash: HASH,
            listenerEpoch: 1,
            beforeGeneration: 1,
            postconditionHash: null,
            successor: null,
          },
        },
      ],
    };
    await expect(
      decodeMirrorDeviceState(encodeMirrorDeviceState(prepared)),
    ).resolves.toEqual({ kind: "valid", state: prepared });
  });

  it("round-trips content-free review, operation, reservation, effect, and preservation metadata", async () => {
    const state = stateWithOperation();
    const encoded = encodeMirrorDeviceState(state);
    expect(encoded).not.toMatch(/"(?:body|payload|content)"/);
    await expect(decodeMirrorDeviceState(encoded)).resolves.toEqual({
      kind: "valid",
      state,
    });
  });

  it("round-trips a restored-pending-review restart fence and rejects an unowned terminal restore", async () => {
    const state = stateWithOperation();
    const baseSnapshot = required(state.reconciliationOperations[0]).snapshot;
    const target = required(baseSnapshot.paths[0]);
    const snapshot = {
      ...baseSnapshot,
      paths: [
        {
          ...target,
          remote: {
            kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone,
            associationId: ASSOCIATION,
            revision: REVISION,
            deletedRevision: REVISION,
            recoveryId: RECOVERY,
            receipt: {
              action: MUTATION_ACTION.tombstone,
              associationId: ASSOCIATION,
              operationId: RECOVERY,
              precondition: { kind: "matching-revision", revision: REVISION },
            },
          },
        },
      ],
      recovery: {
        kind: RECOVERY_SNAPSHOT_STATE_KIND.prepared,
        id: RECOVERY,
        associationId: ASSOCIATION,
        path: PATH,
        revision: REVISION,
        sourceRevision: REVISION,
        contentSha256: HASH,
      },
    } as const;
    const fenced: MirrorDeviceState = {
      ...state,
      reconciliationReviews: [
        {
          ...required(state.reconciliationReviews[0]),
          classification: RECONCILIATION_CLASSIFICATION.remoteTombstoned,
          snapshot,
        },
      ],
      reconciliationOperations: [
        {
          ...required(state.reconciliationOperations[0]),
          authority: RECONCILIATION_AUTHORITY_SOURCE.recoveryRestoreDecision,
          action: { kind: RECONCILIATION_ACTION.restoreRecovery },
          phase: RECONCILIATION_OPERATION_PHASE.restoredPendingReview,
          snapshot,
          preservationReceipts: [
            {
              scope: "operation",
              operationId: OPERATION,
              originalPath: PATH,
              side: RECONCILIATION_PRESERVATION_SIDE.local,
              sourceRevision: null,
              contentSha256: HASH,
              preservationPath: `.ai-bridge-conflicts/${OPERATION}/local.md`,
              proofState: RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
            },
          ],
          localEffectObservation: {
            kind: LOCAL_EFFECT_OBSERVATION_KIND.confirmed,
            effectId: EFFECT,
            path: PATH,
            expectedHash: HASH,
            listenerEpoch: 1,
            beforeGeneration: 0,
            postconditionHash: HASH,
            successor: null,
          },
          localEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
          remoteEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
        },
      ],
    };
    const encoded = encodeMirrorDeviceState(fenced);
    await expect(decodeMirrorDeviceState(encoded)).resolves.toEqual({
      kind: "valid",
      state: fenced,
    });
    const recoveryReview = required(fenced.reconciliationReviews[0]);
    const v3Recovery: MirrorDeviceStateV3 = {
      ...fenced,
      reconciliationReviews: [
        {
          ...recoveryReview,
          status: RECONCILIATION_REVIEW_STATUS.pending,
          operationId: null,
        },
      ],
      reconciliationOperations: [],
    };
    await expect(
      decodeMirrorDeviceStateV3(encodeMirrorDeviceStateV3(v3Recovery)),
    ).resolves.toEqual({ kind: "valid", state: v3Recovery });
    const preparedRecovery = recoveryReview.snapshot.recovery;
    if (preparedRecovery === null)
      throw new Error("Expected recovery evidence.");
    const sealedRecovery = {
      ...preparedRecovery,
      kind: RECOVERY_SNAPSHOT_STATE_KIND.sealed,
      recoverUntil: "2030-01-01T00:00:00.000Z",
    } as const;
    const v3Sealed: MirrorDeviceStateV3 = {
      ...v3Recovery,
      reconciliationReviews: [
        {
          ...required(v3Recovery.reconciliationReviews[0]),
          snapshot: { ...recoveryReview.snapshot, recovery: sealedRecovery },
        },
      ],
    };
    await expect(
      decodeMirrorDeviceStateV3(encodeMirrorDeviceStateV3(v3Sealed)),
    ).resolves.toEqual({ kind: "valid", state: v3Sealed });

    const unownedTerminal = JSON.parse(encoded);
    unownedTerminal.reconciliationOperations[0].phase =
      RECONCILIATION_OPERATION_PHASE.completed;
    expect(
      await decodeMirrorDeviceState(JSON.stringify(unownedTerminal)),
    ).toEqual({ kind: "corrupt" });
  });

  it.each<ReconciliationRemoteEvidence>([
    { kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.absent },
    {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy,
      contentSha256: HASH,
    },
    {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION,
      contentSha256: HASH,
      receipt: {
        action: MUTATION_ACTION.create,
        associationId: ASSOCIATION,
        operationId: RECOVERY,
        precondition: { kind: "absent" },
        contentSha256: HASH,
      },
    },
    {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION,
      contentSha256: HASH,
      receipt: {
        action: MUTATION_ACTION.update,
        associationId: ASSOCIATION,
        operationId: RECOVERY,
        precondition: { kind: "matching-revision", revision: REVISION },
        contentSha256: HASH,
      },
    },
    {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION,
      contentSha256: HASH,
      receipt: {
        action: MUTATION_ACTION.recreate,
        associationId: ASSOCIATION,
        operationId: RECOVERY,
        precondition: { kind: "matching-revision", revision: REVISION },
        contentSha256: HASH,
      },
    },
    {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone,
      associationId: ASSOCIATION,
      revision: REVISION,
      deletedRevision: REVISION,
      recoveryId: RECOVERY,
      receipt: {
        action: MUTATION_ACTION.tombstone,
        associationId: ASSOCIATION,
        operationId: RECOVERY,
        precondition: { kind: "matching-revision", revision: REVISION },
      },
    },
    { kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.unavailable },
  ])("round-trips remote evidence kind $kind", async (remote) => {
    const state = baseState();
    const candidate: MirrorDeviceState = {
      ...state,
      reconciliationReviews: [
        {
          retention: RECONCILIATION_REVIEW_RETENTION.durable,
          reviewId: REVIEW,
          classification: RECONCILIATION_CLASSIFICATION.remoteAhead,
          status: RECONCILIATION_REVIEW_STATUS.pending,
          snapshot: {
            runtime: {
              runtimeOwnerVersion: 3,
              configurationGeneration: 1,
              listenerEpoch: 1,
              deviceId: DEVICE,
              designatedWriterId: DEVICE,
              lifecycle: state.lifecycle,
            },
            targetPath: PATH,
            paths: [
              {
                path: PATH,
                local: {
                  kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.absent,
                  stability: RECONCILIATION_LOCAL_STABILITY.stable,
                  observationGeneration: 1,
                },
                baseline: {
                  kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated,
                },
                remote,
                m3: { unresolvedMutation: null, deferredHistory: null },
              },
            ],
            recovery: null,
          },
          operationId: null,
        },
      ],
    };
    await expect(
      decodeMirrorDeviceState(encodeMirrorDeviceState(candidate)),
    ).resolves.toEqual({ kind: "valid", state: candidate });
    const v3: MirrorDeviceStateV3 = {
      ...candidate,
      reconciliationOperations: [],
    };
    await expect(
      decodeMirrorDeviceStateV3(encodeMirrorDeviceStateV3(v3)),
    ).resolves.toEqual({ kind: "valid", state: v3 });
  });

  it("refuses a semantically valid state that exceeds the codec byte bound", () => {
    const oversizedPath = required(
      normalizeNotePath(`${"a".repeat(MAX_MIRROR_DEVICE_STATE_BYTES)}.md`),
    );
    const state: MirrorDeviceState = {
      ...baseState(),
      paths: [
        {
          path: oversizedPath,
          acknowledgement: { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
          unresolvedMutation: null,
          desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
          blockedReason: null,
        },
      ],
    };
    expect(() => encodeMirrorDeviceState(state)).toThrow("storage bound");
    const v3: MirrorDeviceStateV3 = {
      ...state,
      reconciliationReviews: [],
      reconciliationOperations: [],
    };
    expect(() => encodeMirrorDeviceStateV3(v3)).toThrow("storage bound");
  });

  it("strictly rejects body-like fields and malformed M4 identities/evidence", async () => {
    const raw = JSON.parse(encodeMirrorDeviceState(stateWithOperation()));
    raw.reconciliationReviews[0].body = "PRIVATE";
    expect(await decodeMirrorDeviceState(JSON.stringify(raw))).toEqual({
      kind: "corrupt",
    });

    const malformed = JSON.parse(encodeMirrorDeviceState(stateWithOperation()));
    malformed.reconciliationOperations[0].operationId = "not-a-uuid";
    malformed.reconciliationOperations[0].snapshot.paths[0].remote.revision =
      "bad";
    malformed.reconciliationOperations[0].preservationReceipts[0].contentSha256 =
      "bad";
    expect(await decodeMirrorDeviceState(JSON.stringify(malformed))).toEqual({
      kind: "corrupt",
    });
  });

  it.each<CorruptState>([
    (raw) => {
      raw.extra = true;
    },
    (raw) => {
      raw.reconciliationReviews[0].retention = "temporary";
    },
    (raw) => {
      raw.reconciliationReviews[0].classification = "unknown";
    },
    (raw) => {
      raw.reconciliationReviews[0].status = "unknown";
    },
    (raw) => {
      raw.reconciliationReviews[0].snapshot.runtime.listenerEpoch = -1;
    },
    (raw) => {
      raw.reconciliationReviews[0].snapshot.paths[0].local.kind = "unknown-x";
    },
    (raw) => {
      raw.reconciliationReviews[0].snapshot.paths[0].baseline.kind = "bad";
    },
    (raw) => {
      raw.reconciliationReviews[0].snapshot.paths[0].remote.kind = "bad";
    },
    (raw) => {
      raw.reconciliationReviews[0].snapshot.paths[0].m3.extra = true;
    },
    (raw) => {
      raw.reconciliationOperations[0].operationKind = "bad";
    },
    (raw) => {
      raw.reconciliationOperations[0].authority = "bad";
    },
    (raw) => {
      raw.reconciliationOperations[0].action = { kind: "bad" };
    },
    (raw) => {
      raw.reconciliationOperations[0].phase = "bad";
    },
    (raw) => {
      raw.reconciliationOperations[0].destinationPath = "../bad.md";
    },
    (raw) => {
      raw.reconciliationOperations[0].reservations[0].kind = "bad";
    },
    (raw) => {
      raw.reconciliationOperations[0].preservationReceipts[0].scope = "bad";
    },
    (raw) => {
      raw.reconciliationOperations[0].preservationReceipts[0].side = "bad";
    },
    (raw) => {
      raw.reconciliationOperations[0].preservationReceipts[0].proofState =
        "bad";
    },
    (raw) => {
      raw.reconciliationOperations[0].localEffectObservation = {
        kind: "prepared",
      };
    },
    (raw) => {
      raw.reconciliationOperations[0].localEffect = { kind: "bad" };
    },
    (raw) => {
      raw.reconciliationOperations[0].remoteEffect = { kind: "bad" };
    },
    (raw) => {
      raw.reconciliationOperations[0].successorOperationId = "bad";
    },
  ])("strictly rejects malformed version-4 branch %#", async (corrupt) => {
    const raw = JSON.parse(encodeMirrorDeviceState(stateWithOperation()));
    corrupt(raw);
    await expect(decodeMirrorDeviceState(JSON.stringify(raw))).resolves.toEqual(
      { kind: "corrupt" },
    );
  });

  it.each<CorruptState>([
    (raw) => {
      raw.reconciliationOperations[0].action = { kind: "use-remote" };
    },
    (raw) => {
      raw.reconciliationOperations[0].action = {
        kind: "keep-both",
        primarySide: "remote",
      };
    },
    (raw) => {
      raw.reconciliationOperations[0].action = { kind: "adopt-revision" };
    },
    (raw) => {
      raw.reconciliationOperations[0].action = { kind: "accept-tombstone" };
    },
    (raw) => {
      raw.reconciliationOperations[0].action = { kind: "recreate-remote" };
    },
    (raw) => {
      raw.reconciliationOperations[0].action = { kind: "restore-recovery" };
    },
    (raw) => {
      raw.reconciliationOperations[0].action = { kind: "fork-legacy" };
    },
    (raw) => {
      raw.reconciliationOperations[0].action = { kind: "defer" };
    },
    (raw) => {
      raw.reconciliationOperations[0].action = {
        kind: "resolve-history",
        decision: { kind: "retain-independent" },
      };
    },
    (raw) => {
      raw.reconciliationOperations[0].localEffectObservation = {
        kind: "prepared",
        effectId: EFFECT,
        path: PATH,
        expectedHash: HASH,
        listenerEpoch: 1,
        beforeGeneration: 1,
        successor: null,
      };
    },
    (raw) => {
      raw.reconciliationOperations[0].localEffectObservation = {
        kind: "confirmed",
        effectId: EFFECT,
        path: PATH,
        expectedHash: HASH,
        listenerEpoch: 1,
        beforeGeneration: 1,
        postconditionHash: HASH,
        successor: null,
      };
    },
    (raw) => {
      raw.reconciliationOperations[0].localEffectObservation = {
        kind: "legacy-v3-unfenced",
      };
    },
    (raw) => {
      raw.reconciliationOperations[0].localEffect = {
        kind: "confirmed",
        acknowledgement: { path: PATH, contentSha256: HASH },
      };
    },
    (raw) => {
      raw.reconciliationOperations[0].localEffect = { kind: "unknown" };
    },
    (raw) => {
      raw.reconciliationOperations[0].remoteEffect = { kind: "unknown" };
    },
    (raw) => {
      raw.reconciliationOperations[0].remoteEffect = {
        kind: "definitely-refused",
      };
    },
    (raw) => {
      raw.reconciliationReviews[0].snapshot.paths[0].local = {
        kind: "absent",
        stability: "stable",
        observationGeneration: 1,
      };
    },
    (raw) => {
      raw.reconciliationReviews[0].snapshot.paths[0].local = {
        kind: "unknown",
        reason: "unavailable",
      };
    },
    (raw) => {
      raw.reconciliationReviews[0].snapshot.paths[0].baseline = {
        kind: "unassociated",
      };
    },
    (raw) => {
      raw.reconciliationReviews[0].snapshot.paths[0].baseline = {
        kind: "tombstone",
        revision: REVISION,
      };
    },
    (raw) => {
      raw.reconciliationReviews[0].snapshot.recovery = {
        kind: "prepared",
        id: RECOVERY,
        associationId: ASSOCIATION,
        path: PATH,
        revision: REVISION,
        sourceRevision: REVISION,
        contentSha256: HASH,
      };
    },
  ])(
    "decodes alternate version-4 unions before semantic refusal %#",
    async (change) => {
      const raw = JSON.parse(encodeMirrorDeviceState(stateWithOperation()));
      change(raw);
      await expect(
        decodeMirrorDeviceState(JSON.stringify(raw)),
      ).resolves.toEqual({ kind: "corrupt" });
    },
  );

  it.each<CorruptState>([
    (raw) => {
      raw.reconciliationReviews[0].snapshot.paths[0].remote.associationId =
        DEVICE;
    },
    (raw) => {
      raw.reconciliationReviews[0].snapshot.runtime.runtimeOwnerVersion = -1;
    },
    (raw) => {
      raw.reconciliationReviews[0].snapshot.paths[0].local.stability = "bad";
    },
    (raw) => {
      raw.reconciliationReviews[0].snapshot.paths[0].remote.receipt.action =
        "bad";
    },
    (raw) => {
      raw.reconciliationOperations[0].preservationReceipts[0].operationId =
        "bad";
    },
    (raw) => {
      raw.reconciliationOperations[0].localEffect = { kind: "bad" };
    },
    (raw) => {
      raw.reconciliationOperations[0].remoteEffect = { kind: "bad" };
    },
  ])(
    "keeps the frozen version-3 decoder strict at branch %#",
    async (corrupt) => {
      const raw = JSON.parse(encodeMirrorDeviceStateV3(stateWithOperationV3()));
      corrupt(raw);
      await expect(
        decodeMirrorDeviceStateV3(JSON.stringify(raw)),
      ).resolves.toEqual({ kind: "corrupt" });
    },
  );
});
