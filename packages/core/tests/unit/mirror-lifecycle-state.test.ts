import { MirrorDeletionExecutor } from "@core/mirror/mirror-deletion-executor";
import { MirrorIntentExecutor } from "@core/mirror/mirror-intent-executor";
import {
  destructiveEvidenceIdentity,
  invalidateRenamePlan,
  invalidateRenamePlansForPath,
  persistTombstoneIntent,
  recordRenameDestinationAcknowledgement,
  recordRuntimeDeleteEvidence,
  recordRuntimeRenameEvidence,
} from "@core/mirror/mirror-lifecycle-state";
import { MirrorPathRuntime } from "@core/mirror/mirror-path-runtime";
import { MirrorPathStatusWriter } from "@core/mirror/mirror-path-status";
import { MirrorPositiveReconciler } from "@core/mirror/mirror-positive-reconciler";
import { MirrorRenameExecutor } from "@core/mirror/mirror-rename-executor";
import {
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  LocalInspectionKind,
  MAX_MIRROR_TRACKED_PATHS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_PATH_BLOCK_REASON,
  MIRROR_RENAME_PHASE,
  type MirrorDeviceState,
  type MirrorPathState,
  MirrorStateOwner,
  type MirrorSynchronizerRuntime,
  MUTATION_ACTION,
  normalizeNotePath,
  type ReadOnlyLocalVault,
  type RemoteBridge,
} from "@obsidian-ai-bridge/core";
import { describe, expect, it, vi } from "vitest";

const DEVICE = required(
  createMirrorWriterId("11111111-1111-4111-8111-111111111111"),
);
const ASSOCIATION = required(
  createMirrorAssociationId("22222222-2222-4222-8222-222222222222"),
);
const EVIDENCE = required(
  createMirrorOperationId("33333333-3333-4333-8333-333333333333"),
);
const OTHER_EVIDENCE = required(
  createMirrorOperationId("44444444-4444-4444-8444-444444444444"),
);
const REVISION = required(
  createApplicationRevision("55555555-5555-4555-8555-555555555555"),
);
const DESTINATION_REVISION = required(
  createApplicationRevision("66666666-6666-4666-8666-666666666666"),
);
const HASH = required(createContentSha256("aa".repeat(32)));
const SOURCE = required(normalizeNotePath("notes/source.md"));
const DESTINATION = required(normalizeNotePath("notes/destination.md"));
const OTHER = required(normalizeNotePath("notes/other.md"));

const deleteInput = {
  path: SOURCE,
  observationGeneration: 1,
  evidenceId: EVIDENCE,
  graceDeadlineMilliseconds: 5_000,
};
const renameInput = {
  sourcePath: SOURCE,
  destinationPath: DESTINATION,
  sourceObservationGeneration: 1,
  destinationObservationGeneration: 2,
  renameId: EVIDENCE,
  graceDeadlineMilliseconds: 5_000,
};

