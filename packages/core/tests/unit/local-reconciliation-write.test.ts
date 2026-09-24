import {
  ConflictPreservationService,
  type ContentSha256,
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  createReconciliationPreservationPath,
  isNonHistoryReconciliationOperation,
  isReconciliationPathReserved,
  isReconciliationPreservationPath,
  LOCAL_EFFECT_OBSERVATION_KIND,
  LOCAL_RECONCILIATION_DISPATCH_MODE,
  LOCAL_RECONCILIATION_WRITE_OUTCOME,
  type LocalReconciliationWriter,
  LocalReconciliationWriteService,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_PAUSE_REASON,
  type MirrorDeviceState,
  MirrorStateOwner,
  type MirrorStateStore,
  MUTATION_EFFECT_CERTAINTY,
  RECONCILIATION_ACTION,
  RECONCILIATION_AUTHORITY_SOURCE,
  RECONCILIATION_CLASSIFICATION,
  RECONCILIATION_EVENT_KIND,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_LOCAL_STABILITY,
  RECONCILIATION_OBSERVATION_COVERAGE,
  RECONCILIATION_OPERATION_PHASE,
  RECONCILIATION_PATH_REFERENCE_KIND,
  RECONCILIATION_PRESERVATION_PROOF_STATE,
  RECONCILIATION_PRESERVATION_SIDE,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
  RECONCILIATION_REVIEW_RETENTION,
  RECONCILIATION_REVIEW_STATUS,
  type ReconciliationNonHistoryOperation,
  ReconciliationObservationGenerationOwner,
  type ReconciliationOperation,
  type ReconciliationPathEvidence,
  type ReconciliationReviewSnapshot,
  requiredReconciliationPreservations,
} from "@obsidian-ai-bridge/core";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

/**
 * @param value - Optional validated fixture value.
 * @returns The required value.
 */
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Invalid reconciliation fixture.");
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
const EFFECT = required(
  createMirrorOperationId("77777777-7777-4777-8777-777777777777"),
);
const REVISION_A = required(
  createApplicationRevision("55555555-5555-4555-8555-555555555555"),
);
const REVISION_B = required(
  createApplicationRevision("66666666-6666-4666-8666-666666666666"),
);
const HASH_LOCAL = required(createContentSha256("aa".repeat(32)));
const HASH_REMOTE = required(createContentSha256("bb".repeat(32)));
const PATH = "notes/conflict.md" as ReconciliationPathEvidence["path"];
const DESTINATION = "notes/copy.md" as ReconciliationPathEvidence["path"];
const PRESERVATION_PATH = required(
  createReconciliationPreservationPath(
    OPERATION,
    RECONCILIATION_PRESERVATION_SIDE.local,
  ),
);

/** @returns Prepared synthetic local-effect evidence for restart fixtures. */
function preparedLocalEffect() {
  return {
    kind: LOCAL_EFFECT_OBSERVATION_KIND.prepared,
    effectId: EFFECT,
    path: PATH,
    expectedHash: HASH_REMOTE,
    listenerEpoch: 1,
    beforeGeneration: 7,
    postconditionHash: null,
    successor: null,
  } as const;
}

/** @returns Confirmed synthetic local-effect evidence for terminal fixtures. */
function confirmedLocalEffect() {
  return {
    ...preparedLocalEffect(),
    kind: LOCAL_EFFECT_OBSERVATION_KIND.confirmed,
    postconditionHash: HASH_REMOTE,
  } as const;
}

/** In-memory durable store with one selectable save failure. */
class Store implements MirrorStateStore {
  readonly saves: MirrorDeviceState[] = [];
  failAt: number | null = null;
  calls = 0;

  /** @inheritdoc */
  async save(state: MirrorDeviceState) {
    this.calls += 1;
    if (this.failAt === this.calls) {
      return { kind: "failed", reason: "unavailable" } as const;
    }
    this.saves.push(state);
    return { kind: "saved" } as const;
  }
}

/** @returns Exact immutable snapshot for local-live remote-ahead evidence. */
function liveSnapshot(): ReconciliationReviewSnapshot {
  return snapshot({
    local: {
      kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.live,
      stability: RECONCILIATION_LOCAL_STABILITY.stable,
      observationGeneration: 7,
      byteSize: 5,
      contentSha256: HASH_LOCAL,
    },
    remote: remoteLive(),
  });
}

/** @returns Exact immutable snapshot for local absence and remote live adoption. */
function absentSnapshot(): ReconciliationReviewSnapshot {
  return snapshot({
    local: {
      kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.absent,
      stability: RECONCILIATION_LOCAL_STABILITY.stable,
      observationGeneration: 7,
    },
    remote: remoteLive(),
  });
}

/** @returns Base runtime/baseline plus one supplied local/remote evidence pair. */
function snapshot(
  evidence: Pick<ReconciliationPathEvidence, "local" | "remote">,
): ReconciliationReviewSnapshot {
  return {
    runtime: {
      runtimeOwnerVersion: 3,
      configurationGeneration: 1,
      listenerEpoch: 1,
      deviceId: DEVICE,
      designatedWriterId: DEVICE,
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
        associationId: ASSOCIATION,
        origin: "https://bridge.example",
      },
    },
    targetPath: PATH,
    paths: [
      {
        path: PATH,
        local: evidence.local,
        baseline: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision: REVISION_A,
          contentSha256: HASH_LOCAL,
        },
        remote: evidence.remote,
        m3: { unresolvedMutation: null, deferredHistory: null },
      },
    ],
    recovery: null,
  };
}

/** @returns Exact remote format-2 live evidence for the competing bytes. */
function remoteLive(): ReconciliationPathEvidence["remote"] {
  return {
    kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
    associationId: ASSOCIATION,
    revision: REVISION_B,
    contentSha256: HASH_REMOTE,
    receipt: {
      action: "update",
      associationId: ASSOCIATION,
      operationId: OPERATION,
      precondition: { kind: "matching-revision", revision: REVISION_A },
      contentSha256: HASH_REMOTE,
    },
  };
}

