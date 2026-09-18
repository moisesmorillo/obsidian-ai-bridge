import {
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  createRecoverySnapshotId,
  type EphemeralReconciliationReview,
  isMirrorDeviceStateConsistent,
  MAX_RECONCILIATION_REVIEWS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_MUTATION_PHASE,
  MIRROR_RENAME_PHASE,
  type MirrorDeviceState,
  MUTATION_ACTION,
  MUTATION_EFFECT_CERTAINTY,
  normalizeNotePath,
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
  type ReconciliationAction,
  type ReconciliationOperation,
  type ReconciliationOperationPhase,
  type ReconciliationPathEvidence,
  type ReconciliationReview,
  type ReconciliationReviewSnapshot,
  reconciliationReviewSnapshotsEqual,
} from "@obsidian-ai-bridge/core";
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
const OTHER_DEVICE = required(
  createMirrorWriterId("11111111-1111-4111-8111-222222222222"),
);
const FOREIGN_ASSOCIATION = required(
  createMirrorAssociationId("22222222-2222-4222-8222-333333333333"),
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
const OTHER_REVISION = required(
  createApplicationRevision("99999999-9999-4999-8999-999999999999"),
);
const RECOVERY = required(
  createRecoverySnapshotId("66666666-6666-4666-8666-666666666666"),
);
const HASH = required(createContentSha256("ab".repeat(32)));
const OTHER_HASH = required(createContentSha256("cd".repeat(32)));
const SOURCE = required(normalizeNotePath("notes/source.md"));
const DESTINATION = required(normalizeNotePath("notes/destination.md"));
const SUCCESSOR_REVIEW = required(
  createMirrorOperationId("77777777-7777-4777-8777-777777777777"),
);
const SUCCESSOR_OPERATION = required(
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
        path: SOURCE,
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

function actionFor(kind: ReconciliationAction["kind"]): ReconciliationAction {
  switch (kind) {
    case RECONCILIATION_ACTION.keepBoth:
      return {
        kind,
        primarySide: RECONCILIATION_PRESERVATION_SIDE.local,
      };
    case RECONCILIATION_ACTION.keepLocal:
    case RECONCILIATION_ACTION.useRemote:
    case RECONCILIATION_ACTION.adoptRevision:
    case RECONCILIATION_ACTION.acceptTombstone:
    case RECONCILIATION_ACTION.recreateRemote:
    case RECONCILIATION_ACTION.restoreRecovery:
    case RECONCILIATION_ACTION.forkLegacy:
    case RECONCILIATION_ACTION.resolveHistory:
    case RECONCILIATION_ACTION.defer:
      return { kind };
  }
}

function authorityFor(
  kind: ReconciliationAction["kind"],
): ReconciliationOperation["authority"] {
  switch (kind) {
    case RECONCILIATION_ACTION.keepLocal:
    case RECONCILIATION_ACTION.useRemote:
    case RECONCILIATION_ACTION.keepBoth:
    case RECONCILIATION_ACTION.defer:
      return RECONCILIATION_AUTHORITY_SOURCE.reconciliationDecision;
    case RECONCILIATION_ACTION.adoptRevision:
    case RECONCILIATION_ACTION.forkLegacy:
      return RECONCILIATION_AUTHORITY_SOURCE.adoptionDecision;
    case RECONCILIATION_ACTION.acceptTombstone:
    case RECONCILIATION_ACTION.recreateRemote:
      return RECONCILIATION_AUTHORITY_SOURCE.tombstoneDecision;
    case RECONCILIATION_ACTION.restoreRecovery:
      return RECONCILIATION_AUTHORITY_SOURCE.recoveryRestoreDecision;
    case RECONCILIATION_ACTION.resolveHistory:
      return RECONCILIATION_AUTHORITY_SOURCE.historyDecision;
  }
}

function operationFor(
  kind: ReconciliationAction["kind"] = RECONCILIATION_ACTION.keepLocal,
  phase: ReconciliationOperationPhase = RECONCILIATION_OPERATION_PHASE.admitted,
): ReconciliationOperation {
  const needsDestination =
    kind === RECONCILIATION_ACTION.keepBoth ||
    kind === RECONCILIATION_ACTION.restoreRecovery ||
    kind === RECONCILIATION_ACTION.forkLegacy;
  const remote: ReconciliationPathEvidence["remote"] =
    kind === RECONCILIATION_ACTION.acceptTombstone ||
    kind === RECONCILIATION_ACTION.recreateRemote ||
    kind === RECONCILIATION_ACTION.restoreRecovery
      ? {
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
        }
      : kind === RECONCILIATION_ACTION.forkLegacy
        ? {
            kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy,
            contentSha256: HASH,
          }
        : {
            kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
            associationId: ASSOCIATION,
            revision: REVISION,
            contentSha256: OTHER_HASH,
            receipt: {
              action: MUTATION_ACTION.create,
              associationId: ASSOCIATION,
              operationId: RECOVERY,
              precondition: { kind: "absent" },
              contentSha256: OTHER_HASH,
            },
          };
  const local: ReconciliationPathEvidence["local"] =
    kind === RECONCILIATION_ACTION.acceptTombstone ||
    kind === RECONCILIATION_ACTION.adoptRevision
      ? {
          kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.absent,
          stability: RECONCILIATION_LOCAL_STABILITY.stable,
          observationGeneration: 1,
        }
      : {
          kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.live,
          stability: RECONCILIATION_LOCAL_STABILITY.stable,
          observationGeneration: 1,
          byteSize: 1,
          contentSha256: HASH,
        };
  const deferredHistory: ReconciliationPathEvidence["m3"]["deferredHistory"] =
    kind === RECONCILIATION_ACTION.resolveHistory
      ? {
          kind: MIRROR_DESIRED_STATE_KIND.renameDeferred,
          observationGeneration: 1,
          renameId: OPERATION,
          associationId: ASSOCIATION,
          sourcePath: SOURCE,
          destinationPath: DESTINATION,
          sourceExpectedRevision: REVISION,
          destinationObservationGeneration: 1,
          destinationAcknowledgedRevision: null,
          graceDeadlineMilliseconds: 1,
          phase: MIRROR_RENAME_PHASE.destinationRequired,
        }
      : null;
  const destinationEvidence: ReconciliationPathEvidence = {
    path: DESTINATION,
    local: {
      kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.absent,
      stability: RECONCILIATION_LOCAL_STABILITY.stable,
      observationGeneration: 1,
    },
    baseline: { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
    remote: { kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.absent },
    m3: { unresolvedMutation: null, deferredHistory: null },
  };
  const snapshot: ReconciliationReviewSnapshot = {
    runtime: {
      runtimeOwnerVersion: 3,
      configurationGeneration: 1,
      listenerEpoch: 1,
      deviceId: DEVICE,
      designatedWriterId: DEVICE,
      lifecycle: baseState().lifecycle,
    },
    targetPath: SOURCE,
    paths: [
      {
        path: SOURCE,
        local,
        baseline: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision: REVISION,
          contentSha256: HASH,
        },
        remote,
        m3: { unresolvedMutation: null, deferredHistory },
      },
      ...(needsDestination ? [destinationEvidence] : []),
    ],
    recovery:
      kind === RECONCILIATION_ACTION.restoreRecovery
        ? {
            kind: RECOVERY_SNAPSHOT_STATE_KIND.prepared,
            id: RECOVERY,
            associationId: ASSOCIATION,
            path: SOURCE,
            revision: REVISION,
            sourceRevision: REVISION,
            contentSha256: HASH,
          }
        : null,
  };
  return {
    operationId: OPERATION,
    reviewId: REVIEW,
    authority: authorityFor(kind),
    action: actionFor(kind),
    phase,
    snapshot,
    destinationPath: needsDestination ? DESTINATION : null,
    reservations: [
      { path: SOURCE, kind: RECONCILIATION_PATH_REFERENCE_KIND.tracked },
      ...(needsDestination
        ? [
            {
              path: DESTINATION,
              kind: RECONCILIATION_PATH_REFERENCE_KIND.newDestination,
            } as const,
          ]
        : []),
    ],
    preservationReceipts: [],
    successorOperationId: null,
    localEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
    remoteEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
  };
}

function withPathEvidence(
  operation: ReconciliationOperation,
  path: ReconciliationPathEvidence["path"],
  update: (current: ReconciliationPathEvidence) => ReconciliationPathEvidence,
): ReconciliationOperation {
  return {
    ...operation,
    snapshot: {
      ...operation.snapshot,
      paths: operation.snapshot.paths.map((evidence) =>
        evidence.path === path ? update(evidence) : evidence,
      ),
    },
  };
}

function verifiedReceipt(
  operation: ReconciliationOperation,
  side: ReconciliationPreservationReceiptSide,
): ReconciliationOperation["preservationReceipts"][number] {
  const target = required(
    operation.snapshot.paths.find(
      (evidence) => evidence.path === operation.snapshot.targetPath,
    ),
  );
  if (side === RECONCILIATION_PRESERVATION_SIDE.local) {
    if (target.local.kind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.live) {
      throw new Error("Expected live local preservation evidence.");
    }
    return {
      operationId: operation.operationId,
      originalPath: target.path,
      side,
      sourceRevision: null,
      contentSha256: target.local.contentSha256,
      preservationPath: `.ai-bridge-conflicts/${operation.operationId}/local.md`,
      proofState: RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
    };
  }
  if (
    target.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.live &&
    target.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy
  ) {
    throw new Error("Expected exact remote preservation evidence.");
  }
  return {
    operationId: operation.operationId,
    originalPath: target.path,
    side,
    sourceRevision:
      target.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live
        ? target.remote.revision
        : null,
    contentSha256: target.remote.contentSha256,
    preservationPath: `.ai-bridge-conflicts/${operation.operationId}/remote.md`,
    proofState: RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
  };
}

type ReconciliationPreservationReceiptSide =
  ReconciliationOperation["preservationReceipts"][number]["side"];

function classificationForAction(
  kind: ReconciliationAction["kind"],
): ReconciliationReview["classification"] {
  switch (kind) {
    case RECONCILIATION_ACTION.keepLocal:
    case RECONCILIATION_ACTION.useRemote:
    case RECONCILIATION_ACTION.keepBoth:
      return RECONCILIATION_CLASSIFICATION.bothChanged;
    case RECONCILIATION_ACTION.adoptRevision:
      return RECONCILIATION_CLASSIFICATION.remoteAhead;
    case RECONCILIATION_ACTION.acceptTombstone:
    case RECONCILIATION_ACTION.recreateRemote:
    case RECONCILIATION_ACTION.restoreRecovery:
      return RECONCILIATION_CLASSIFICATION.remoteTombstoned;
    case RECONCILIATION_ACTION.forkLegacy:
      return RECONCILIATION_CLASSIFICATION.legacyRemote;
    case RECONCILIATION_ACTION.resolveHistory:
      return RECONCILIATION_CLASSIFICATION.deferredHistory;
    case RECONCILIATION_ACTION.defer:
      return RECONCILIATION_CLASSIFICATION.remoteUnavailable;
  }
}

function stateWithOperation(
  operation: ReconciliationOperation,
): MirrorDeviceState {
  const terminalStatus =
    operation.phase === RECONCILIATION_OPERATION_PHASE.stale
      ? RECONCILIATION_REVIEW_STATUS.stale
      : RECONCILIATION_REVIEW_STATUS.completed;
  const status =
    operation.phase === RECONCILIATION_OPERATION_PHASE.stale ||
    operation.phase === RECONCILIATION_OPERATION_PHASE.completed
      ? terminalStatus
      : RECONCILIATION_REVIEW_STATUS.staged;
  const review: ReconciliationReview = {
    retention: RECONCILIATION_REVIEW_RETENTION.durable,
    reviewId: REVIEW,
    classification: classificationForAction(operation.action.kind),
    status,
    snapshot: operation.snapshot,
    operationId: operation.operationId,
  };
  const initial = baseState();
  const paths: MirrorDeviceState["paths"] =
    operation.action.kind === RECONCILIATION_ACTION.resolveHistory
      ? initial.paths.map((path) => ({
          ...path,
          desired: {
            kind: MIRROR_DESIRED_STATE_KIND.renameDeferred,
            observationGeneration: 1,
            renameId: OPERATION,
            associationId: ASSOCIATION,
            sourcePath: SOURCE,
            destinationPath: DESTINATION,
            sourceExpectedRevision: REVISION,
            destinationObservationGeneration: 1,
            destinationAcknowledgedRevision: null,
            graceDeadlineMilliseconds: 1,
            phase: MIRROR_RENAME_PHASE.destinationRequired,
          },
        }))
      : initial.paths;
  return {
    ...initial,
    paths,
    reconciliationReviews: [review],
    reconciliationOperations: [operation],
  };
}

describe("M4 reconciliation state contracts", () => {
  it.each(Object.values(RECONCILIATION_AUTHORITY_SOURCE))(
    "keeps authority source %s closed",
    (authority) => {
      expect(Object.values(RECONCILIATION_AUTHORITY_SOURCE)).toContain(
        authority,
      );
    },
  );

  it("keeps ephemeral sampled text outside the durable state contract", () => {
    const durable = stateWithOperation(operationFor()).reconciliationReviews[0];
    if (durable === undefined)
      throw new Error("Missing durable review fixture.");
    const ephemeral: EphemeralReconciliationReview = {
      ...durable,
      retention: RECONCILIATION_REVIEW_RETENTION.ephemeral,
      sessionId: OPERATION,
      allowedActions: [],
      sampledLocalText: "transient local",
      sampledRemoteText: "transient remote",
    };
    expect(ephemeral.retention).toBe(RECONCILIATION_REVIEW_RETENTION.ephemeral);
    expect(durable.retention).toBe(RECONCILIATION_REVIEW_RETENTION.durable);
    expect(baseState()).not.toHaveProperty("sampledLocalText");
    expect(baseState()).not.toHaveProperty("sampledRemoteText");
  });

  it.each(Object.values(RECONCILIATION_CLASSIFICATION))(
    "accepts classification %s in sparse read-only metadata",
    (classification) => {
      const initial = baseState();
      const path = required(initial.paths[0]);
      const paths =
        classification === RECONCILIATION_CLASSIFICATION.unresolvedM3Effect
          ? [
              {
                ...path,
                unresolvedMutation: {
                  intent: {
                    action: MUTATION_ACTION.update,
                    associationId: ASSOCIATION,
                    writerId: DEVICE,
                    operationId: OPERATION,
                    path: SOURCE,
                    precondition: {
                      kind: "matching-revision" as const,
                      revision: REVISION,
                    },
                    contentSha256: HASH,
                    mutationAttempts: 0,
                    evidenceAttempts: 0,
                  },
                  phase: MIRROR_MUTATION_PHASE.intentPersisted,
                },
              },
            ]
          : classification === RECONCILIATION_CLASSIFICATION.deferredHistory
            ? [
                {
                  ...path,
                  desired: {
                    kind: MIRROR_DESIRED_STATE_KIND.renameDeferred,
                    observationGeneration: 1,
                    renameId: OPERATION,
                    associationId: ASSOCIATION,
                    sourcePath: SOURCE,
                    destinationPath: DESTINATION,
                    sourceExpectedRevision: REVISION,
                    destinationObservationGeneration: 1,
                    destinationAcknowledgedRevision: null,
                    graceDeadlineMilliseconds: 1,
                    phase: MIRROR_RENAME_PHASE.destinationRequired,
                  },
                },
              ]
            : initial.paths;
      const operation = operationFor();
      const reviewedPath = required(paths[0]);
      const review: ReconciliationReview = {
        retention: RECONCILIATION_REVIEW_RETENTION.durable,
        reviewId: REVIEW,
        classification,
        status: RECONCILIATION_REVIEW_STATUS.pending,
        snapshot: {
          ...operation.snapshot,
          paths: operation.snapshot.paths.map((evidence) =>
            evidence.path === SOURCE
              ? {
                  ...evidence,
                  m3: {
                    unresolvedMutation: reviewedPath.unresolvedMutation,
                    deferredHistory:
                      reviewedPath.desired.kind ===
                      MIRROR_DESIRED_STATE_KIND.renameDeferred
                        ? reviewedPath.desired
                        : null,
                  },
                }
              : evidence,
          ),
        },
        operationId: null,
      };
      const state = {
        ...initial,
        paths,
        reconciliationReviews: [review],
      };
      expect(isMirrorDeviceStateConsistent(state)).toBe(true);
    },
  );

  it.each(Object.values(RECONCILIATION_ACTION))(
    "accepts approved action %s with compatible evidence",
    (action) => {
      const operation = operationFor(
        action,
        action === RECONCILIATION_ACTION.defer
          ? RECONCILIATION_OPERATION_PHASE.completed
          : RECONCILIATION_OPERATION_PHASE.admitted,
      );
      expect(isMirrorDeviceStateConsistent(stateWithOperation(operation))).toBe(
        true,
      );
    },
  );

  it.each(
    Object.values(RECONCILIATION_OPERATION_PHASE).filter(
      (phase) => phase !== RECONCILIATION_OPERATION_PHASE.restoredPendingReview,
    ),
  )(
    "accepts operation phase %s for a compatible keep-both operation",
    (phase) => {
      const operation = operationFor(RECONCILIATION_ACTION.keepBoth, phase);
      const needsReceipt = phase !== RECONCILIATION_OPERATION_PHASE.admitted;
      const proofState =
        phase === RECONCILIATION_OPERATION_PHASE.preserving
          ? RECONCILIATION_PRESERVATION_PROOF_STATE.pending
          : phase === RECONCILIATION_OPERATION_PHASE.blocked
            ? RECONCILIATION_PRESERVATION_PROOF_STATE.blocked
            : RECONCILIATION_PRESERVATION_PROOF_STATE.verified;
      const localEffect =
        phase === RECONCILIATION_OPERATION_PHASE.partial ||
        phase === RECONCILIATION_OPERATION_PHASE.completed
          ? MUTATION_EFFECT_CERTAINTY.confirmed
          : MUTATION_EFFECT_CERTAINTY.notDispatched;
      const remoteEffect =
        phase === RECONCILIATION_OPERATION_PHASE.evidenceRequired
          ? MUTATION_EFFECT_CERTAINTY.unknown
          : phase === RECONCILIATION_OPERATION_PHASE.completed
            ? MUTATION_EFFECT_CERTAINTY.confirmed
            : MUTATION_EFFECT_CERTAINTY.notDispatched;
      expect(
        isMirrorDeviceStateConsistent(
          stateWithOperation({
            ...operation,
            preservationReceipts: needsReceipt
              ? [
                  {
                    ...verifiedReceipt(
                      operation,
                      RECONCILIATION_PRESERVATION_SIDE.remote,
                    ),
                    proofState,
                  },
                ]
              : [],
            localEffect,
            remoteEffect,
          }),
        ),
      ).toBe(true);
    },
  );

  it.each(Object.values(RECONCILIATION_PRESERVATION_PROOF_STATE))(
    "accepts preservation proof state %s",
    (proofState) => {
      const phase =
        proofState === RECONCILIATION_PRESERVATION_PROOF_STATE.pending ||
        proofState === RECONCILIATION_PRESERVATION_PROOF_STATE.verified
          ? RECONCILIATION_OPERATION_PHASE.preserving
          : proofState ===
              RECONCILIATION_PRESERVATION_PROOF_STATE.evidenceRequired
            ? RECONCILIATION_OPERATION_PHASE.evidenceRequired
            : RECONCILIATION_OPERATION_PHASE.blocked;
      const operation = operationFor(RECONCILIATION_ACTION.keepLocal, phase);
      const withReceipt: ReconciliationOperation = {
        ...operation,
        preservationReceipts: [
          {
            ...verifiedReceipt(
              operation,
              RECONCILIATION_PRESERVATION_SIDE.remote,
            ),
            proofState,
          },
        ],
      };
      expect(
        isMirrorDeviceStateConsistent(stateWithOperation(withReceipt)),
      ).toBe(true);
    },
  );

  it.each([
    {
      action: RECONCILIATION_ACTION.keepLocal,
      side: RECONCILIATION_PRESERVATION_SIDE.remote,
      localEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
      remoteEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
    },
    {
      action: RECONCILIATION_ACTION.useRemote,
      side: RECONCILIATION_PRESERVATION_SIDE.local,
      localEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
      remoteEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
    },
    {
      action: RECONCILIATION_ACTION.recreateRemote,
      side: RECONCILIATION_PRESERVATION_SIDE.local,
      localEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
      remoteEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
    },
    {
      action: RECONCILIATION_ACTION.forkLegacy,
      side: RECONCILIATION_PRESERVATION_SIDE.remote,
      localEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
      remoteEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
    },
    {
      action: RECONCILIATION_ACTION.resolveHistory,
      side: RECONCILIATION_PRESERVATION_SIDE.remote,
      localEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
      remoteEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
    },
  ] as const)(
    "accepts completed $action only with its exact preservation and effects",
    ({ action, side, localEffect, remoteEffect }) => {
      const operation = operationFor(
        action,
        RECONCILIATION_OPERATION_PHASE.completed,
      );
      expect(
        isMirrorDeviceStateConsistent(
          stateWithOperation({
            ...operation,
            preservationReceipts: [verifiedReceipt(operation, side)],
            localEffect,
            remoteEffect,
          }),
        ),
      ).toBe(true);
    },
  );

  it("accepts completed exact adoption from stable local absence", () => {
    const operation = operationFor(
      RECONCILIATION_ACTION.adoptRevision,
      RECONCILIATION_OPERATION_PHASE.completed,
    );
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation({
          ...operation,
          localEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
        }),
      ),
    ).toBe(true);
  });

  it("accepts local-missing import and tombstoned keep-both relationships", () => {
    const localMissingImport = operationFor(RECONCILIATION_ACTION.useRemote);
    const importState = stateWithOperation(
      withPathEvidence(localMissingImport, SOURCE, (evidence) => ({
        ...evidence,
        local: {
          kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.absent,
          stability: RECONCILIATION_LOCAL_STABILITY.stable,
          observationGeneration: 2,
        },
      })),
    );
    const importReview = required(importState.reconciliationReviews[0]);
    expect(
      isMirrorDeviceStateConsistent({
        ...importState,
        reconciliationReviews: [
          {
            ...importReview,
            classification: RECONCILIATION_CLASSIFICATION.localMissing,
          },
        ],
      }),
    ).toBe(true);

    const originalPathRestore = operationFor(
      RECONCILIATION_ACTION.restoreRecovery,
    );
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation({
          ...originalPathRestore,
          snapshot: {
            ...originalPathRestore.snapshot,
            paths: [required(originalPathRestore.snapshot.paths[0])],
          },
          destinationPath: null,
          reservations: [required(originalPathRestore.reservations[0])],
        }),
      ),
    ).toBe(true);

    const tombstoneKeepBoth = operationFor(RECONCILIATION_ACTION.keepBoth);
    const keepBothState = stateWithOperation(
      withPathEvidence(
        {
          ...tombstoneKeepBoth,
          action: {
            kind: RECONCILIATION_ACTION.keepBoth,
            primarySide: RECONCILIATION_PRESERVATION_SIDE.remote,
          },
        },
        SOURCE,
        (evidence) => ({
          ...evidence,
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
        }),
      ),
    );
    const keepBothReview = required(keepBothState.reconciliationReviews[0]);
    expect(
      isMirrorDeviceStateConsistent({
        ...keepBothState,
        reconciliationReviews: [
          {
            ...keepBothReview,
            classification: RECONCILIATION_CLASSIFICATION.remoteTombstoned,
          },
        ],
      }),
    ).toBe(true);
  });

  it("rejects remote evidence from another association", () => {
    const operation = operationFor(RECONCILIATION_ACTION.useRemote);
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation(
          withPathEvidence(operation, SOURCE, (evidence) => ({
            ...evidence,
            remote: {
              kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
              associationId: FOREIGN_ASSOCIATION,
              revision: REVISION,
              contentSha256: HASH,
              receipt: {
                action: MUTATION_ACTION.create,
                associationId: FOREIGN_ASSOCIATION,
                operationId: RECOVERY,
                precondition: { kind: "absent" },
                contentSha256: HASH,
              },
            },
          })),
        ),
      ),
    ).toBe(false);
  });

  it.each([MUTATION_ACTION.update, MUTATION_ACTION.recreate] as const)(
    "accepts exact %s receipt preconditions as remote identity",
    (action) => {
      const operation = operationFor(RECONCILIATION_ACTION.useRemote);
      const withReceipt = withPathEvidence(operation, SOURCE, (evidence) => {
        if (evidence.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.live) {
          throw new Error("Expected live remote evidence.");
        }
        return {
          ...evidence,
          remote: {
            ...evidence.remote,
            receipt: {
              ...evidence.remote.receipt,
              action,
              precondition: {
                kind: "matching-revision",
                revision: REVISION,
              },
            },
          },
        };
      });
      expect(
        isMirrorDeviceStateConsistent(stateWithOperation(withReceipt)),
      ).toBe(true);
    },
  );

  it("rejects remote evidence whose receipt does not identify the sampled bytes", () => {
    const operation = operationFor(RECONCILIATION_ACTION.useRemote);
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation(
          withPathEvidence(operation, SOURCE, (evidence) => {
            if (
              evidence.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.live
            ) {
              throw new Error("Expected live remote evidence.");
            }
            return {
              ...evidence,
              remote: {
                ...evidence.remote,
                receipt: {
                  ...evidence.remote.receipt,
                  contentSha256: HASH,
                },
              },
            };
          }),
        ),
      ),
    ).toBe(false);
  });

  it("rejects tombstone evidence whose receipt does not identify the deletion", () => {
    const operation = operationFor(RECONCILIATION_ACTION.recreateRemote);
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation(
          withPathEvidence(operation, SOURCE, (evidence) => {
            if (
              evidence.remote.kind !==
              RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone
            ) {
              throw new Error("Expected tombstone remote evidence.");
            }
            return {
              ...evidence,
              remote: {
                ...evidence.remote,
                receipt: {
                  ...evidence.remote.receipt,
                  operationId: SUCCESSOR_OPERATION,
                },
              },
            };
          }),
        ),
      ),
    ).toBe(false);
  });

  it("rejects invalid related-path, M3, recovery, and active-delete relationships", () => {
    const keepBoth = operationFor(RECONCILIATION_ACTION.keepBoth);
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation({
          ...keepBoth,
          snapshot: {
            ...keepBoth.snapshot,
            paths: [required(keepBoth.snapshot.paths[0])],
          },
        }),
      ),
    ).toBe(false);

    const keepLocal = operationFor(RECONCILIATION_ACTION.keepLocal);
    const target = required(keepLocal.snapshot.paths[0]);
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation({
          ...keepLocal,
          snapshot: {
            ...keepLocal.snapshot,
            paths: [
              {
                ...target,
                m3: {
                  deferredHistory: null,
                  unresolvedMutation: {
                    intent: {
                      action: MUTATION_ACTION.update,
                      associationId: ASSOCIATION,
                      writerId: DEVICE,
                      operationId: SUCCESSOR_OPERATION,
                      path: SOURCE,
                      precondition: {
                        kind: "matching-revision",
                        revision: REVISION,
                      },
                      contentSha256: HASH,
                      mutationAttempts: 0,
                      evidenceAttempts: 0,
                    },
                    phase: MIRROR_MUTATION_PHASE.recoveryPreparation,
                  },
                },
              },
            ],
          },
        }),
      ),
    ).toBe(false);

    const restore = operationFor(RECONCILIATION_ACTION.restoreRecovery);
    const recovery = restore.snapshot.recovery;
    if (recovery === null) throw new Error("Expected recovery evidence.");
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation({
          ...restore,
          snapshot: {
            ...restore.snapshot,
            recovery: {
              ...recovery,
              associationId: FOREIGN_ASSOCIATION,
            },
          },
        }),
      ),
    ).toBe(false);

    const state = stateWithOperation(keepLocal);
    const path = required(state.paths[0]);
    expect(
      isMirrorDeviceStateConsistent({
        ...state,
        paths: [
          {
            ...path,
            desired: {
              kind: MIRROR_DESIRED_STATE_KIND.runtimeDelete,
              observationGeneration: 1,
              evidenceId: SUCCESSOR_OPERATION,
              associationId: ASSOCIATION,
              expectedRevision: REVISION,
              graceDeadlineMilliseconds: 1,
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("compares disabled and unknown-local identities exhaustively", () => {
    const snapshot = operationFor().snapshot;
    const disabled = {
      ...snapshot,
      runtime: {
        ...snapshot.runtime,
        lifecycle: { kind: MIRROR_DEVICE_LIFECYCLE_KIND.disabled },
      },
    } satisfies ReconciliationReviewSnapshot;
    expect(reconciliationReviewSnapshotsEqual(disabled, disabled)).toBe(true);

    const target = required(snapshot.paths[0]);
    const unknown = {
      ...snapshot,
      paths: [
        {
          ...target,
          local: {
            kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown,
            stability: RECONCILIATION_LOCAL_STABILITY.unknown,
          },
        },
      ],
    } satisfies ReconciliationReviewSnapshot;
    expect(reconciliationReviewSnapshotsEqual(unknown, unknown)).toBe(true);
  });

  it("rejects an action that is incompatible with its review classification", () => {
    const state = stateWithOperation(
      operationFor(RECONCILIATION_ACTION.keepLocal),
    );
    const review = required(state.reconciliationReviews[0]);
    expect(
      isMirrorDeviceStateConsistent({
        ...state,
        reconciliationReviews: [
          {
            ...review,
            classification: RECONCILIATION_CLASSIFICATION.aligned,
          },
        ],
      }),
    ).toBe(false);
  });

  it("rejects invalid action/phase and preservation combinations", () => {
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation(
          operationFor(
            RECONCILIATION_ACTION.keepBoth,
            RECONCILIATION_OPERATION_PHASE.evidenceRequired,
          ),
        ),
      ),
    ).toBe(false);
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation(
          operationFor(
            RECONCILIATION_ACTION.keepBoth,
            RECONCILIATION_OPERATION_PHASE.partial,
          ),
        ),
      ),
    ).toBe(false);
    const completedKeepLocal = operationFor(
      RECONCILIATION_ACTION.keepLocal,
      RECONCILIATION_OPERATION_PHASE.completed,
    );
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation(
          withPathEvidence(completedKeepLocal, SOURCE, (evidence) => ({
            ...evidence,
            remote: {
              kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
              associationId: ASSOCIATION,
              revision: REVISION,
              contentSha256: OTHER_HASH,
              receipt: {
                action: MUTATION_ACTION.create,
                associationId: ASSOCIATION,
                operationId: RECOVERY,
                precondition: { kind: "absent" },
                contentSha256: OTHER_HASH,
              },
            },
          })),
        ),
      ),
    ).toBe(false);
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation(
          operationFor(
            RECONCILIATION_ACTION.useRemote,
            RECONCILIATION_OPERATION_PHASE.mutatingRemote,
          ),
        ),
      ),
    ).toBe(false);
    const adoption = operationFor(RECONCILIATION_ACTION.adoptRevision);
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation({
          ...adoption,
          preservationReceipts: [
            {
              operationId: OPERATION,
              originalPath: SOURCE,
              side: RECONCILIATION_PRESERVATION_SIDE.remote,
              sourceRevision: REVISION,
              contentSha256: HASH,
              preservationPath: `.ai-bridge-conflicts/${OPERATION}/remote.md`,
              proofState: RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("rejects duplicate IDs and overlapping active reservations", () => {
    const state = stateWithOperation(operationFor());
    expect(
      isMirrorDeviceStateConsistent({
        ...state,
        reconciliationReviews: [
          required(state.reconciliationReviews[0]),
          required(state.reconciliationReviews[0]),
        ],
      }),
    ).toBe(false);

    const secondReviewId = required(
      createMirrorOperationId("77777777-7777-4777-8777-777777777777"),
    );
    const secondOperationId = required(
      createMirrorOperationId("88888888-8888-4888-8888-888888888888"),
    );
    const firstReview = required(state.reconciliationReviews[0]);
    const firstOperation = required(state.reconciliationOperations[0]);
    expect(
      isMirrorDeviceStateConsistent({
        ...state,
        reconciliationReviews: [
          firstReview,
          {
            ...firstReview,
            reviewId: secondReviewId,
            operationId: secondOperationId,
          },
        ],
        reconciliationOperations: [
          firstOperation,
          {
            ...firstOperation,
            reviewId: secondReviewId,
            operationId: secondOperationId,
          },
        ],
      }),
    ).toBe(false);
  });

  it("rejects invalid source/destination and tracked/new-destination references", () => {
    const operation = operationFor(RECONCILIATION_ACTION.keepBoth);
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation({
          ...operation,
          destinationPath: SOURCE,
        }),
      ),
    ).toBe(false);
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation({
          ...operation,
          reservations: operation.reservations.map((reservation) =>
            reservation.path === DESTINATION
              ? {
                  ...reservation,
                  kind: RECONCILIATION_PATH_REFERENCE_KIND.tracked,
                }
              : reservation,
          ),
        }),
      ),
    ).toBe(false);
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation({
          ...operation,
          reservations: [
            required(operation.reservations[0]),
            required(operation.reservations[0]),
          ],
        }),
      ),
    ).toBe(false);
    const valid = stateWithOperation(operation);
    const review = required(valid.reconciliationReviews[0]);
    expect(
      isMirrorDeviceStateConsistent({
        ...valid,
        reconciliationReviews: [
          {
            ...review,
            snapshot: {
              ...review.snapshot,
              paths: [
                ...review.snapshot.paths,
                required(review.snapshot.paths[1]),
              ],
            },
          },
        ],
      }),
    ).toBe(false);
    const singlePathState = stateWithOperation(
      operationFor(RECONCILIATION_ACTION.keepLocal),
    );
    const singlePathReview = required(singlePathState.reconciliationReviews[0]);
    expect(
      isMirrorDeviceStateConsistent({
        ...singlePathState,
        reconciliationReviews: [
          {
            ...singlePathReview,
            snapshot: {
              ...singlePathReview.snapshot,
              paths: operation.snapshot.paths,
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("rejects malformed generations, missing reservations, duplicate receipts, and incompatible effects", () => {
    const keepBoth = operationFor(RECONCILIATION_ACTION.keepBoth);
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation({
          ...keepBoth,
          reservations: [required(keepBoth.reservations[0])],
        }),
      ),
    ).toBe(false);

    const keepLocal = operationFor();
    const receipt = {
      operationId: OPERATION,
      originalPath: SOURCE,
      side: RECONCILIATION_PRESERVATION_SIDE.remote,
      sourceRevision: REVISION,
      contentSha256: HASH,
      preservationPath: `.ai-bridge-conflicts/${OPERATION}/remote.md`,
      proofState: RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
    } as const;
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation({
          ...keepLocal,
          preservationReceipts: [receipt, receipt],
        }),
      ),
    ).toBe(false);
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation({
          ...keepLocal,
          preservationReceipts: [{ ...receipt, operationId: REVIEW }],
        }),
      ),
    ).toBe(false);

    for (const invalid of [
      {
        ...keepLocal,
        phase: RECONCILIATION_OPERATION_PHASE.mutatingLocal,
      },
      {
        ...keepLocal,
        localEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
      },
      {
        ...operationFor(RECONCILIATION_ACTION.useRemote),
        remoteEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
      },
      withPathEvidence(keepLocal, SOURCE, (evidence) => ({
        ...evidence,
        local: {
          kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.live,
          stability: RECONCILIATION_LOCAL_STABILITY.stable,
          observationGeneration: 0,
          byteSize: 1,
          contentSha256: HASH,
        },
      })),
    ] as const) {
      expect(isMirrorDeviceStateConsistent(stateWithOperation(invalid))).toBe(
        false,
      );
    }

    const absent = operationFor(RECONCILIATION_ACTION.acceptTombstone);
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation(
          withPathEvidence(absent, SOURCE, (evidence) => ({
            ...evidence,
            local: {
              kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.absent,
              stability: RECONCILIATION_LOCAL_STABILITY.stable,
              observationGeneration: 0,
            },
          })),
        ),
      ),
    ).toBe(false);
  });

  it("rejects an invalid review-target reservation and a new destination that is already tracked", () => {
    const operation = operationFor();
    const state = stateWithOperation(operation);
    const review = required(state.reconciliationReviews[0]);
    expect(
      isMirrorDeviceStateConsistent({
        ...state,
        reconciliationReviews: [
          {
            ...review,
            snapshot: {
              ...review.snapshot,
              paths: operationFor(RECONCILIATION_ACTION.keepBoth).snapshot
                .paths,
            },
          },
        ],
        reconciliationOperations: [
          {
            ...operation,
            reservations: [
              ...operation.reservations,
              {
                path: DESTINATION,
                kind: RECONCILIATION_PATH_REFERENCE_KIND.reviewTarget,
              },
            ],
          },
        ],
      }),
    ).toBe(false);

    const keepBoth = operationFor(RECONCILIATION_ACTION.keepBoth);
    const trackedDestination = {
      ...required(baseState().paths[0]),
      path: DESTINATION,
    };
    expect(
      isMirrorDeviceStateConsistent({
        ...stateWithOperation(keepBoth),
        paths: [...baseState().paths, trackedDestination],
      }),
    ).toBe(false);
  });

  it("gives unresolved M3 effects and deferred rename state precedence", () => {
    const operation = operationFor();
    const state = stateWithOperation(operation);
    const path = required(state.paths[0]);
    expect(
      isMirrorDeviceStateConsistent({
        ...state,
        paths: [
          {
            ...path,
            unresolvedMutation: {
              intent: {
                action: MUTATION_ACTION.update,
                associationId: ASSOCIATION,
                writerId: DEVICE,
                operationId: required(
                  createMirrorOperationId(
                    "99999999-9999-4999-8999-999999999999",
                  ),
                ),
                path: SOURCE,
                precondition: { kind: "matching-revision", revision: REVISION },
                contentSha256: HASH,
                mutationAttempts: 0,
                evidenceAttempts: 0,
              },
              phase: MIRROR_MUTATION_PHASE.intentPersisted,
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("invalidates every authoritative stale-decision identity dimension", () => {
    const operation = operationFor();
    const snapshot = operation.snapshot;
    const target = required(snapshot.paths[0]);
    if (target.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.live) {
      throw new Error("Expected live remote fixture.");
    }
    if (target.local.kind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.live) {
      throw new Error("Expected live local fixture.");
    }
    const changedSnapshots: readonly ReconciliationReviewSnapshot[] = [
      {
        ...snapshot,
        runtime: {
          ...snapshot.runtime,
          lifecycle: {
            kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
            associationId: ASSOCIATION,
            origin: "https://other.example",
          },
        },
      },
      {
        ...snapshot,
        runtime: { ...snapshot.runtime, deviceId: OTHER_DEVICE },
      },
      {
        ...snapshot,
        runtime: { ...snapshot.runtime, designatedWriterId: OTHER_DEVICE },
      },
      {
        ...snapshot,
        runtime: {
          ...snapshot.runtime,
          lifecycle: {
            kind: MIRROR_DEVICE_LIFECYCLE_KIND.paused,
            associationId: ASSOCIATION,
            origin: "https://bridge.example",
            reason: "manual",
          },
        },
      },
      {
        ...snapshot,
        runtime: { ...snapshot.runtime, listenerEpoch: 2 },
      },
      {
        ...snapshot,
        runtime: { ...snapshot.runtime, configurationGeneration: 2 },
      },
      {
        ...snapshot,
        runtime: { ...snapshot.runtime, runtimeOwnerVersion: 4 },
      },
      {
        ...snapshot,
        paths: [
          {
            ...target,
            remote: {
              ...target.remote,
              receipt: { ...target.remote.receipt, operationId: OPERATION },
            },
          },
        ],
      },
      {
        ...snapshot,
        paths: [
          {
            ...target,
            local: { ...target.local, observationGeneration: 2 },
          },
        ],
      },
      {
        ...snapshot,
        paths: [
          {
            ...target,
            local: { ...target.local, byteSize: 2 },
          },
        ],
      },
      {
        ...snapshot,
        paths: [
          {
            ...target,
            local: { ...target.local, contentSha256: OTHER_HASH },
          },
        ],
      },
      {
        ...snapshot,
        paths: [
          {
            ...target,
            local: {
              kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown,
              stability: RECONCILIATION_LOCAL_STABILITY.unknown,
            },
          },
        ],
      },
      {
        ...snapshot,
        paths: [
          {
            ...target,
            baseline: { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
          },
        ],
      },
      {
        ...snapshot,
        paths: [
          {
            ...target,
            remote: { ...target.remote, revision: OTHER_REVISION },
          },
        ],
      },
      {
        ...snapshot,
        paths: [
          {
            ...target,
            remote: {
              ...target.remote,
              contentSha256: HASH,
              receipt: { ...target.remote.receipt, contentSha256: HASH },
            },
          },
        ],
      },
      {
        ...snapshot,
        targetPath: DESTINATION,
        paths: [
          target,
          {
            path: DESTINATION,
            local: {
              kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.absent,
              stability: RECONCILIATION_LOCAL_STABILITY.stable,
              observationGeneration: 1,
            },
            baseline: { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
            remote: { kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.absent },
            m3: { unresolvedMutation: null, deferredHistory: null },
          },
        ],
      },
      {
        ...snapshot,
        paths: [
          {
            ...target,
            m3: {
              deferredHistory: null,
              unresolvedMutation: {
                intent: {
                  action: MUTATION_ACTION.update,
                  associationId: ASSOCIATION,
                  writerId: DEVICE,
                  operationId: SUCCESSOR_OPERATION,
                  path: SOURCE,
                  precondition: {
                    kind: "matching-revision",
                    revision: REVISION,
                  },
                  contentSha256: HASH,
                  mutationAttempts: 0,
                  evidenceAttempts: 0,
                },
                phase: MIRROR_MUTATION_PHASE.intentPersisted,
              },
            },
          },
        ],
      },
      {
        ...snapshot,
        recovery: {
          kind: RECOVERY_SNAPSHOT_STATE_KIND.prepared,
          id: RECOVERY,
          associationId: ASSOCIATION,
          path: SOURCE,
          revision: REVISION,
          sourceRevision: REVISION,
          contentSha256: HASH,
        },
      },
    ];
    for (const changed of changedSnapshots) {
      expect(reconciliationReviewSnapshotsEqual(snapshot, changed)).toBe(false);
      const state = stateWithOperation(operation);
      expect(
        isMirrorDeviceStateConsistent({
          ...state,
          reconciliationOperations: [{ ...operation, snapshot: changed }],
        }),
      ).toBe(false);
    }
  });

  it("compares complete nested M3 and lifecycle identity rather than object presence", () => {
    const operation = operationFor();
    const target = required(operation.snapshot.paths[0]);
    const unresolved = {
      intent: {
        action: MUTATION_ACTION.update,
        associationId: ASSOCIATION,
        writerId: DEVICE,
        operationId: SUCCESSOR_OPERATION,
        path: SOURCE,
        precondition: { kind: "matching-revision", revision: REVISION },
        contentSha256: HASH,
        mutationAttempts: 0,
        evidenceAttempts: 0,
      },
      phase: MIRROR_MUTATION_PHASE.intentPersisted,
    } as const;
    const withUnresolved = {
      ...operation.snapshot,
      paths: [
        {
          ...target,
          m3: { unresolvedMutation: unresolved, deferredHistory: null },
        },
      ],
    } satisfies ReconciliationReviewSnapshot;
    const changedUnresolved = {
      ...withUnresolved,
      paths: [
        {
          ...required(withUnresolved.paths[0]),
          m3: {
            unresolvedMutation: {
              ...unresolved,
              intent: { ...unresolved.intent, mutationAttempts: 1 },
            },
            deferredHistory: null,
          },
        },
      ],
    } satisfies ReconciliationReviewSnapshot;
    expect(
      reconciliationReviewSnapshotsEqual(withUnresolved, changedUnresolved),
    ).toBe(false);

    const paused = {
      ...operation.snapshot,
      runtime: {
        ...operation.snapshot.runtime,
        lifecycle: {
          kind: MIRROR_DEVICE_LIFECYCLE_KIND.paused,
          associationId: ASSOCIATION,
          origin: "https://bridge.example",
          reason: "manual",
        },
      },
    } satisfies ReconciliationReviewSnapshot;
    expect(
      reconciliationReviewSnapshotsEqual(paused, {
        ...paused,
        runtime: {
          ...paused.runtime,
          lifecycle: {
            ...paused.runtime.lifecycle,
            reason: "persistence-failure",
          },
        },
      }),
    ).toBe(false);
  });

  it("validates canonical recoverable snapshot status metadata", () => {
    const operation = operationFor(RECONCILIATION_ACTION.restoreRecovery);
    const recovery = operation.snapshot.recovery;
    if (
      recovery === null ||
      recovery.kind !== RECOVERY_SNAPSHOT_STATE_KIND.prepared
    ) {
      throw new Error("Expected prepared recovery evidence.");
    }
    const sealed = {
      ...operation,
      snapshot: {
        ...operation.snapshot,
        recovery: {
          kind: RECOVERY_SNAPSHOT_STATE_KIND.sealed,
          id: recovery.id,
          associationId: recovery.associationId,
          path: recovery.path,
          revision: recovery.revision,
          sourceRevision: recovery.sourceRevision,
          contentSha256: recovery.contentSha256,
          recoverUntil: "2030-01-01T00:00:00.000Z",
        },
      },
    } satisfies ReconciliationOperation;
    expect(isMirrorDeviceStateConsistent(stateWithOperation(sealed))).toBe(
      true,
    );
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation({
          ...sealed,
          snapshot: {
            ...sealed.snapshot,
            recovery: {
              ...required(sealed.snapshot.recovery),
              recoverUntil: "not-an-instant",
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it("validates local and legacy preservation receipt identities", () => {
    const localOperation = operationFor(
      RECONCILIATION_ACTION.useRemote,
      RECONCILIATION_OPERATION_PHASE.preserving,
    );
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation({
          ...localOperation,
          preservationReceipts: [
            {
              operationId: OPERATION,
              originalPath: SOURCE,
              side: RECONCILIATION_PRESERVATION_SIDE.local,
              sourceRevision: null,
              contentSha256: HASH,
              preservationPath: `.ai-bridge-conflicts/${OPERATION}/local.md`,
              proofState: RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
            },
          ],
        }),
      ),
    ).toBe(true);
    const legacyOperation = operationFor(
      RECONCILIATION_ACTION.forkLegacy,
      RECONCILIATION_OPERATION_PHASE.preserving,
    );
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation({
          ...legacyOperation,
          preservationReceipts: [
            {
              operationId: OPERATION,
              originalPath: SOURCE,
              side: RECONCILIATION_PRESERVATION_SIDE.remote,
              sourceRevision: null,
              contentSha256: HASH,
              preservationPath: `.ai-bridge-conflicts/${OPERATION}/remote.md`,
              proofState: RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it.each([
    {
      name: "keep-local remote bytes",
      action: RECONCILIATION_ACTION.keepLocal,
      phase: RECONCILIATION_OPERATION_PHASE.mutatingRemote,
      side: RECONCILIATION_PRESERVATION_SIDE.remote,
    },
    {
      name: "use-remote local bytes",
      action: RECONCILIATION_ACTION.useRemote,
      phase: RECONCILIATION_OPERATION_PHASE.mutatingLocal,
      side: RECONCILIATION_PRESERVATION_SIDE.local,
    },
    {
      name: "keep-both competitor bytes",
      action: RECONCILIATION_ACTION.keepBoth,
      phase: RECONCILIATION_OPERATION_PHASE.mutatingLocal,
      side: RECONCILIATION_PRESERVATION_SIDE.remote,
    },
    {
      name: "tombstone recreation local bytes",
      action: RECONCILIATION_ACTION.recreateRemote,
      phase: RECONCILIATION_OPERATION_PHASE.mutatingRemote,
      side: RECONCILIATION_PRESERVATION_SIDE.local,
    },
    {
      name: "legacy fork remote bytes",
      action: RECONCILIATION_ACTION.forkLegacy,
      phase: RECONCILIATION_OPERATION_PHASE.mutatingLocal,
      side: RECONCILIATION_PRESERVATION_SIDE.remote,
    },
    {
      name: "history cleanup remote bytes",
      action: RECONCILIATION_ACTION.resolveHistory,
      phase: RECONCILIATION_OPERATION_PHASE.mutatingRemote,
      side: RECONCILIATION_PRESERVATION_SIDE.remote,
    },
  ] as const)(
    "binds $name to the exact sampled hash and revision",
    ({ action, phase, side }) => {
      const operation = operationFor(action, phase);
      expect(
        isMirrorDeviceStateConsistent(
          stateWithOperation({
            ...operation,
            preservationReceipts: [verifiedReceipt(operation, side)],
          }),
        ),
      ).toBe(true);
    },
  );

  it.each([
    {
      action: RECONCILIATION_ACTION.keepLocal,
      phase: RECONCILIATION_OPERATION_PHASE.mutatingRemote,
    },
    {
      action: RECONCILIATION_ACTION.useRemote,
      phase: RECONCILIATION_OPERATION_PHASE.mutatingLocal,
    },
    {
      action: RECONCILIATION_ACTION.keepBoth,
      phase: RECONCILIATION_OPERATION_PHASE.mutatingLocal,
    },
    {
      action: RECONCILIATION_ACTION.recreateRemote,
      phase: RECONCILIATION_OPERATION_PHASE.mutatingRemote,
    },
    {
      action: RECONCILIATION_ACTION.forkLegacy,
      phase: RECONCILIATION_OPERATION_PHASE.mutatingLocal,
    },
    {
      action: RECONCILIATION_ACTION.resolveHistory,
      phase: RECONCILIATION_OPERATION_PHASE.mutatingRemote,
    },
  ] as const)(
    "rejects missing required preservation for $action",
    ({ action, phase }) => {
      expect(
        isMirrorDeviceStateConsistent(
          stateWithOperation(operationFor(action, phase)),
        ),
      ).toBe(false);
    },
  );

  it.each([
    {
      name: "wrong hash",
      mutate: (receipt: ReturnType<typeof verifiedReceipt>) => ({
        ...receipt,
        contentSha256: receipt.contentSha256 === HASH ? OTHER_HASH : HASH,
      }),
    },
    {
      name: "wrong side",
      mutate: (receipt: ReturnType<typeof verifiedReceipt>) => ({
        ...receipt,
        side: RECONCILIATION_PRESERVATION_SIDE.local,
        sourceRevision: null,
        preservationPath: `.ai-bridge-conflicts/${OPERATION}/local.md`,
      }),
    },
    {
      name: "wrong revision",
      mutate: (receipt: ReturnType<typeof verifiedReceipt>) => ({
        ...receipt,
        sourceRevision: OTHER_REVISION,
      }),
    },
    {
      name: "wrong operation",
      mutate: (receipt: ReturnType<typeof verifiedReceipt>) => ({
        ...receipt,
        operationId: REVIEW,
      }),
    },
    {
      name: "wrong original path",
      mutate: (receipt: ReturnType<typeof verifiedReceipt>) => ({
        ...receipt,
        originalPath: DESTINATION,
      }),
    },
    {
      name: "wrong preservation path",
      mutate: (receipt: ReturnType<typeof verifiedReceipt>) => ({
        ...receipt,
        preservationPath: `.ai-bridge-conflicts/${OPERATION}/unrelated.md`,
      }),
    },
  ])("rejects a verified receipt with $name", ({ mutate }) => {
    const operation = operationFor(
      RECONCILIATION_ACTION.keepLocal,
      RECONCILIATION_OPERATION_PHASE.mutatingRemote,
    );
    const receipt = mutate(
      verifiedReceipt(operation, RECONCILIATION_PRESERVATION_SIDE.remote),
    );
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation({
          ...operation,
          preservationReceipts: [receipt],
        }),
      ),
    ).toBe(false);
  });

  it.each([
    {
      name: "legacy fork",
      action: RECONCILIATION_ACTION.forkLegacy,
      phase: RECONCILIATION_OPERATION_PHASE.mutatingLocal,
      side: RECONCILIATION_PRESERVATION_SIDE.remote,
    },
    {
      name: "recovery restore",
      action: RECONCILIATION_ACTION.restoreRecovery,
      phase: RECONCILIATION_OPERATION_PHASE.mutatingLocal,
      side: RECONCILIATION_PRESERVATION_SIDE.local,
    },
    {
      name: "history cleanup",
      action: RECONCILIATION_ACTION.resolveHistory,
      phase: RECONCILIATION_OPERATION_PHASE.mutatingRemote,
      side: RECONCILIATION_PRESERVATION_SIDE.remote,
    },
  ] as const)(
    "rejects a $name receipt with a hash not bound to sampled bytes",
    ({ action, phase, side }) => {
      const operation = operationFor(action, phase);
      expect(
        isMirrorDeviceStateConsistent(
          stateWithOperation({
            ...operation,
            preservationReceipts: [
              {
                ...verifiedReceipt(operation, side),
                contentSha256:
                  verifiedReceipt(operation, side).contentSha256 === HASH
                    ? OTHER_HASH
                    : HASH,
              },
            ],
          }),
        ),
      ).toBe(false);
    },
  );

  it("rejects a verified receipt when sampled evidence cannot establish exact bytes", () => {
    const operation = operationFor(
      RECONCILIATION_ACTION.acceptTombstone,
      RECONCILIATION_OPERATION_PHASE.admitted,
    );
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation({
          ...operation,
          preservationReceipts: [
            {
              operationId: OPERATION,
              originalPath: SOURCE,
              side: RECONCILIATION_PRESERVATION_SIDE.remote,
              sourceRevision: REVISION,
              contentSha256: HASH,
              preservationPath: `.ai-bridge-conflicts/${OPERATION}/remote.md`,
              proofState: RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("keeps a confirmed restore durably fenced until an active reviewed successor takes ownership", () => {
    const initialRestore = operationFor(
      RECONCILIATION_ACTION.restoreRecovery,
      RECONCILIATION_OPERATION_PHASE.restoredPendingReview,
    );
    const collision = {
      ...initialRestore,
      snapshot: {
        ...initialRestore.snapshot,
        paths: [required(initialRestore.snapshot.paths[0])],
      },
      destinationPath: null,
      reservations: [required(initialRestore.reservations[0])],
    } satisfies ReconciliationOperation;
    expect(isMirrorDeviceStateConsistent(stateWithOperation(collision))).toBe(
      false,
    );

    const restore = {
      ...collision,
      preservationReceipts: [
        verifiedReceipt(collision, RECONCILIATION_PRESERVATION_SIDE.local),
      ],
      localEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
    } satisfies ReconciliationOperation;
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation({
          ...restore,
          localEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
        }),
      ),
    ).toBe(true);

    const pendingState = stateWithOperation(restore);
    const dirtyPath = {
      ...required(pendingState.paths[0]),
      desired: {
        kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent,
        observationGeneration: 2,
      },
    } as const;
    expect(
      isMirrorDeviceStateConsistent({ ...pendingState, paths: [dirtyPath] }),
    ).toBe(true);
    expect(
      isMirrorDeviceStateConsistent({
        ...pendingState,
        lifecycle: {
          kind: MIRROR_DEVICE_LIFECYCLE_KIND.handoffDrained,
          associationId: ASSOCIATION,
          origin: "https://bridge.example",
        },
      }),
    ).toBe(false);

    const terminalWithoutOwner: ReconciliationOperation = {
      ...restore,
      phase: RECONCILIATION_OPERATION_PHASE.completed,
    };
    expect(
      isMirrorDeviceStateConsistent(stateWithOperation(terminalWithoutOwner)),
    ).toBe(false);

    const successorTemplate = operationFor(RECONCILIATION_ACTION.keepLocal);
    const successor: ReconciliationOperation = {
      ...successorTemplate,
      operationId: SUCCESSOR_OPERATION,
      reviewId: SUCCESSOR_REVIEW,
      snapshot: {
        ...successorTemplate.snapshot,
        paths: successorTemplate.snapshot.paths.map((evidence) =>
          evidence.path === SOURCE &&
          evidence.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live
            ? {
                ...evidence,
                local: { ...evidence.local, observationGeneration: 2 },
              }
            : evidence,
        ),
      },
      preservationReceipts: [],
    };
    const completedRestore: ReconciliationOperation = {
      ...restore,
      phase: RECONCILIATION_OPERATION_PHASE.completed,
      successorOperationId: SUCCESSOR_OPERATION,
    };
    const restoredState = stateWithOperation(completedRestore);
    const successorReview: ReconciliationReview = {
      retention: RECONCILIATION_REVIEW_RETENTION.durable,
      reviewId: SUCCESSOR_REVIEW,
      classification: RECONCILIATION_CLASSIFICATION.bothChanged,
      status: RECONCILIATION_REVIEW_STATUS.staged,
      snapshot: successor.snapshot,
      operationId: SUCCESSOR_OPERATION,
    };
    const staleSuccessor = {
      ...successor,
      snapshot: successorTemplate.snapshot,
    } satisfies ReconciliationOperation;
    expect(
      isMirrorDeviceStateConsistent({
        ...restoredState,
        reconciliationReviews: [
          required(restoredState.reconciliationReviews[0]),
          { ...successorReview, snapshot: staleSuccessor.snapshot },
        ],
        reconciliationOperations: [completedRestore, staleSuccessor],
      }),
    ).toBe(false);
    expect(
      isMirrorDeviceStateConsistent({
        ...restoredState,
        reconciliationReviews: [
          required(restoredState.reconciliationReviews[0]),
          successorReview,
        ],
        reconciliationOperations: [completedRestore, successor],
      }),
    ).toBe(true);
  });

  it("permits exact revision adoption without preservation only when no competitor is replaced", () => {
    const adoption = operationFor(RECONCILIATION_ACTION.adoptRevision);
    expect(isMirrorDeviceStateConsistent(stateWithOperation(adoption))).toBe(
      true,
    );
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation({
          ...adoption,
          preservationReceipts: [
            verifiedReceipt(
              operationFor(RECONCILIATION_ACTION.keepLocal),
              RECONCILIATION_PRESERVATION_SIDE.remote,
            ),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("rejects impossible review-operation and lifecycle relationships", () => {
    const state = stateWithOperation(operationFor());
    const operation = required(state.reconciliationOperations[0]);
    const otherReviewId = required(
      createMirrorOperationId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    );
    expect(
      isMirrorDeviceStateConsistent({
        ...state,
        reconciliationOperations: [{ ...operation, reviewId: otherReviewId }],
      }),
    ).toBe(false);
    expect(
      isMirrorDeviceStateConsistent({
        ...state,
        lifecycle: { kind: MIRROR_DEVICE_LIFECYCLE_KIND.disabled },
        paths: [],
      }),
    ).toBe(false);
    const review = required(state.reconciliationReviews[0]);
    expect(
      isMirrorDeviceStateConsistent({
        ...baseState(),
        reconciliationReviews: [
          {
            ...review,
            status: RECONCILIATION_REVIEW_STATUS.completed,
          },
        ],
      }),
    ).toBe(false);
  });

  it("allows only an explicit history operation to coexist with deferred rename evidence", () => {
    const initial = stateWithOperation(operationFor());
    const pathState = required(initial.paths[0]);
    const deferredPath = {
      ...pathState,
      desired: {
        kind: MIRROR_DESIRED_STATE_KIND.renameDeferred,
        observationGeneration: 2,
        renameId: required(
          createMirrorOperationId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
        ),
        associationId: ASSOCIATION,
        sourcePath: SOURCE,
        destinationPath: DESTINATION,
        sourceExpectedRevision: REVISION,
        destinationObservationGeneration: 2,
        destinationAcknowledgedRevision: null,
        graceDeadlineMilliseconds: 10,
        phase: MIRROR_RENAME_PHASE.destinationRequired,
      },
    } as const;
    expect(
      isMirrorDeviceStateConsistent({ ...initial, paths: [deferredPath] }),
    ).toBe(false);

    const historyOperation = operationFor(RECONCILIATION_ACTION.resolveHistory);
    const historyState = stateWithOperation(historyOperation);
    const historyReview = required(historyState.reconciliationReviews[0]);
    expect(
      isMirrorDeviceStateConsistent({
        ...historyState,
        paths: [deferredPath],
        reconciliationReviews: [
          {
            ...historyReview,
            classification: RECONCILIATION_CLASSIFICATION.deferredHistory,
          },
        ],
      }),
    ).toBe(true);
  });

  it("enforces the global sparse-review capacity", () => {
    const template: ReconciliationReview = {
      retention: RECONCILIATION_REVIEW_RETENTION.durable,
      reviewId: REVIEW,
      classification: RECONCILIATION_CLASSIFICATION.aligned,
      status: RECONCILIATION_REVIEW_STATUS.pending,
      snapshot: operationFor().snapshot,
      operationId: null,
    };
    const reviews = Array.from(
      { length: MAX_RECONCILIATION_REVIEWS + 1 },
      (_, index): ReconciliationReview => ({
        ...template,
        reviewId: required(
          createMirrorOperationId(
            `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
          ),
        ),
      }),
    );
    expect(
      isMirrorDeviceStateConsistent({
        ...baseState(),
        reconciliationReviews: reviews,
      }),
    ).toBe(false);
  });
});
