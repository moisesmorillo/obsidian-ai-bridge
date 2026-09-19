import {
  activateIsolatedAssociation,
  activateStagedHandoff,
  alignAndActivateStagedHandoff,
  alignStagedHandoff,
  createApplicationRevision,
  createContentSha256,
  createDisabledMirrorState,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  evaluateWriterReadiness,
  HANDOFF_ALIGNMENT_KIND,
  HANDOFF_EXPORT_FAILURE,
  type HandoffAlignmentSnapshot,
  type HandoffRecord,
  invalidateHandoffAlignments,
  isDurableMutationAdmissionAllowed,
  LOCAL_EFFECT_OBSERVATION_KIND,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_PAUSE_REASON,
  type MirrorDeviceState,
  MUTATION_ACTION,
  MUTATION_EFFECT_CERTAINTY,
  markHandoffDrained,
  normalizeNotePath,
  pauseForHandoff,
  pauseMirrorWriter,
  prepareHandoffExport,
  RECONCILIATION_ACTION,
  RECONCILIATION_AUTHORITY_SOURCE,
  RECONCILIATION_CLASSIFICATION,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_LOCAL_STABILITY,
  RECONCILIATION_OPERATION_PHASE,
  RECONCILIATION_PATH_REFERENCE_KIND,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
  RECONCILIATION_REVIEW_RETENTION,
  RECONCILIATION_REVIEW_STATUS,
  resumeMirrorWriter,
  stageHandoffImport,
  type TransferableAcknowledgement,
  WRITER_ACTIVATION_FAILURE,
} from "@obsidian-ai-bridge/core";
import { describe, expect, it } from "vitest";

const DEVICE_ID = required(
  createMirrorWriterId("11111111-1111-4111-8111-111111111111"),
);
const OTHER_DEVICE_ID = required(
  createMirrorWriterId("99999999-9999-4999-8999-999999999999"),
);
const ASSOCIATION_ID = required(
  createMirrorAssociationId("22222222-2222-4222-8222-222222222222"),
);
const OTHER_ASSOCIATION_ID = required(
  createMirrorAssociationId("88888888-8888-4888-8888-888888888888"),
);
const OPERATION_ID = required(
  createMirrorOperationId("33333333-3333-4333-8333-333333333333"),
);
const REVIEW_ID = required(
  createMirrorOperationId("77777777-7777-4777-8777-777777777777"),
);
const LIVE_REVISION = required(
  createApplicationRevision("44444444-4444-4444-8444-444444444444"),
);
const TOMBSTONE_REVISION = required(
  createApplicationRevision("55555555-5555-4555-8555-555555555555"),
);
const LIVE_HASH = required(createContentSha256("ab".repeat(32)));
const STALE_HASH = required(createContentSha256("cd".repeat(32)));
const CHECKSUM = required(createContentSha256("ef".repeat(32)));
const LIVE_PATH = required(normalizeNotePath("notes/live.md"));
const TOMBSTONE_PATH = required(normalizeNotePath("notes/deleted.md"));
const ORIGIN = "https://bridge.example";

function designation(
  overrides: Partial<{
    associationId: typeof ASSOCIATION_ID;
    designatedWriterId: typeof DEVICE_ID;
    secretAvailable: boolean;
  }> = {},
) {
  return {
    origin: ORIGIN,
    associationId: overrides.associationId ?? ASSOCIATION_ID,
    designatedWriterId: overrides.designatedWriterId ?? DEVICE_ID,
    secretAvailable: overrides.secretAvailable ?? true,
  };
}

function activeState(): MirrorDeviceState {
  return {
    ...createDisabledMirrorState(DEVICE_ID),
    lifecycle: {
      kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
      associationId: ASSOCIATION_ID,
      origin: ORIGIN,
    },
  };
}

