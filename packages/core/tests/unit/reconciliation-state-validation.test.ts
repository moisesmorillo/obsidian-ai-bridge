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
  RECONCILIATION_OPERATION_PHASE,
  RECONCILIATION_PATH_REFERENCE_KIND,
  RECONCILIATION_PRESERVATION_PROOF_STATE,
  RECONCILIATION_PRESERVATION_SIDE,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
  RECONCILIATION_REVIEW_RETENTION,
  RECONCILIATION_REVIEW_STATUS,
  type ReconciliationAction,
  type ReconciliationOperation,
  type ReconciliationOperationPhase,
  type ReconciliationReview,
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
const RECOVERY = required(
  createRecoverySnapshotId("66666666-6666-4666-8666-666666666666"),
);
const HASH = required(createContentSha256("ab".repeat(32)));
const OTHER_HASH = required(createContentSha256("cd".repeat(32)));
const SOURCE = required(normalizeNotePath("notes/source.md"));
const DESTINATION = required(normalizeNotePath("notes/destination.md"));

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
  const remote =
    kind === RECONCILIATION_ACTION.acceptTombstone ||
    kind === RECONCILIATION_ACTION.recreateRemote
      ? {
          kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone,
          associationId: ASSOCIATION,
          revision: REVISION,
          recoveryId: RECOVERY,
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
            contentSha256: HASH,
          };
  const local =
    kind === RECONCILIATION_ACTION.acceptTombstone
      ? {
          kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.absent,
          observationGeneration: 1,
        }
      : {
          kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.live,
          observationGeneration: 1,
          contentSha256: HASH,
        };
  return {
    operationId: OPERATION,
    reviewId: REVIEW,
    authority: authorityFor(kind),
    action: actionFor(kind),
    phase,
    sourcePath: SOURCE,
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
    evidence: {
      local,
      baseline: {
        kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
        revision: REVISION,
        contentSha256: HASH,
      },
      remote,
    },
    recovery:
      kind === RECONCILIATION_ACTION.restoreRecovery
        ? { recoveryId: RECOVERY, revision: REVISION, contentSha256: HASH }
        : null,
    preservationReceipts: [],
    localEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
    remoteEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
  };
}

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
    targetPath: SOURCE,
    relatedPaths: [],
    classification: classificationForAction(operation.action.kind),
    status,
    evidence: operation.evidence,
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
      const review: ReconciliationReview = {
        retention: RECONCILIATION_REVIEW_RETENTION.durable,
        reviewId: REVIEW,
        targetPath: SOURCE,
        relatedPaths: [],
        classification,
        status: RECONCILIATION_REVIEW_STATUS.pending,
        evidence: operationFor().evidence,
        operationId: null,
      };
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

  it.each(Object.values(RECONCILIATION_OPERATION_PHASE))(
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
                    operationId: OPERATION,
                    originalPath: SOURCE,
                    side: RECONCILIATION_PRESERVATION_SIDE.remote,
                    sourceRevision: REVISION,
                    contentSha256: HASH,
                    preservationPath: `.ai-bridge-conflicts/${OPERATION}/remote.md`,
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
            operationId: OPERATION,
            originalPath: SOURCE,
            side: RECONCILIATION_PRESERVATION_SIDE.remote,
            sourceRevision: REVISION,
            contentSha256: HASH,
            preservationPath: `.ai-bridge-conflicts/${OPERATION}/remote.md`,
            proofState,
          },
        ],
      };
      expect(
        isMirrorDeviceStateConsistent(stateWithOperation(withReceipt)),
      ).toBe(true);
    },
  );

  it("accepts local-missing import and tombstoned keep-both relationships", () => {
    const localMissingImport = operationFor(RECONCILIATION_ACTION.useRemote);
    const importState = stateWithOperation({
      ...localMissingImport,
      evidence: {
        ...localMissingImport.evidence,
        local: {
          kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.absent,
          observationGeneration: 2,
        },
      },
    });
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
          destinationPath: null,
          reservations: [required(originalPathRestore.reservations[0])],
        }),
      ),
    ).toBe(true);

    const tombstoneKeepBoth = operationFor(RECONCILIATION_ACTION.keepBoth);
    const keepBothState = stateWithOperation({
      ...tombstoneKeepBoth,
      action: {
        kind: RECONCILIATION_ACTION.keepBoth,
        primarySide: RECONCILIATION_PRESERVATION_SIDE.remote,
      },
      evidence: {
        ...tombstoneKeepBoth.evidence,
        remote: {
          kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone,
          associationId: ASSOCIATION,
          revision: REVISION,
          recoveryId: RECOVERY,
        },
      },
    });
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
        stateWithOperation({
          ...operation,
          evidence: {
            ...operation.evidence,
            remote: {
              kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
              associationId: FOREIGN_ASSOCIATION,
              revision: REVISION,
              contentSha256: HASH,
            },
          },
        }),
      ),
    ).toBe(false);
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
        stateWithOperation({
          ...completedKeepLocal,
          evidence: {
            ...completedKeepLocal.evidence,
            remote: {
              kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
              associationId: ASSOCIATION,
              revision: REVISION,
              contentSha256: OTHER_HASH,
            },
          },
        }),
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
          { ...review, relatedPaths: [DESTINATION, DESTINATION] },
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
          { ...singlePathReview, relatedPaths: [DESTINATION] },
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
      {
        ...keepLocal,
        evidence: {
          ...keepLocal.evidence,
          local: {
            kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.live,
            observationGeneration: 0,
            contentSha256: HASH,
          },
        },
      },
    ] as const) {
      expect(isMirrorDeviceStateConsistent(stateWithOperation(invalid))).toBe(
        false,
      );
    }

    const absent = operationFor(RECONCILIATION_ACTION.acceptTombstone);
    expect(
      isMirrorDeviceStateConsistent(
        stateWithOperation({
          ...absent,
          evidence: {
            ...absent.evidence,
            local: {
              kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.absent,
              observationGeneration: 0,
            },
          },
        }),
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
        reconciliationReviews: [{ ...review, relatedPaths: [DESTINATION] }],
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

  it("compares every closed local, baseline, and remote evidence variant semantically", () => {
    const evidenceVariants: readonly ReconciliationOperation["evidence"][] = [
      {
        local: { kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown },
        baseline: { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
        remote: { kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.unavailable },
      },
      {
        local: {
          kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.absent,
          observationGeneration: 2,
        },
        baseline: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
          revision: REVISION,
          recoveryId: RECOVERY,
        },
        remote: { kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.absent },
      },
      {
        local: {
          kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.live,
          observationGeneration: 3,
          contentSha256: HASH,
        },
        baseline: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision: REVISION,
          contentSha256: HASH,
        },
        remote: {
          kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy,
          contentSha256: HASH,
        },
      },
      {
        local: {
          kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.live,
          observationGeneration: 4,
          contentSha256: HASH,
        },
        baseline: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision: REVISION,
          contentSha256: HASH,
        },
        remote: {
          kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone,
          associationId: ASSOCIATION,
          revision: REVISION,
          recoveryId: RECOVERY,
        },
      },
    ];
    for (const evidence of evidenceVariants) {
      const operation: ReconciliationOperation = {
        ...operationFor(RECONCILIATION_ACTION.resolveHistory),
        evidence,
      };
      expect(isMirrorDeviceStateConsistent(stateWithOperation(operation))).toBe(
        true,
      );
    }
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
      targetPath: SOURCE,
      relatedPaths: [],
      classification: RECONCILIATION_CLASSIFICATION.aligned,
      status: RECONCILIATION_REVIEW_STATUS.pending,
      evidence: operationFor().evidence,
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
