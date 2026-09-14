import {
  activateIsolatedAssociation,
  activateStagedHandoff,
  alignHandoffLivePath,
  alignHandoffTombstonePath,
  createApplicationRevision,
  createContentSha256,
  createDisabledMirrorState,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  evaluateWriterReadiness,
  HANDOFF_ALIGNMENT_KIND,
  type HandoffRecord,
  invalidateHandoffAlignment,
  isDurableMutationAdmissionAllowed,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_PAUSE_REASON,
  type MirrorDeviceState,
  MUTATION_ACTION,
  normalizeNotePath,
  pauseForHandoff,
  prepareHandoffExport,
  stageHandoffImport,
  verifyHandoffRemotePath,
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
    expect(prepareHandoffExport(withIntent)).toMatchObject({
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
          counterpartPath: TOMBSTONE_PATH,
          phase: "source-cleanup-required" as const,
        },
      })),
    };
    expect(prepareHandoffExport(withRename)).toMatchObject({
      kind: "rejected",
      reason: "unsettled-desired-state",
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
    const exported = prepareHandoffExport(state);
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
    expect(state.lifecycle).toMatchObject({
      reason: MIRROR_PAUSE_REASON.handoff,
    });
  });

  it("rejects wrong-association import and never overwrites active state", () => {
    expect(
      stageHandoffImport(
        createDisabledMirrorState(DEVICE_ID),
        handoffRecord(),
        {
          associationId: OTHER_ASSOCIATION_ID,
          origin: ORIGIN,
        },
      ),
    ).toMatchObject({ kind: "rejected", reason: "association-mismatch" });
    expect(
      stageHandoffImport(activeState(), handoffRecord(), {
        associationId: ASSOCIATION_ID,
        origin: ORIGIN,
      }),
    ).toMatchObject({ kind: "rejected", reason: "incompatible-lifecycle" });
  });

  it("keeps live and tombstone ACKs staged until exact local alignment", () => {
    const imported = stageHandoffImport(
      createDisabledMirrorState(DEVICE_ID),
      handoffRecord(),
      {
        associationId: ASSOCIATION_ID,
        origin: ORIGIN,
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

    const staleLive = required(
      alignHandoffLivePath(imported.state, LIVE_PATH, STALE_HASH, 1),
    );
    expect(staleLive.stagedHandoff?.entries[0]?.localAlignment).toBe(
      HANDOFF_ALIGNMENT_KIND.mismatch,
    );
    const staleFileAtTombstone = required(
      alignHandoffTombstonePath(staleLive, TOMBSTONE_PATH, false, 1),
    );
    expect(staleFileAtTombstone.stagedHandoff?.entries[1]?.localAlignment).toBe(
      HANDOFF_ALIGNMENT_KIND.mismatch,
    );
    expect(
      activateStagedHandoff(staleFileAtTombstone, {
        ...designation(),
        explicitWholeMirrorConsent: true,
      }),
    ).toMatchObject({
      kind: "rejected",
      reason: WRITER_ACTIVATION_FAILURE.handoffNotAligned,
    });

    const liveAligned = required(
      alignHandoffLivePath(staleFileAtTombstone, LIVE_PATH, LIVE_HASH, 2),
    );
    const tombstoneAligned = required(
      alignHandoffTombstonePath(liveAligned, TOMBSTONE_PATH, true, 2),
    );
    const changed = required(
      invalidateHandoffAlignment(tombstoneAligned, LIVE_PATH, 3),
    );
    expect(changed.stagedHandoff?.entries[0]?.localAlignment).toBe(
      HANDOFF_ALIGNMENT_KIND.pending,
    );
    const realigned = required(
      alignHandoffLivePath(changed, LIVE_PATH, LIVE_HASH, 3),
    );
    const remoteLive = required(
      verifyHandoffRemotePath(
        realigned,
        LIVE_PATH,
        required(handoffRecord().entries[0]).acknowledgement,
      ),
    );
    const remotelyVerified = required(
      verifyHandoffRemotePath(
        remoteLive,
        TOMBSTONE_PATH,
        required(handoffRecord().entries[1]).acknowledgement,
      ),
    );
    const activated = activateStagedHandoff(remotelyVerified, {
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

  it("requires a real clean handoff pause and omits unassociated entries", () => {
    expect(
      pauseForHandoff(createDisabledMirrorState(DEVICE_ID)),
    ).toBeUndefined();
    expect(prepareHandoffExport(activeState())).toMatchObject({
      reason: "not-paused-for-handoff",
    });
    const paused = required(pauseForHandoff(activeState()));
    expect(
      prepareHandoffExport({
        ...paused,
        globalBlockReason: "state-unavailable",
      }),
    ).toMatchObject({ reason: "globally-blocked" });
    const unassociated: MirrorDeviceState = {
      ...paused,
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
    expect(prepareHandoffExport(unassociated)).toMatchObject({
      kind: "prepared",
      payload: { entries: [] },
    });
    expect(
      prepareHandoffExport({
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
        },
      ),
    ).toMatchObject({ reason: "existing-local-state" });
    const imported = stageHandoffImport(disabled, handoffRecord(), {
      associationId: ASSOCIATION_ID,
      origin: ORIGIN,
    });
    if (imported.kind !== "staged") throw new Error("Expected staging.");
    const unknownPath = required(normalizeNotePath("notes/unknown.md"));
    expect(
      alignHandoffLivePath(activeState(), LIVE_PATH, LIVE_HASH, 1),
    ).toBeUndefined();
    expect(
      verifyHandoffRemotePath(activeState(), LIVE_PATH, null),
    ).toBeUndefined();
    const remoteMismatch = required(
      verifyHandoffRemotePath(imported.state, LIVE_PATH, {
        kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
        revision: TOMBSTONE_REVISION,
        contentSha256: LIVE_HASH,
      }),
    );
    expect(remoteMismatch.stagedHandoff?.entries[0]?.remoteVerification).toBe(
      HANDOFF_ALIGNMENT_KIND.mismatch,
    );
    expect(
      alignHandoffLivePath(imported.state, TOMBSTONE_PATH, LIVE_HASH, 1),
    ).toBeUndefined();
    expect(
      alignHandoffTombstonePath(imported.state, LIVE_PATH, true, 1),
    ).toBeUndefined();
    expect(
      alignHandoffLivePath(imported.state, unknownPath, LIVE_HASH, 1),
    ).toBeUndefined();
    expect(
      invalidateHandoffAlignment(imported.state, LIVE_PATH, 0),
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

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid fixture value.");
  return value;
}
