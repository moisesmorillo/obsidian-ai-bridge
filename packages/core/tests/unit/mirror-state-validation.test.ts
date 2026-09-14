import {
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  isMirrorDeviceStateConsistent,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  type MirrorDeviceState,
  type MirrorPathState,
  MUTATION_ACTION,
  normalizeNotePath,
} from "@obsidian-ai-bridge/core";
import { describe, expect, it } from "vitest";

const DEVICE = required(
  createMirrorWriterId("11111111-1111-4111-8111-111111111111"),
);
const OTHER_DEVICE = required(
  createMirrorWriterId("99999999-9999-4999-8999-999999999999"),
);
const ASSOCIATION = required(
  createMirrorAssociationId("22222222-2222-4222-8222-222222222222"),
);
const OTHER_ASSOCIATION = required(
  createMirrorAssociationId("88888888-8888-4888-8888-888888888888"),
);
const OPERATION = required(
  createMirrorOperationId("33333333-3333-4333-8333-333333333333"),
);
const REVISION = required(
  createApplicationRevision("44444444-4444-4444-8444-444444444444"),
);
const OTHER_REVISION = required(
  createApplicationRevision("55555555-5555-4555-8555-555555555555"),
);
const HASH = required(createContentSha256("ab".repeat(32)));
const PATH = required(normalizeNotePath("notes/a.md"));
const OTHER_PATH = required(normalizeNotePath("notes/b.md"));

function livePath(): MirrorPathState {
  return {
    path: PATH,
    acknowledgement: {
      kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
      revision: REVISION,
      contentSha256: HASH,
    },
    unresolvedMutation: {
      intent: {
        action: MUTATION_ACTION.update,
        associationId: ASSOCIATION,
        writerId: DEVICE,
        operationId: OPERATION,
        path: PATH,
        precondition: { kind: "matching-revision", revision: REVISION },
        contentSha256: HASH,
        mutationAttempts: 1,
        evidenceAttempts: 1,
      },
      phase: "dispatched",
    },
    desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
    blockedReason: null,
  };
}

function state(path = livePath()): MirrorDeviceState {
  return {
    deviceId: DEVICE,
    lifecycle: {
      kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
      associationId: ASSOCIATION,
      origin: "https://bridge.example",
    },
    globalBlockReason: null,
    paths: [path],
    stagedHandoff: null,
  };
}

