import {
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  MAX_MUTATION_ATTEMPTS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_PAUSE_REASON,
  MIRROR_STATE_STORE_FAILURE,
  type MirrorDeviceState,
  MirrorStateOwner,
  type MirrorStateSaveResult,
  type MirrorStateStore,
  MUTATION_ACTION,
  type MutationAcknowledgement,
  markHandoffDrained,
  normalizeNotePath,
  pauseForHandoff,
  prepareHandoffExport,
  type UpdateOperationReceipt,
} from "@obsidian-ai-bridge/core";
import { describe, expect, it, vi } from "vitest";

const DEVICE_ID = required(
  createMirrorWriterId("11111111-1111-4111-8111-111111111111"),
);
const ASSOCIATION_ID = required(
  createMirrorAssociationId("22222222-2222-4222-8222-222222222222"),
);
const OPERATION_ID = required(
  createMirrorOperationId("33333333-3333-4333-8333-333333333333"),
);
const REVISION_A = required(
  createApplicationRevision("44444444-4444-4444-8444-444444444444"),
);
const REVISION_B = required(
  createApplicationRevision("55555555-5555-4555-8555-555555555555"),
);
const HASH = required(createContentSha256("ab".repeat(32)));
const OTHER_HASH = required(createContentSha256("cd".repeat(32)));
const OTHER_OPERATION_ID = required(
  createMirrorOperationId("66666666-6666-4666-8666-666666666666"),
);
const OTHER_ASSOCIATION_ID = required(
  createMirrorAssociationId("77777777-7777-4777-8777-777777777777"),
);
const PATH = required(normalizeNotePath("notes/example.md"));
const OTHER_PATH = required(normalizeNotePath("notes/other.md"));
const ORIGIN = "https://bridge.example" as const;

class FakeStateStore implements MirrorStateStore {
  readonly save = vi.fn(
    async (): Promise<MirrorStateSaveResult> => ({ kind: "saved" }),
  );
}

function activeState(): MirrorDeviceState {
  return {
    deviceId: DEVICE_ID,
    lifecycle: {
      kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
      associationId: ASSOCIATION_ID,
      origin: ORIGIN,
    },
    globalBlockReason: null,
    paths: [
      {
        path: PATH,
        acknowledgement: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision: REVISION_A,
          contentSha256: HASH,
        },
        unresolvedMutation: {
          intent: {
            action: MUTATION_ACTION.update,
            associationId: ASSOCIATION_ID,
            writerId: DEVICE_ID,
            operationId: OPERATION_ID,
            path: PATH,
            precondition: { kind: "matching-revision", revision: REVISION_A },
            contentSha256: HASH,
            mutationAttempts: MAX_MUTATION_ATTEMPTS,
            evidenceAttempts: 2,
          },
          phase: "evidence-required",
        },
        desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
        blockedReason: null,
      },
    ],
    stagedHandoff: null,
  };
}

function updateAcknowledgement(
  revision: typeof REVISION_A,
): MutationAcknowledgement & { readonly receipt: UpdateOperationReceipt } {
  return {
    path: PATH,
    revision,
    receipt: {
      action: MUTATION_ACTION.update,
      associationId: ASSOCIATION_ID,
      operationId: OPERATION_ID,
      precondition: { kind: "matching-revision", revision: REVISION_A },
      contentSha256: HASH,
    },
  };
}

