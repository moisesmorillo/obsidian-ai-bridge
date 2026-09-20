import {
  deriveMigratedLocalPostcondition,
  deriveRecoveredV3Phase,
} from "@core/mirror/reconciliation-v3-local-effect-recovery";
import {
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  createRecoverySnapshotId,
  isMirrorDeviceStateConsistent,
  isNonHistoryReconciliationOperation,
  isReconciliationPathReserved,
  LEGACY_V3_LOCAL_EFFECT_RECOVERY_STATE,
  LOCAL_EFFECT_OBSERVATION_KIND,
  LocalInspectionKind,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  type MirrorDeviceState,
  MirrorStateOwner,
  type MirrorStateStore,
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
  RECONCILIATION_PRESERVATION_SCOPE,
  RECONCILIATION_PRESERVATION_SIDE,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
  RECONCILIATION_REVIEW_RETENTION,
  RECONCILIATION_REVIEW_STATUS,
  RECOVERY_SNAPSHOT_STATE_KIND,
  type ReadOnlyLocalVault,
  type ReconciliationNonHistoryOperation,
  type ReconciliationOperationPhaseV3,
  type ReconciliationReviewSnapshot,
  ReconciliationV3LocalEffectRecoveryService,
} from "@obsidian-ai-bridge/core";
import { describe, expect, it, vi } from "vitest";

/**
 * @param value - Optional validated fixture value.
 * @returns Required validated fixture identity.
 */
function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("Invalid migration recovery fixture.");
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
  createMirrorOperationId("55555555-5555-4555-8555-555555555555"),
);
const RECOVERY = required(
  createRecoverySnapshotId("88888888-8888-4888-8888-888888888888"),
);
const REVISION_A = required(
  createApplicationRevision("66666666-6666-4666-8666-666666666666"),
);
const REVISION_B = required(
  createApplicationRevision("77777777-7777-4777-8777-777777777777"),
);
const LOCAL_HASH = required(createContentSha256("11".repeat(32)));
const REMOTE_HASH = required(createContentSha256("22".repeat(32)));
const PATH = required(normalizeNotePath("notes/migrated.md"));
const DESTINATION = required(normalizeNotePath("notes/recovered-copy.md"));

/** Selectable persistent store used to assert startup fencing and idempotence. */
class Store implements MirrorStateStore {
  readonly saves: MirrorDeviceState[] = [];
  fail = false;

  /** @inheritdoc */
  async save(state: MirrorDeviceState) {
    if (this.fail) return { kind: "failed", reason: "unavailable" } as const;
    this.saves.push(state);
    return { kind: "saved" } as const;
  }
}

/** @returns Exact v3-era immutable adoption snapshot. */
function snapshot(): ReconciliationReviewSnapshot {
  return {
    runtime: {
      runtimeOwnerVersion: 3,
      configurationGeneration: 1,
      listenerEpoch: 3,
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
        local: {
          kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.absent,
          stability: RECONCILIATION_LOCAL_STABILITY.stable,
          observationGeneration: 7,
        },
        baseline: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision: REVISION_A,
          contentSha256: LOCAL_HASH,
        },
        remote: {
          kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
          associationId: ASSOCIATION,
          revision: REVISION_B,
          contentSha256: REMOTE_HASH,
          receipt: {
            action: "update",
            associationId: ASSOCIATION,
            operationId: EFFECT,
            precondition: { kind: "matching-revision", revision: REVISION_A },
            contentSha256: REMOTE_HASH,
          },
        },
        m3: { unresolvedMutation: null, deferredHistory: null },
      },
    ],
    recovery: null,
  };
}

/**
 * @param localEffect - Historical aggregate local certainty.
 * @param priorPhase - Exact pre-projection v3 operation phase.
 * @returns Valid projected v4 blocker retaining exact prior v3 phase/effect certainty.
 */