describe("lifecycle durable transition policy", () => {
  it("admits delete evidence only for an active acknowledged live path", () => {
    expect(
      recordRuntimeDeleteEvidence(
        {
          ...activeState(),
          lifecycle: { kind: MIRROR_DEVICE_LIFECYCLE_KIND.disabled },
          paths: [],
        },
        deleteInput,
      ),
    ).toBeUndefined();
    expect(
      recordRuntimeDeleteEvidence(
        activeState([
          pathState(SOURCE, { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated }),
        ]),
        deleteInput,
      ),
    ).toBeUndefined();
    expect(
      recordRuntimeDeleteEvidence(activeState(), {
        ...deleteInput,
        path: OTHER,
      }),
    ).toBeUndefined();

    expect(
      recordRuntimeDeleteEvidence(activeState(), deleteInput)?.paths[0]
        ?.desired,
    ).toMatchObject({
      kind: MIRROR_DESIRED_STATE_KIND.runtimeDelete,
      evidenceId: EVIDENCE,
      expectedRevision: REVISION,
    });
  });

  it("models destination collision, existing destination, and excluded destination explicitly", () => {
    const collision = recordRuntimeRenameEvidence(
      activeState([
        livePath(SOURCE, REVISION),
        livePath(DESTINATION, DESTINATION_REVISION),
      ]),
      renameInput,
    );
    expect(collision?.paths[0]?.desired).toMatchObject({
      kind: MIRROR_DESIRED_STATE_KIND.renameDeferred,
      phase: MIRROR_RENAME_PHASE.invalidated,
    });
    expect(collision?.paths[0]?.blockedReason).toBe(
      MIRROR_PATH_BLOCK_REASON.renameDeferred,
    );

    const existingDestination = recordRuntimeRenameEvidence(
      activeState([
        livePath(SOURCE, REVISION),
        pathState(DESTINATION, {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated,
        }),
      ]),
      renameInput,
    );
    expect(
      existingDestination?.paths.find((entry) => entry.path === DESTINATION)
        ?.desired,
    ).toEqual({
      kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent,
      observationGeneration: 2,
    });

    const excluded = recordRuntimeRenameEvidence(activeState(), {
      ...renameInput,
      destinationPath: null,
      destinationObservationGeneration: null,
    });
    expect(excluded?.paths[0]?.desired).toMatchObject({
      destinationPath: null,
      phase: MIRROR_RENAME_PHASE.sourceCleanupRequired,
    });
  });

  it("rejects rename authority and malformed destination evidence safely", () => {
    expect(
      recordRuntimeRenameEvidence(
        {
          ...activeState(),
          lifecycle: { kind: MIRROR_DEVICE_LIFECYCLE_KIND.disabled },
          paths: [],
        },
        renameInput,
      ),
    ).toBeUndefined();
    expect(
      recordRuntimeRenameEvidence(
        activeState([
          pathState(SOURCE, { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated }),
        ]),
        renameInput,
      ),
    ).toBeUndefined();
    expect(() =>
      recordRuntimeRenameEvidence(activeState(), {
        ...renameInput,
        destinationObservationGeneration: null,
      }),
    ).toThrow("observation generation");

    const fullPaths = Array.from(
      { length: MAX_MIRROR_TRACKED_PATHS },
      (_, index) =>
        livePath(
          required(
            normalizeNotePath(`full/note-${String(index).padStart(5, "0")}.md`),
          ),
          REVISION,
        ),
    );
    const source = fullPaths[0];
    expect(source).toBeDefined();
    expect(
      recordRuntimeRenameEvidence(activeState(fullPaths), {
        ...renameInput,
        sourcePath: required(source).path,
      }),
    ).toBeUndefined();
  });

  it("persists and invalidates the exact destination dependency", () => {
    const planned = required(
      recordRuntimeRenameEvidence(
        activeState([
          livePath(SOURCE, REVISION),
          livePath(DESTINATION, DESTINATION_REVISION),
        ]),
        { ...renameInput, destinationPath: OTHER },
      ),
    );
    const withDestinationAck: MirrorDeviceState = {
      ...planned,
      paths: planned.paths.map((entry) =>
        entry.path === OTHER
          ? {
              ...entry,
              acknowledgement: {
                kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
                revision: DESTINATION_REVISION,
                contentSha256: HASH,
              },
              desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
            }
          : entry,
      ),
    };
    expect(
      recordRenameDestinationAcknowledgement(
        withDestinationAck,
        SOURCE,
        EVIDENCE,
        DESTINATION_REVISION,
      )?.paths[0]?.desired,
    ).toMatchObject({
      phase: MIRROR_RENAME_PHASE.sourceCleanupRequired,
      destinationAcknowledgedRevision: DESTINATION_REVISION,
    });
    expect(
      recordRenameDestinationAcknowledgement(
        withDestinationAck,
        SOURCE,
        OTHER_EVIDENCE,
        DESTINATION_REVISION,
      ),
    ).toBeUndefined();
    expect(
      recordRenameDestinationAcknowledgement(
        withDestinationAck,
        SOURCE,
        EVIDENCE,
        REVISION,
      ),
    ).toBeUndefined();

    const invalidated = invalidateRenamePlansForPath(withDestinationAck, OTHER);
    expect(invalidated.paths[0]?.desired).toMatchObject({
      phase: MIRROR_RENAME_PHASE.invalidated,
    });
    expect(
      invalidateRenamePlansForPath(withDestinationAck, OTHER, EVIDENCE),
    ).toEqual(withDestinationAck);
    expect(
      invalidateRenamePlan(withDestinationAck, SOURCE, EVIDENCE)?.paths[0]
        ?.blockedReason,
    ).toBe(MIRROR_PATH_BLOCK_REASON.renameDeferred);
    expect(
      invalidateRenamePlan(withDestinationAck, SOURCE, OTHER_EVIDENCE),
    ).toBeUndefined();
  });

  it("keeps direct deletion execution behind the durable grace deadline", async () => {
    const withDelete = required(
      recordRuntimeDeleteEvidence(activeState(), deleteInput),
    );
    const harness = lifecycleHarness(withDelete);

    await harness.deletion.run(SOURCE);
    await harness.deletion.run(OTHER);

    expect(harness.localRead).not.toHaveBeenCalled();
    expect(harness.remote.mutateNote).not.toHaveBeenCalled();

    const unresolvedState: MirrorDeviceState = {
      ...withDelete,
      paths: withDelete.paths.map((entry) => ({
        ...entry,
        unresolvedMutation: {
          intent: {
            action: MUTATION_ACTION.update,
            associationId: ASSOCIATION,
            writerId: DEVICE,
            operationId: OTHER_EVIDENCE,
            path: SOURCE,
            precondition: { kind: "matching-revision", revision: REVISION },
            contentSha256: HASH,
            mutationAttempts: 1,
            evidenceAttempts: 0,
          },
          phase: "evidence-required",
        },
      })),
    };
    const unresolved = lifecycleHarness(unresolvedState);
    unresolved.remote.inspectNote.mockResolvedValueOnce({
      kind: "success",
      value: {
        kind: "live",
        path: SOURCE,
        revision: REVISION,
        contentSha256: HASH,
        receipt: {
          action: MUTATION_ACTION.update,
          associationId: ASSOCIATION,
          operationId: EVIDENCE,
          precondition: {
            kind: "matching-revision",
            revision: DESTINATION_REVISION,
          },
          contentSha256: HASH,
        },
      },
    });
    await unresolved.deletion.run(SOURCE);
    expect(
      unresolved.owner.snapshot().state.paths[0]?.unresolvedMutation,
    ).not.toBeNull();
  });

  it("stops a pending rename when a later event invalidates its cleanup plan", async () => {
    const planned = required(
      recordRuntimeRenameEvidence(activeState(), renameInput),
    );
    const state: MirrorDeviceState = {
      ...planned,
      paths: planned.paths.map((entry) =>
        entry.path === SOURCE
          ? {
              ...entry,
              unresolvedMutation: {
                intent: {
                  action: MUTATION_ACTION.update,
                  associationId: ASSOCIATION,
                  writerId: DEVICE,
                  operationId: OTHER_EVIDENCE,
                  path: SOURCE,
                  precondition: {
                    kind: "matching-revision",
                    revision: REVISION,
                  },
                  contentSha256: HASH,
                  mutationAttempts: 1,
                  evidenceAttempts: 0,
                },
                phase: "evidence-required",
              },
            }
          : entry,
      ),
    };
    const harness = lifecycleHarness(state);
    const evidence =
      Promise.withResolvers<Awaited<ReturnType<RemoteBridge["inspectNote"]>>>();
    harness.remote.inspectNote.mockReturnValueOnce(evidence.promise);
    const running = harness.rename.run(SOURCE);
    await vi.waitFor(() =>
      expect(harness.remote.inspectNote).toHaveBeenCalled(),
    );
    await harness.owner.transition((current) =>
      invalidateRenamePlan(current, SOURCE, EVIDENCE),
    );
    evidence.resolve({
      kind: "success",
      value: {
        kind: "live",
        path: SOURCE,
        revision: REVISION,
        contentSha256: HASH,
        receipt: {
          action: MUTATION_ACTION.update,
          associationId: ASSOCIATION,
          operationId: EVIDENCE,
          precondition: {
            kind: "matching-revision",
            revision: DESTINATION_REVISION,
          },
          contentSha256: HASH,
        },
      },
    });

    await running;

    expect(harness.owner.snapshot().state.paths[0]?.desired).toMatchObject({
      phase: MIRROR_RENAME_PHASE.invalidated,
    });
    expect(harness.remote.mutateNote).not.toHaveBeenCalled();
  });

  it("creates a fresh tombstone intent only from matching destructive evidence", () => {
    const withDelete = required(
      recordRuntimeDeleteEvidence(activeState(), deleteInput),
    );
    const persisted = persistTombstoneIntent(
      withDelete,
      SOURCE,
      EVIDENCE,
      OTHER_EVIDENCE,
    );
    expect(persisted?.paths[0]?.unresolvedMutation).toMatchObject({
      phase: "recovery-preparation",
      intent: {
        action: MUTATION_ACTION.tombstone,
        operationId: OTHER_EVIDENCE,
        precondition: { revision: REVISION },
      },
    });
    expect(
      persistTombstoneIntent(withDelete, SOURCE, OTHER_EVIDENCE, EVIDENCE),
    ).toBeUndefined();
    expect(
      persistTombstoneIntent(
        {
          ...withDelete,
          lifecycle: { kind: MIRROR_DEVICE_LIFECYCLE_KIND.disabled },
          paths: [],
        },
        SOURCE,
        EVIDENCE,
        OTHER_EVIDENCE,
      ),
    ).toBeUndefined();
    expect(
      destructiveEvidenceIdentity(
        pathState(SOURCE, { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated }),
      ),
    ).toBeUndefined();
    expect(
      destructiveEvidenceIdentity({
        ...livePath(SOURCE, REVISION),
        desired: {
          kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent,
          observationGeneration: 1,
        },
      }),
    ).toBeUndefined();
  });
});

