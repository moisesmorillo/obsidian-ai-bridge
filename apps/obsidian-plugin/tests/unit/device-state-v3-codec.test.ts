import {
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  createRecoverySnapshotId,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
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
  type ReconciliationRemoteEvidence,
} from "@obsidian-ai-bridge/core";
import {
  decodeMirrorDeviceState,
  encodeMirrorDeviceState,
  MAX_MIRROR_DEVICE_STATE_BYTES,
} from "@obsidian-plugin/state/device-state-codec";
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
const HASH = required(createContentSha256("ab".repeat(32)));
const PATH = required(normalizeNotePath("notes/reviewed.md"));

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
        localEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
        remoteEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
      },
    ],
  };
}

describe("version-3 device-state codec", () => {
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
              operationId: OPERATION,
              originalPath: PATH,
              side: RECONCILIATION_PRESERVATION_SIDE.local,
              sourceRevision: null,
              contentSha256: HASH,
              preservationPath: `.ai-bridge-conflicts/${OPERATION}/local.md`,
              proofState: RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
            },
          ],
          localEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
        },
      ],
    };
    const encoded = encodeMirrorDeviceState(fenced);
    await expect(decodeMirrorDeviceState(encoded)).resolves.toEqual({
      kind: "valid",
      state: fenced,
    });

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
});