function migratedState(
  localEffect:
    | typeof MUTATION_EFFECT_CERTAINTY.confirmed
    | typeof MUTATION_EFFECT_CERTAINTY.unknown,
  priorPhase: ReconciliationOperationPhaseV3 = RECONCILIATION_OPERATION_PHASE.partial,
): MirrorDeviceState {
  const completed = priorPhase === RECONCILIATION_OPERATION_PHASE.completed;
  const operationSnapshot = snapshot();
  return {
    deviceId: DEVICE,
    lifecycle: operationSnapshot.runtime.lifecycle,
    globalBlockReason: null,
    paths: [
      {
        path: PATH,
        acknowledgement: completed
          ? {
              kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
              revision: REVISION_B,
              contentSha256: REMOTE_HASH,
            }
          : {
              kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
              revision: REVISION_A,
              contentSha256: LOCAL_HASH,
            },
        unresolvedMutation: null,
        desired: { kind: "none" },
        blockedReason: null,
      },
    ],
    stagedHandoff: null,
    reconciliationReviews: [
      {
        retention: RECONCILIATION_REVIEW_RETENTION.durable,
        reviewId: REVIEW,
        classification: RECONCILIATION_CLASSIFICATION.localMissing,
        status: RECONCILIATION_REVIEW_STATUS.staged,
        snapshot: operationSnapshot,
        operationId: OPERATION,
      },
    ],
    reconciliationOperations: [
      {
        operationId: OPERATION,
        reviewId: REVIEW,
        authority: RECONCILIATION_AUTHORITY_SOURCE.adoptionDecision,
        action: { kind: RECONCILIATION_ACTION.adoptRevision },
        phase: RECONCILIATION_OPERATION_PHASE.blocked,
        snapshot: operationSnapshot,
        destinationPath: null,
        reservations: [
          {
            path: PATH,
            kind: RECONCILIATION_PATH_REFERENCE_KIND.reviewTarget,
          },
        ],
        preservationReceipts: [],
        successorOperationId: null,
        localEffect,
        remoteEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
        localEffectObservation: {
          kind: LOCAL_EFFECT_OBSERVATION_KIND.legacyV3Unfenced,
          priorPhase,
          recoveryState: LEGACY_V3_LOCAL_EFFECT_RECOVERY_STATE.pending,
        },
      },
    ],
  };
}

/** @returns Valid migrated Use remote blocker whose local effect was a replace. */
function migratedReplaceState(): MirrorDeviceState {
  const base = migratedState(MUTATION_EFFECT_CERTAINTY.confirmed);
  const review = required(base.reconciliationReviews[0]);
  const currentOperation = operation(base);
  const target = required(currentOperation.snapshot.paths[0]);
  const replacementSnapshot: ReconciliationReviewSnapshot = {
    ...currentOperation.snapshot,
    paths: [
      {
        ...target,
        local: {
          kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.live,
          stability: RECONCILIATION_LOCAL_STABILITY.stable,
          observationGeneration: 7,
          byteSize: 5,
          contentSha256: LOCAL_HASH,
        },
      },
    ],
  };
  return {
    ...base,
    reconciliationReviews: [
      {
        ...review,
        classification: RECONCILIATION_CLASSIFICATION.remoteAhead,
        snapshot: replacementSnapshot,
      },
    ],
    reconciliationOperations: [
      {
        ...currentOperation,
        authority: RECONCILIATION_AUTHORITY_SOURCE.reconciliationDecision,
        action: { kind: RECONCILIATION_ACTION.useRemote },
        snapshot: replacementSnapshot,
        preservationReceipts: [
          {
            scope: RECONCILIATION_PRESERVATION_SCOPE.operation,
            operationId: OPERATION,
            originalPath: PATH,
            side: RECONCILIATION_PRESERVATION_SIDE.local,
            sourceRevision: null,
            contentSha256: LOCAL_HASH,
            preservationPath: `.ai-bridge-conflicts/${OPERATION}/local.md`,
            proofState: RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
          },
        ],
      },
    ],
  };
}