function handoffRecord(): HandoffRecord {
  return {
    associationId: ASSOCIATION_ID,
    origin: ORIGIN,
    checksum: CHECKSUM,
    entries: [
      {
        path: LIVE_PATH,
        acknowledgement: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision: LIVE_REVISION,
          contentSha256: LIVE_HASH,
        },
      },
      {
        path: TOMBSTONE_PATH,
        acknowledgement: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
          revision: TOMBSTONE_REVISION,
          recoveryId: OPERATION_ID,
        },
      },
    ],
  };
}

describe("writer activation policy", () => {
  it("starts disabled and cannot become ready from synced preferences or missing local identity", () => {
    const state = createDisabledMirrorState(DEVICE_ID);
    expect(state.lifecycle.kind).toBe(MIRROR_DEVICE_LIFECYCLE_KIND.disabled);
    expect(evaluateWriterReadiness(null, designation())).toEqual({
      kind: "not-ready",
      reason: WRITER_ACTIVATION_FAILURE.missingLocalState,
    });
    expect(evaluateWriterReadiness(state, designation())).toEqual({
      kind: "not-ready",
      reason: WRITER_ACTIVATION_FAILURE.incompatibleLifecycle,
    });
  });

  it("rejects missing secret, wrong designation, and implicit activation", () => {
    const state = createDisabledMirrorState(DEVICE_ID);
    expect(
      activateIsolatedAssociation(state, {
        ...designation({ secretAvailable: false }),
        explicitWholeMirrorConsent: true,
        isolatedEmptyAssociationConfirmed: true,
      }),
    ).toMatchObject({
      kind: "rejected",
      reason: WRITER_ACTIVATION_FAILURE.secretMissing,
    });
    expect(
      activateIsolatedAssociation(state, {
        ...designation({ designatedWriterId: OTHER_DEVICE_ID }),
        explicitWholeMirrorConsent: true,
        isolatedEmptyAssociationConfirmed: true,
      }),
    ).toMatchObject({
      kind: "rejected",
      reason: WRITER_ACTIVATION_FAILURE.designationMismatch,
    });
    expect(
      activateIsolatedAssociation(state, {
        ...designation(),
        explicitWholeMirrorConsent: false,
        isolatedEmptyAssociationConfirmed: true,
      }),
    ).toMatchObject({
      kind: "rejected",
      reason: WRITER_ACTIVATION_FAILURE.notExplicit,
    });
  });

  it("refuses readiness and activation while device-local state is globally blocked", () => {
    const blockedActive: MirrorDeviceState = {
      ...activeState(),
      globalBlockReason: "configuration-unavailable",
    };
    expect(evaluateWriterReadiness(blockedActive, designation())).toEqual({
      kind: "not-ready",
      reason: WRITER_ACTIVATION_FAILURE.globallyBlocked,
    });
    const blockedDisabled: MirrorDeviceState = {
      ...createDisabledMirrorState(DEVICE_ID),
      globalBlockReason: "persistence-failed",
    };
    expect(
      activateIsolatedAssociation(blockedDisabled, {
        ...designation(),
        explicitWholeMirrorConsent: true,
        isolatedEmptyAssociationConfirmed: true,
      }),
    ).toMatchObject({
      kind: "rejected",
      reason: WRITER_ACTIVATION_FAILURE.globallyBlocked,
    });
  });

  it("activates only a locally explicit writer for a proven isolated empty association", () => {
    const rejected = activateIsolatedAssociation(
      createDisabledMirrorState(DEVICE_ID),
      {
        ...designation(),
        explicitWholeMirrorConsent: true,
        isolatedEmptyAssociationConfirmed: false,
      },
    );
    expect(rejected).toMatchObject({
      kind: "rejected",
      reason: WRITER_ACTIVATION_FAILURE.associationNotProvenEmpty,
    });
    const activated = activateIsolatedAssociation(
      createDisabledMirrorState(DEVICE_ID),
      {
        ...designation(),
        explicitWholeMirrorConsent: true,
        isolatedEmptyAssociationConfirmed: true,
      },
    );
    expect(activated.kind).toBe("activated");
    if (activated.kind !== "activated") throw new Error("Expected activation.");
    expect(evaluateWriterReadiness(activated.state, designation())).toEqual({
      kind: "ready",
    });
  });
});