/** @returns Valid durable state with one staged operation and exact review linkage. */
function stateWithOperation(
  operation: ReconciliationOperation,
): MirrorDeviceState {
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
          revision: REVISION_A,
          contentSha256: HASH_LOCAL,
        },
        unresolvedMutation: null,
        desired: { kind: "none" },
        blockedReason: null,
      },
    ],
    stagedHandoff: null,
    reconciliationGapGroupReviews: [],
    reconciliationReviews: [
      {
        retention: RECONCILIATION_REVIEW_RETENTION.durable,
        reviewId: REVIEW,
        classification:
          operation.snapshot.paths[0]?.local.kind ===
          RECONCILIATION_LOCAL_EVIDENCE_KIND.absent
            ? RECONCILIATION_CLASSIFICATION.localMissing
            : RECONCILIATION_CLASSIFICATION.remoteAhead,
        status:
          operation.phase === RECONCILIATION_OPERATION_PHASE.completed
            ? RECONCILIATION_REVIEW_STATUS.completed
            : operation.phase === RECONCILIATION_OPERATION_PHASE.stale
              ? RECONCILIATION_REVIEW_STATUS.stale
              : RECONCILIATION_REVIEW_STATUS.staged,
        snapshot: operation.snapshot,
        operationId: OPERATION,
      },
    ],
    reconciliationOperations: [operation],
  };
}

/**
 * @param operation - Active operation retained across the lifecycle pause.
 * @returns One valid state/operation pair fenced by a manual pause.
 */
function pausedStateWithOperation(
  operation: ReconciliationOperation,
): MirrorDeviceState {
  const lifecycle = {
    kind: MIRROR_DEVICE_LIFECYCLE_KIND.paused,
    associationId: ASSOCIATION,
    origin: "https://bridge.example",
    reason: MIRROR_PAUSE_REASON.manual,
  } as const;
  const pausedOperation: ReconciliationOperation = {
    ...operation,
    snapshot: {
      ...operation.snapshot,
      runtime: { ...operation.snapshot.runtime, lifecycle },
    },
  };
  return { ...stateWithOperation(pausedOperation), lifecycle };
}

/**
 * @param phase - Initial durable phase and associated fixture receipt state.
 * @returns A valid use-remote operation requiring local preservation.
 */
function preservationOperation(
  phase: ReconciliationOperation["phase"] = RECONCILIATION_OPERATION_PHASE.admitted,
): ReconciliationNonHistoryOperation {
  return {
    observationCoverage: RECONCILIATION_OBSERVATION_COVERAGE.continuous,
    gapSuccessorOperationIds: [],
    operationId: OPERATION,
    reviewId: REVIEW,
    authority: RECONCILIATION_AUTHORITY_SOURCE.reconciliationDecision,
    action: { kind: RECONCILIATION_ACTION.useRemote },
    phase,
    snapshot: liveSnapshot(),
    destinationPath: null,
    reservations: [
      { path: PATH, kind: RECONCILIATION_PATH_REFERENCE_KIND.reviewTarget },
    ],
    preservationReceipts:
      phase === RECONCILIATION_OPERATION_PHASE.preserving
        ? [
            {
              scope: "operation",
              operationId: OPERATION,
              originalPath: PATH,
              side: RECONCILIATION_PRESERVATION_SIDE.local,
              sourceRevision: null,
              contentSha256: HASH_LOCAL,
              preservationPath: `.ai-bridge-conflicts/${OPERATION}/local.md`,
              proofState: RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
            },
          ]
        : [],
    successorOperationId: null,
    localEffectObservation: { kind: LOCAL_EFFECT_OBSERVATION_KIND.notStarted },
    localEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
    remoteEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
  };
}

/** @returns A valid remote-only operation with a durable target event fence. */
function remoteOnlyOperation(): ReconciliationNonHistoryOperation {
  const operation = preservationOperation();
  const target = operation.snapshot.paths[0];
  if (target?.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.live) {
    throw new Error("Invalid remote-only fixture.");
  }
  return {
    ...operation,
    action: { kind: RECONCILIATION_ACTION.keepLocal },
    phase: RECONCILIATION_OPERATION_PHASE.mutatingRemote,
    preservationReceipts: [
      {
        scope: "operation",
        operationId: OPERATION,
        originalPath: PATH,
        side: RECONCILIATION_PRESERVATION_SIDE.remote,
        sourceRevision: target.remote.revision,
        contentSha256: target.remote.contentSha256,
        preservationPath: `.ai-bridge-conflicts/${OPERATION}/remote.md`,
        proofState: RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
      },
    ],
    localEffectObservation: {
      kind: LOCAL_EFFECT_OBSERVATION_KIND.notRequired,
      path: PATH,
      listenerEpoch: operation.snapshot.runtime.listenerEpoch,
      beforeGeneration: 7,
      successor: null,
    },
  };
}