/** @returns Valid migrated Keep both blocker with a local-primary destination copy. */
function migratedKeepBothState(): MirrorDeviceState {
  const base = migratedReplaceState();
  const review = required(base.reconciliationReviews[0]);
  const current = operation(base);
  const target = required(current.snapshot.paths[0]);
  const keepBothSnapshot: ReconciliationReviewSnapshot = {
    ...current.snapshot,
    paths: [
      target,
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
  };
  return {
    ...base,
    reconciliationReviews: [
      {
        ...review,
        classification: RECONCILIATION_CLASSIFICATION.bothChanged,
        snapshot: keepBothSnapshot,
      },
    ],
    reconciliationOperations: [
      {
        ...current,
        action: {
          kind: RECONCILIATION_ACTION.keepBoth,
          primarySide: RECONCILIATION_PRESERVATION_SIDE.local,
        },
        snapshot: keepBothSnapshot,
        destinationPath: DESTINATION,
        reservations: [
          ...current.reservations,
          {
            path: DESTINATION,
            kind: RECONCILIATION_PATH_REFERENCE_KIND.newDestination,
          },
        ],
        preservationReceipts: [
          {
            scope: RECONCILIATION_PRESERVATION_SCOPE.operation,
            operationId: OPERATION,
            originalPath: PATH,
            side: RECONCILIATION_PRESERVATION_SIDE.remote,
            sourceRevision: REVISION_B,
            contentSha256: REMOTE_HASH,
            preservationPath: `.ai-bridge-conflicts/${OPERATION}/remote.md`,
            proofState: RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
          },
        ],
      },
    ],
  };
}

/**
 * @param result - Selected postcondition evidence or a thrown-adapter fixture.
 * @returns Read-only local adapter returning the selected postcondition evidence.
 */
function local(
  result: Awaited<ReturnType<ReadOnlyLocalVault["read"]>> | Error,
): {
  readonly port: ReadOnlyLocalVault;
  readonly read: ReturnType<typeof vi.fn>;
} {
  const read = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return {
    port: {
      list: vi.fn(async () => ({
        kind: LocalInspectionKind.ok,
        entries: [],
        skipped: {
          unsupported_file: 0,
          excluded_location: 0,
          invalid_path: 0,
          oversized: 0,
        },
      })),
      read,
    },
    read,
  };
}

/**
 * @param state - Initial migrated device state.
 * @param readResult - Selected current local evidence.
 * @param hashFails - Whether hashing must fail closed.
 * @returns Recovery service plus durable owner/store for assertions.
 */
function harness(
  state: MirrorDeviceState,
  readResult: Awaited<ReturnType<ReadOnlyLocalVault["read"]>> | Error,
  hashFails = false,
) {
  const store = new Store();
  const stateOwner = new MirrorStateOwner(state, store);
  const localVault = local(readResult);
  const localWriterDispatch = vi.fn();
  const service = new ReconciliationV3LocalEffectRecoveryService({
    local: localVault.port,
    stateOwner,
    hashContent: async (content) => {
      if (hashFails) throw new Error("expected hash failure");
      return content === "remote" ? REMOTE_HASH : LOCAL_HASH;
    },
    createEffectId: () => EFFECT,
  });
  return {
    service,
    stateOwner,
    store,
    readLocal: localVault.read,
    localWriterDispatch,
  };
}

/** @returns Current ordinary operation after one recovery transition. */
function operation(state: MirrorDeviceState) {
  const current = state.reconciliationOperations[0];
  if (current === undefined || !isNonHistoryReconciliationOperation(current)) {
    throw new Error("Expected recovered ordinary operation.");
  }
  return current;
}

describe("ReconciliationV3LocalEffectRecoveryService", () => {
  it("confirms exact current bytes for a v3 confirmed local replace", async () => {
    const subject = harness(migratedReplaceState(), {
      kind: LocalInspectionKind.ok,
      content: "remote",
      sizeBytes: 6,
    });

    await expect(subject.service.recover()).resolves.toMatchObject({
      kind: "completed",
      recoveredOperations: 1,
    });
    const recovered = subject.stateOwner.snapshot().state;
    expect(operation(recovered)).toMatchObject({
      localEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
      localEffectObservation: {
        kind: LOCAL_EFFECT_OBSERVATION_KIND.recoveredV3,
        path: PATH,
        expectedHash: REMOTE_HASH,
      },
    });
    const current = operation(recovered);
    if (
      current.localEffectObservation.kind !==
      LOCAL_EFFECT_OBSERVATION_KIND.recoveredV3
    ) {
      throw new Error("Expected recovered local-effect observation.");
    }
    expect(
      isMirrorDeviceStateConsistent({
        ...recovered,
        reconciliationOperations: [
          {
            ...current,
            localEffectObservation: {
              ...current.localEffectObservation,
              expectedHash: LOCAL_HASH,
              postconditionHash: LOCAL_HASH,
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("recovers the exact Keep both destination selected by durable primary-side evidence", async () => {
    const subject = harness(migratedKeepBothState(), {
      kind: LocalInspectionKind.ok,
      content: "remote",
      sizeBytes: 6,
    });

    await expect(subject.service.recover()).resolves.toMatchObject({
      kind: "completed",
      recoveredOperations: 1,
    });
    expect(operation(subject.stateOwner.snapshot().state)).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.partial,
      localEffectObservation: {
        kind: LOCAL_EFFECT_OBSERVATION_KIND.recoveredV3,
        path: DESTINATION,
        expectedHash: REMOTE_HASH,
      },
    });
  });

  it.each([
    {
      remoteEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
      expectedPath: DESTINATION,
      content: "local",
      expectedHash: LOCAL_HASH,
    },
    {
      remoteEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
      expectedPath: PATH,
      content: "remote",
      expectedHash: REMOTE_HASH,
    },
  ] as const)(
    "recovers remote-primary Keep both at $expectedPath from exact effect progress",
    async ({ remoteEffect, expectedPath, content, expectedHash }) => {
      const initial = migratedKeepBothState();
      const current = operation(initial);
      const remotePrimary: MirrorDeviceState = {
        ...initial,
        reconciliationOperations: [
          {
            ...current,
            action: {
              kind: RECONCILIATION_ACTION.keepBoth,
              primarySide: RECONCILIATION_PRESERVATION_SIDE.remote,
            },
            remoteEffect,
            preservationReceipts: [
              {
                scope: RECONCILIATION_PRESERVATION_SCOPE.operation,
                operationId: OPERATION,
                originalPath: PATH,
                side: RECONCILIATION_PRESERVATION_SIDE.local,
                sourceRevision: null,
                contentSha256: LOCAL_HASH,
                preservationPath: `.ai-bridge-conflicts/${OPERATION}/local.md`,
                proofState: RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
              },
            ],
          },
        ],
      };
      const subject = harness(remotePrimary, {
        kind: LocalInspectionKind.ok,
        content,
        sizeBytes: content.length,
      });

      await expect(subject.service.recover()).resolves.toMatchObject({
        kind: "completed",
        recoveredOperations: 1,
      });
      expect(operation(subject.stateOwner.snapshot().state)).toMatchObject({
        localEffectObservation: {
          kind: LOCAL_EFFECT_OBSERVATION_KIND.recoveredV3,
          path: expectedPath,
          expectedHash,
        },
      });
    },
  );

  it("recovers a legacy fork destination from the immutable remote digest", async () => {
    const initial = migratedKeepBothState();
    const review = required(initial.reconciliationReviews[0]);
    const current = operation(initial);
    const target = required(current.snapshot.paths[0]);
    const forkSnapshot: ReconciliationReviewSnapshot = {
      ...current.snapshot,
      paths: [
        {
          ...target,
          remote: {
            kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy,
            contentSha256: REMOTE_HASH,
          },
        },
        required(current.snapshot.paths[1]),
      ],
    };
    const forkState: MirrorDeviceState = {
      ...initial,
      reconciliationReviews: [
        {
          ...review,
          classification: RECONCILIATION_CLASSIFICATION.legacyRemote,
          snapshot: forkSnapshot,
        },
      ],
      reconciliationOperations: [
        {
          ...current,
          authority: RECONCILIATION_AUTHORITY_SOURCE.adoptionDecision,
          action: { kind: RECONCILIATION_ACTION.forkLegacy },
          snapshot: forkSnapshot,
          preservationReceipts: [
            {
              scope: RECONCILIATION_PRESERVATION_SCOPE.operation,
              operationId: OPERATION,
              originalPath: PATH,
              side: RECONCILIATION_PRESERVATION_SIDE.remote,
              sourceRevision: null,
              contentSha256: REMOTE_HASH,
              preservationPath: `.ai-bridge-conflicts/${OPERATION}/remote.md`,
              proofState: RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
            },
          ],
        },
      ],
    };
    const subject = harness(forkState, {
      kind: LocalInspectionKind.ok,
      content: "remote",
      sizeBytes: 6,
    });

    await expect(subject.service.recover()).resolves.toMatchObject({
      kind: "completed",
      recoveredOperations: 1,
    });
    expect(operation(subject.stateOwner.snapshot().state)).toMatchObject({
      localEffectObservation: {
        kind: LOCAL_EFFECT_OBSERVATION_KIND.recoveredV3,
        path: DESTINATION,
        expectedHash: REMOTE_HASH,
      },
    });
  });

  it("derives restore evidence and rejects actions with no local effect channel", () => {
    const current = operation(
      migratedState(MUTATION_EFFECT_CERTAINTY.confirmed),
    );
    const restore: ReconciliationNonHistoryOperation = {
      ...current,
      action: { kind: RECONCILIATION_ACTION.restoreRecovery },
      snapshot: {
        ...current.snapshot,
        recovery: {
          kind: RECOVERY_SNAPSHOT_STATE_KIND.prepared,
          id: RECOVERY,
          associationId: ASSOCIATION,
          path: PATH,
          revision: REVISION_B,
          sourceRevision: REVISION_A,
          contentSha256: REMOTE_HASH,
        },
      },
    };

    expect(deriveMigratedLocalPostcondition(restore)).toEqual({
      path: PATH,
      expectedHash: REMOTE_HASH,
      beforeGeneration: 7,
    });
    expect(
      deriveMigratedLocalPostcondition({
        ...restore,
        snapshot: { ...restore.snapshot, recovery: null },
      }),
    ).toBeUndefined();
    for (const kind of [
      RECONCILIATION_ACTION.keepLocal,
      RECONCILIATION_ACTION.acceptTombstone,
      RECONCILIATION_ACTION.recreateRemote,
      RECONCILIATION_ACTION.defer,
    ] as const) {
      expect(
        deriveMigratedLocalPostcondition({ ...current, action: { kind } }),
      ).toBeUndefined();
    }
  });

  it("fails closed for incomplete Keep both migration evidence", () => {
    const current = operation(migratedKeepBothState());
    const target = required(current.snapshot.paths[0]);
    const destination = required(current.snapshot.paths[1]);
    /**
     * @param replacement - Alternate target evidence.
     * @returns Operation retaining the exact destination.
     */
    const withTarget = (
      replacement: ReconciliationReviewSnapshot["paths"][number],
    ): ReconciliationNonHistoryOperation => ({
      ...current,
      snapshot: { ...current.snapshot, paths: [replacement, destination] },
    });

    expect(
      deriveMigratedLocalPostcondition(
        withTarget({
          ...target,
          local: {
            kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.absent,
            stability: RECONCILIATION_LOCAL_STABILITY.stable,
            observationGeneration: 7,
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      deriveMigratedLocalPostcondition(
        withTarget({
          ...target,
          remote: {
            kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone,
            associationId: ASSOCIATION,
            revision: REVISION_B,
            deletedRevision: REVISION_A,
            recoveryId: RECOVERY,
            receipt: {
              action: "tombstone",
              associationId: ASSOCIATION,
              operationId: RECOVERY,
              precondition: {
                kind: "matching-revision",
                revision: REVISION_A,
              },
            },
          },
        }),
      ),
    ).toEqual({
      path: DESTINATION,
      expectedHash: LOCAL_HASH,
      beforeGeneration: 8,
    });
    expect(
      deriveMigratedLocalPostcondition(
        withTarget({
          ...target,
          remote: { kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.absent },
        }),
      ),
    ).toBeUndefined();
    expect(
      deriveRecoveredV3Phase(
        {
          ...current,
          action: { kind: RECONCILIATION_ACTION.restoreRecovery },
        },
        RECONCILIATION_OPERATION_PHASE.partial,
      ),
    ).toBe(RECONCILIATION_OPERATION_PHASE.restoredPendingReview);
    expect(
      deriveRecoveredV3Phase(
        {
          ...current,
          remoteEffect: MUTATION_EFFECT_CERTAINTY.unknown,
        },
        RECONCILIATION_OPERATION_PHASE.partial,
      ),
    ).toBe(RECONCILIATION_OPERATION_PHASE.evidenceRequired);
  });

  it.each([
    MUTATION_EFFECT_CERTAINTY.confirmed,
    MUTATION_EFFECT_CERTAINTY.unknown,
  ])(
    "confirms exact current bytes for a v3 %s local effect without redispatch",
    async (effect) => {
      const subject = harness(migratedState(effect), {
        kind: LocalInspectionKind.ok,
        content: "remote",
        sizeBytes: 6,
      });

      await expect(subject.service.recover()).resolves.toMatchObject({
        kind: "completed",
        recoveredOperations: 1,
      });
      const current = operation(subject.stateOwner.snapshot().state);
      expect(current).toMatchObject({
        phase: RECONCILIATION_OPERATION_PHASE.partial,
        localEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
        localEffectObservation: {
          kind: LOCAL_EFFECT_OBSERVATION_KIND.recoveredV3,
          effectId: EFFECT,
          path: PATH,
          expectedHash: REMOTE_HASH,
          listenerEpoch: 3,
          beforeGeneration: 7,
          postconditionHash: REMOTE_HASH,
          successor: null,
        },
      });
      expect(subject.localWriterDispatch).not.toHaveBeenCalled();
      expect(
        isReconciliationPathReserved(subject.stateOwner.snapshot().state, PATH),
      ).toBe(true);
    },
  );

  it.each([
    {
      label: "changed bytes",
      read: {
        kind: LocalInspectionKind.ok,
        content: "changed",
        sizeBytes: 7,
      } as const,
      phase: RECONCILIATION_OPERATION_PHASE.blocked,
    },
    {
      label: "definite absence",
      read: {
        kind: LocalInspectionKind.failed,
        reason: "missing_file",
      } as const,
      phase: RECONCILIATION_OPERATION_PHASE.blocked,
    },
    {
      label: "unavailable read",
      read: {
        kind: LocalInspectionKind.failed,
        reason: "unavailable",
      } as const,
      phase: RECONCILIATION_OPERATION_PHASE.evidenceRequired,
    },
    {
      label: "ambiguous changing read",
      read: {
        kind: LocalInspectionKind.failed,
        reason: "changed_during_read",
      } as const,
      phase: RECONCILIATION_OPERATION_PHASE.evidenceRequired,
    },
    {
      label: "thrown local inspection",
      read: new Error("expected read failure"),
      phase: RECONCILIATION_OPERATION_PHASE.evidenceRequired,
    },
  ])("persists $label as $phase", async ({ read, phase }) => {
    const subject = harness(
      migratedState(MUTATION_EFFECT_CERTAINTY.unknown),
      read,
    );

    await expect(subject.service.recover()).resolves.toMatchObject({
      kind: "completed",
      recoveredOperations: 0,
    });
    expect(operation(subject.stateOwner.snapshot().state)).toMatchObject({
      phase,
      localEffectObservation: {
        kind: LOCAL_EFFECT_OBSERVATION_KIND.legacyV3Unfenced,
        recoveryState:
          phase === RECONCILIATION_OPERATION_PHASE.evidenceRequired
            ? LEGACY_V3_LOCAL_EFFECT_RECOVERY_STATE.evidenceRequired
            : LEGACY_V3_LOCAL_EFFECT_RECOVERY_STATE.blocked,
      },
    });
    await expect(subject.service.recover()).resolves.toMatchObject({
      kind: "completed",
      recoveredOperations: 0,
    });
    expect(subject.store.saves).toHaveLength(1);
  });

  it("retains evidence-required when hashing current bytes is unavailable", async () => {
    const subject = harness(
      migratedState(MUTATION_EFFECT_CERTAINTY.unknown),
      {
        kind: LocalInspectionKind.ok,
        content: "remote",
        sizeBytes: 6,
      },
      true,
    );

    await expect(subject.service.recover()).resolves.toMatchObject({
      kind: "completed",
      recoveredOperations: 0,
    });
    expect(operation(subject.stateOwner.snapshot().state)).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.evidenceRequired,
      localEffectObservation: {
        recoveryState: LEGACY_V3_LOCAL_EFFECT_RECOVERY_STATE.evidenceRequired,
      },
    });
  });

  it("fails closed when recovery authority becomes stale during an asynchronous read", async () => {
    const initial = migratedState(MUTATION_EFFECT_CERTAINTY.confirmed);
    const store = new Store();
    const stateOwner = new MirrorStateOwner(initial, store);
    const read =
      Promise.withResolvers<Awaited<ReturnType<ReadOnlyLocalVault["read"]>>>();
    const service = new ReconciliationV3LocalEffectRecoveryService({
      local: {
        list: vi.fn(async () => ({
          kind: LocalInspectionKind.ok,
          entries: [],
          skipped: {
            unsupported_file: 0,
            excluded_location: 0,
            invalid_path: 0,
            oversized: 0,
          },
        })),
        read: vi.fn(async () => read.promise),
      },
      stateOwner,
      hashContent: async () => REMOTE_HASH,
      createEffectId: () => EFFECT,
    });

    const pending = service.recover();
    await Promise.resolve();
    await stateOwner.transition((state) => ({
      ...state,
      reconciliationOperations: state.reconciliationOperations.map(
        (candidate) =>
          candidate.operationId === OPERATION &&
          isNonHistoryReconciliationOperation(candidate) &&
          candidate.localEffectObservation.kind ===
            LOCAL_EFFECT_OBSERVATION_KIND.legacyV3Unfenced
            ? {
                ...candidate,
                localEffectObservation: {
                  ...candidate.localEffectObservation,
                  recoveryState: LEGACY_V3_LOCAL_EFFECT_RECOVERY_STATE.blocked,
                },
              }
            : candidate,
      ),
    }));
    read.resolve({
      kind: LocalInspectionKind.ok,
      content: "remote",
      sizeBytes: 6,
    });

    await expect(pending).resolves.toMatchObject({ kind: "unavailable" });
    expect(operation(stateOwner.snapshot().state)).toMatchObject({
      localEffectObservation: {
        recoveryState: LEGACY_V3_LOCAL_EFFECT_RECOVERY_STATE.blocked,
      },
    });
  });

  it("does not retry a definitively blocked migration effect after restart", async () => {
    const initial = migratedState(MUTATION_EFFECT_CERTAINTY.unknown);
    const current = operation(initial);
    const blocked: MirrorDeviceState = {
      ...initial,
      reconciliationOperations: [
        {
          ...current,
          localEffectObservation: {
            kind: LOCAL_EFFECT_OBSERVATION_KIND.legacyV3Unfenced,
            priorPhase: RECONCILIATION_OPERATION_PHASE.partial,
            recoveryState: LEGACY_V3_LOCAL_EFFECT_RECOVERY_STATE.blocked,
          },
        },
      ],
    };
    const subject = harness(blocked, {
      kind: LocalInspectionKind.ok,
      content: "remote",
      sizeBytes: 6,
    });

    await expect(subject.service.recover()).resolves.toMatchObject({
      kind: "completed",
      recoveredOperations: 0,
    });
    expect(subject.readLocal).not.toHaveBeenCalled();
    expect(subject.store.saves).toHaveLength(0);
  });

  it("fails startup closed on state save failure and retries idempotently after restart", async () => {
    const initial = migratedState(MUTATION_EFFECT_CERTAINTY.confirmed);
    const first = harness(initial, {
      kind: LocalInspectionKind.ok,
      content: "remote",
      sizeBytes: 6,
    });
    first.store.fail = true;

    await expect(first.service.recover()).resolves.toMatchObject({
      kind: "unavailable",
    });
    expect(
      operation(first.stateOwner.snapshot().state).localEffectObservation,
    ).toEqual({
      kind: LOCAL_EFFECT_OBSERVATION_KIND.legacyV3Unfenced,
      priorPhase: RECONCILIATION_OPERATION_PHASE.partial,
      recoveryState: LEGACY_V3_LOCAL_EFFECT_RECOVERY_STATE.pending,
    });

    const restarted = harness(initial, {
      kind: LocalInspectionKind.ok,
      content: "remote",
      sizeBytes: 6,
    });
    const recovered = await restarted.service.recover();
    expect(recovered).toMatchObject({
      kind: "completed",
      recoveredOperations: 1,
    });
    await expect(restarted.service.recover()).resolves.toMatchObject({
      kind: "completed",
      recoveredOperations: 0,
    });
    expect(restarted.store.saves).toHaveLength(1);
  });

  it("restores an exactly proven terminal v3 operation without retaining reservations", async () => {
    const subject = harness(
      migratedState(
        MUTATION_EFFECT_CERTAINTY.confirmed,
        RECONCILIATION_OPERATION_PHASE.completed,
      ),
      {
        kind: LocalInspectionKind.ok,
        content: "remote",
        sizeBytes: 6,
      },
    );

    await expect(subject.service.recover()).resolves.toMatchObject({
      kind: "completed",
      recoveredOperations: 1,
    });
    const snapshot = subject.stateOwner.snapshot();
    expect(operation(snapshot.state).phase).toBe(
      RECONCILIATION_OPERATION_PHASE.completed,
    );
    expect(snapshot.state.reconciliationReviews[0]?.status).toBe(
      RECONCILIATION_REVIEW_STATUS.completed,
    );
    expect(isReconciliationPathReserved(snapshot.state, PATH)).toBe(false);
    expect(snapshot.mutationAdmissionAllowed).toBe(true);
  });
});