describe("MirrorStateOwner", () => {
  it("refuses a stale completion after another caller commits a newer acknowledgement", async () => {
    const store = new FakeStateStore();
    const owner = new MirrorStateOwner(activeState(), store);
    const staleSnapshot = owner.snapshot();
    const newer = await owner.applyAcknowledgement(
      staleSnapshot.revision,
      updateAcknowledgement(REVISION_B),
    );
    const stale = await owner.applyAcknowledgement(
      staleSnapshot.revision,
      updateAcknowledgement(REVISION_A),
    );

    expect(newer.kind).toBe("committed");
    expect(stale.kind).toBe("stale");
    expect(owner.snapshot().state.paths[0]?.acknowledgement).toEqual({
      kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
      revision: REVISION_B,
      contentSha256: HASH,
    });
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it("serializes competing ACK applications so only the first observed revision wins", async () => {
    const pending = Promise.withResolvers<MirrorStateSaveResult>();
    const store = new FakeStateStore();
    store.save.mockImplementationOnce(() => pending.promise);
    const owner = new MirrorStateOwner(activeState(), store);
    const observed = owner.snapshot().revision;

    const first = owner.applyAcknowledgement(
      observed,
      updateAcknowledgement(REVISION_B),
    );
    const competing = owner.applyAcknowledgement(
      observed,
      updateAcknowledgement(REVISION_A),
    );
    await Promise.resolve();
    expect(store.save).toHaveBeenCalledTimes(1);
    pending.resolve({ kind: "saved" });

    expect((await first).kind).toBe("committed");
    expect((await competing).kind).toBe("stale");
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it("rejects ACKs that mismatch any persisted intent identity field", async () => {
    const valid = updateAcknowledgement(REVISION_B);
    const mismatches: MutationAcknowledgement[] = [
      { ...valid, path: OTHER_PATH },
      updateAcknowledgement(REVISION_A),
      {
        ...valid,
        receipt: { ...valid.receipt, associationId: OTHER_ASSOCIATION_ID },
      },
      {
        ...valid,
        receipt: { ...valid.receipt, operationId: OTHER_OPERATION_ID },
      },
      {
        ...valid,
        receipt: {
          ...valid.receipt,
          precondition: { kind: "matching-revision", revision: REVISION_B },
        },
      },
      {
        ...valid,
        receipt: { ...valid.receipt, contentSha256: OTHER_HASH },
      },
      {
        ...valid,
        receipt: {
          action: MUTATION_ACTION.tombstone,
          associationId: ASSOCIATION_ID,
          operationId: OPERATION_ID,
          precondition: { kind: "matching-revision", revision: REVISION_A },
        },
      },
    ];
    for (const mismatch of mismatches) {
      const store = new FakeStateStore();
      const owner = new MirrorStateOwner(activeState(), store);
      expect((await owner.applyAcknowledgement(0, mismatch)).kind).toBe(
        "invalid-transition",
      );
      expect(store.save).not.toHaveBeenCalled();
      expect(
        owner.snapshot().state.paths[0]?.unresolvedMutation,
      ).not.toBeNull();
    }
  });

  it("derives a tombstone recovery ID from the matching persisted operation", async () => {
    const base = activeState();
    const pathState = required(base.paths[0]);
    const tombstoneIntent: MirrorDeviceState = {
      ...base,
      paths: [
        {
          ...pathState,
          unresolvedMutation: {
            intent: {
              action: MUTATION_ACTION.tombstone,
              associationId: ASSOCIATION_ID,
              writerId: DEVICE_ID,
              operationId: OPERATION_ID,
              path: PATH,
              precondition: { kind: "matching-revision", revision: REVISION_A },
              mutationAttempts: 1,
              evidenceAttempts: 0,
            },
            phase: "tombstone-commit",
          },
        },
      ],
    };
    const owner = new MirrorStateOwner(tombstoneIntent, new FakeStateStore());
    const result = await owner.applyAcknowledgement(0, {
      path: PATH,
      revision: REVISION_B,
      receipt: {
        action: MUTATION_ACTION.tombstone,
        associationId: ASSOCIATION_ID,
        operationId: OPERATION_ID,
        precondition: { kind: "matching-revision", revision: REVISION_A },
      },
    });
    expect(result.kind).toBe("committed");
    expect(owner.snapshot().state.paths[0]).toMatchObject({
      acknowledgement: {
        kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
        revision: REVISION_B,
        recoveryId: OPERATION_ID,
      },
      unresolvedMutation: null,
    });
  });

  it("applies pause to the latest state after a pending ACK save and rejects its stale late replay", async () => {
    const pending = Promise.withResolvers<MirrorStateSaveResult>();
    const store = new FakeStateStore();
    store.save.mockImplementationOnce(() => pending.promise);
    const owner = new MirrorStateOwner(activeState(), store);
    const oldRevision = owner.snapshot().revision;
    const acknowledgement = owner.applyAcknowledgement(
      oldRevision,
      updateAcknowledgement(REVISION_B),
    );
    const pause = owner.transition((state) => ({
      ...state,
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.paused,
        associationId: ASSOCIATION_ID,
        origin: ORIGIN,
        reason: MIRROR_PAUSE_REASON.manual,
      },
    }));
    expect(owner.snapshot().mutationAdmissionAllowed).toBe(false);
    pending.resolve({ kind: "saved" });

    expect((await acknowledgement).kind).toBe("committed");
    expect((await pause).kind).toBe("committed");
    expect(owner.snapshot().state.lifecycle.kind).toBe(
      MIRROR_DEVICE_LIFECYCLE_KIND.paused,
    );
    const stale = await owner.commit(oldRevision, () => activeState());
    expect(stale.kind).toBe("stale");
    expect(owner.snapshot().mutationAdmissionAllowed).toBe(false);
  });

  it("retains unresolved evidence and globally fences admission when an ACK save fails", async () => {
    const store = new FakeStateStore();
    store.save.mockResolvedValueOnce({
      kind: "failed",
      reason: MIRROR_STATE_STORE_FAILURE.quotaOrStorageError,
    });
    const owner = new MirrorStateOwner(activeState(), store);
    const result = await owner.applyAcknowledgement(
      owner.snapshot().revision,
      updateAcknowledgement(REVISION_B),
    );

    expect(result.kind).toBe("save-failed");
    expect(owner.snapshot().state.paths[0]?.unresolvedMutation).not.toBeNull();
    expect(owner.snapshot()).toMatchObject({
      revision: 0,
      persistenceAvailable: false,
      mutationAdmissionAllowed: false,
    });
    store.save.mockResolvedValueOnce({ kind: "saved" });
    expect((await owner.verifyPersistence()).persistenceAvailable).toBe(true);
  });

  it("rejects invalid reducers before persistence and invalid initial state", async () => {
    const store = new FakeStateStore();
    const owner = new MirrorStateOwner(activeState(), store);
    expect((await owner.transition(() => undefined)).kind).toBe(
      "invalid-transition",
    );
    expect(
      (
        await owner.transition((current) => ({
          ...current,
          lifecycle: {
            kind: MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged,
            associationId: ASSOCIATION_ID,
            origin: ORIGIN,
          },
          stagedHandoff: null,
        }))
      ).kind,
    ).toBe("invalid-transition");
    const current = activeState();
    const entry = required(current.paths[0]);
    if (entry.unresolvedMutation === null) {
      throw new Error("Missing fixture intent.");
    }
    const unresolved = entry.unresolvedMutation;
    expect(
      (
        await owner.transition(() => ({
          ...current,
          paths: [
            {
              ...entry,
              unresolvedMutation: {
                ...unresolved,
                intent: {
                  ...unresolved.intent,
                  mutationAttempts: Number.NaN,
                },
              },
            },
          ],
        }))
      ).kind,
    ).toBe("invalid-transition");
    expect(
      (
        await owner.transition(() => ({
          ...current,
          paths: [
            {
              ...entry,
              desired: {
                kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent,
                observationGeneration: 1.5,
              },
            },
          ],
        }))
      ).kind,
    ).toBe("invalid-transition");
    expect(store.save).not.toHaveBeenCalled();
    expect(
      () =>
        new MirrorStateOwner(
          {
            ...activeState(),
            lifecycle: {
              kind: MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged,
              associationId: ASSOCIATION_ID,
              origin: ORIGIN,
            },
          },
          store,
        ),
    ).toThrow("Invalid initial");
  });

  it("does not publish drained handoff state when its save fails", async () => {
    const store = new FakeStateStore();
    const initial = activeState();
    const clean: MirrorDeviceState = {
      ...initial,
      paths: initial.paths.map((entry) => ({
        ...entry,
        unresolvedMutation: null,
      })),
    };
    const owner = new MirrorStateOwner(clean, store);
    expect(
      (await owner.transition((state) => pauseForHandoff(state))).kind,
    ).toBe("committed");
    store.save.mockResolvedValueOnce({
      kind: "failed",
      reason: MIRROR_STATE_STORE_FAILURE.quotaOrStorageError,
    });
    const drain = await owner.transition((state) => {
      const result = markHandoffDrained(state);
      return result.kind === "drained" ? result.state : undefined;
    });

    expect(drain.kind).toBe("save-failed");
    expect(owner.snapshot().state.lifecycle.kind).toBe(
      MIRROR_DEVICE_LIFECYCLE_KIND.handoffDraining,
    );
    expect(prepareHandoffExport(owner.snapshot().state)).toMatchObject({
      kind: "rejected",
      reason: "not-drained",
    });
  });

  it("denies hypothetical dispatch when durable intent creation cannot be saved", async () => {
    const store = new FakeStateStore();
    store.save.mockResolvedValueOnce({
      kind: "failed",
      reason: MIRROR_STATE_STORE_FAILURE.unavailable,
    });
    const state = activeState();
    const withoutIntent: MirrorDeviceState = {
      ...state,
      paths: state.paths.map((entry) => ({
        ...entry,
        unresolvedMutation: null,
      })),
    };
    const owner = new MirrorStateOwner(withoutIntent, store);
    const result = await owner.commit(owner.snapshot().revision, () => state);
    expect(result.kind).toBe("save-failed");
    expect(owner.snapshot().state.paths[0]?.unresolvedMutation).toBeNull();
    expect(owner.snapshot().mutationAdmissionAllowed).toBe(false);
  });
});

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid fixture value.");
  return value;
}