function lifecycleHarness(state: MirrorDeviceState) {
  const localRead = vi.fn<ReadOnlyLocalVault["read"]>(async () => ({
    kind: LocalInspectionKind.failed,
    reason: "missing_file",
  }));
  const local: ReadOnlyLocalVault = {
    list: vi.fn<ReadOnlyLocalVault["list"]>(async () => ({
      kind: LocalInspectionKind.ok,
      entries: [],
      skipped: {
        unsupported_file: 0,
        excluded_location: 0,
        invalid_path: 0,
        oversized: 0,
      },
    })),
    read: localRead,
  };
  const remote: {
    [Method in keyof RemoteBridge]: ReturnType<
      typeof vi.fn<RemoteBridge[Method]>
    >;
  } = {
    describe: vi.fn<RemoteBridge["describe"]>(),
    listNotes: vi.fn<RemoteBridge["listNotes"]>(),
    readNote: vi.fn<RemoteBridge["readNote"]>(),
    inspectNote: vi.fn<RemoteBridge["inspectNote"]>(),
    mutateNote: vi.fn<RemoteBridge["mutateNote"]>(),
    listRecovery: vi.fn<RemoteBridge["listRecovery"]>(),
    inspectRecovery: vi.fn<RemoteBridge["inspectRecovery"]>(),
    readRecoveryContent: vi.fn<RemoteBridge["readRecoveryContent"]>(),
    sealRecovery: vi.fn<RemoteBridge["sealRecovery"]>(),
    purgeRecovery: vi.fn<RemoteBridge["purgeRecovery"]>(),
  };
  const runtime: MirrorSynchronizerRuntime = {
    nowMilliseconds: () => 0,
    hashContent: async () => HASH,
    createOperationId: () => OTHER_EVIDENCE,
  };
  const owner = new MirrorStateOwner(state, {
    save: async () => ({ kind: "saved" }),
  });
  const pathRuntime = new MirrorPathRuntime();
  const status = new MirrorPathStatusWriter(owner, () => undefined);
  const intent = new MirrorIntentExecutor(
    local,
    remote,
    owner,
    runtime,
    pathRuntime,
    status,
  );
  const reconciler = new MirrorPositiveReconciler(
    local,
    remote,
    owner,
    runtime,
    pathRuntime,
    intent,
    status,
  );
  const deletion = new MirrorDeletionExecutor(
    local,
    remote,
    owner,
    runtime,
    pathRuntime,
    intent,
    status,
  );
  const rename = new MirrorRenameExecutor(
    owner,
    reconciler,
    intent,
    deletion,
    status,
  );
  return { deletion, localRead, owner, remote, rename };
}

function activeState(
  paths: readonly MirrorPathState[] = [livePath(SOURCE, REVISION)],
): MirrorDeviceState {
  return {
    deviceId: DEVICE,
    lifecycle: {
      kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
      associationId: ASSOCIATION,
      origin: "https://bridge.example",
    },
    globalBlockReason: null,
    paths,
    stagedHandoff: null,
    reconciliationGapGroupReviews: [],
    reconciliationReviews: [],
    reconciliationOperations: [],
  };
}

function livePath(
  path: MirrorPathState["path"],
  revision: NonNullable<ReturnType<typeof createApplicationRevision>>,
): MirrorPathState {
  return pathState(path, {
    kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
    revision,
    contentSha256: HASH,
  });
}

function pathState(
  path: MirrorPathState["path"],
  acknowledgement: MirrorPathState["acknowledgement"],
): MirrorPathState {
  return {
    path,
    acknowledgement,
    unresolvedMutation: null,
    desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
    blockedReason: null,
  };
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid lifecycle-state fixture.");
  return value;
}