describe("handoff policy", () => {
  it("blocks export for unresolved mutation and unsafe desired/rename evidence", () => {
    const paused = required(pauseForHandoff(activeState()));
    const withIntent: MirrorDeviceState = {
      ...paused,
      paths: [
        {
          path: LIVE_PATH,
          acknowledgement: handoffRecord().entries[0]?.acknowledgement ?? {
            kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated,
          },
          unresolvedMutation: {
            intent: {
              action: MUTATION_ACTION.update,
              associationId: ASSOCIATION_ID,
              writerId: DEVICE_ID,
              operationId: OPERATION_ID,
              path: LIVE_PATH,
              precondition: {
                kind: "matching-revision",
                revision: LIVE_REVISION,
              },
              contentSha256: LIVE_HASH,
              mutationAttempts: 2,
              evidenceAttempts: 1,
            },
            phase: "evidence-required",
          },
          desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
          blockedReason: null,
        },
      ],
    };
    expect(markHandoffDrained(withIntent)).toMatchObject({
      kind: "rejected",
      reason: "unresolved-mutation",
    });
    const withRename: MirrorDeviceState = {
      ...withIntent,
      paths: withIntent.paths.map((entry) => ({
        ...entry,
        unresolvedMutation: null,
        desired: {
          kind: MIRROR_DESIRED_STATE_KIND.renameDeferred,
          observationGeneration: 4,
          renameId: OPERATION_ID,
          associationId: ASSOCIATION_ID,
          sourcePath: LIVE_PATH,
          destinationPath: TOMBSTONE_PATH,
          sourceExpectedRevision: LIVE_REVISION,
          destinationObservationGeneration: 5,
          destinationAcknowledgedRevision: TOMBSTONE_REVISION,
          graceDeadlineMilliseconds: 5_000,
          phase: "source-cleanup-required" as const,
        },
      })),
    };
    expect(markHandoffDrained(withRename)).toMatchObject({
      kind: "rejected",
      reason: "unsettled-desired-state",
    });
  });

  it("blocks handoff drain/export while an M4 operation remains active", () => {
    const snapshot = {
      runtime: {
        runtimeOwnerVersion: 3,
        configurationGeneration: 1,
        listenerEpoch: 1,
        deviceId: DEVICE_ID,
        designatedWriterId: DEVICE_ID,
        lifecycle: {
          kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
          associationId: ASSOCIATION_ID,
          origin: ORIGIN,
        },
      },
      targetPath: LIVE_PATH,
      paths: [
        {
          path: LIVE_PATH,
          local: {
            kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.live,
            stability: RECONCILIATION_LOCAL_STABILITY.stable,
            observationGeneration: 1,
            byteSize: 1,
            contentSha256: LIVE_HASH,
          },
          baseline: { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
          remote: {
            kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
            associationId: ASSOCIATION_ID,
            revision: LIVE_REVISION,
            contentSha256: LIVE_HASH,
            receipt: {
              action: MUTATION_ACTION.create,
              associationId: ASSOCIATION_ID,
              operationId: OPERATION_ID,
              precondition: { kind: "absent" },
              contentSha256: LIVE_HASH,
            },
          },
          m3: { unresolvedMutation: null, deferredHistory: null },
        },
      ],
      recovery: null,
    } as const;
    const active: MirrorDeviceState = {
      ...activeState(),
      reconciliationReviews: [
        {
          retention: RECONCILIATION_REVIEW_RETENTION.durable,
          reviewId: REVIEW_ID,
          classification: RECONCILIATION_CLASSIFICATION.bothChanged,
          status: RECONCILIATION_REVIEW_STATUS.staged,
          snapshot,
          operationId: OPERATION_ID,
        },
      ],
      reconciliationOperations: [
        {
          operationId: OPERATION_ID,
          reviewId: REVIEW_ID,
          authority: RECONCILIATION_AUTHORITY_SOURCE.reconciliationDecision,
          action: { kind: RECONCILIATION_ACTION.keepLocal },
          phase: RECONCILIATION_OPERATION_PHASE.admitted,
          snapshot,
          destinationPath: null,
          reservations: [
            {
              path: LIVE_PATH,
              kind: RECONCILIATION_PATH_REFERENCE_KIND.reviewTarget,
            },
          ],
          preservationReceipts: [],
          successorOperationId: null,
          localEffectObservation: {
            kind: LOCAL_EFFECT_OBSERVATION_KIND.notStarted,
          },
          localEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
          remoteEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
        },
      ],
    };
    const draining = required(pauseForHandoff(active));
    expect(markHandoffDrained(draining)).toEqual({
      kind: "rejected",
      reason: HANDOFF_EXPORT_FAILURE.activeReconciliationOperation,
    });
    expect(
      prepareHandoffExport({
        ...draining,
        lifecycle: {
          kind: MIRROR_DEVICE_LIFECYCLE_KIND.handoffDrained,
          associationId: ASSOCIATION_ID,
          origin: ORIGIN,
        },
      }),
    ).toEqual({
      kind: "rejected",
      reason: HANDOFF_EXPORT_FAILURE.activeReconciliationOperation,
    });
  });

  it("exports only established content-free ACK metadata from a paused/drained writer", () => {
    const paused = required(pauseForHandoff(activeState()));
    const record = handoffRecord();
    const state: MirrorDeviceState = {
      ...paused,
      paths: record.entries.map((entry) => ({
        path: entry.path,
        acknowledgement: entry.acknowledgement,
        unresolvedMutation: null,
        desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
        blockedReason: null,
      })),
    };
    expect(prepareHandoffExport(state)).toMatchObject({
      kind: "rejected",
      reason: "not-drained",
    });
    const drained = markHandoffDrained(state);
    expect(drained.kind).toBe("drained");
    if (drained.kind !== "drained") throw new Error("Expected drained state.");
    const exported = prepareHandoffExport(drained.state);
    expect(exported).toEqual({
      kind: "prepared",
      payload: {
        origin: ORIGIN,
        associationId: ASSOCIATION_ID,
        entries: record.entries,
      },
    });
    expect(JSON.stringify(exported)).not.toMatch(
      /deviceId|activation|secret|token|body|content"/i,
    );
    expect(drained.state.lifecycle.kind).toBe(
      MIRROR_DEVICE_LIFECYCLE_KIND.handoffDrained,
    );
  });

  it("rejects duplicate recovery import, wrong association, and active overwrite", () => {
    const record = handoffRecord();
    const tombstone = required(record.entries[1]);
    expect(
      stageHandoffImport(
        createDisabledMirrorState(DEVICE_ID),
        {
          ...record,
          entries: [tombstone, { ...tombstone, path: LIVE_PATH }],
        },
        {
          associationId: ASSOCIATION_ID,
          origin: ORIGIN,
          initialObservationGeneration: 1,
        },
      ),
    ).toMatchObject({ kind: "rejected", reason: "invalid-record" });
    expect(
      stageHandoffImport(
        createDisabledMirrorState(DEVICE_ID),
        handoffRecord(),
        {
          associationId: OTHER_ASSOCIATION_ID,
          origin: ORIGIN,
          initialObservationGeneration: 1,
        },
      ),
    ).toMatchObject({ kind: "rejected", reason: "association-mismatch" });
    expect(
      stageHandoffImport(activeState(), handoffRecord(), {
        associationId: ASSOCIATION_ID,
        origin: ORIGIN,
        initialObservationGeneration: 1,
      }),
    ).toMatchObject({ kind: "rejected", reason: "incompatible-lifecycle" });
  });

  it("preserves unrelated global blocks through staging and refuses activation", () => {
    const blocked: MirrorDeviceState = {
      ...createDisabledMirrorState(DEVICE_ID),
      globalBlockReason: "configuration-unavailable",
    };
    const imported = stageHandoffImport(blocked, handoffRecord(), {
      associationId: ASSOCIATION_ID,
      origin: ORIGIN,
      initialObservationGeneration: 1,
    });
    expect(imported.kind).toBe("staged");
    if (imported.kind !== "staged") throw new Error("Expected staged handoff.");
    expect(imported.state.globalBlockReason).toBe("configuration-unavailable");
    const aligned = required(
      alignStagedHandoff(
        imported.state,
        handoffAlignmentSnapshot(STALE_HASH, false, 1),
      ),
    );
    expect(aligned.globalBlockReason).toBe("configuration-unavailable");
    expect(
      activateStagedHandoff(aligned, {
        ...designation(),
        explicitWholeMirrorConsent: true,
      }),
    ).toMatchObject({
      kind: "rejected",
      reason: WRITER_ACTIVATION_FAILURE.globallyBlocked,
    });
  });

  it("requires a real positive initial handoff observation generation", () => {
    expect(
      stageHandoffImport(
        createDisabledMirrorState(DEVICE_ID),
        handoffRecord(),
        {
          associationId: ASSOCIATION_ID,
          origin: ORIGIN,
          initialObservationGeneration: 0,
        },
      ),
    ).toMatchObject({ kind: "rejected", reason: "invalid-record" });
  });

  it("aligns and activates one exact sampled generation atomically", () => {
    const imported = stageHandoffImport(
      createDisabledMirrorState(DEVICE_ID),
      handoffRecord(),
      {
        associationId: ASSOCIATION_ID,
        origin: ORIGIN,
        initialObservationGeneration: 1,
      },
    );
    if (imported.kind !== "staged") throw new Error("Expected staged handoff.");
    const activation = {
      ...designation(),
      explicitWholeMirrorConsent: true,
    };
    expect(
      alignAndActivateStagedHandoff(
        imported.state,
        handoffAlignmentSnapshot(LIVE_HASH, true, 1),
        activation,
      )?.state.lifecycle.kind,
    ).toBe(MIRROR_DEVICE_LIFECYCLE_KIND.active);
    const invalidated = invalidateHandoffAlignments(imported.state, [
      { path: LIVE_PATH, observationGeneration: 2 },
    ]);
    expect(
      invalidated === undefined
        ? undefined
        : alignAndActivateStagedHandoff(
            invalidated,
            handoffAlignmentSnapshot(LIVE_HASH, true, 1),
            activation,
          ),
    ).toBeUndefined();
  });

  it("aligns a complete handoff atomically and rejects stale snapshots", () => {
    const imported = stageHandoffImport(
      createDisabledMirrorState(DEVICE_ID),
      handoffRecord(),
      {
        associationId: ASSOCIATION_ID,
        origin: ORIGIN,
        initialObservationGeneration: 1,
      },
    );
    if (imported.kind !== "staged") throw new Error("Expected staged handoff.");
    expect(imported.state.lifecycle.kind).toBe(
      MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged,
    );
    expect(
      activateStagedHandoff(imported.state, {
        ...designation(),
        explicitWholeMirrorConsent: true,
      }),
    ).toMatchObject({
      kind: "rejected",
      reason: WRITER_ACTIVATION_FAILURE.handoffNotAligned,
    });

    const mismatched = required(
      alignStagedHandoff(
        imported.state,
        handoffAlignmentSnapshot(STALE_HASH, false, 1),
      ),
    );
    expect(
      mismatched.stagedHandoff?.entries.map((entry) => entry.localAlignment),
    ).toEqual([
      HANDOFF_ALIGNMENT_KIND.mismatch,
      HANDOFF_ALIGNMENT_KIND.mismatch,
    ]);
    expect(
      activateStagedHandoff(mismatched, {
        ...designation(),
        explicitWholeMirrorConsent: true,
      }),
    ).toMatchObject({
      kind: "rejected",
      reason: WRITER_ACTIVATION_FAILURE.globallyBlocked,
    });

    const changed = required(
      invalidateHandoffAlignments(mismatched, [
        { path: LIVE_PATH, observationGeneration: 2 },
        { path: TOMBSTONE_PATH, observationGeneration: 2 },
      ]),
    );
    expect(
      changed.stagedHandoff?.entries.map((entry) => entry.localAlignment),
    ).toEqual([HANDOFF_ALIGNMENT_KIND.pending, HANDOFF_ALIGNMENT_KIND.pending]);
    expect(
      alignStagedHandoff(changed, handoffAlignmentSnapshot(LIVE_HASH, true, 1)),
    ).toBeUndefined();
    expect(
      activateStagedHandoff(changed, {
        ...designation(),
        explicitWholeMirrorConsent: true,
      }),
    ).toMatchObject({
      kind: "rejected",
      reason: WRITER_ACTIVATION_FAILURE.handoffNotAligned,
    });

    const aligned = required(
      alignStagedHandoff(changed, handoffAlignmentSnapshot(LIVE_HASH, true, 2)),
    );
    const activated = activateStagedHandoff(aligned, {
      ...designation(),
      explicitWholeMirrorConsent: true,
    });
    expect(activated.kind).toBe("activated");
    if (activated.kind !== "activated")
      throw new Error("Expected activated handoff.");
    expect(
      activated.state.paths.map((entry) => entry.acknowledgement.kind),
    ).toEqual([
      MIRROR_ACKNOWLEDGEMENT_KIND.live,
      MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
    ]);
  });

  it("does not allow lost local state to take over the old association", () => {
    expect(evaluateWriterReadiness(null, designation())).toMatchObject({
      kind: "not-ready",
      reason: WRITER_ACTIVATION_FAILURE.missingLocalState,
    });
    expect(
      activateIsolatedAssociation(createDisabledMirrorState(OTHER_DEVICE_ID), {
        ...designation({ designatedWriterId: OTHER_DEVICE_ID }),
        explicitWholeMirrorConsent: true,
        isolatedEmptyAssociationConfirmed: false,
      }),
    ).toMatchObject({
      kind: "rejected",
      reason: WRITER_ACTIVATION_FAILURE.associationNotProvenEmpty,
    });
  });
});

describe("closed activation and handoff refusal branches", () => {
  it("reports active readiness mismatches without adopting new evidence", () => {
    const active = activeState();
    expect(
      evaluateWriterReadiness(active, designation({ secretAvailable: false })),
    ).toMatchObject({ reason: WRITER_ACTIVATION_FAILURE.secretMissing });
    expect(
      evaluateWriterReadiness(active, {
        ...designation(),
        origin: "https://other.example",
      }),
    ).toMatchObject({ reason: WRITER_ACTIVATION_FAILURE.originMismatch });
    expect(
      evaluateWriterReadiness(
        active,
        designation({ associationId: OTHER_ASSOCIATION_ID }),
      ),
    ).toMatchObject({ reason: WRITER_ACTIVATION_FAILURE.associationMismatch });
    expect(
      evaluateWriterReadiness(
        active,
        designation({ designatedWriterId: OTHER_DEVICE_ID }),
      ),
    ).toMatchObject({ reason: WRITER_ACTIVATION_FAILURE.designationMismatch });
  });

  it("rejects incompatible or prepopulated isolated-association activation", () => {
    const request = {
      ...designation(),
      explicitWholeMirrorConsent: true,
      isolatedEmptyAssociationConfirmed: true,
    };
    expect(activateIsolatedAssociation(activeState(), request)).toMatchObject({
      reason: WRITER_ACTIVATION_FAILURE.incompatibleLifecycle,
    });
    const prepopulated: MirrorDeviceState = {
      ...createDisabledMirrorState(DEVICE_ID),
      paths: [
        {
          path: LIVE_PATH,
          acknowledgement: { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
          unresolvedMutation: null,
          desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
          blockedReason: null,
        },
      ],
    };
    expect(activateIsolatedAssociation(prepopulated, request)).toMatchObject({
      reason: WRITER_ACTIVATION_FAILURE.incompatibleLifecycle,
    });
  });

  it("requires an explicit clean drained transition and omits unassociated entries", () => {
    expect(
      pauseForHandoff(createDisabledMirrorState(DEVICE_ID)),
    ).toBeUndefined();
    expect(prepareHandoffExport(activeState())).toMatchObject({
      reason: "not-drained",
    });
    const draining = required(pauseForHandoff(activeState()));
    const unchangedAfterAbortOrRead = draining;
    expect(prepareHandoffExport(unchangedAfterAbortOrRead)).toMatchObject({
      reason: "not-drained",
    });
    expect(
      markHandoffDrained({
        ...draining,
        globalBlockReason: "state-unavailable",
      }),
    ).toMatchObject({ reason: "globally-blocked" });
    const unassociated: MirrorDeviceState = {
      ...draining,
      paths: [
        {
          path: LIVE_PATH,
          acknowledgement: { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
          unresolvedMutation: null,
          desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
          blockedReason: null,
        },
      ],
    };
    const drained = markHandoffDrained(unassociated);
    expect(drained.kind).toBe("drained");
    if (drained.kind !== "drained") throw new Error("Expected drained state.");
    expect(prepareHandoffExport(drained.state)).toMatchObject({
      kind: "prepared",
      payload: { entries: [] },
    });
    expect(
      markHandoffDrained({
        ...unassociated,
        paths: unassociated.paths.map((entry) => ({
          ...entry,
          blockedReason: "diverged",
        })),
      }),
    ).toMatchObject({ reason: "blocked-path" });
  });

  it("rejects wrong origins, existing state, wrong alignment calls, and incompatible activation", () => {
    const disabled = createDisabledMirrorState(DEVICE_ID);
    expect(
      stageHandoffImport(disabled, handoffRecord(), {
        associationId: ASSOCIATION_ID,
        origin: "https://other.example",
        initialObservationGeneration: 1,
      }),
    ).toMatchObject({ reason: "origin-mismatch" });
    expect(
      stageHandoffImport(
        {
          ...disabled,
          paths: [
            {
              path: LIVE_PATH,
              acknowledgement: {
                kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated,
              },
              unresolvedMutation: null,
              desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
              blockedReason: null,
            },
          ],
        },
        handoffRecord(),
        {
          associationId: ASSOCIATION_ID,
          origin: ORIGIN,
          initialObservationGeneration: 1,
        },
      ),
    ).toMatchObject({ reason: "existing-local-state" });
    const imported = stageHandoffImport(disabled, handoffRecord(), {
      associationId: ASSOCIATION_ID,
      origin: ORIGIN,
      initialObservationGeneration: 1,
    });
    if (imported.kind !== "staged") throw new Error("Expected staging.");
    const unknownPath = required(normalizeNotePath("notes/unknown.md"));
    const complete = handoffAlignmentSnapshot(LIVE_HASH, true, 1);
    expect(alignStagedHandoff(activeState(), complete)).toBeUndefined();
    const remoteMismatch = required(
      alignStagedHandoff(
        imported.state,
        handoffAlignmentSnapshot(LIVE_HASH, true, 1, {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision: TOMBSTONE_REVISION,
          contentSha256: LIVE_HASH,
        }),
      ),
    );
    expect(remoteMismatch.stagedHandoff?.entries[0]?.remoteVerification).toBe(
      HANDOFF_ALIGNMENT_KIND.mismatch,
    );
    expect(
      alignStagedHandoff(imported.state, {
        ...complete,
        local: [
          {
            kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
            path: LIVE_PATH,
            isAbsent: true,
            observationGeneration: 1,
          },
          required(complete.local[1]),
        ],
      }),
    ).toBeUndefined();
    expect(
      alignStagedHandoff(imported.state, {
        ...complete,
        local: [
          { ...required(complete.local[0]), path: unknownPath },
          required(complete.local[1]),
        ],
      }),
    ).toBeUndefined();
    expect(
      alignStagedHandoff(imported.state, {
        ...complete,
        remote: [required(complete.remote[0])],
      }),
    ).toBeUndefined();
    expect(
      alignStagedHandoff(imported.state, {
        ...complete,
        remote: [required(complete.remote[0]), required(complete.remote[0])],
      }),
    ).toBeUndefined();
    expect(
      invalidateHandoffAlignments(activeState(), complete.local),
    ).toBeUndefined();
    expect(invalidateHandoffAlignments(imported.state, [])).toBeUndefined();
    expect(
      invalidateHandoffAlignments(imported.state, [
        { path: LIVE_PATH, observationGeneration: 1 },
        { path: LIVE_PATH, observationGeneration: 2 },
      ]),
    ).toBeUndefined();
    expect(
      invalidateHandoffAlignments(imported.state, [
        { path: unknownPath, observationGeneration: 1 },
      ]),
    ).toBeUndefined();
    expect(
      invalidateHandoffAlignments(imported.state, [
        { path: LIVE_PATH, observationGeneration: 0 },
      ]),
    ).toBeUndefined();
    expect(
      activateStagedHandoff(activeState(), {
        ...designation(),
        explicitWholeMirrorConsent: true,
      }),
    ).toMatchObject({
      reason: WRITER_ACTIVATION_FAILURE.incompatibleLifecycle,
    });
    expect(
      activateStagedHandoff(imported.state, {
        ...designation({ associationId: OTHER_ASSOCIATION_ID }),
        explicitWholeMirrorConsent: true,
      }),
    ).toMatchObject({ reason: WRITER_ACTIVATION_FAILURE.associationMismatch });
    expect(
      activateStagedHandoff(imported.state, {
        ...designation(),
        origin: "https://other.example",
        explicitWholeMirrorConsent: true,
      }),
    ).toMatchObject({ reason: WRITER_ACTIVATION_FAILURE.originMismatch });
    expect(isDurableMutationAdmissionAllowed(activeState())).toBe(true);
    expect(isDurableMutationAdmissionAllowed(disabled)).toBe(false);
  });
});

function handoffAlignmentSnapshot(
  liveHash: typeof LIVE_HASH,
  tombstoneAbsent: boolean,
  observationGeneration: number,
  liveRemote: TransferableAcknowledgement | null = required(
    handoffRecord().entries[0],
  ).acknowledgement,
  tombstoneRemote: TransferableAcknowledgement | null = required(
    handoffRecord().entries[1],
  ).acknowledgement,
): HandoffAlignmentSnapshot {
  return {
    local: [
      {
        kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
        path: LIVE_PATH,
        contentSha256: liveHash,
        observationGeneration,
      },
      {
        kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
        path: TOMBSTONE_PATH,
        isAbsent: tombstoneAbsent,
        observationGeneration,
      },
    ],
    remote: [
      { path: LIVE_PATH, acknowledgement: liveRemote },
      { path: TOMBSTONE_PATH, acknowledgement: tombstoneRemote },
    ],
  };
}

describe("operational pause and resume policy", () => {
  it("preserves the binding and ledger while paused, then requires fresh exact evidence", () => {
    const active = activeState();
    const paused = pauseMirrorWriter(active, MIRROR_PAUSE_REASON.manual);
    expect(paused?.lifecycle).toEqual({
      kind: MIRROR_DEVICE_LIFECYCLE_KIND.paused,
      associationId: ASSOCIATION_ID,
      origin: ORIGIN,
      reason: MIRROR_PAUSE_REASON.manual,
    });
    if (paused === undefined) throw new Error("Expected paused state.");
    expect(isDurableMutationAdmissionAllowed(paused)).toBe(false);
    expect(
      resumeMirrorWriter(
        paused,
        designation({ designatedWriterId: OTHER_DEVICE_ID }),
      ),
    ).toEqual({
      kind: "rejected",
      reason: WRITER_ACTIVATION_FAILURE.designationMismatch,
    });
    const resumed = resumeMirrorWriter(paused, designation());
    expect(resumed.kind).toBe("resumed");
    if (resumed.kind !== "resumed") throw new Error("Expected resumed state.");
    expect(resumed.state.lifecycle).toEqual(active.lifecycle);
    expect(isDurableMutationAdmissionAllowed(resumed.state)).toBe(true);
  });
});

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid fixture value.");
  return value;
}
