import {
  type ApplicationRevision,
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  isMirrorDeviceStateConsistent,
  type LiveAcknowledgement,
  MAX_MIRROR_TRACKED_PATHS,
  MAX_MUTATION_ATTEMPTS,
  MAX_MUTATION_EVIDENCE_ATTEMPTS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_GLOBAL_BLOCK_REASON,
  MIRROR_MUTATION_PHASE,
  MIRROR_PATH_BLOCK_REASON,
  type MirrorAcknowledgement,
  type MirrorAssociationId,
  type MirrorDesiredState,
  type MirrorDeviceLifecycle,
  type MirrorDeviceState,
  type MirrorOperationId,
  type MirrorPathState,
  type MirrorWriterId,
  MUTATION_ACTION,
  type MutationAction,
  type NotePath,
  normalizeNotePath,
  type UnresolvedMutationIntent,
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
const RECOVERY = required(
  createMirrorOperationId("77777777-7777-4777-8777-777777777777"),
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
const ORIGIN = "https://bridge.example";

const UNASSOCIATED_ACKNOWLEDGEMENT: MirrorAcknowledgement = {
  kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated,
};
const LIVE_ACKNOWLEDGEMENT: LiveAcknowledgement = {
  kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
  revision: REVISION,
  contentSha256: HASH,
};
const TOMBSTONE_ACKNOWLEDGEMENT: MirrorAcknowledgement = {
  kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
  revision: REVISION,
  recoveryId: RECOVERY,
};

interface IntentOptions {
  readonly associationId?: MirrorAssociationId;
  readonly writerId?: MirrorWriterId;
  readonly operationId?: MirrorOperationId;
  readonly path?: NotePath;
  readonly revision?: ApplicationRevision;
  readonly mutationAttempts?: number;
  readonly evidenceAttempts?: number;
}

function mutationIntent(
  action: MutationAction,
  options: IntentOptions = {},
): UnresolvedMutationIntent {
  const common = {
    associationId: options.associationId ?? ASSOCIATION,
    writerId: options.writerId ?? DEVICE,
    operationId: options.operationId ?? OPERATION,
    path: options.path ?? PATH,
    mutationAttempts: options.mutationAttempts ?? 1,
    evidenceAttempts: options.evidenceAttempts ?? 1,
  };
  switch (action) {
    case MUTATION_ACTION.create:
      return {
        ...common,
        action,
        precondition: { kind: "absent" },
        contentSha256: HASH,
      };
    case MUTATION_ACTION.update:
    case MUTATION_ACTION.recreate:
      return {
        ...common,
        action,
        precondition: {
          kind: "matching-revision",
          revision: options.revision ?? REVISION,
        },
        contentSha256: HASH,
      };
    case MUTATION_ACTION.tombstone:
      return {
        ...common,
        action,
        precondition: {
          kind: "matching-revision",
          revision: options.revision ?? REVISION,
        },
      };
  }
}

function pathWithMutation(
  acknowledgement: MirrorAcknowledgement = LIVE_ACKNOWLEDGEMENT,
  action: MutationAction = MUTATION_ACTION.update,
  options: IntentOptions = {},
  phase: NonNullable<
    MirrorPathState["unresolvedMutation"]
  >["phase"] = MIRROR_MUTATION_PHASE.dispatched,
): MirrorPathState {
  const intent = mutationIntent(action, options);
  return {
    path: intent.path,
    acknowledgement,
    unresolvedMutation: { intent, phase },
    desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
    blockedReason: null,
  };
}

function pathWithoutMutation(
  acknowledgement: MirrorAcknowledgement = LIVE_ACKNOWLEDGEMENT,
  path: NotePath = PATH,
  desired: MirrorDesiredState = { kind: MIRROR_DESIRED_STATE_KIND.none },
): MirrorPathState {
  return {
    path,
    acknowledgement,
    unresolvedMutation: null,
    desired,
    blockedReason: null,
  };
}

function activeLifecycle(): MirrorDeviceLifecycle {
  return {
    kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
    associationId: ASSOCIATION,
    origin: ORIGIN,
  };
}

function state(
  paths: readonly MirrorPathState[] = [pathWithMutation()],
  lifecycle: MirrorDeviceLifecycle = activeLifecycle(),
): MirrorDeviceState {
  return {
    deviceId: DEVICE,
    lifecycle,
    globalBlockReason: null,
    paths,
    stagedHandoff: null,
  };
}

function stagedState(
  entries: NonNullable<MirrorDeviceState["stagedHandoff"]>["entries"] = [
    {
      path: PATH,
      acknowledgement: LIVE_ACKNOWLEDGEMENT,
      localAlignment: "pending",
      remoteVerification: "pending",
      observationGeneration: 0,
    },
  ],
): MirrorDeviceState {
  return {
    ...state([], {
      kind: MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged,
      associationId: ASSOCIATION,
      origin: ORIGIN,
    }),
    stagedHandoff: {
      associationId: ASSOCIATION,
      origin: ORIGIN,
      checksum: HASH,
      entries,
    },
  };
}

describe("mirror device state invariants", () => {
  it("accepts a representative valid active state", () => {
    expect(isMirrorDeviceStateConsistent(state())).toBe(true);
  });

  it("enforces active and staged path capacity independently", () => {
    const paths = Array.from(
      { length: MAX_MIRROR_TRACKED_PATHS + 1 },
      (_, index): MirrorPathState =>
        pathWithoutMutation(
          UNASSOCIATED_ACKNOWLEDGEMENT,
          required(normalizeNotePath(`notes/capacity-${index}.md`)),
        ),
    );
    expect(isMirrorDeviceStateConsistent(state(paths))).toBe(false);
    expect(
      isMirrorDeviceStateConsistent(
        stagedState(
          paths.map((entry) => ({
            path: entry.path,
            acknowledgement: LIVE_ACKNOWLEDGEMENT,
            localAlignment: "pending",
            remoteVerification: "pending",
            observationGeneration: 0,
          })),
        ),
      ),
    ).toBe(false);
  });

  it("enforces lifecycle and staged-handoff ownership", () => {
    expect(
      isMirrorDeviceStateConsistent(
        state([], { kind: MIRROR_DEVICE_LIFECYCLE_KIND.disabled }),
      ),
    ).toBe(true);
    expect(
      isMirrorDeviceStateConsistent(
        state([pathWithoutMutation()], {
          kind: MIRROR_DEVICE_LIFECYCLE_KIND.disabled,
        }),
      ),
    ).toBe(false);
    expect(isMirrorDeviceStateConsistent(stagedState())).toBe(true);
    expect(
      isMirrorDeviceStateConsistent({ ...stagedState(), stagedHandoff: null }),
    ).toBe(false);
    expect(
      isMirrorDeviceStateConsistent({
        ...stagedState(),
        lifecycle: activeLifecycle(),
      }),
    ).toBe(false);
    expect(
      isMirrorDeviceStateConsistent({
        ...stagedState(),
        stagedHandoff: {
          ...required(stagedState().stagedHandoff),
          associationId: OTHER_ASSOCIATION,
        },
      }),
    ).toBe(false);
    expect(
      isMirrorDeviceStateConsistent({
        ...stagedState(),
        stagedHandoff: {
          ...required(stagedState().stagedHandoff),
          origin: "https://other.example",
        },
      }),
    ).toBe(false);
    for (const observationGeneration of [Number.NaN, 0.5, -1]) {
      expect(
        isMirrorDeviceStateConsistent(
          stagedState([
            {
              path: PATH,
              acknowledgement: LIVE_ACKNOWLEDGEMENT,
              localAlignment: "pending",
              remoteVerification: "pending",
              observationGeneration,
            },
          ]),
        ),
      ).toBe(false);
    }
  });

  it("rejects duplicate and colliding ledger identities", () => {
    const duplicatePath = state([
      pathWithoutMutation(),
      pathWithoutMutation(LIVE_ACKNOWLEDGEMENT, PATH),
    ]);
    const duplicateOperation = state([
      pathWithMutation(),
      pathWithMutation(LIVE_ACKNOWLEDGEMENT, MUTATION_ACTION.update, {
        path: OTHER_PATH,
        operationId: OPERATION,
      }),
    ]);
    const duplicateRecovery = state([
      pathWithoutMutation(TOMBSTONE_ACKNOWLEDGEMENT),
      pathWithoutMutation(TOMBSTONE_ACKNOWLEDGEMENT, OTHER_PATH),
    ]);
    const operationRecoveryCollision = state([
      pathWithMutation(
        {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
          revision: REVISION,
          recoveryId: OPERATION,
        },
        MUTATION_ACTION.recreate,
      ),
    ]);
    const stagedDuplicatePath = stagedState([
      {
        path: PATH,
        acknowledgement: LIVE_ACKNOWLEDGEMENT,
        localAlignment: "pending",
        remoteVerification: "pending",
        observationGeneration: 0,
      },
      {
        path: PATH,
        acknowledgement: TOMBSTONE_ACKNOWLEDGEMENT,
        localAlignment: "pending",
        remoteVerification: "pending",
        observationGeneration: 0,
      },
    ]);
    const stagedDuplicateRecovery = stagedState([
      {
        path: PATH,
        acknowledgement: TOMBSTONE_ACKNOWLEDGEMENT,
        localAlignment: "pending",
        remoteVerification: "pending",
        observationGeneration: 0,
      },
      {
        path: OTHER_PATH,
        acknowledgement: TOMBSTONE_ACKNOWLEDGEMENT,
        localAlignment: "pending",
        remoteVerification: "pending",
        observationGeneration: 0,
      },
    ]);
    for (const candidate of [
      duplicatePath,
      duplicateOperation,
      duplicateRecovery,
      operationRecoveryCollision,
      stagedDuplicatePath,
      stagedDuplicateRecovery,
    ]) {
      expect(isMirrorDeviceStateConsistent(candidate)).toBe(false);
    }
  });

  it("requires handoff-drained state to remain quiescent", () => {
    const cleanPath = pathWithoutMutation();
    const drained = state([cleanPath], {
      kind: MIRROR_DEVICE_LIFECYCLE_KIND.handoffDrained,
      associationId: ASSOCIATION,
      origin: ORIGIN,
    });
    expect(isMirrorDeviceStateConsistent(drained)).toBe(true);
    const invalidStates = [
      {
        ...drained,
        globalBlockReason: MIRROR_GLOBAL_BLOCK_REASON.persistenceFailed,
      },
      { ...drained, paths: [pathWithMutation()] },
      {
        ...drained,
        paths: [
          pathWithoutMutation(LIVE_ACKNOWLEDGEMENT, PATH, {
            kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent,
            observationGeneration: 1,
          }),
        ],
      },
      {
        ...drained,
        paths: [
          {
            ...cleanPath,
            blockedReason: MIRROR_PATH_BLOCK_REASON.diverged,
          },
        ],
      },
    ];
    for (const candidate of invalidStates) {
      expect(isMirrorDeviceStateConsistent(candidate)).toBe(false);
    }
  });

  it("validates mutation path, writer, association, and budget ownership", () => {
    const wrongPath = {
      ...pathWithMutation(),
      path: OTHER_PATH,
    };
    const wrongWriter = pathWithMutation(
      LIVE_ACKNOWLEDGEMENT,
      MUTATION_ACTION.update,
      { writerId: OTHER_DEVICE },
    );
    const wrongAssociation = pathWithMutation(
      LIVE_ACKNOWLEDGEMENT,
      MUTATION_ACTION.update,
      { associationId: OTHER_ASSOCIATION },
    );
    for (const candidate of [wrongPath, wrongWriter, wrongAssociation]) {
      expect(isMirrorDeviceStateConsistent(state([candidate]))).toBe(false);
    }
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, 0.5, -1]) {
      expect(
        isMirrorDeviceStateConsistent(
          state([
            pathWithMutation(LIVE_ACKNOWLEDGEMENT, MUTATION_ACTION.update, {
              mutationAttempts: invalid,
            }),
          ]),
        ),
      ).toBe(false);
      expect(
        isMirrorDeviceStateConsistent(
          state([
            pathWithMutation(LIVE_ACKNOWLEDGEMENT, MUTATION_ACTION.update, {
              evidenceAttempts: invalid,
            }),
          ]),
        ),
      ).toBe(false);
    }
    for (const [field, maximum] of [
      ["mutationAttempts", MAX_MUTATION_ATTEMPTS],
      ["evidenceAttempts", MAX_MUTATION_EVIDENCE_ATTEMPTS],
    ] as const) {
      expect(
        isMirrorDeviceStateConsistent(
          state([
            pathWithMutation(LIVE_ACKNOWLEDGEMENT, MUTATION_ACTION.update, {
              [field]: maximum,
            }),
          ]),
        ),
      ).toBe(true);
      expect(
        isMirrorDeviceStateConsistent(
          state([
            pathWithMutation(LIVE_ACKNOWLEDGEMENT, MUTATION_ACTION.update, {
              [field]: maximum + 1,
            }),
          ]),
        ),
      ).toBe(false);
    }
  });

  it("exhaustively enforces mutation phase/action compatibility", () => {
    for (const phase of [
      MIRROR_MUTATION_PHASE.intentPersisted,
      MIRROR_MUTATION_PHASE.dispatched,
      MIRROR_MUTATION_PHASE.evidenceRequired,
    ] as const) {
      expect(
        isMirrorDeviceStateConsistent(
          state([
            pathWithMutation(
              LIVE_ACKNOWLEDGEMENT,
              MUTATION_ACTION.update,
              {},
              phase,
            ),
          ]),
        ),
      ).toBe(true);
    }
    for (const phase of [
      MIRROR_MUTATION_PHASE.recoveryPreparation,
      MIRROR_MUTATION_PHASE.tombstoneCommit,
    ] as const) {
      for (const [acknowledgement, action] of [
        [UNASSOCIATED_ACKNOWLEDGEMENT, MUTATION_ACTION.create],
        [LIVE_ACKNOWLEDGEMENT, MUTATION_ACTION.update],
        [TOMBSTONE_ACKNOWLEDGEMENT, MUTATION_ACTION.recreate],
      ] as const) {
        expect(
          isMirrorDeviceStateConsistent(
            state([pathWithMutation(acknowledgement, action, {}, phase)]),
          ),
        ).toBe(false);
      }
      expect(
        isMirrorDeviceStateConsistent(
          state([
            pathWithMutation(
              LIVE_ACKNOWLEDGEMENT,
              MUTATION_ACTION.tombstone,
              {},
              phase,
            ),
          ]),
        ),
      ).toBe(true);
    }
  });

  it("exhaustively enforces acknowledgement/action compatibility", () => {
    const actions = [
      MUTATION_ACTION.create,
      MUTATION_ACTION.update,
      MUTATION_ACTION.tombstone,
      MUTATION_ACTION.recreate,
    ] as const;
    const matrix = [
      {
        acknowledgement: UNASSOCIATED_ACKNOWLEDGEMENT,
        allowed: new Set<MutationAction>([MUTATION_ACTION.create]),
      },
      {
        acknowledgement: LIVE_ACKNOWLEDGEMENT,
        allowed: new Set<MutationAction>([
          MUTATION_ACTION.update,
          MUTATION_ACTION.tombstone,
        ]),
      },
      {
        acknowledgement: TOMBSTONE_ACKNOWLEDGEMENT,
        allowed: new Set<MutationAction>([MUTATION_ACTION.recreate]),
      },
    ];
    for (const { acknowledgement, allowed } of matrix) {
      for (const action of actions) {
        expect(
          isMirrorDeviceStateConsistent(
            state([pathWithMutation(acknowledgement, action)]),
          ),
        ).toBe(allowed.has(action));
      }
    }
  });

  it("binds matching-revision actions to the acknowledged revision", () => {
    for (const [acknowledgement, action] of [
      [LIVE_ACKNOWLEDGEMENT, MUTATION_ACTION.update],
      [LIVE_ACKNOWLEDGEMENT, MUTATION_ACTION.tombstone],
      [TOMBSTONE_ACKNOWLEDGEMENT, MUTATION_ACTION.recreate],
    ] as const) {
      expect(
        isMirrorDeviceStateConsistent(
          state([
            pathWithMutation(acknowledgement, action, {
              revision: OTHER_REVISION,
            }),
          ]),
        ),
      ).toBe(false);
    }
  });

  it("validates every desired-state variant and observation generation", () => {
    const desiredStates = [
      {
        kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent,
        observationGeneration: 1,
      },
      {
        kind: MIRROR_DESIRED_STATE_KIND.renameDeferred,
        observationGeneration: 1,
        counterpartPath: OTHER_PATH,
        phase: "destination-required",
      },
      {
        kind: MIRROR_DESIRED_STATE_KIND.runtimeDelete,
        observationGeneration: 1,
        associationId: ASSOCIATION,
        expectedRevision: REVISION,
      },
    ] as const satisfies readonly MirrorDesiredState[];
    expect(isMirrorDeviceStateConsistent(state([pathWithoutMutation()]))).toBe(
      true,
    );
    for (const desired of desiredStates) {
      expect(
        isMirrorDeviceStateConsistent(
          state([pathWithoutMutation(LIVE_ACKNOWLEDGEMENT, PATH, desired)]),
        ),
      ).toBe(true);
      expect(
        isMirrorDeviceStateConsistent(
          state([
            pathWithoutMutation(LIVE_ACKNOWLEDGEMENT, PATH, {
              ...desired,
              observationGeneration: -1,
            }),
          ]),
        ),
      ).toBe(false);
    }
    expect(
      isMirrorDeviceStateConsistent(
        state([
          pathWithoutMutation(LIVE_ACKNOWLEDGEMENT, PATH, {
            kind: MIRROR_DESIRED_STATE_KIND.renameDeferred,
            observationGeneration: 1,
            counterpartPath: PATH,
            phase: "destination-required",
          }),
        ]),
      ),
    ).toBe(false);
  });

  it("enforces runtime-delete acknowledgement, revision, association, and lifecycle authority", () => {
    const runtimeDelete: MirrorDesiredState = {
      kind: MIRROR_DESIRED_STATE_KIND.runtimeDelete,
      observationGeneration: 1,
      associationId: ASSOCIATION,
      expectedRevision: REVISION,
    };
    const runtimeDeletePath = pathWithoutMutation(
      LIVE_ACKNOWLEDGEMENT,
      PATH,
      runtimeDelete,
    );
    for (const lifecycle of [
      activeLifecycle(),
      {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.paused,
        associationId: ASSOCIATION,
        origin: ORIGIN,
        reason: "manual",
      },
      {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.handoffDraining,
        associationId: ASSOCIATION,
        origin: ORIGIN,
      },
    ] as const) {
      expect(
        isMirrorDeviceStateConsistent(state([runtimeDeletePath], lifecycle)),
      ).toBe(true);
    }
    for (const lifecycle of [
      { kind: MIRROR_DEVICE_LIFECYCLE_KIND.disabled },
      {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.handoffDrained,
        associationId: ASSOCIATION,
        origin: ORIGIN,
      },
      {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged,
        associationId: ASSOCIATION,
        origin: ORIGIN,
      },
    ] as const) {
      expect(
        isMirrorDeviceStateConsistent(state([runtimeDeletePath], lifecycle)),
      ).toBe(false);
    }
    for (const acknowledgement of [
      UNASSOCIATED_ACKNOWLEDGEMENT,
      TOMBSTONE_ACKNOWLEDGEMENT,
    ]) {
      expect(
        isMirrorDeviceStateConsistent(
          state([pathWithoutMutation(acknowledgement, PATH, runtimeDelete)]),
        ),
      ).toBe(false);
    }
    expect(
      isMirrorDeviceStateConsistent(
        state([
          pathWithoutMutation(LIVE_ACKNOWLEDGEMENT, PATH, {
            ...runtimeDelete,
            expectedRevision: OTHER_REVISION,
          }),
        ]),
      ),
    ).toBe(false);
    expect(
      isMirrorDeviceStateConsistent(
        state([
          pathWithoutMutation(LIVE_ACKNOWLEDGEMENT, PATH, {
            ...runtimeDelete,
            associationId: OTHER_ASSOCIATION,
          }),
        ]),
      ),
    ).toBe(false);
  });
});

function required<Value>(value: Value | null | undefined): Value {
  if (value === null || value === undefined)
    throw new Error("Invalid fixture value.");
  return value;
}