/** @returns A valid two-path keep-both operation whose local competitor requires preservation. */
function multiPathPreservationOperation(): ReconciliationNonHistoryOperation {
  const target = liveSnapshot();
  return {
    observationCoverage: RECONCILIATION_OBSERVATION_COVERAGE.continuous,
    gapSuccessorOperationIds: [],
    operationId: OPERATION,
    reviewId: REVIEW,
    authority: RECONCILIATION_AUTHORITY_SOURCE.reconciliationDecision,
    action: {
      kind: RECONCILIATION_ACTION.keepBoth,
      primarySide: RECONCILIATION_PRESERVATION_SIDE.remote,
    },
    phase: RECONCILIATION_OPERATION_PHASE.admitted,
    snapshot: {
      ...target,
      paths: [
        ...target.paths,
        {
          path: DESTINATION,
          local: {
            kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.absent,
            stability: RECONCILIATION_LOCAL_STABILITY.stable,
            observationGeneration: 8,
          },
          baseline: { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
          remote: { kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.absent },
          m3: { unresolvedMutation: null, deferredHistory: null },
        },
      ],
    },
    destinationPath: DESTINATION,
    reservations: [
      { path: PATH, kind: RECONCILIATION_PATH_REFERENCE_KIND.reviewTarget },
      {
        path: DESTINATION,
        kind: RECONCILIATION_PATH_REFERENCE_KIND.newDestination,
      },
    ],
    preservationReceipts: [],
    successorOperationId: null,
    localEffectObservation: { kind: LOCAL_EFFECT_OBSERVATION_KIND.notStarted },
    localEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
    remoteEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
  };
}

/** @returns A valid absent-target exact revision adoption operation. */
function adoptionOperation(): ReconciliationNonHistoryOperation {
  return {
    observationCoverage: RECONCILIATION_OBSERVATION_COVERAGE.continuous,
    gapSuccessorOperationIds: [],
    operationId: OPERATION,
    reviewId: REVIEW,
    authority: RECONCILIATION_AUTHORITY_SOURCE.adoptionDecision,
    action: { kind: RECONCILIATION_ACTION.adoptRevision },
    phase: RECONCILIATION_OPERATION_PHASE.admitted,
    snapshot: absentSnapshot(),
    destinationPath: null,
    reservations: [
      { path: PATH, kind: RECONCILIATION_PATH_REFERENCE_KIND.reviewTarget },
    ],
    preservationReceipts: [],
    successorOperationId: null,
    localEffectObservation: { kind: LOCAL_EFFECT_OBSERVATION_KIND.notStarted },
    localEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
    remoteEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
  };
}

/** @returns The first aggregate-effect operation in a test snapshot. */
function firstNonHistoryOperation(state: MirrorDeviceState) {
  const operation = state.reconciliationOperations[0];
  if (
    operation === undefined ||
    !isNonHistoryReconciliationOperation(operation)
  ) {
    throw new Error("Expected non-history operation.");
  }
  return operation;
}

/** Function-property mock surface that remains safe to reference without a bound receiver. */
interface LocalReconciliationWriterMock {
  readonly createEligible: Mock<LocalReconciliationWriter["createEligible"]>;
  readonly replaceEligible: Mock<LocalReconciliationWriter["replaceEligible"]>;
  readonly createPreservation: Mock<
    LocalReconciliationWriter["createPreservation"]
  >;
}

/** @returns Writer mock with all three narrow methods and no broader capability. */
function writer(): LocalReconciliationWriterMock {
  return {
    createEligible: vi.fn(),
    replaceEligible: vi.fn(),
    createPreservation: vi.fn(),
  };
}

/** Exact fixture digest seam. */
const cryptography = {
  hashContent: vi.fn(async (content: string): Promise<ContentSha256> => {
    if (content === "local") return HASH_LOCAL;
    if (content === "remote") return HASH_REMOTE;
    return required(createContentSha256("cc".repeat(32)));
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("preservation path and matrix owners", () => {
  it("matches only the exact generated operation/side path", () => {
    expect(
      isReconciliationPreservationPath(
        PRESERVATION_PATH,
        OPERATION,
        RECONCILIATION_PRESERVATION_SIDE.local,
      ),
    ).toBe(true);
    expect(
      isReconciliationPreservationPath(
        PRESERVATION_PATH,
        REVIEW,
        RECONCILIATION_PRESERVATION_SIDE.local,
      ),
    ).toBe(false);
  });

  it("fails closed when direct malformed policy input lacks preservable local or remote bytes", () => {
    expect(
      requiredReconciliationPreservations({
        ...preservationOperation(),
        action: { kind: RECONCILIATION_ACTION.recreateRemote },
        snapshot: absentSnapshot(),
      }),
    ).toBeUndefined();
    expect(
      requiredReconciliationPreservations({
        ...preservationOperation(),
        action: { kind: RECONCILIATION_ACTION.keepLocal },
        snapshot: snapshot({
          local: {
            kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.live,
            stability: RECONCILIATION_LOCAL_STABILITY.stable,
            observationGeneration: 1,
            byteSize: 5,
            contentSha256: HASH_LOCAL,
          },
          remote: { kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.absent },
        }),
      }),
    ).toBeUndefined();
  });
});

describe("ConflictPreservationService", () => {
  it("persists pending intent before the effect and verified receipt only after reread proof", async () => {
    const store = new Store();
    const operation = preservationOperation();
    const owner = new MirrorStateOwner(stateWithOperation(operation), store);
    const localWriter = writer();
    localWriter.createPreservation.mockResolvedValue({
      kind: "confirmed",
      outcome: "created",
      path: PRESERVATION_PATH,
      contentSha256: HASH_LOCAL,
      sizeBytes: 5,
    });
    const service = new ConflictPreservationService(
      localWriter,
      owner,
      cryptography,
    );
    const result = await service.preserve({
      operationId: OPERATION,
      side: RECONCILIATION_PRESERVATION_SIDE.local,
      content: "local",
    });
    expect(result.kind).toBe("verified");
    expect(store.saves).toHaveLength(2);
    expect(
      store.saves[0]?.reconciliationOperations[0]?.preservationReceipts[0]
        ?.proofState,
    ).toBe(RECONCILIATION_PRESERVATION_PROOF_STATE.pending);
    expect(
      store.saves[1]?.reconciliationOperations[0]?.preservationReceipts[0]
        ?.proofState,
    ).toBe(RECONCILIATION_PRESERVATION_PROOF_STATE.verified);
    expect(localWriter.createPreservation).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: OPERATION,
        side: RECONCILIATION_PRESERVATION_SIDE.local,
        mode: LOCAL_RECONCILIATION_DISPATCH_MODE.firstDispatch,
      }),
    );
  });

  it("rechecks lifecycle admission after asynchronous source hashing", async () => {
    const owner = new MirrorStateOwner(
      stateWithOperation(preservationOperation()),
      new Store(),
    );
    const localWriter = writer();
    let releaseHash: ((hash: ContentSha256) => void) | undefined;
    let markHashStarted: (() => void) | undefined;
    const hashStarted = new Promise<void>((resolve) => {
      markHashStarted = resolve;
    });
    const pendingHash = new Promise<ContentSha256>((resolve) => {
      releaseHash = resolve;
    });
    const service = new ConflictPreservationService(localWriter, owner, {
      hashContent: vi.fn(() => {
        markHashStarted?.();
        return pendingHash;
      }),
    });
    const result = service.preserve({
      operationId: OPERATION,
      side: RECONCILIATION_PRESERVATION_SIDE.local,
      content: "local",
    });
    await hashStarted;
    await owner.transition((state) => ({
      ...state,
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.paused,
        associationId: ASSOCIATION,
        origin: "https://bridge.example",
        reason: MIRROR_PAUSE_REASON.manual,
      },
    }));
    required(releaseHash)(HASH_LOCAL);
    await expect(result).resolves.toMatchObject({
      kind: "rejected",
      reason: "operation-not-active",
    });
    expect(localWriter.createPreservation).not.toHaveBeenCalled();
  });

  it("fences preservation dispatch while the durable lifecycle is paused", async () => {
    const localWriter = writer();
    await expect(
      new ConflictPreservationService(
        localWriter,
        new MirrorStateOwner(
          pausedStateWithOperation(preservationOperation()),
          new Store(),
        ),
        cryptography,
      ).preserve({
        operationId: OPERATION,
        side: RECONCILIATION_PRESERVATION_SIDE.local,
        content: "local",
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "operation-not-active",
    });
    expect(localWriter.createPreservation).not.toHaveBeenCalled();
  });

  it("rejects mismatched source bytes, missing operations, and actions without preservation requirements", async () => {
    const owner = new MirrorStateOwner(
      stateWithOperation(preservationOperation()),
      new Store(),
    );
    const localWriter = writer();
    const service = new ConflictPreservationService(
      localWriter,
      owner,
      cryptography,
    );
    await expect(
      service.preserve({
        operationId: OPERATION,
        side: RECONCILIATION_PRESERVATION_SIDE.local,
        content: "wrong",
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "source-evidence-mismatch",
    });
    await expect(
      service.preserve({
        operationId: REVIEW,
        side: RECONCILIATION_PRESERVATION_SIDE.local,
        content: "local",
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "operation-not-found",
    });
    const noPreservationOwner = new MirrorStateOwner(
      stateWithOperation(adoptionOperation()),
      new Store(),
    );
    await expect(
      new ConflictPreservationService(
        localWriter,
        noPreservationOwner,
        cryptography,
      ).preserve({
        operationId: OPERATION,
        side: RECONCILIATION_PRESERVATION_SIDE.local,
        content: "local",
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "preservation-not-required",
    });
    expect(localWriter.createPreservation).not.toHaveBeenCalled();
  });

  it("contains digest failure and refuses host dispatch when pending-state persistence fails", async () => {
    const localWriter = writer();
    const hashingFailure = {
      hashContent: vi.fn(async (): Promise<ContentSha256> => {
        throw new Error("unavailable");
      }),
    };
    await expect(
      new ConflictPreservationService(
        localWriter,
        new MirrorStateOwner(
          stateWithOperation(preservationOperation()),
          new Store(),
        ),
        hashingFailure,
      ).preserve({
        operationId: OPERATION,
        side: RECONCILIATION_PRESERVATION_SIDE.local,
        content: "local",
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "source-evidence-mismatch",
    });

    const store = new Store();
    store.failAt = 1;
    await expect(
      new ConflictPreservationService(
        localWriter,
        new MirrorStateOwner(
          stateWithOperation(preservationOperation()),
          store,
        ),
        cryptography,
      ).preserve({
        operationId: OPERATION,
        side: RECONCILIATION_PRESERVATION_SIDE.local,
        content: "local",
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "persistence-failure",
    });
    expect(localWriter.createPreservation).not.toHaveBeenCalled();
  });

  it("retains recoverable pending evidence when receipt persistence fails after artifact creation", async () => {
    const store = new Store();
    store.failAt = 2;
    const owner = new MirrorStateOwner(
      stateWithOperation(preservationOperation()),
      store,
    );
    const localWriter = writer();
    localWriter.createPreservation.mockResolvedValue({
      kind: "confirmed",
      outcome: "created",
      path: PRESERVATION_PATH,
      contentSha256: HASH_LOCAL,
      sizeBytes: 5,
    });
    const service = new ConflictPreservationService(
      localWriter,
      owner,
      cryptography,
    );
    await expect(
      service.preserve({
        operationId: OPERATION,
        side: RECONCILIATION_PRESERVATION_SIDE.local,
        content: "local",
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "persistence-failure",
    });
    const pending = owner.snapshot().state.reconciliationOperations[0];
    expect(pending?.phase).toBe(RECONCILIATION_OPERATION_PHASE.preserving);
    expect(pending?.preservationReceipts[0]?.proofState).toBe(
      RECONCILIATION_PRESERVATION_PROOF_STATE.pending,
    );
    expect(owner.snapshot().persistenceAvailable).toBe(false);

    store.failAt = null;
    await expect(
      service.preserve({
        operationId: OPERATION,
        side: RECONCILIATION_PRESERVATION_SIDE.local,
        content: "local",
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "persistence-failure",
    });
    localWriter.createPreservation.mockResolvedValueOnce({
      kind: "confirmed",
      outcome: "adopted",
      path: PRESERVATION_PATH,
      contentSha256: HASH_LOCAL,
      sizeBytes: 5,
    });
    const restartedService = new ConflictPreservationService(
      localWriter,
      new MirrorStateOwner(required(store.saves.at(-1)), store),
      cryptography,
    );
    await expect(
      restartedService.preserve({
        operationId: OPERATION,
        side: RECONCILIATION_PRESERVATION_SIDE.local,
        content: "local",
      }),
    ).resolves.toMatchObject({ kind: "verified" });
    expect(localWriter.createPreservation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mode: LOCAL_RECONCILIATION_DISPATCH_MODE.sameOperationRecovery,
      }),
    );
  });

  it("returns persistence failure when ambiguous or blocked outcome metadata cannot be saved", async () => {
    for (const writerResult of [
      {
        kind: "failed",
        reason: "host-unavailable",
        effect: "unknown",
      },
      {
        kind: "refused",
        reason: "preservation-collision",
        effect: "definitely-refused",
      },
    ] as const) {
      const store = new Store();
      store.failAt = 2;
      const localWriter = writer();
      localWriter.createPreservation.mockResolvedValue(writerResult);
      await expect(
        new ConflictPreservationService(
          localWriter,
          new MirrorStateOwner(
            stateWithOperation(preservationOperation()),
            store,
          ),
          cryptography,
        ).preserve({
          operationId: OPERATION,
          side: RECONCILIATION_PRESERVATION_SIDE.local,
          content: "local",
        }),
      ).resolves.toMatchObject({
        kind: "rejected",
        reason: "persistence-failure",
      });
    }
  });

  it("refuses to redispatch a preservation requirement already verified", async () => {
    const localWriter = writer();
    await expect(
      new ConflictPreservationService(
        localWriter,
        new MirrorStateOwner(
          stateWithOperation(
            preservationOperation(RECONCILIATION_OPERATION_PHASE.preserving),
          ),
          new Store(),
        ),
        cryptography,
      ).preserve({
        operationId: OPERATION,
        side: RECONCILIATION_PRESERVATION_SIDE.local,
        content: "local",
      }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "wrong-phase" });
    expect(localWriter.createPreservation).not.toHaveBeenCalled();
  });

  it("retains every lexical reservation while preserving one side of a multi-path operation", async () => {
    const owner = new MirrorStateOwner(
      stateWithOperation(multiPathPreservationOperation()),
      new Store(),
    );
    const localWriter = writer();
    localWriter.createPreservation.mockResolvedValue({
      kind: "confirmed",
      outcome: "created",
      path: PRESERVATION_PATH,
      contentSha256: HASH_LOCAL,
      sizeBytes: 5,
    });
    const result = await new ConflictPreservationService(
      localWriter,
      owner,
      cryptography,
    ).preserve({
      operationId: OPERATION,
      side: RECONCILIATION_PRESERVATION_SIDE.local,
      content: "local",
    });
    expect(result.kind).toBe("verified");
    expect(
      owner.snapshot().state.reconciliationOperations[0]?.reservations,
    ).toEqual([
      { path: PATH, kind: RECONCILIATION_PATH_REFERENCE_KIND.reviewTarget },
      {
        path: DESTINATION,
        kind: RECONCILIATION_PATH_REFERENCE_KIND.newDestination,
      },
    ]);
  });

  it("treats an impossible confirmed preservation outcome as evidence-required", async () => {
    const owner = new MirrorStateOwner(
      stateWithOperation(preservationOperation()),
      new Store(),
    );
    const localWriter = writer();
    localWriter.createPreservation.mockResolvedValue({
      kind: "confirmed",
      outcome: "replaced",
      path: PRESERVATION_PATH,
      contentSha256: HASH_LOCAL,
      sizeBytes: 5,
    });
    await expect(
      new ConflictPreservationService(
        localWriter,
        owner,
        cryptography,
      ).preserve({
        operationId: OPERATION,
        side: RECONCILIATION_PRESERVATION_SIDE.local,
        content: "local",
      }),
    ).resolves.toMatchObject({ kind: "evidence-required" });
  });

  it("blocks mismatching restart artifacts and records ambiguous host effects", async () => {
    const blockedOwner = new MirrorStateOwner(
      stateWithOperation(preservationOperation()),
      new Store(),
    );
    const blockedWriter = writer();
    blockedWriter.createPreservation.mockResolvedValue({
      kind: "refused",
      reason: "preservation-collision",
      effect: "definitely-refused",
    });
    await expect(
      new ConflictPreservationService(
        blockedWriter,
        blockedOwner,
        cryptography,
      ).preserve({
        operationId: OPERATION,
        side: RECONCILIATION_PRESERVATION_SIDE.local,
        content: "local",
      }),
    ).resolves.toMatchObject({ kind: "blocked" });

    const unknownOwner = new MirrorStateOwner(
      stateWithOperation(preservationOperation()),
      new Store(),
    );
    const unknownWriter = writer();
    unknownWriter.createPreservation.mockResolvedValue({
      kind: "failed",
      reason: "host-unavailable",
      effect: "unknown",
    });
    await expect(
      new ConflictPreservationService(
        unknownWriter,
        unknownOwner,
        cryptography,
      ).preserve({
        operationId: OPERATION,
        side: RECONCILIATION_PRESERVATION_SIDE.local,
        content: "local",
      }),
    ).resolves.toMatchObject({ kind: "evidence-required" });
    expect(
      unknownOwner.snapshot().state.reconciliationOperations[0]?.phase,
    ).toBe(RECONCILIATION_OPERATION_PHASE.evidenceRequired);
  });
});

describe("LocalReconciliationWriteService", () => {
  it("authorizes exact absent adoption, persists pre-effect phase, and leaves confirmed work partial", async () => {
    const store = new Store();
    const owner = new MirrorStateOwner(
      stateWithOperation(adoptionOperation()),
      store,
    );
    const localWriter = writer();
    localWriter.createEligible.mockResolvedValue({
      kind: "confirmed",
      outcome: "created",
      path: PATH,
      contentSha256: HASH_REMOTE,
      sizeBytes: 6,
    });
    const service = new LocalReconciliationWriteService(
      localWriter,
      owner,
      cryptography,
    );
    await expect(
      service.createEligible({
        operationId: OPERATION,
        path: PATH,
        content: "remote",
      }),
    ).resolves.toMatchObject({ kind: "confirmed" });
    expect(store.saves[0]?.reconciliationOperations[0]?.phase).toBe(
      RECONCILIATION_OPERATION_PHASE.mutatingLocal,
    );
    const final = firstNonHistoryOperation(owner.snapshot().state);
    expect(final?.phase).toBe(RECONCILIATION_OPERATION_PHASE.partial);
    expect(final?.localEffect).toBe(MUTATION_EFFECT_CERTAINTY.confirmed);
    expect(isReconciliationPathReserved(owner.snapshot().state, PATH)).toBe(
      true,
    );
    const observations = new ReconciliationObservationGenerationOwner();
    const beforeOwnEvent = observations.ensure(PATH);
    const ownEvent = observations.observe(PATH);
    const successorExternalEdit = observations.observe(PATH);
    expect(ownEvent).toBeGreaterThan(beforeOwnEvent);
    expect(successorExternalEdit).toBeGreaterThan(ownEvent);
    expect(final?.snapshot.paths[0]?.local).toMatchObject({
      observationGeneration: 7,
    });
    expect(localWriter.createEligible).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: LOCAL_RECONCILIATION_DISPATCH_MODE.firstDispatch,
      }),
    );
  });

  it("retains every post-preparation host callback as durable successor evidence", async () => {
    const owner = new MirrorStateOwner(
      stateWithOperation(adoptionOperation()),
      new Store(),
    );
    const localWriter = writer();
    const generations = new ReconciliationObservationGenerationOwner();
    Array.from({ length: 7 }).forEach(() => {
      generations.observe(PATH);
    });
    let service: LocalReconciliationWriteService;
    localWriter.createEligible.mockImplementation(async () => {
      const generation = generations.observe(PATH);
      await service.observeReservedEvent(
        PATH,
        RECONCILIATION_EVENT_KIND.create,
        generation,
      );
      return {
        kind: "confirmed",
        outcome: LOCAL_RECONCILIATION_WRITE_OUTCOME.created,
        path: PATH,
        contentSha256: HASH_REMOTE,
        sizeBytes: 6,
      };
    });
    service = new LocalReconciliationWriteService(
      localWriter,
      owner,
      cryptography,
      {
        createEffectId: () => EFFECT,
        listenerEpoch: () => 1,
        currentGeneration: (path) => generations.current(path),
      },
    );

    await expect(
      service.createEligible({
        operationId: OPERATION,
        path: PATH,
        content: "remote",
      }),
    ).resolves.toMatchObject({ kind: "confirmed" });
    const laterGeneration = generations.observe(PATH);
    await expect(
      service.observeReservedEvent(
        PATH,
        RECONCILIATION_EVENT_KIND.modify,
        laterGeneration,
      ),
    ).resolves.toBe(true);

    expect(firstNonHistoryOperation(owner.snapshot().state)).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.successorReviewRequired,
      localEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
      localEffectObservation: {
        kind: LOCAL_EFFECT_OBSERVATION_KIND.confirmed,
        effectId: EFFECT,
        beforeGeneration: 7,
        postconditionHash: HASH_REMOTE,
        successor: {
          firstGeneration: 8,
          latestGeneration: 9,
          eventKinds: [
            RECONCILIATION_EVENT_KIND.create,
            RECONCILIATION_EVENT_KIND.modify,
          ],
        },
      },
    });
  });

  it("retains a local edit while a remote-only effect is pending", async () => {
    const owner = new MirrorStateOwner(
      stateWithOperation(remoteOnlyOperation()),
      new Store(),
    );
    const service = new LocalReconciliationWriteService(
      writer(),
      owner,
      cryptography,
    );

    await expect(
      service.observeReservedEvent(PATH, RECONCILIATION_EVENT_KIND.modify, 8),
    ).resolves.toBe(true);

    expect(firstNonHistoryOperation(owner.snapshot().state)).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.mutatingRemote,
      localEffectObservation: {
        kind: LOCAL_EFFECT_OBSERVATION_KIND.notRequired,
        successor: {
          firstGeneration: 8,
          latestGeneration: 8,
          eventKinds: [RECONCILIATION_EVENT_KIND.modify],
        },
      },
    });
  });

  it("retains callbacks from every reservation after preparing a local effect", async () => {
    const owner = new MirrorStateOwner(
      stateWithOperation(multiPathPreservationOperation()),
      new Store(),
    );
    const localWriter = writer();
    localWriter.createPreservation.mockResolvedValue({
      kind: "confirmed",
      outcome: LOCAL_RECONCILIATION_WRITE_OUTCOME.created,
      path: PRESERVATION_PATH,
      contentSha256: HASH_LOCAL,
      sizeBytes: 5,
    });
    await new ConflictPreservationService(
      localWriter,
      owner,
      cryptography,
    ).preserve({
      operationId: OPERATION,
      side: RECONCILIATION_PRESERVATION_SIDE.local,
      content: "local",
    });
    const generations = new ReconciliationObservationGenerationOwner();
    let service: LocalReconciliationWriteService;
    localWriter.createEligible.mockImplementation(async () => {
      await service.observeReservedEvent(
        PATH,
        RECONCILIATION_EVENT_KIND.modify,
        generations.observe(PATH),
      );
      return {
        kind: "confirmed",
        outcome: LOCAL_RECONCILIATION_WRITE_OUTCOME.created,
        path: DESTINATION,
        contentSha256: HASH_LOCAL,
        sizeBytes: 5,
      };
    });
    service = new LocalReconciliationWriteService(
      localWriter,
      owner,
      cryptography,
      {
        createEffectId: () => EFFECT,
        listenerEpoch: () => 1,
        currentGeneration: (path) => generations.current(path),
      },
    );

    await service.createEligible({
      operationId: OPERATION,
      path: DESTINATION,
      content: "local",
    });

    expect(firstNonHistoryOperation(owner.snapshot().state)).toMatchObject({
      localEffectObservation: {
        path: DESTINATION,
        successor: {
          firstGeneration: 1,
          latestGeneration: 1,
          eventKinds: [RECONCILIATION_EVENT_KIND.modify],
        },
      },
    });
  });

  it("rechecks lifecycle admission after asynchronous local source hashing", async () => {
    const owner = new MirrorStateOwner(
      stateWithOperation(adoptionOperation()),
      new Store(),
    );
    const localWriter = writer();
    let releaseHash: ((hash: ContentSha256) => void) | undefined;
    let markHashStarted: (() => void) | undefined;
    const hashStarted = new Promise<void>((resolve) => {
      markHashStarted = resolve;
    });
    const pendingHash = new Promise<ContentSha256>((resolve) => {
      releaseHash = resolve;
    });
    const service = new LocalReconciliationWriteService(localWriter, owner, {
      hashContent: vi.fn(() => {
        markHashStarted?.();
        return pendingHash;
      }),
    });
    const result = service.createEligible({
      operationId: OPERATION,
      path: PATH,
      content: "remote",
    });
    await hashStarted;
    await owner.transition((state) => ({
      ...state,
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.paused,
        associationId: ASSOCIATION,
        origin: "https://bridge.example",
        reason: MIRROR_PAUSE_REASON.manual,
      },
    }));
    required(releaseHash)(HASH_REMOTE);
    await expect(result).resolves.toMatchObject({
      kind: "rejected",
      reason: "operation-not-active",
    });
    expect(localWriter.createEligible).not.toHaveBeenCalled();
  });

  it("fences both local commands while the durable lifecycle is paused", async () => {
    const localWriter = writer();
    const service = new LocalReconciliationWriteService(
      localWriter,
      new MirrorStateOwner(
        pausedStateWithOperation(preservationOperation()),
        new Store(),
      ),
      cryptography,
    );
    await expect(
      service.createEligible({
        operationId: OPERATION,
        path: PATH,
        content: "remote",
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "operation-not-active",
    });
    await expect(
      service.replaceEligible({
        operationId: OPERATION,
        path: PATH,
        expectedContent: "local",
        replacementContent: "remote",
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "operation-not-active",
    });
    expect(localWriter.createEligible).not.toHaveBeenCalled();
    expect(localWriter.replaceEligible).not.toHaveBeenCalled();
  });

  it("performs exact compare-and-replace only after verified preservation", async () => {
    const owner = new MirrorStateOwner(
      stateWithOperation(
        preservationOperation(RECONCILIATION_OPERATION_PHASE.preserving),
      ),
      new Store(),
    );
    const localWriter = writer();
    localWriter.replaceEligible.mockResolvedValue({
      kind: "confirmed",
      outcome: "replaced",
      path: PATH,
      contentSha256: HASH_REMOTE,
      sizeBytes: 6,
    });
    const service = new LocalReconciliationWriteService(
      localWriter,
      owner,
      cryptography,
    );
    await expect(
      service.replaceEligible({
        operationId: OPERATION,
        path: PATH,
        expectedContent: "local",
        replacementContent: "remote",
      }),
    ).resolves.toMatchObject({ kind: "confirmed" });
    expect(localWriter.replaceEligible).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedContentSha256: HASH_LOCAL,
        replacementContentSha256: HASH_REMOTE,
        expectedObservationGeneration: 7,
      }),
    );
  });

  it("rejects missing ownership, wrong source evidence, and preservation-incomplete phase", async () => {
    const owner = new MirrorStateOwner(
      stateWithOperation(preservationOperation()),
      new Store(),
    );
    const localWriter = writer();
    const service = new LocalReconciliationWriteService(
      localWriter,
      owner,
      cryptography,
    );
    await expect(
      service.replaceEligible({
        operationId: REVIEW,
        path: PATH,
        expectedContent: "local",
        replacementContent: "remote",
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "operation-not-found",
    });
    await expect(
      new LocalReconciliationWriteService(
        localWriter,
        new MirrorStateOwner(
          stateWithOperation(
            preservationOperation(RECONCILIATION_OPERATION_PHASE.preserving),
          ),
          new Store(),
        ),
        cryptography,
      ).replaceEligible({
        operationId: OPERATION,
        path: PATH,
        expectedContent: "wrong",
        replacementContent: "remote",
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "source-evidence-mismatch",
    });
    await expect(
      service.replaceEligible({
        operationId: OPERATION,
        path: PATH,
        expectedContent: "local",
        replacementContent: "remote",
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "wrong-phase",
    });
    expect(localWriter.replaceEligible).not.toHaveBeenCalled();
  });

  it("reports inactive/wrong-action operations and pre-effect persistence failures without writer calls", async () => {
    const completed: ReconciliationOperation = {
      ...adoptionOperation(),
      phase: RECONCILIATION_OPERATION_PHASE.completed,
      localEffectObservation: confirmedLocalEffect(),
      localEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
    };
    const inactiveWriter = writer();
    await expect(
      new LocalReconciliationWriteService(
        inactiveWriter,
        new MirrorStateOwner(stateWithOperation(completed), new Store()),
        cryptography,
      ).createEligible({
        operationId: OPERATION,
        path: PATH,
        content: "remote",
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "operation-not-active",
    });

    const wrongAction: ReconciliationOperation = {
      ...preservationOperation(),
      action: { kind: RECONCILIATION_ACTION.keepLocal },
    };
    await expect(
      new LocalReconciliationWriteService(
        inactiveWriter,
        new MirrorStateOwner(stateWithOperation(wrongAction), new Store()),
        cryptography,
      ).createEligible({
        operationId: OPERATION,
        path: PATH,
        content: "remote",
      }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "wrong-action" });

    const failedStore = new Store();
    failedStore.failAt = 1;
    await expect(
      new LocalReconciliationWriteService(
        inactiveWriter,
        new MirrorStateOwner(
          stateWithOperation(adoptionOperation()),
          failedStore,
        ),
        cryptography,
      ).createEligible({
        operationId: OPERATION,
        path: PATH,
        content: "remote",
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "persistence-failure",
    });
    expect(inactiveWriter.createEligible).not.toHaveBeenCalled();
  });

  it("records proven refusal, defensive evidence mismatch, and post-effect save failure conservatively", async () => {
    const blockedOwner = new MirrorStateOwner(
      stateWithOperation(adoptionOperation()),
      new Store(),
    );
    const blockedWriter = writer();
    blockedWriter.createEligible.mockResolvedValue({
      kind: "refused",
      reason: "destination-file-exists",
      effect: "definitely-refused",
    });
    await expect(
      new LocalReconciliationWriteService(
        blockedWriter,
        blockedOwner,
        cryptography,
      ).createEligible({
        operationId: OPERATION,
        path: PATH,
        content: "remote",
      }),
    ).resolves.toMatchObject({ kind: "blocked" });

    const defensiveOwner = new MirrorStateOwner(
      stateWithOperation(adoptionOperation()),
      new Store(),
    );
    const defensiveWriter = writer();
    defensiveWriter.createEligible.mockResolvedValue({
      kind: "confirmed",
      outcome: "created",
      path: PATH,
      contentSha256: HASH_LOCAL,
      sizeBytes: 6,
    });
    await expect(
      new LocalReconciliationWriteService(
        defensiveWriter,
        defensiveOwner,
        cryptography,
      ).createEligible({
        operationId: OPERATION,
        path: PATH,
        content: "remote",
      }),
    ).resolves.toMatchObject({ kind: "evidence-required" });

    const impossibleOutcomeWriter = writer();
    impossibleOutcomeWriter.createEligible.mockResolvedValue({
      kind: "confirmed",
      outcome: "replaced",
      path: PATH,
      contentSha256: HASH_REMOTE,
      sizeBytes: 6,
    });
    await expect(
      new LocalReconciliationWriteService(
        impossibleOutcomeWriter,
        new MirrorStateOwner(
          stateWithOperation(adoptionOperation()),
          new Store(),
        ),
        cryptography,
      ).createEligible({
        operationId: OPERATION,
        path: PATH,
        content: "remote",
      }),
    ).resolves.toMatchObject({ kind: "evidence-required" });

    const failedStore = new Store();
    failedStore.failAt = 2;
    const failedWriter = writer();
    failedWriter.createEligible.mockResolvedValue({
      kind: "confirmed",
      outcome: "created",
      path: PATH,
      contentSha256: HASH_REMOTE,
      sizeBytes: 6,
    });
    const failedService = new LocalReconciliationWriteService(
      failedWriter,
      new MirrorStateOwner(
        stateWithOperation(adoptionOperation()),
        failedStore,
      ),
      cryptography,
    );
    await expect(
      failedService.createEligible({
        operationId: OPERATION,
        path: PATH,
        content: "remote",
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "persistence-failure",
    });
    await expect(
      failedService.createEligible({
        operationId: OPERATION,
        path: PATH,
        content: "remote",
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "persistence-failure",
    });
    expect(failedWriter.createEligible).toHaveBeenCalledTimes(1);
  });

  it("contains digest failure before preparing a local write", async () => {
    const localWriter = writer();
    const failedCryptography = {
      hashContent: vi.fn(async (): Promise<ContentSha256> => {
        throw new Error("unavailable");
      }),
    };
    await expect(
      new LocalReconciliationWriteService(
        localWriter,
        new MirrorStateOwner(
          stateWithOperation(adoptionOperation()),
          new Store(),
        ),
        failedCryptography,
      ).createEligible({
        operationId: OPERATION,
        path: PATH,
        content: "remote",
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "source-evidence-mismatch",
    });
    expect(localWriter.createEligible).not.toHaveBeenCalled();
  });

  it("rejects wrong-action and wrong-path replacement commands before writer dispatch", async () => {
    const localWriter = writer();
    const adoptionOwner = new MirrorStateOwner(
      stateWithOperation(adoptionOperation()),
      new Store(),
    );
    await expect(
      new LocalReconciliationWriteService(
        localWriter,
        adoptionOwner,
        cryptography,
      ).replaceEligible({
        operationId: OPERATION,
        path: PATH,
        expectedContent: "local",
        replacementContent: "remote",
      }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "wrong-action" });

    const liveOwner = new MirrorStateOwner(
      stateWithOperation(
        preservationOperation(RECONCILIATION_OPERATION_PHASE.preserving),
      ),
      new Store(),
    );
    await expect(
      new LocalReconciliationWriteService(
        localWriter,
        liveOwner,
        cryptography,
      ).replaceEligible({
        operationId: OPERATION,
        path: DESTINATION,
        expectedContent: "local",
        replacementContent: "remote",
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "path-evidence-mismatch",
    });
    expect(localWriter.replaceEligible).not.toHaveBeenCalled();
  });

  it("retains unknown certainty when operation state changes before settlement", async () => {
    const store = new Store();
    const owner = new MirrorStateOwner(
      stateWithOperation(adoptionOperation()),
      store,
    );
    const localWriter = writer();
    localWriter.createEligible.mockImplementationOnce(async () => {
      await owner.transition((state) => ({
        ...state,
        reconciliationOperations: state.reconciliationOperations.map(
          (operation) =>
            operation.operationId === OPERATION
              ? {
                  ...operation,
                  phase: RECONCILIATION_OPERATION_PHASE.blocked,
                }
              : operation,
        ),
      }));
      return {
        kind: "confirmed",
        outcome: "created",
        path: PATH,
        contentSha256: HASH_REMOTE,
        sizeBytes: 6,
      };
    });
    await expect(
      new LocalReconciliationWriteService(
        localWriter,
        owner,
        cryptography,
      ).createEligible({
        operationId: OPERATION,
        path: PATH,
        content: "remote",
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "persistence-failure",
    });
  });

  it("does not downgrade prior unknown certainty when exact recovery is refused", async () => {
    const operation: ReconciliationOperation = {
      ...preservationOperation(RECONCILIATION_OPERATION_PHASE.preserving),
      phase: RECONCILIATION_OPERATION_PHASE.evidenceRequired,
      localEffectObservation: preparedLocalEffect(),
      localEffect: MUTATION_EFFECT_CERTAINTY.unknown,
    };
    const owner = new MirrorStateOwner(
      stateWithOperation(operation),
      new Store(),
    );
    const localWriter = writer();
    localWriter.replaceEligible.mockResolvedValue({
      kind: "refused",
      reason: "stale-content",
      effect: "definitely-refused",
    });
    await expect(
      new LocalReconciliationWriteService(
        localWriter,
        owner,
        cryptography,
      ).replaceEligible({
        operationId: OPERATION,
        path: PATH,
        expectedContent: "local",
        replacementContent: "remote",
      }),
    ).resolves.toMatchObject({ kind: "evidence-required" });
    expect(firstNonHistoryOperation(owner.snapshot().state).localEffect).toBe(
      MUTATION_EFFECT_CERTAINTY.unknown,
    );
  });

  it("persists unknown local effects and permits only exact same-operation recovery", async () => {
    const owner = new MirrorStateOwner(
      stateWithOperation(adoptionOperation()),
      new Store(),
    );
    const localWriter = writer();
    localWriter.createEligible
      .mockResolvedValueOnce({
        kind: "failed",
        reason: "host-unavailable",
        effect: "unknown",
      })
      .mockResolvedValueOnce({
        kind: "confirmed",
        outcome: "adopted",
        path: PATH,
        contentSha256: HASH_REMOTE,
        sizeBytes: 6,
      });
    const service = new LocalReconciliationWriteService(
      localWriter,
      owner,
      cryptography,
    );
    await expect(
      service.createEligible({
        operationId: OPERATION,
        path: PATH,
        content: "remote",
      }),
    ).resolves.toMatchObject({ kind: "evidence-required" });
    expect(firstNonHistoryOperation(owner.snapshot().state).localEffect).toBe(
      MUTATION_EFFECT_CERTAINTY.unknown,
    );
    await expect(
      service.createEligible({
        operationId: OPERATION,
        path: PATH,
        content: "remote",
      }),
    ).resolves.toMatchObject({ kind: "confirmed" });
    expect(localWriter.createEligible).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mode: LOCAL_RECONCILIATION_DISPATCH_MODE.sameOperationRecovery,
      }),
    );
  });
});