describe("mirror device state invariants", () => {
  it("accepts valid intent ownership and exact runtime-delete evidence", () => {
    expect(isMirrorDeviceStateConsistent(state())).toBe(true);
    const path = livePath();
    expect(
      isMirrorDeviceStateConsistent(
        state({
          ...path,
          desired: {
            kind: MIRROR_DESIRED_STATE_KIND.runtimeDelete,
            observationGeneration: 2,
            associationId: ASSOCIATION,
            expectedRevision: REVISION,
          },
        }),
      ),
    ).toBe(true);
  });

  it("rejects lifecycle/staging binding and duplicate path corruption", () => {
    expect(
      isMirrorDeviceStateConsistent({
        ...state(),
        lifecycle: {
          kind: MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged,
          associationId: ASSOCIATION,
          origin: "https://bridge.example",
        },
      }),
    ).toBe(false);
    expect(
      isMirrorDeviceStateConsistent({
        ...state(),
        paths: [livePath(), livePath()],
      }),
    ).toBe(false);
    const staged = {
      associationId: ASSOCIATION,
      origin: "https://bridge.example",
      checksum: HASH,
      entries: [
        {
          path: PATH,
          acknowledgement: {
            kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
            revision: REVISION,
            contentSha256: HASH,
          },
          localAlignment: "pending" as const,
          remoteVerification: "pending" as const,
          observationGeneration: 0,
        },
      ],
    };
    const stagedState: MirrorDeviceState = {
      ...state(),
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged,
        associationId: ASSOCIATION,
        origin: "https://bridge.example",
      },
      paths: [],
      stagedHandoff: staged,
    };
    expect(isMirrorDeviceStateConsistent(stagedState)).toBe(true);
    for (const invalidGeneration of [Number.NaN, 0.5, -1]) {
      expect(
        isMirrorDeviceStateConsistent({
          ...stagedState,
          stagedHandoff: {
            ...staged,
            entries: [
              {
                ...(staged.entries[0] ?? neverValue()),
                observationGeneration: invalidGeneration,
              },
            ],
          },
        }),
      ).toBe(false);
    }
    expect(
      isMirrorDeviceStateConsistent({
        ...stagedState,
        stagedHandoff: { ...staged, origin: "https://other.example" },
      }),
    ).toBe(false);
    expect(
      isMirrorDeviceStateConsistent({
        ...stagedState,
        stagedHandoff: {
          ...staged,
          entries: [...staged.entries, staged.entries[0] ?? neverValue()],
        },
      }),
    ).toBe(false);
  });

  it("rejects wrong intent path/writer/association and acknowledgement-action combinations", () => {
    const base = livePath();
    const unresolved = required(base.unresolvedMutation);
    const intent = unresolved.intent;
    for (const changedIntent of [
      { ...intent, path: OTHER_PATH },
      { ...intent, writerId: OTHER_DEVICE },
      { ...intent, associationId: OTHER_ASSOCIATION },
    ]) {
      expect(
        isMirrorDeviceStateConsistent(
          state({
            ...base,
            unresolvedMutation: { ...unresolved, intent: changedIntent },
          }),
        ),
      ).toBe(false);
    }
    expect(
      isMirrorDeviceStateConsistent(
        state({
          ...base,
          unresolvedMutation: {
            ...unresolved,
            intent: {
              action: MUTATION_ACTION.update,
              associationId: ASSOCIATION,
              writerId: DEVICE,
              operationId: OPERATION,
              path: PATH,
              precondition: {
                kind: "matching-revision",
                revision: OTHER_REVISION,
              },
              contentSha256: HASH,
              mutationAttempts: 1,
              evidenceAttempts: 1,
            },
          },
        }),
      ),
    ).toBe(false);
    expect(
      isMirrorDeviceStateConsistent(
        state({
          ...base,
          acknowledgement: { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
        }),
      ),
    ).toBe(false);
    expect(
      isMirrorDeviceStateConsistent(
        state({
          ...base,
          acknowledgement: {
            kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
            revision: REVISION,
            recoveryId: OPERATION,
          },
        }),
      ),
    ).toBe(false);
    expect(
      isMirrorDeviceStateConsistent(
        state({
          ...base,
          unresolvedMutation: {
            ...unresolved,
            intent: {
              action: MUTATION_ACTION.recreate,
              associationId: ASSOCIATION,
              writerId: DEVICE,
              operationId: OPERATION,
              path: PATH,
              precondition: { kind: "matching-revision", revision: REVISION },
              contentSha256: HASH,
              mutationAttempts: 1,
              evidenceAttempts: 1,
            },
          },
        }),
      ),
    ).toBe(false);
    expect(
      isMirrorDeviceStateConsistent(
        state({
          ...base,
          acknowledgement: {
            kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
            revision: REVISION,
            recoveryId: OPERATION,
          },
          unresolvedMutation: {
            ...unresolved,
            intent: {
              action: MUTATION_ACTION.recreate,
              associationId: ASSOCIATION,
              writerId: DEVICE,
              operationId: OPERATION,
              path: PATH,
              precondition: {
                kind: "matching-revision",
                revision: OTHER_REVISION,
              },
              contentSha256: HASH,
              mutationAttempts: 1,
              evidenceAttempts: 1,
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it("rejects non-safe-integer counters and observation generations", () => {
    const base = livePath();
    const unresolved = required(base.unresolvedMutation);
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, 0.5, -1]) {
      expect(
        isMirrorDeviceStateConsistent(
          state({
            ...base,
            unresolvedMutation: {
              ...unresolved,
              intent: { ...unresolved.intent, mutationAttempts: invalid },
            },
          }),
        ),
      ).toBe(false);
      expect(
        isMirrorDeviceStateConsistent(
          state({
            ...base,
            unresolvedMutation: {
              ...unresolved,
              intent: { ...unresolved.intent, evidenceAttempts: invalid },
            },
          }),
        ),
      ).toBe(false);
      expect(
        isMirrorDeviceStateConsistent(
          state({
            ...base,
            desired: {
              kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent,
              observationGeneration: invalid,
            },
          }),
        ),
      ).toBe(false);
    }
  });

  it("rejects mismatched runtime-delete revision/association", () => {
    const base = livePath();
    for (const desired of [
      {
        kind: MIRROR_DESIRED_STATE_KIND.runtimeDelete,
        observationGeneration: 2,
        associationId: OTHER_ASSOCIATION,
        expectedRevision: REVISION,
      },
      {
        kind: MIRROR_DESIRED_STATE_KIND.runtimeDelete,
        observationGeneration: 2,
        associationId: ASSOCIATION,
        expectedRevision: OTHER_REVISION,
      },
    ] as const) {
      expect(isMirrorDeviceStateConsistent(state({ ...base, desired }))).toBe(
        false,
      );
    }
  });
});

function neverValue(): never {
  throw new Error("Unreachable fixture branch.");
}

function required<Value>(value: Value | null | undefined): Value {
  if (value === null || value === undefined)
    throw new Error("Invalid fixture value.");
  return value;
}
