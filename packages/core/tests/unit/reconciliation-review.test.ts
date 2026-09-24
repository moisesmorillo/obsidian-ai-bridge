import {
  allowedReconciliationActions,
  type CurrentNoteState,
  classifyReconciliation,
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  createReconciliationPreservationPath,
  fenceActiveReconciliationForObservationGap,
  HISTORY_CLEANUP_STEP_PHASE,
  HISTORY_DECISION_KIND,
  HISTORY_PROGRESS_KIND,
  HISTORY_REMOTE_EFFECT_KIND,
  inspectBoundedMirrorInventory,
  inspectBoundedRecoveryInventory,
  isGapFencedReconciliationOperation,
  isNonHistoryReconciliationOperation,
  isReconciliationActionAllowed,
  isRefinedHistoryReconciliationOperation,
  LEGACY_RECONCILIATION_PRESERVATION_ROOT,
  LOCAL_EFFECT_OBSERVATION_KIND,
  LocalInspectionKind,
  LocalVaultFailureReason,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_GLOBAL_BLOCK_REASON,
  MIRROR_PATH_BLOCK_REASON,
  MIRROR_PAUSE_REASON,
  MIRROR_RENAME_PHASE,
  type MirrorDeviceState,
  type MirrorOperationId,
  MirrorStateOwner,
  type MirrorStateStore,
  MUTATION_EFFECT_CERTAINTY,
  type NotePath,
  normalizeNotePath,
  RECONCILIATION_ACTION,
  RECONCILIATION_AUTHORITY_SOURCE,
  RECONCILIATION_CLASSIFICATION,
  RECONCILIATION_EVENT_KIND,
  RECONCILIATION_GAP_REVIEW_STATUS,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_LOCAL_STABILITY,
  RECONCILIATION_OBSERVATION_COVERAGE,
  RECONCILIATION_OPERATION_PHASE,
  RECONCILIATION_PATH_REFERENCE_KIND,
  RECONCILIATION_PRESERVATION_PROOF_STATE,
  RECONCILIATION_PRESERVATION_ROOT,
  RECONCILIATION_PRESERVATION_SCOPE,
  RECONCILIATION_PRESERVATION_SIDE,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
  RECOVERY_SNAPSHOT_STATE_KIND,
  REMOTE_BRIDGE_FAILURE,
  type ReadOnlyLocalVault,
  type ReconciliationAction,
  type ReconciliationAdmissionAction,
  ReconciliationObservationGenerationOwner,
  type ReconciliationPathEvidence,
  type ReconciliationRemoteReader,
  ReconciliationReviewService,
  type ReconciliationReviewSnapshot,
  type RecoverySnapshotState,
  type RemoteBridgeDescription,
  type RemoteBridgeResult,
  reconciliationAuthorityForAction,
  reconciliationReviewSnapshotsEqual,
} from "@obsidian-ai-bridge/core";
import { describe, expect, it, vi } from "vitest";

/**
 * Converts a validated fixture identifier into a required test value.
 * @param value - Identifier result produced by the production validator.
 * @returns The validated identifier.
 */
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Invalid review fixture.");
  return value;
}

const device = required(
  createMirrorWriterId("11111111-1111-4111-8111-111111111111"),
);
const association = required(
  createMirrorAssociationId("22222222-2222-4222-8222-222222222222"),
);
const reviewId = required(
  createMirrorOperationId("33333333-3333-4333-8333-333333333333"),
);
const operationId = required(
  createMirrorOperationId("44444444-4444-4444-8444-444444444444"),
);
const secondOperationId = required(
  createMirrorOperationId("77777777-7777-4777-8777-777777777777"),
);
const thirdOperationId = required(
  createMirrorOperationId("88888888-8888-4888-8888-888888888888"),
);
const fourthOperationId = required(
  createMirrorOperationId("99999999-9999-4999-8999-999999999999"),
);
const fifthOperationId = required(
  createMirrorOperationId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
);
const sixthOperationId = required(
  createMirrorOperationId("aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff"),
);
const effectId = required(
  createMirrorOperationId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
);
const revision = required(
  createApplicationRevision("55555555-5555-4555-8555-555555555555"),
);
const otherRevision = required(
  createApplicationRevision("66666666-6666-4666-8666-666666666666"),
);
const recoveredRevision = required(
  createApplicationRevision("bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"),
);
const hash = required(createContentSha256("ab".repeat(32)));
const otherHash = required(createContentSha256("cd".repeat(32)));
const path = "notes/review.md" as ReconciliationPathEvidence["path"];
const historySource = required(normalizeNotePath("notes/history-old.md"));
const historyDestination = required(normalizeNotePath("notes/history-new.md"));

function localLive(contentSha256 = hash): ReconciliationPathEvidence["local"] {
  return {
    kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.live,
    stability: RECONCILIATION_LOCAL_STABILITY.stable,
    observationGeneration: 1,
    byteSize: 4,
    contentSha256,
  };
}

function localAbsent(): ReconciliationPathEvidence["local"] {
  return {
    kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.absent,
    stability: RECONCILIATION_LOCAL_STABILITY.stable,
    observationGeneration: 1,
  };
}

function remoteAbsent(): ReconciliationPathEvidence["remote"] {
  return { kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.absent };
}

function remoteTombstone(): ReconciliationPathEvidence["remote"] {
  return {
    kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone,
    associationId: association,
    revision: otherRevision,
    deletedRevision: revision,
    recoveryId: operationId,
    receipt: {
      action: "tombstone",
      associationId: association,
      operationId,
      precondition: { kind: "matching-revision", revision },
    },
  };
}

/**
 * Creates the exact tombstone state returned by the remote inspection seam.
 * @returns A stable tombstone current-state fixture.
 */
function remoteTombstoneState(): Extract<
  CurrentNoteState,
  { kind: "tombstone" }
> {
  return {
    kind: "tombstone",
    path,
    revision: otherRevision,
    deletedRevision: revision,
    recoveryId: operationId,
    receipt: {
      action: "tombstone",
      associationId: association,
      operationId,
      precondition: { kind: "matching-revision", revision },
    },
  };
}

function snapshotRecovery(): RecoverySnapshotState {
  return {
    kind: "prepared",
    id: operationId,
    associationId: association,
    path,
    revision,
    sourceRevision: revision,
    contentSha256: hash,
  };
}

function remoteLive(
  contentSha256 = hash,
  remoteRevision = revision,
): ReconciliationPathEvidence["remote"] {
  return {
    kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
    associationId: association,
    revision: remoteRevision,
    contentSha256,
    receipt: {
      action: "create",
      associationId: association,
      operationId,
      precondition: { kind: "absent" },
      contentSha256,
    },
  };
}

function baseEvidence(): ReconciliationPathEvidence {
  return {
    path,
    local: localLive(),
    baseline: {
      kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
      revision,
      contentSha256: hash,
    },
    remote: remoteLive(),
    m3: { unresolvedMutation: null, deferredHistory: null },
  };
}

function snapshot(
  update: Partial<ReconciliationPathEvidence> = {},
  recovery: RecoverySnapshotState | null = null,
): ReconciliationReviewSnapshot {
  const base = baseEvidence();
  return {
    runtime: {
      runtimeOwnerVersion: 3,
      configurationGeneration: 1,
      listenerEpoch: 1,
      deviceId: device,
      designatedWriterId: device,
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
        associationId: association,
        origin: "https://bridge.example",
      },
    },
    targetPath: path,
    paths: [
      {
        path: base.path,
        local: update.local ?? base.local,
        baseline: update.baseline ?? base.baseline,
        remote: update.remote ?? base.remote,
        m3: update.m3 ?? base.m3,
      },
    ],
    recovery,
  };
}

describe("M4 divergence classifier", () => {
  it.each([
    ["aligned", snapshot()],
    ["local-ahead", snapshot({ local: localLive(otherHash) })],
    [
      "remote-ahead",
      snapshot({ remote: remoteLive(otherHash, otherRevision) }),
    ],
    [
      "both-changed",
      snapshot({
        local: localLive(otherHash),
        remote: remoteLive(otherHash, otherRevision),
      }),
    ],
    [
      "local-missing",
      snapshot({
        local: {
          kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.absent,
          stability: RECONCILIATION_LOCAL_STABILITY.stable,
          observationGeneration: 1,
        },
      }),
    ],
    [
      "legacy-remote",
      snapshot({
        remote: {
          kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy,
          contentSha256: otherHash,
        },
      }),
    ],
    [
      "remote-tombstoned",
      snapshot({
        remote: {
          kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone,
          associationId: association,
          revision: otherRevision,
          deletedRevision: revision,
          recoveryId: operationId,
          receipt: {
            action: "tombstone",
            associationId: association,
            operationId,
            precondition: { kind: "matching-revision", revision },
          },
        },
      }),
    ],
    [
      "aligned",
      snapshot({
        local: {
          kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.absent,
          stability: RECONCILIATION_LOCAL_STABILITY.stable,
          observationGeneration: 2,
        },
        baseline: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
          revision: otherRevision,
          recoveryId: operationId,
        },
        remote: {
          kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone,
          associationId: association,
          revision: otherRevision,
          deletedRevision: revision,
          recoveryId: operationId,
          receipt: {
            action: "tombstone",
            associationId: association,
            operationId,
            precondition: { kind: "matching-revision", revision },
          },
        },
      }),
    ],
    [
      "remote-ahead",
      snapshot({
        baseline: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
          revision,
          recoveryId: operationId,
        },
      }),
    ],
    [
      "unknown-local",
      snapshot({
        local: {
          kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown,
          stability: RECONCILIATION_LOCAL_STABILITY.unknown,
        },
      }),
    ],
  ] as const)("classifies $0", (expected, value) => {
    expect(classifyReconciliation(value)).toBe(expected);
  });

  it("preserves M3 and evidence precedence", () => {
    const unresolved = snapshot({
      m3: {
        unresolvedMutation: {
          intent: {
            action: "update",
            associationId: association,
            writerId: device,
            operationId,
            path,
            precondition: { kind: "matching-revision", revision },
            contentSha256: hash,
            mutationAttempts: 0,
            evidenceAttempts: 0,
          },
          phase: "intent-persisted",
        },
        deferredHistory: null,
      },
    });
    expect(classifyReconciliation(unresolved)).toBe(
      RECONCILIATION_CLASSIFICATION.unresolvedM3Effect,
    );
    expect(
      classifyReconciliation({
        ...unresolved,
        paths: [
          {
            ...baseEvidence(),
            m3: {
              unresolvedMutation: null,
              deferredHistory: {
                kind: "rename-deferred",
                observationGeneration: 1,
                renameId: operationId,
                associationId: association,
                sourcePath: path,
                destinationPath: "notes/new.md" as typeof path,
                sourceExpectedRevision: revision,
                destinationObservationGeneration: 1,
                destinationAcknowledgedRevision: null,
                graceDeadlineMilliseconds: 1,
                phase: MIRROR_RENAME_PHASE.destinationRequired,
              },
            },
          },
        ],
      }),
    ).toBe(RECONCILIATION_CLASSIFICATION.deferredHistory);
    expect(
      classifyReconciliation({
        ...snapshot(),
        paths: [
          {
            ...baseEvidence(),
            local: {
              kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown,
              stability: RECONCILIATION_LOCAL_STABILITY.unknown,
            },
            remote: { kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.unavailable },
          },
        ],
      }),
    ).toBe(RECONCILIATION_CLASSIFICATION.remoteUnavailable);
  });

  it("does not turn an unassociated local/remote absence into an M4 review state", () => {
    expect(
      classifyReconciliation({
        ...snapshot(),
        paths: [
          {
            ...baseEvidence(),
            baseline: { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
            remote: { kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.absent },
          },
        ],
      }),
    ).toBe(RECONCILIATION_CLASSIFICATION.localAhead);
  });
});

describe("M4 action policy", () => {
  it("returns only defer for aligned and blocked evidence", () => {
    const blocked = snapshot({
      local: {
        kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown,
        stability: RECONCILIATION_LOCAL_STABILITY.unknown,
      },
    });
    expect(allowedReconciliationActions(snapshot())).toEqual(["defer"]);
    expect(allowedReconciliationActions(blocked)).toEqual(["defer"]);
    expect(
      allowedReconciliationActions({
        ...snapshot(),
        paths: [
          {
            ...baseEvidence(),
            baseline: { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
            local: localLive(otherHash),
            remote: { kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.absent },
          },
        ],
      }),
    ).toEqual([]);
  });

  it("keeps history and legacy choices explicit", () => {
    const history = snapshot({
      m3: {
        unresolvedMutation: null,
        deferredHistory: {
          kind: "rename-deferred",
          observationGeneration: 1,
          renameId: operationId,
          associationId: association,
          sourcePath: path,
          destinationPath: "notes/new.md" as typeof path,
          sourceExpectedRevision: revision,
          destinationObservationGeneration: 1,
          destinationAcknowledgedRevision: null,
          graceDeadlineMilliseconds: 1,
          phase: MIRROR_RENAME_PHASE.destinationRequired,
        },
      },
    });
    expect(allowedReconciliationActions(history)).toEqual([
      RECONCILIATION_ACTION.resolveHistory,
      RECONCILIATION_ACTION.defer,
    ]);
    expect(
      allowedReconciliationActions(
        snapshot({
          remote: {
            kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy,
            contentSha256: otherHash,
          },
        }),
      ),
    ).toEqual(["fork-legacy", "defer"]);
  });

  it("does not offer expired recovery material as an actionable restore", () => {
    const purged = {
      ...snapshotRecovery(),
      kind: RECOVERY_SNAPSHOT_STATE_KIND.purged,
      recoverUntil: "2025-01-01T00:00:00.000Z",
    };
    expect(
      allowedReconciliationActions(
        snapshot({ local: localAbsent(), remote: remoteTombstone() }, purged),
      ),
    ).toEqual([
      RECONCILIATION_ACTION.acceptTombstone,
      RECONCILIATION_ACTION.defer,
    ]);
  });

  it("derives local-missing, tombstone, and remote-ahead matrices", () => {
    expect(
      allowedReconciliationActions(snapshot({ local: localAbsent() })),
    ).toEqual(["use-remote", "exact-revisioned-adoption", "defer"]);
    expect(
      allowedReconciliationActions(
        snapshot({ local: localAbsent(), remote: { kind: "absent" } }),
      ),
    ).toEqual(["defer"]);
    expect(
      allowedReconciliationActions(
        snapshot(
          { local: localAbsent(), remote: remoteTombstone() },
          snapshotRecovery(),
        ),
      ),
    ).toEqual(["accept-tombstone", "restore-recovery", "defer"]);
    expect(
      allowedReconciliationActions(
        snapshot({ remote: remoteTombstone() }, snapshotRecovery()),
      ),
    ).toEqual(["recreate-remote", "keep-both", "restore-recovery", "defer"]);
    expect(
      allowedReconciliationActions(
        snapshot({ remote: remoteLive(hash, otherRevision) }),
      ),
    ).toEqual(["use-remote", "exact-revisioned-adoption", "defer"]);
    expect(
      allowedReconciliationActions(
        snapshot({
          local: localLive(otherHash),
          remote: remoteLive(otherHash, otherRevision),
        }),
      ),
    ).toEqual(["keep-local", "use-remote", "keep-both", "defer"]);
    expect(
      allowedReconciliationActions(
        snapshot({
          local: localLive(otherHash),
          remote: remoteLive(hash, otherRevision),
        }),
      ),
    ).toEqual(["keep-local", "use-remote", "keep-both", "defer"]);
  });

  it("maps every action to an explicit authority source", () => {
    const actions: readonly ReconciliationAction[] = [
      { kind: RECONCILIATION_ACTION.keepLocal },
      { kind: RECONCILIATION_ACTION.useRemote },
      { kind: RECONCILIATION_ACTION.keepBoth, primarySide: "local" },
      { kind: RECONCILIATION_ACTION.adoptRevision },
      { kind: RECONCILIATION_ACTION.acceptTombstone },
      { kind: RECONCILIATION_ACTION.recreateRemote },
      { kind: RECONCILIATION_ACTION.restoreRecovery },
      { kind: RECONCILIATION_ACTION.forkLegacy },
      {
        kind: RECONCILIATION_ACTION.resolveHistory,
        decision: { kind: "defer-history" },
      },
      { kind: RECONCILIATION_ACTION.defer },
    ];
    for (const action of actions) {
      expect(reconciliationAuthorityForAction(action)).toBeTruthy();
    }
  });

  it("fails closed for missing targets and unknown local evidence", () => {
    const missingTarget = { ...snapshot(), paths: [] };
    expect(allowedReconciliationActions(missingTarget)).toEqual([]);
    expect(
      allowedReconciliationActions(
        snapshot({
          local: {
            kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown,
            stability: RECONCILIATION_LOCAL_STABILITY.unknown,
          },
        }),
      ),
    ).toEqual([RECONCILIATION_ACTION.defer]);
  });

  it("rejects action shapes whose required evidence is absent", () => {
    const noLocal = snapshot({ local: localAbsent() });
    expect(
      isReconciliationActionAllowed(noLocal, {
        kind: RECONCILIATION_ACTION.keepBoth,
        primarySide: "local",
      }),
    ).toBe(false);
    expect(
      isReconciliationActionAllowed(noLocal, {
        kind: RECONCILIATION_ACTION.adoptRevision,
      }),
    ).toBe(true);
    expect(
      isReconciliationActionAllowed(snapshot({ remote: remoteTombstone() }), {
        kind: RECONCILIATION_ACTION.acceptTombstone,
      }),
    ).toBe(false);
    expect(
      isReconciliationActionAllowed(snapshot({ remote: remoteTombstone() }), {
        kind: RECONCILIATION_ACTION.recreateRemote,
      }),
    ).toBe(true);
    expect(
      isReconciliationActionAllowed(snapshot({ remote: remoteLive() }), {
        kind: RECONCILIATION_ACTION.recreateRemote,
      }),
    ).toBe(false);
    expect(
      allowedReconciliationActions(
        snapshot({ local: localAbsent(), remote: remoteAbsent() }),
      ),
    ).toEqual([RECONCILIATION_ACTION.defer]);
    expect(
      allowedReconciliationActions(
        snapshot(
          { local: localAbsent(), remote: remoteTombstone() },
          snapshotRecovery(),
        ),
      ),
    ).toEqual([
      RECONCILIATION_ACTION.acceptTombstone,
      RECONCILIATION_ACTION.restoreRecovery,
      RECONCILIATION_ACTION.defer,
    ]);
  });
});

class Store implements MirrorStateStore {
  readonly saves: MirrorDeviceState[] = [];
  fail = false;
  afterSave: (() => void) | undefined;

  async save(
    state: MirrorDeviceState,
  ): Promise<
    | { readonly kind: "saved" }
    | { readonly kind: "failed"; readonly reason: "unavailable" }
  > {
    if (this.fail) return { kind: "failed", reason: "unavailable" };
    this.saves.push(state);
    this.afterSave?.();
    return { kind: "saved" };
  }
}

function state(
  desired: MirrorDeviceState["paths"][number]["desired"] = { kind: "none" },
): MirrorDeviceState {
  return {
    deviceId: device,
    lifecycle: {
      kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
      associationId: association,
      origin: "https://bridge.example",
    },
    globalBlockReason: null,
    paths: [
      {
        path,
        acknowledgement: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision,
          contentSha256: hash,
        },
        unresolvedMutation: null,
        desired,
        blockedReason: null,
      },
    ],
    stagedHandoff: null,
    reconciliationGapGroupReviews: [],
    reconciliationReviews: [],
    reconciliationOperations: [],
  };
}

function historyState(): MirrorDeviceState {
  const base = state();
  const deferred = {
    kind: MIRROR_DESIRED_STATE_KIND.renameDeferred,
    observationGeneration: 1,
    renameId: thirdOperationId,
    associationId: association,
    sourcePath: historySource,
    destinationPath: historyDestination,
    sourceExpectedRevision: revision,
    destinationObservationGeneration: 1,
    destinationAcknowledgedRevision: otherRevision,
    graceDeadlineMilliseconds: 1,
    phase: MIRROR_RENAME_PHASE.sourceCleanupRequired,
  } as const;
  return {
    ...base,
    paths: [
      {
        path: historySource,
        acknowledgement: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision,
          contentSha256: hash,
        },
        unresolvedMutation: null,
        desired: deferred,
        blockedReason: MIRROR_PATH_BLOCK_REASON.renameDeferred,
      },
      {
        path: historyDestination,
        acknowledgement: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision: otherRevision,
          contentSha256: hash,
        },
        unresolvedMutation: null,
        desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
        blockedReason: null,
      },
    ],
  };
}

function historyNoteState(
  notePath: ReconciliationPathEvidence["path"],
  noteRevision: Extract<CurrentNoteState, { kind: "live" }>["revision"],
  receiptOperationId: MirrorOperationId,
): CurrentNoteState {
  return {
    kind: "live",
    path: notePath,
    revision: noteRevision,
    contentSha256: hash,
    receipt: {
      action: "create",
      associationId: association,
      operationId: receiptOperationId,
      precondition: { kind: "absent" },
      contentSha256: hash,
    },
  };
}

function makeHistoryService() {
  const fixture = makeService(snapshot().runtime, historyState(), [
    reviewId,
    operationId,
    secondOperationId,
    thirdOperationId,
    fourthOperationId,
    fifthOperationId,
    effectId,
  ]);
  fixture.local.read.mockImplementation(async (candidatePath) =>
    candidatePath === historySource
      ? {
          kind: LocalInspectionKind.failed,
          reason: LocalVaultFailureReason.missingFile,
        }
      : { kind: LocalInspectionKind.ok, content: "same", sizeBytes: 4 },
  );
  fixture.local.list.mockResolvedValue({
    kind: LocalInspectionKind.ok,
    entries: [{ path: historyDestination, sizeBytes: 4 }],
    skipped: {
      unsupported_file: 0,
      excluded_location: 0,
      invalid_path: 0,
      oversized: 0,
    },
  });
  fixture.remote.listNotes.mockResolvedValue({
    kind: "success",
    value: { notes: [historySource, historyDestination], nextCursor: null },
  });
  fixture.remote.inspectNote.mockImplementation(async (candidatePath) => ({
    kind: "success",
    value:
      candidatePath === historySource
        ? historyNoteState(historySource, revision, operationId)
        : historyNoteState(
            historyDestination,
            otherRevision,
            secondOperationId,
          ),
  }));
  fixture.remote.readNote.mockImplementation(async (candidatePath) => ({
    kind: "success",
    value: {
      kind: "live",
      revision: candidatePath === historySource ? revision : otherRevision,
      content: "same",
    },
  }));
  return fixture;
}

function remoteReader() {
  const current: CurrentNoteState = {
    kind: "live",
    path,
    revision: otherRevision,
    contentSha256: hash,
    receipt: {
      action: "create",
      associationId: association,
      operationId,
      precondition: { kind: "absent" },
      contentSha256: hash,
    },
  };
  return {
    describe: vi.fn<ReconciliationRemoteReader["describe"]>(
      async (): Promise<RemoteBridgeResult<RemoteBridgeDescription>> => ({
        kind: "success",
        value: {
          protocol: "obsidian-ai-bridge-mirror-v2" as const,
          associationId: association,
          writerId: device,
          maxNoteSizeBytes: 1_048_576,
          maxPageSize: 50,
          recoveryRetentionSeconds: 2_592_000,
        },
      }),
    ),
    listNotes: vi.fn<ReconciliationRemoteReader["listNotes"]>(async () => ({
      kind: "success" as const,
      value: { notes: [path], nextCursor: null },
    })),
    readNote: vi.fn<ReconciliationRemoteReader["readNote"]>(async () => ({
      kind: "success" as const,
      value: {
        kind: "live" as const,
        revision: otherRevision,
        content: "same",
      },
    })),
    inspectNote: vi.fn<ReconciliationRemoteReader["inspectNote"]>(async () => ({
      kind: "success" as const,
      value: current,
    })),
    listRecovery: vi.fn<ReconciliationRemoteReader["listRecovery"]>(
      async () => ({
        kind: "success" as const,
        value: { recoveries: [], nextCursor: null },
      }),
    ),
    inspectRecovery: vi.fn<ReconciliationRemoteReader["inspectRecovery"]>(
      async () => ({
        kind: "success" as const,
        value: null,
      }),
    ),
    mutateNote: vi.fn(),
  };
}

describe("M4 bounded inventory", () => {
  it("reports remote and recovery pagination failures without authority", async () => {
    const remoteFailure = {
      kind: "failure" as const,
      failure: "malformed-response" as const,
    };
    const remote = {
      listNotes: vi.fn(async () => remoteFailure),
      listRecovery: vi.fn(async () => remoteFailure),
    };
    const notes = await inspectBoundedMirrorInventory(remote);
    const recoveries = await inspectBoundedRecoveryInventory(remote);
    expect(notes.kind).toBe("incomplete");
    expect(recoveries.kind).toBe("incomplete");
    expect(notes.paths).toEqual([]);
    expect(recoveries.paths).toEqual([]);
  });

  it("never admits current or historical preservation artifacts as review candidates", async () => {
    const fixture = makeService();
    const currentArtifact =
      `${RECONCILIATION_PRESERVATION_ROOT}/${operationId}/remote.md` as typeof path;
    const legacyArtifact =
      `${LEGACY_RECONCILIATION_PRESERVATION_ROOT}/${operationId}/local.md` as typeof path;
    const prefixOrdinary =
      `${RECONCILIATION_PRESERVATION_ROOT}-notes/ordinary.md` as typeof path;
    fixture.remote.listNotes.mockResolvedValue({
      kind: "success",
      value: {
        notes: [currentArtifact, legacyArtifact, prefixOrdinary],
        nextCursor: null,
      },
    });
    fixture.remote.listRecovery.mockResolvedValue({
      kind: "success",
      value: {
        recoveries: [
          { ...snapshotRecovery(), path: currentArtifact },
          { ...snapshotRecovery(), path: legacyArtifact },
        ],
        nextCursor: null,
      },
    });

    const result = await fixture.service.discover();

    expect(result.candidates).toContain(prefixOrdinary);
    expect(result.candidates).not.toContain(currentArtifact);
    expect(result.candidates).not.toContain(legacyArtifact);
    await expect(
      fixture.service.createReview({
        targetPath: currentArtifact,
        sessionId: reviewId,
      }),
    ).resolves.toEqual({ kind: "failure", reason: "not-a-candidate" });
  });

  it("reports capacity limits from local, remote, and recovery inventories", async () => {
    const paths = Array.from(
      { length: 50_010 },
      (_, index) => `notes/${index}.md` as typeof path,
    );
    const local = makeService();
    local.local.list.mockResolvedValue({
      kind: LocalInspectionKind.ok,
      entries: paths.map((candidatePath) => ({
        path: candidatePath,
        sizeBytes: 1,
      })),
      skipped: {
        unsupported_file: 0,
        excluded_location: 0,
        invalid_path: 0,
        oversized: 0,
      },
    });
    const localResult = await local.service.discover();
    expect(localResult.kind).toBe("incomplete");

    const remote = makeService();
    remote.local.list.mockResolvedValue({
      kind: LocalInspectionKind.ok,
      entries: [],
      skipped: {
        unsupported_file: 0,
        excluded_location: 0,
        invalid_path: 0,
        oversized: 0,
      },
    });
    remote.remote.listNotes.mockResolvedValue({
      kind: "success",
      value: { notes: paths, nextCursor: "same" },
    });
    const remoteResult = await remote.service.discover();
    expect(remoteResult.kind).toBe("incomplete");

    const recovery = makeService();
    recovery.local.list.mockResolvedValue({
      kind: LocalInspectionKind.ok,
      entries: [],
      skipped: {
        unsupported_file: 0,
        excluded_location: 0,
        invalid_path: 0,
        oversized: 0,
      },
    });
    recovery.remote.listNotes.mockResolvedValue({
      kind: "success",
      value: { notes: paths, nextCursor: null },
    });
    recovery.remote.listRecovery.mockResolvedValue({
      kind: "success",
      value: {
        recoveries: paths.map((candidatePath) => ({
          ...snapshotRecovery(),
          path: candidatePath,
        })),
        nextCursor: "same",
      },
    });
    const recoveryResult = await recovery.service.discover();
    expect(recoveryResult.kind).toBe("incomplete");
  });

  it("stops repeated note and recovery cursors", async () => {
    const remote = {
      listNotes: vi.fn(async () => ({
        kind: "success" as const,
        value: { notes: [path], nextCursor: "same" },
      })),
      listRecovery: vi.fn(async () => ({
        kind: "success" as const,
        value: { recoveries: [], nextCursor: "same" },
      })),
    };
    const notes = await inspectBoundedMirrorInventory(remote);
    const recoveries = await inspectBoundedRecoveryInventory(remote);
    expect(notes.kind).toBe("incomplete");
    expect(recoveries.kind).toBe("incomplete");
    expect(notes.paths).toEqual([path]);
    expect(recoveries.paths).toEqual([]);
  });
});

/**
 * Creates the deterministic service fixture used by lifecycle and admission tests.
 * @param runtime - Runtime authority snapshot returned by the mutable test seam.
 * @param initialState - Durable state fixture supplied to the serialized owner.
 * @param operationIds - Deterministic review/operation identities emitted by the fixture.
 * @returns A service and its observable test seams.
 */
function makeService(
  runtime: ReconciliationReviewSnapshot["runtime"] = snapshot().runtime,
  initialState: MirrorDeviceState = state(),
  operationIds: readonly MirrorOperationId[] = [
    reviewId,
    operationId,
    secondOperationId,
    thirdOperationId,
    fourthOperationId,
    fifthOperationId,
    sixthOperationId,
  ],
) {
  const store = new Store();
  let currentRuntime = runtime;
  const observations = new ReconciliationObservationGenerationOwner();
  const remote = remoteReader();
  const hashContent = vi.fn(async (_content: string) => hash);
  let operationIndex = 0;
  const local = {
    list: vi.fn<ReadOnlyLocalVault["list"]>(async () => ({
      kind: LocalInspectionKind.ok,
      entries: [{ path, sizeBytes: 4 }],
      skipped: {
        unsupported_file: 0,
        excluded_location: 0,
        invalid_path: 0,
        oversized: 0,
      },
    })),
    read: vi.fn<ReadOnlyLocalVault["read"]>(async () => ({
      kind: LocalInspectionKind.ok,
      content: "same",
      sizeBytes: 4,
    })),
  };
  const owner = new MirrorStateOwner(initialState, store);
  const service = new ReconciliationReviewService(local, remote, owner, {
    runtime: { current: () => currentRuntime },
    observations,
    hashContent,
    createOperationId: vi.fn(() => {
      const next = operationIds[operationIndex];
      operationIndex += 1;
      return next ?? thirdOperationId;
    }),
  });
  return {
    local,
    observations,
    remote,
    hashContent,
    owner,
    service,
    setRuntime: (next: ReconciliationReviewSnapshot["runtime"]) => {
      currentRuntime = next;
    },
    store,
  };
}

async function createGapFencedOperation(
  fixture: ReturnType<typeof makeService>,
  action: ReconciliationAdmissionAction = {
    kind: RECONCILIATION_ACTION.adoptRevision,
  },
  options: {
    readonly relatedPaths?: readonly NotePath[];
    readonly destinationPath?: NotePath | null;
  } = {},
): Promise<MirrorOperationId> {
  await fixture.service.discover();
  const review = await fixture.service.createReview({
    targetPath: path,
    sessionId: reviewId,
    ...(options.relatedPaths === undefined
      ? {}
      : { relatedPaths: options.relatedPaths }),
  });
  if (review.kind !== "created") throw new Error("Review fixture failed.");
  const admitted = await fixture.service.admit({
    reviewId: review.review.reviewId,
    sessionId: reviewId,
    action,
    ...(options.destinationPath === undefined
      ? {}
      : { destinationPath: options.destinationPath }),
  });
  if (admitted.kind !== "admitted") {
    throw new Error(`Admission fixture failed: ${JSON.stringify(admitted)}`);
  }
  const fenced = await fixture.owner.transition(
    fenceActiveReconciliationForObservationGap,
  );
  if (fenced.kind !== "committed") throw new Error("Gap fixture failed.");
  return admitted.operation.operationId;
}

/**
 * Prepares one operation-bound local postcondition for exact gap recovery tests.
 * @param fixture - Service fixture whose active operation is fenced and persisted.
 * @returns The gap predecessor with one uncertain, prepared local effect.
 */
async function prepareLocalGapEffect(
  fixture: ReturnType<typeof makeService>,
): Promise<MirrorOperationId> {
  const predecessorOperationId = await createGapFencedOperation(fixture, {
    kind: RECONCILIATION_ACTION.useRemote,
  });
  const preservationPath = createReconciliationPreservationPath(
    operationId,
    RECONCILIATION_PRESERVATION_SIDE.local,
  );
  if (preservationPath === undefined) {
    throw new Error("Preservation fixture failed.");
  }
  const prepared = await fixture.owner.transition((current) => ({
    ...current,
    reconciliationOperations: current.reconciliationOperations.map(
      (operation) =>
        operation.operationId === predecessorOperationId &&
        isNonHistoryReconciliationOperation(operation)
          ? {
              ...operation,
              phase: RECONCILIATION_OPERATION_PHASE.evidenceRequired,
              localEffect: MUTATION_EFFECT_CERTAINTY.unknown,
              preservationReceipts: [
                {
                  scope: "operation",
                  operationId: operation.operationId,
                  originalPath: path,
                  side: RECONCILIATION_PRESERVATION_SIDE.local,
                  sourceRevision: null,
                  contentSha256: hash,
                  preservationPath,
                  proofState: RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
                },
              ],
              localEffectObservation: {
                kind: LOCAL_EFFECT_OBSERVATION_KIND.prepared,
                effectId,
                path,
                expectedHash: hash,
                listenerEpoch: operation.snapshot.runtime.listenerEpoch,
                beforeGeneration: 1,
                postconditionHash: null,
                successor: null,
              },
            }
          : operation,
    ),
  }));
  if (prepared.kind !== "committed") {
    throw new Error("Prepared local-effect fixture was not persisted.");
  }
  return predecessorOperationId;
}

/**
 * Prepares one confirmed alternate-path restore for restart and listener-gap tests.
 * @returns An active restore owner and its exact absent destination.
 */
async function createRestoredAlternatePathFixture(): Promise<{
  readonly fixture: ReturnType<typeof makeService>;
  readonly alternatePath: NotePath;
}> {
  const fixture = makeService();
  const alternatePath = required(normalizeNotePath("notes/restored.md"));
  const tombstone = remoteTombstoneState();
  fixture.local.list.mockResolvedValue({
    kind: LocalInspectionKind.ok,
    entries: [],
    skipped: {
      unsupported_file: 0,
      excluded_location: 0,
      invalid_path: 0,
      oversized: 0,
    },
  });
  fixture.local.read.mockResolvedValue({
    kind: LocalInspectionKind.failed,
    reason: LocalVaultFailureReason.missingFile,
  });
  fixture.remote.inspectNote.mockImplementation(async (candidatePath) => ({
    kind: "success",
    value:
      candidatePath === path
        ? tombstone
        : { kind: "absent", path: candidatePath },
  }));
  fixture.remote.readNote.mockResolvedValue({
    kind: "success",
    value: { kind: "missing" },
  });
  fixture.remote.listRecovery.mockResolvedValue({
    kind: "success",
    value: { recoveries: [snapshotRecovery()], nextCursor: null },
  });
  fixture.remote.inspectRecovery.mockResolvedValue({
    kind: "success",
    value: snapshotRecovery(),
  });

  await fixture.service.discover();
  const restoreReview = await fixture.service.createReview({
    targetPath: path,
    sessionId: reviewId,
    relatedPaths: [alternatePath],
  });
  if (restoreReview.kind !== "created") {
    throw new Error("Restore review fixture failed.");
  }
  const admitted = await fixture.service.admit({
    reviewId: restoreReview.review.reviewId,
    sessionId: reviewId,
    action: { kind: RECONCILIATION_ACTION.restoreRecovery },
    destinationPath: alternatePath,
  });
  if (admitted.kind !== "admitted") {
    throw new Error("Restore admission fixture failed.");
  }
  const restored = await fixture.owner.transition((current) => ({
    ...current,
    reconciliationOperations: current.reconciliationOperations.map(
      (operation) => ({
        ...operation,
        phase: RECONCILIATION_OPERATION_PHASE.restoredPendingReview,
        localEffectObservation: {
          kind: LOCAL_EFFECT_OBSERVATION_KIND.confirmed,
          effectId,
          path: alternatePath,
          expectedHash: hash,
          listenerEpoch: 1,
          beforeGeneration: 1,
          postconditionHash: hash,
          successor: null,
        },
        localEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
      }),
    ),
  }));
  if (restored.kind !== "committed") {
    throw new Error("Restore effect fixture failed.");
  }
  fixture.setRuntime({ ...snapshot().runtime, listenerEpoch: 2 });
  fixture.local.list.mockResolvedValue({
    kind: LocalInspectionKind.ok,
    entries: [{ path: alternatePath, sizeBytes: 4 }],
    skipped: {
      unsupported_file: 0,
      excluded_location: 0,
      invalid_path: 0,
      oversized: 0,
    },
  });
  fixture.local.read.mockResolvedValue({
    kind: LocalInspectionKind.ok,
    content: "same",
    sizeBytes: 4,
  });
  await fixture.service.discover();
  return { fixture, alternatePath };
}

describe("observation-gap transition policy", () => {
  it("fences an active operation once and retains only its exact active identity", async () => {
    const fixture = makeService();
    const operationId = await createGapFencedOperation(fixture);
    const state = fixture.owner.snapshot().state;

    expect(isGapFencedReconciliationOperation(state, operationId)).toBe(true);
    expect(isGapFencedReconciliationOperation(state, secondOperationId)).toBe(
      false,
    );
    expect(fenceActiveReconciliationForObservationGap(state)).toBe(state);
  });
});

describe("M4 read-only review service", () => {
  it("stales a review when the authenticated runtime origin changes", async () => {
    const fixture = makeService();
    await fixture.service.discover();
    const created = await fixture.service.createReview({
      targetPath: path,
      sessionId: reviewId,
    });
    if (created.kind !== "created") throw new Error("Review fixture failed.");
    fixture.setRuntime({
      ...snapshot().runtime,
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
        associationId: association,
        origin: "https://different.example",
      },
    });

    await expect(
      fixture.service.admit({
        reviewId: created.review.reviewId,
        sessionId: reviewId,
        action: { kind: RECONCILIATION_ACTION.adoptRevision },
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "invalid-lifecycle-or-authority",
    });
    expect(
      reconciliationReviewSnapshotsEqual(created.review.snapshot, {
        ...created.review.snapshot,
        runtime: {
          ...created.review.snapshot.runtime,
          lifecycle: {
            kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
            associationId: association,
            origin: "https://different.example",
          },
        },
      }),
    ).toBe(false);
  });

  it("rejects unknown candidates and non-reviewable aligned evidence", async () => {
    const first = makeService();
    await first.service.discover();
    expect(
      await first.service.createReview({
        targetPath: "notes/other.md" as typeof path,
        sessionId: reviewId,
      }),
    ).toEqual({ kind: "failure", reason: "not-a-candidate" });

    const aligned = makeService();
    aligned.remote.inspectNote.mockResolvedValue({
      kind: "success",
      value: {
        kind: "live",
        path,
        revision,
        contentSha256: hash,
        receipt: {
          action: "create",
          associationId: association,
          operationId,
          precondition: { kind: "absent" },
          contentSha256: hash,
        },
      },
    });
    aligned.remote.readNote.mockResolvedValue({
      kind: "success",
      value: { kind: "live", revision, content: "same" },
    });
    await aligned.service.discover();
    expect(
      await aligned.service.createReview({
        targetPath: path,
        sessionId: reviewId,
      }),
    ).toEqual({ kind: "not-reviewable" });
  });

  it("reports incomplete reads and invalidates session-owned reviews", async () => {
    const failed = makeService();
    failed.remote.describe.mockResolvedValue({
      kind: "failure",
      failure: "malformed-response",
    });
    const discovery = await failed.service.discover();
    expect(discovery.kind).toBe("complete");
    const review = await failed.service.createReview({
      targetPath: path,
      sessionId: reviewId,
    });
    expect(review.kind).toBe("created");
    expect(failed.service.listOpen(reviewId)).toHaveLength(1);
    expect(failed.service.listOpen(operationId)).toEqual([]);
    failed.service.invalidate();
    expect(failed.service.listOpen(reviewId)).toEqual([]);
    expect(await failed.service.refreshReview(reviewId, reviewId)).toEqual({
      kind: "failure",
      reason: "stale-review",
    });
    expect(await failed.service.refreshReview(operationId, reviewId)).toEqual({
      kind: "failure",
      reason: "review-not-found",
    });

    const wrongSession = makeService();
    await wrongSession.service.discover();
    const created = await wrongSession.service.createReview({
      targetPath: path,
      sessionId: reviewId,
    });
    expect(created.kind).toBe("created");
    if (created.kind !== "created") return;
    expect(
      await wrongSession.service.refreshReview(
        created.review.reviewId,
        operationId,
      ),
    ).toEqual({ kind: "failure", reason: "stale-review" });
    expect(
      wrongSession.service.preview(
        created.review.reviewId,
        operationId,
        "local",
      ),
    ).toBeNull();
    expect(
      wrongSession.service.preview(created.review.reviewId, reviewId, "local"),
    ).toBe("same");
    wrongSession.service.invalidateSession(operationId);
    expect(wrongSession.service.listOpen(reviewId)).toHaveLength(1);
    expect(
      wrongSession.service.closeReview(created.review.reviewId, operationId),
    ).toBe(false);
    expect(
      wrongSession.service.closeReview(created.review.reviewId, reviewId),
    ).toBe(true);
    expect(wrongSession.service.listOpen(reviewId)).toEqual([]);
  });

  it("rejects admission when the action or destination is not allowed", async () => {
    const fixture = makeService();
    await fixture.service.discover();
    const created = await fixture.service.createReview({
      targetPath: path,
      sessionId: reviewId,
    });
    expect(created.kind).toBe("created");
    if (created.kind !== "created") return;
    expect(
      await fixture.service.admit({
        reviewId: created.review.reviewId,
        sessionId: reviewId,
        destinationPath: "notes/other.md" as typeof path,
        action: { kind: RECONCILIATION_ACTION.adoptRevision },
      }),
    ).toMatchObject({ kind: "rejected", reason: "action-not-allowed" });
    expect(
      await fixture.service.admit({
        reviewId: created.review.reviewId,
        sessionId: reviewId,
        action: {
          kind: RECONCILIATION_ACTION.keepBoth,
          primarySide: "local",
        },
      }),
    ).toMatchObject({ kind: "rejected", reason: "action-not-allowed" });
    expect(
      await fixture.service.admit({
        reviewId: operationId,
        sessionId: reviewId,
        action: { kind: RECONCILIATION_ACTION.defer },
      }),
    ).toMatchObject({ kind: "rejected", reason: "review-not-found" });
  });

  it("fails closed for unstable local and remote samples", async () => {
    const localFailure = makeService();
    localFailure.local.list.mockResolvedValue({
      kind: LocalInspectionKind.failed,
      reason: LocalVaultFailureReason.unavailable,
    });
    localFailure.local.read.mockResolvedValue({
      kind: LocalInspectionKind.failed,
      reason: LocalVaultFailureReason.changedDuringRead,
    });
    await localFailure.service.discover();
    const unknown = await localFailure.service.createReview({
      targetPath: path,
      sessionId: reviewId,
    });
    expect(unknown).toMatchObject({
      kind: "created",
      review: { classification: "unknown-local" },
    });

    const unstable = makeService();
    unstable.local.read.mockImplementation(async () => {
      unstable.observations.observe(path);
      return { kind: LocalInspectionKind.ok, content: "same", sizeBytes: 4 };
    });
    await unstable.service.discover();
    expect(
      await unstable.service.createReview({
        targetPath: path,
        sessionId: reviewId,
      }),
    ).toMatchObject({
      kind: "created",
      review: { classification: "unknown-local" },
    });

    const hashRace = makeService();
    hashRace.hashContent.mockImplementation(async () => {
      hashRace.observations.observe(path);
      return hash;
    });
    await hashRace.service.discover();
    expect(
      await hashRace.service.createReview({
        targetPath: path,
        sessionId: reviewId,
      }),
    ).toMatchObject({
      kind: "created",
      review: { classification: "unknown-local" },
    });

    const remoteFailure = makeService();
    remoteFailure.remote.inspectNote.mockResolvedValue({
      kind: "failure",
      failure: "malformed-response",
    });
    await remoteFailure.service.discover();
    expect(
      await remoteFailure.service.createReview({
        targetPath: path,
        sessionId: reviewId,
      }),
    ).toMatchObject({
      kind: "created",
      review: { classification: "remote-unavailable" },
    });

    const explicitRecovery = makeService();
    explicitRecovery.remote.inspectRecovery.mockResolvedValue({
      kind: "failure",
      failure: "malformed-response",
    });
    await explicitRecovery.service.discover();
    expect(
      await explicitRecovery.service.createReview({
        targetPath: path,
        sessionId: reviewId,
        recoveryId: operationId,
      }),
    ).toMatchObject({
      kind: "created",
      review: { classification: "remote-unavailable" },
    });

    const remoteAba = makeService();
    remoteAba.remote.inspectNote
      .mockResolvedValueOnce({
        kind: "success",
        value: {
          kind: "live",
          path,
          revision: otherRevision,
          contentSha256: hash,
          receipt: {
            action: "create",
            associationId: association,
            operationId,
            precondition: { kind: "absent" },
            contentSha256: hash,
          },
        },
      })
      .mockResolvedValueOnce({
        kind: "success",
        value: {
          kind: "live",
          path,
          revision,
          contentSha256: hash,
          receipt: {
            action: "create",
            associationId: association,
            operationId,
            precondition: { kind: "absent" },
            contentSha256: hash,
          },
        },
      });
    await remoteAba.service.discover();
    expect(
      await remoteAba.service.createReview({
        targetPath: path,
        sessionId: reviewId,
      }),
    ).toMatchObject({
      kind: "created",
      review: { classification: "remote-unavailable" },
    });

    const tombstoneAba = makeService();
    tombstoneAba.remote.inspectNote
      .mockResolvedValueOnce({ kind: "success", value: remoteTombstoneState() })
      .mockResolvedValueOnce({
        kind: "success",
        value: { kind: "absent", path },
      });
    await tombstoneAba.service.discover();
    expect(
      await tombstoneAba.service.createReview({
        targetPath: path,
        sessionId: reviewId,
      }),
    ).toMatchObject({
      kind: "created",
      review: { classification: "remote-unavailable" },
    });
  });

  it("fences pause-reason changes as authority changes", async () => {
    const fixture = makeService();
    const pausedManual = {
      kind: MIRROR_DEVICE_LIFECYCLE_KIND.paused,
      associationId: association,
      origin: "https://bridge.example",
      reason: MIRROR_PAUSE_REASON.manual,
    } as const;
    await fixture.owner.transition((current) => ({
      ...current,
      lifecycle: pausedManual,
    }));
    fixture.setRuntime({ ...snapshot().runtime, lifecycle: pausedManual });
    await fixture.service.discover();
    const created = await fixture.service.createReview({
      targetPath: path,
      sessionId: reviewId,
    });
    expect(created.kind).toBe("created");
    if (created.kind !== "created") return;
    fixture.setRuntime({
      ...snapshot().runtime,
      lifecycle: {
        ...pausedManual,
        reason: MIRROR_PAUSE_REASON.persistenceFailure,
      },
    });
    expect(
      await fixture.service.admit({
        reviewId: created.review.reviewId,
        sessionId: reviewId,
        action: { kind: RECONCILIATION_ACTION.defer },
      }),
    ).toMatchObject({
      kind: "rejected",
      reason: "invalid-lifecycle-or-authority",
    });
  });

  it("rejects admission when runtime authority becomes invalid", async () => {
    const fixture = makeService();
    await fixture.service.discover();
    const created = await fixture.service.createReview({
      targetPath: path,
      sessionId: reviewId,
    });
    expect(created.kind).toBe("created");
    if (created.kind !== "created") return;
    expect(
      await fixture.service.admit({
        reviewId: created.review.reviewId,
        sessionId: operationId,
        action: { kind: RECONCILIATION_ACTION.adoptRevision },
      }),
    ).toMatchObject({ kind: "rejected", reason: "stale-review" });
    const collision = makeService(undefined, state(), [
      reviewId,
      reviewId,
      secondOperationId,
      thirdOperationId,
    ]);
    await collision.service.discover();
    const collisionReview = await collision.service.createReview({
      targetPath: path,
      sessionId: reviewId,
    });
    expect(collisionReview.kind).toBe("created");
    if (collisionReview.kind !== "created") return;
    expect(
      await collision.service.admit({
        reviewId: collisionReview.review.reviewId,
        sessionId: reviewId,
        action: { kind: RECONCILIATION_ACTION.adoptRevision },
      }),
    ).toMatchObject({ kind: "rejected", reason: "stale-review" });

    fixture.setRuntime({
      ...snapshot().runtime,
      lifecycle: { kind: MIRROR_DEVICE_LIFECYCLE_KIND.disabled },
    });
    expect(
      await fixture.service.admit({
        reviewId: created.review.reviewId,
        sessionId: reviewId,
        action: { kind: RECONCILIATION_ACTION.adoptRevision },
      }),
    ).toMatchObject({
      kind: "rejected",
      reason: "invalid-lifecycle-or-authority",
    });
  });

  it("rejects admission after durable evidence changes", async () => {
    const fixture = makeService();
    const armed = false;
    fixture.remote.inspectNote.mockImplementation(async () => {
      if (armed) fixture.observations.observe(path);
      return {
        kind: "success",
        value: {
          kind: "live",
          path,
          revision: otherRevision,
          contentSha256: hash,
          receipt: {
            action: "create",
            associationId: association,
            operationId,
            precondition: { kind: "absent" },
            contentSha256: hash,
          },
        },
      };
    });
    await fixture.service.discover();
    const created = await fixture.service.createReview({
      targetPath: path,
      sessionId: reviewId,
    });
    expect(created.kind).toBe("created");
    if (created.kind !== "created") return;
    await fixture.owner.transition((current) => ({
      ...current,
      paths: current.paths.map((entry) => ({
        ...entry,
        acknowledgement: { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
      })),
    }));
    expect(
      await fixture.service.admit({
        reviewId: created.review.reviewId,
        sessionId: reviewId,
        action: { kind: RECONCILIATION_ACTION.adoptRevision },
      }),
    ).toMatchObject({ kind: "rejected", reason: "stale-review" });

    const observed = makeService();
    await observed.service.discover();
    const observedReview = await observed.service.createReview({
      targetPath: path,
      sessionId: reviewId,
    });
    expect(observedReview.kind).toBe("created");
    if (observedReview.kind !== "created") return;
    observed.remote.inspectNote.mockImplementation(async () => {
      observed.observations.observe(path);
      return {
        kind: "success",
        value: {
          kind: "live",
          path,
          revision: otherRevision,
          contentSha256: hash,
          receipt: {
            action: "create",
            associationId: association,
            operationId,
            precondition: { kind: "absent" },
            contentSha256: hash,
          },
        },
      };
    });
    expect(
      await observed.service.admit({
        reviewId: observedReview.review.reviewId,
        sessionId: reviewId,
        action: { kind: RECONCILIATION_ACTION.adoptRevision },
      }),
    ).toMatchObject({ kind: "rejected", reason: "reservation-conflict" });
  });

  it("rechecks durable blocks and rejects untracked related reservations", async () => {
    const blocked = makeService();
    await blocked.service.discover();
    const created = await blocked.service.createReview({
      targetPath: path,
      sessionId: reviewId,
    });
    expect(created.kind).toBe("created");
    if (created.kind !== "created") return;
    await blocked.owner.transition((current) => ({
      ...current,
      globalBlockReason: MIRROR_GLOBAL_BLOCK_REASON.stateUnavailable,
    }));
    expect(
      await blocked.service.admit({
        reviewId: created.review.reviewId,
        sessionId: reviewId,
        action: { kind: RECONCILIATION_ACTION.adoptRevision },
      }),
    ).toMatchObject({ kind: "rejected", reason: "reservation-conflict" });

    const tracked = makeService();
    const trackedPath = "notes/tracked-related.md" as typeof path;
    await tracked.owner.transition((current) => ({
      ...current,
      paths: [
        ...current.paths,
        {
          path: trackedPath,
          acknowledgement: {
            kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
            revision,
            contentSha256: hash,
          },
          unresolvedMutation: null,
          desired: { kind: "none" },
          blockedReason: null,
        },
      ],
    }));
    await tracked.service.discover();
    const trackedReview = await tracked.service.createReview({
      targetPath: path,
      relatedPaths: [trackedPath],
      sessionId: reviewId,
    });
    expect(trackedReview.kind).toBe("created");
    if (trackedReview.kind !== "created") return;
    expect(
      await tracked.service.admit({
        reviewId: trackedReview.review.reviewId,
        sessionId: reviewId,
        action: { kind: RECONCILIATION_ACTION.adoptRevision },
      }),
    ).toMatchObject({ kind: "admitted" });

    const untracked = makeService();
    await untracked.service.discover();
    const related = await untracked.service.createReview({
      targetPath: path,
      relatedPaths: ["notes/untracked.md" as typeof path],
      sessionId: reviewId,
    });
    expect(related.kind).toBe("created");
    if (related.kind !== "created") return;
    expect(
      await untracked.service.admit({
        reviewId: related.review.reviewId,
        sessionId: reviewId,
        action: { kind: RECONCILIATION_ACTION.adoptRevision },
      }),
    ).toMatchObject({ kind: "rejected", reason: "reservation-conflict" });
  });

  it("fences persistence and overlapping reservations before admission", async () => {
    const failed = makeService();
    await failed.service.discover();
    const failedReview = await failed.service.createReview({
      targetPath: path,
      sessionId: reviewId,
    });
    expect(failedReview.kind).toBe("created");
    if (failedReview.kind !== "created") return;
    failed.store.fail = true;
    expect(
      await failed.service.admit({
        reviewId: failedReview.review.reviewId,
        sessionId: reviewId,
        action: { kind: RECONCILIATION_ACTION.adoptRevision },
      }),
    ).toMatchObject({ kind: "rejected", reason: "persistence-failure" });

    const overlapping = makeService();
    await overlapping.service.discover();
    const first = await overlapping.service.createReview({
      targetPath: path,
      sessionId: reviewId,
    });
    expect(first.kind).toBe("created");
    if (first.kind !== "created") return;
    expect(
      await overlapping.service.admit({
        reviewId: first.review.reviewId,
        sessionId: reviewId,
        action: { kind: RECONCILIATION_ACTION.adoptRevision },
      }),
    ).toMatchObject({ kind: "admitted" });
    const second = await overlapping.service.createReview({
      targetPath: path,
      sessionId: reviewId,
    });
    expect(second.kind).toBe("created");
    if (second.kind !== "created") return;
    expect(
      await overlapping.service.admit({
        reviewId: second.review.reviewId,
        sessionId: reviewId,
        action: { kind: RECONCILIATION_ACTION.adoptRevision },
      }),
    ).toMatchObject({ kind: "rejected", reason: "reservation-conflict" });
  });

  it("includes and reserves genuinely absent explicit destinations", async () => {
    const fixture = makeService();
    const destination = "notes/new-destination.md" as typeof path;
    fixture.local.list.mockResolvedValue({
      kind: LocalInspectionKind.ok,
      entries: [{ path, sizeBytes: 4 }],
      skipped: {
        unsupported_file: 0,
        excluded_location: 0,
        invalid_path: 0,
        oversized: 0,
      },
    });
    fixture.local.read.mockImplementation(async (candidatePath) => {
      if (candidatePath === destination) {
        return {
          kind: LocalInspectionKind.failed,
          reason: LocalVaultFailureReason.missingFile,
        };
      }
      return { kind: LocalInspectionKind.ok, content: "same", sizeBytes: 4 };
    });
    fixture.remote.inspectNote.mockImplementation(async (candidatePath) => {
      if (candidatePath === destination)
        return {
          kind: "success",
          value: { kind: "absent", path: candidatePath },
        };
      return {
        kind: "success",
        value: {
          kind: "live",
          path: candidatePath,
          revision: otherRevision,
          contentSha256: hash,
          receipt: {
            action: "create",
            associationId: association,
            operationId,
            precondition: { kind: "absent" },
            contentSha256: hash,
          },
        },
      };
    });
    await fixture.service.discover();
    const created = await fixture.service.createReview({
      targetPath: path,
      destinationPath: destination,
      sessionId: reviewId,
    });
    expect(created.kind).toBe("created");
    if (created.kind !== "created") return;
    expect(created.review.snapshot.paths.map((entry) => entry.path)).toEqual([
      destination,
      path,
    ]);
    const admitted = await fixture.service.admit({
      reviewId: created.review.reviewId,
      sessionId: reviewId,
      destinationPath: destination,
      action: { kind: RECONCILIATION_ACTION.adoptRevision },
    });
    expect(admitted).toMatchObject({
      kind: "rejected",
      reason: "reservation-conflict",
    });
  });

  it("includes deferred rename history in bounded candidates and samples", async () => {
    const destination = "notes/deferred-destination.md" as typeof path;
    const fixture = makeService(
      undefined,
      state({
        kind: MIRROR_DESIRED_STATE_KIND.renameDeferred,
        observationGeneration: 1,
        renameId: operationId,
        associationId: association,
        sourcePath: path,
        destinationPath: destination,
        sourceExpectedRevision: revision,
        destinationObservationGeneration: 1,
        destinationAcknowledgedRevision: null,
        graceDeadlineMilliseconds: 10,
        phase: MIRROR_RENAME_PHASE.destinationRequired,
      }),
    );
    const discovered = await fixture.service.discover();
    expect(discovered.kind).toBe("complete");
    if (discovered.kind !== "complete") return;
    expect(discovered.candidates).toContain(destination);
    const created = await fixture.service.createReview({
      targetPath: path,
      relatedPaths: [destination],
      sessionId: reviewId,
    });
    expect(created.kind).toBe("created");
    if (created.kind !== "created") return;
    expect(created.review.snapshot.paths.map((entry) => entry.path)).toContain(
      destination,
    );
  });

  it("samples physical absence, tombstones, and legacy remote states", async () => {
    const absent = makeService();
    absent.local.list.mockResolvedValue({
      kind: LocalInspectionKind.ok,
      entries: [],
      skipped: {
        unsupported_file: 0,
        excluded_location: 0,
        invalid_path: 0,
        oversized: 0,
      },
    });
    absent.local.read.mockResolvedValue({
      kind: LocalInspectionKind.failed,
      reason: LocalVaultFailureReason.missingFile,
    });
    absent.remote.inspectNote.mockResolvedValue({
      kind: "success",
      value: { kind: "absent", path },
    });
    await absent.service.discover();
    expect(
      await absent.service.createReview({
        targetPath: path,
        sessionId: reviewId,
      }),
    ).toMatchObject({
      kind: "created",
      review: { classification: "remote-unavailable" },
    });

    const tombstone = makeService();
    tombstone.remote.inspectNote
      .mockResolvedValueOnce({ kind: "success", value: remoteTombstoneState() })
      .mockResolvedValueOnce({
        kind: "success",
        value: remoteTombstoneState(),
      });
    tombstone.remote.inspectRecovery.mockResolvedValue({
      kind: "success",
      value: snapshotRecovery(),
    });
    await tombstone.service.discover();
    const tombstoneReview = await tombstone.service.createReview({
      targetPath: path,
      sessionId: reviewId,
    });
    expect(tombstoneReview).toMatchObject({
      kind: "created",
      review: { classification: "remote-tombstoned" },
    });

    const legacy = makeService();
    const legacyState = { kind: "legacy" as const, path };
    legacy.remote.inspectNote
      .mockResolvedValueOnce({ kind: "success", value: legacyState })
      .mockResolvedValueOnce({ kind: "success", value: legacyState });
    legacy.remote.readNote.mockResolvedValue({
      kind: "success",
      value: { kind: "legacy", content: "legacy" },
    });
    await legacy.service.discover();
    expect(
      await legacy.service.createReview({
        targetPath: path,
        sessionId: reviewId,
      }),
    ).toMatchObject({
      kind: "created",
      review: { classification: "legacy-remote" },
    });
  });

  it("rejects unstable remote barriers and local read exceptions", async () => {
    const localException = makeService();
    localException.local.read.mockRejectedValue(new Error("read failed"));
    await localException.service.discover();
    expect(
      await localException.service.createReview({
        targetPath: path,
        sessionId: reviewId,
      }),
    ).toMatchObject({
      kind: "created",
      review: { classification: "unknown-local" },
    });

    const remoteReadFailure = makeService();
    remoteReadFailure.remote.readNote.mockResolvedValue({
      kind: "failure",
      failure: "malformed-response",
    });
    await remoteReadFailure.service.discover();
    expect(
      await remoteReadFailure.service.createReview({
        targetPath: path,
        sessionId: reviewId,
      }),
    ).toMatchObject({
      kind: "created",
      review: { classification: "remote-unavailable" },
    });

    const liveRevisionMismatch = makeService();
    liveRevisionMismatch.remote.readNote.mockResolvedValue({
      kind: "success",
      value: { kind: "live", revision, content: "same" },
    });
    await liveRevisionMismatch.service.discover();
    expect(
      await liveRevisionMismatch.service.createReview({
        targetPath: path,
        sessionId: reviewId,
      }),
    ).toMatchObject({
      kind: "created",
      review: { classification: "remote-unavailable" },
    });

    const legacyMismatch = makeService();
    legacyMismatch.remote.inspectNote
      .mockResolvedValueOnce({
        kind: "success",
        value: { kind: "legacy", path },
      })
      .mockResolvedValueOnce({
        kind: "success",
        value: { kind: "absent", path },
      });
    legacyMismatch.remote.readNote.mockResolvedValue({
      kind: "success",
      value: { kind: "legacy", content: "legacy" },
    });
    await legacyMismatch.service.discover();
    expect(
      await legacyMismatch.service.createReview({
        targetPath: path,
        sessionId: reviewId,
      }),
    ).toMatchObject({
      kind: "created",
      review: { classification: "remote-unavailable" },
    });
  });

  it("creates an ephemeral review and admits only the exact revisioned decision", async () => {
    const store = new Store();
    const observations = new ReconciliationObservationGenerationOwner();
    const remote = remoteReader();
    const service = new ReconciliationReviewService(
      {
        list: vi.fn(async () => ({
          kind: LocalInspectionKind.ok,
          entries: [{ path, sizeBytes: 5 }],
          skipped: {
            unsupported_file: 0,
            excluded_location: 0,
            invalid_path: 0,
            oversized: 0,
          },
        })),
        read: vi.fn(async () => ({
          kind: LocalInspectionKind.ok,
          content: "same",
          sizeBytes: 4,
        })),
      },
      remote,
      new MirrorStateOwner(state(), store),
      {
        runtime: { current: () => snapshot().runtime },
        observations,
        hashContent: vi.fn(async (content: string) =>
          content === "same" ? hash : otherHash,
        ),
        createOperationId: vi
          .fn()
          .mockReturnValueOnce(reviewId)
          .mockReturnValueOnce(operationId),
      },
    );
    const discovered = await service.discover();
    expect(discovered.kind).toBe("complete");
    const created = await service.createReview({
      targetPath: path,
      sessionId: reviewId,
    });
    expect(created.kind).toBe("created");
    if (created.kind !== "created") return;
    const sampledEvidence = created.review.snapshot.paths[0];
    expect(sampledEvidence?.local.kind).toBe(
      RECONCILIATION_LOCAL_EVIDENCE_KIND.live,
    );
    expect(sampledEvidence?.baseline.kind).toBe(
      MIRROR_ACKNOWLEDGEMENT_KIND.live,
    );
    if (
      sampledEvidence?.local.kind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.live ||
      sampledEvidence.baseline.kind !== MIRROR_ACKNOWLEDGEMENT_KIND.live
    ) {
      return;
    }
    expect(sampledEvidence.local.contentSha256).toBe(hash);
    expect(sampledEvidence.baseline.contentSha256).toBe(hash);
    expect(created.review.classification).toBe(
      RECONCILIATION_CLASSIFICATION.remoteAhead,
    );
    expect(created.review.allowedActions).toContain(
      RECONCILIATION_ACTION.adoptRevision,
    );
    expect(created.review.sampledLocalText).toBe("same");
    const admitted = await service.admit({
      reviewId,
      sessionId: reviewId,
      action: { kind: RECONCILIATION_ACTION.adoptRevision },
    });
    expect(admitted.kind).toBe("admitted");
    expect(store.saves).toHaveLength(1);
    expect(service.listOpen(reviewId)).toEqual([]);
    expect(remote.mutateNote).not.toHaveBeenCalled();
    expect(JSON.stringify(store.saves[0])).not.toContain("same");
  });

  it("transfers a continuously observed alternate restore to its explicit successor", async () => {
    const { fixture, alternatePath } =
      await createRestoredAlternatePathFixture();
    const successorReview = await fixture.service.createReview({
      targetPath: alternatePath,
      sessionId: secondOperationId,
    });
    if (successorReview.kind !== "created") {
      throw new Error("Restore successor fixture failed.");
    }
    const admitted = await fixture.service.admit({
      reviewId: successorReview.review.reviewId,
      sessionId: secondOperationId,
      action: { kind: RECONCILIATION_ACTION.keepLocal },
    });

    expect(admitted.kind).toBe("admitted");
    expect(fixture.owner.snapshot().state.reconciliationOperations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId,
          phase: RECONCILIATION_OPERATION_PHASE.completed,
          successorOperationId: thirdOperationId,
        }),
        expect.objectContaining({
          operationId: thirdOperationId,
          phase: RECONCILIATION_OPERATION_PHASE.admitted,
        }),
      ]),
    );
  });

  it("keeps an alternate restored path behind a gap-scoped successor review", async () => {
    const fixture = makeService();
    const alternatePath = "notes/restored.md" as typeof path;
    const tombstone = remoteTombstoneState();
    fixture.local.list.mockResolvedValue({
      kind: LocalInspectionKind.ok,
      entries: [],
      skipped: {
        unsupported_file: 0,
        excluded_location: 0,
        invalid_path: 0,
        oversized: 0,
      },
    });
    fixture.local.read.mockResolvedValue({
      kind: LocalInspectionKind.failed,
      reason: LocalVaultFailureReason.missingFile,
    });
    fixture.remote.inspectNote.mockImplementation(async (candidatePath) => ({
      kind: "success",
      value:
        candidatePath === path
          ? tombstone
          : { kind: "absent", path: candidatePath },
    }));
    fixture.remote.readNote.mockResolvedValue({
      kind: "success",
      value: { kind: "missing" },
    });
    fixture.remote.listRecovery.mockResolvedValue({
      kind: "success",
      value: { recoveries: [snapshotRecovery()], nextCursor: null },
    });
    fixture.remote.inspectRecovery.mockResolvedValue({
      kind: "success",
      value: snapshotRecovery(),
    });

    await fixture.service.discover();
    const restoreReview = await fixture.service.createReview({
      targetPath: path,
      sessionId: reviewId,
      relatedPaths: [alternatePath],
    });
    expect(restoreReview.kind).toBe("created");
    if (restoreReview.kind !== "created") return;
    await expect(
      fixture.service.admit({
        reviewId: restoreReview.review.reviewId,
        sessionId: reviewId,
        action: { kind: RECONCILIATION_ACTION.restoreRecovery },
        destinationPath: alternatePath,
      }),
    ).resolves.toMatchObject({ kind: "admitted" });
    await fixture.owner.transition((current) => ({
      ...current,
      reconciliationOperations: current.reconciliationOperations.map(
        (operation) => ({
          ...operation,
          phase: RECONCILIATION_OPERATION_PHASE.restoredPendingReview,
          localEffectObservation: {
            kind: LOCAL_EFFECT_OBSERVATION_KIND.confirmed,
            effectId,
            path: alternatePath,
            expectedHash: hash,
            listenerEpoch: 1,
            beforeGeneration: 1,
            postconditionHash: hash,
            successor: null,
          },
          localEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
        }),
      ),
    }));

    fixture.setRuntime({
      ...snapshot().runtime,
      listenerEpoch: 2,
    });
    fixture.local.list.mockResolvedValue({
      kind: LocalInspectionKind.ok,
      entries: [{ path: alternatePath, sizeBytes: 4 }],
      skipped: {
        unsupported_file: 0,
        excluded_location: 0,
        invalid_path: 0,
        oversized: 0,
      },
    });
    fixture.local.read.mockResolvedValue({
      kind: LocalInspectionKind.ok,
      content: "same",
      sizeBytes: 4,
    });
    await fixture.service.discover();
    const uncertainRestore = await fixture.owner.transition((current) => ({
      ...current,
      reconciliationOperations: current.reconciliationOperations.map(
        (operation) =>
          operation.operationId === operationId &&
          isNonHistoryReconciliationOperation(operation)
            ? {
                ...operation,
                phase: RECONCILIATION_OPERATION_PHASE.evidenceRequired,
                localEffect: MUTATION_EFFECT_CERTAINTY.unknown,
                localEffectObservation: {
                  kind: LOCAL_EFFECT_OBSERVATION_KIND.prepared,
                  effectId,
                  path: alternatePath,
                  expectedHash: hash,
                  listenerEpoch: 1,
                  beforeGeneration: 1,
                  postconditionHash: null,
                  successor: null,
                },
              }
            : operation,
      ),
    }));
    expect(uncertainRestore.kind).toBe("committed");
    const fenced = await fixture.owner.transition(
      fenceActiveReconciliationForObservationGap,
    );
    expect(fenced.kind).toBe("committed");
    const gapReview = await fixture.service.createGapGroupReview({
      predecessorOperationId: operationId,
      sessionId: reviewId,
    });
    expect(gapReview).toMatchObject({
      kind: "created",
      review: {
        children: expect.arrayContaining([
          expect.objectContaining({
            snapshot: expect.objectContaining({ targetPath: alternatePath }),
            allowedActions: [RECONCILIATION_ACTION.keepLocal],
          }),
        ]),
      },
    });
    expect(
      fixture.owner
        .snapshot()
        .state.reconciliationOperations.find(
          (operation) => operation.operationId === operationId,
        ),
    ).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.restoredPendingReview,
      observationCoverage:
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
    });
  });

  it("transfers a durable local-event fence to an explicit aligned successor", async () => {
    const fixture = makeService();
    fixture.hashContent.mockImplementation(async (content) =>
      content === "same" ? hash : otherHash,
    );
    fixture.remote.inspectNote.mockResolvedValue({
      kind: "success",
      value: {
        kind: "live",
        path,
        revision: otherRevision,
        contentSha256: otherHash,
        receipt: {
          action: "create",
          associationId: association,
          operationId,
          precondition: { kind: "absent" },
          contentSha256: otherHash,
        },
      },
    });
    fixture.remote.readNote.mockResolvedValue({
      kind: "success",
      value: {
        kind: "live",
        revision: otherRevision,
        content: "other",
      },
    });
    await fixture.service.discover();
    const initialReview = await fixture.service.createReview({
      targetPath: path,
      sessionId: reviewId,
    });
    expect(initialReview.kind).toBe("created");
    if (initialReview.kind !== "created") return;
    const initialAdmission = await fixture.service.admit({
      reviewId: initialReview.review.reviewId,
      sessionId: reviewId,
      action: { kind: RECONCILIATION_ACTION.useRemote },
    });
    if (initialAdmission.kind !== "admitted") {
      throw new Error(`Initial admission failed: ${initialAdmission.reason}`);
    }
    const preservationPath = createReconciliationPreservationPath(
      operationId,
      RECONCILIATION_PRESERVATION_SIDE.local,
    );
    expect(preservationPath).toBeDefined();
    if (preservationPath === undefined) return;
    fixture.observations.observe(path);
    await fixture.owner.transition((current) => ({
      ...current,
      paths: current.paths.map((entry) => ({
        ...entry,
        acknowledgement: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision: otherRevision,
          contentSha256: otherHash,
        },
      })),
      reconciliationOperations: current.reconciliationOperations.map(
        (operation) =>
          isNonHistoryReconciliationOperation(operation)
            ? {
                ...operation,
                phase: RECONCILIATION_OPERATION_PHASE.successorReviewRequired,
                preservationReceipts: [
                  {
                    scope: "operation",
                    operationId: operation.operationId,
                    originalPath: path,
                    side: RECONCILIATION_PRESERVATION_SIDE.local,
                    sourceRevision: null,
                    contentSha256: hash,
                    preservationPath,
                    proofState:
                      RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
                  },
                ],
                localEffectObservation: {
                  kind: LOCAL_EFFECT_OBSERVATION_KIND.confirmed,
                  effectId,
                  path,
                  expectedHash: otherHash,
                  listenerEpoch: 1,
                  beforeGeneration: 1,
                  postconditionHash: otherHash,
                  successor: {
                    firstGeneration: 2,
                    latestGeneration: 2,
                    eventKinds: [RECONCILIATION_EVENT_KIND.modify],
                  },
                },
                localEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
              }
            : operation,
      ),
    }));

    fixture.local.read.mockResolvedValue({
      kind: LocalInspectionKind.ok,
      content: "other",
      sizeBytes: 5,
    });
    await fixture.service.discover();
    const successorReview = await fixture.service.createReview({
      targetPath: path,
      sessionId: secondOperationId,
    });
    expect(successorReview).toMatchObject({
      kind: "created",
      review: {
        classification: RECONCILIATION_CLASSIFICATION.aligned,
        allowedActions: [RECONCILIATION_ACTION.defer],
      },
    });
    if (successorReview.kind !== "created") return;
    await expect(
      fixture.service.admit({
        reviewId: successorReview.review.reviewId,
        sessionId: secondOperationId,
        action: { kind: RECONCILIATION_ACTION.defer },
      }),
    ).resolves.toMatchObject({ kind: "admitted" });

    expect(fixture.owner.snapshot().state.reconciliationOperations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId,
          phase: RECONCILIATION_OPERATION_PHASE.completed,
          successorOperationId: thirdOperationId,
        }),
        expect.objectContaining({
          operationId: thirdOperationId,
          phase: RECONCILIATION_OPERATION_PHASE.completed,
        }),
      ]),
    );
  });

  it("invalidates the old review on refresh and on a same-text observation", async () => {
    const observations = new ReconciliationObservationGenerationOwner();
    const service = new ReconciliationReviewService(
      {
        list: vi.fn(async () => ({
          kind: LocalInspectionKind.ok,
          entries: [{ path, sizeBytes: 4 }],
          skipped: {
            unsupported_file: 0,
            excluded_location: 0,
            invalid_path: 0,
            oversized: 0,
          },
        })),
        read: vi.fn(async () => ({
          kind: LocalInspectionKind.ok,
          content: "same",
          sizeBytes: 4,
        })),
      },
      remoteReader(),
      new MirrorStateOwner(state(), new Store()),
      {
        runtime: { current: () => snapshot().runtime },
        observations,
        hashContent: vi.fn(async () => hash),
        createOperationId: vi
          .fn()
          .mockReturnValueOnce(reviewId)
          .mockReturnValueOnce(operationId),
      },
    );
    await service.discover();
    const first = await service.createReview({
      targetPath: path,
      sessionId: reviewId,
    });
    expect(first.kind).toBe("created");
    if (first.kind !== "created") return;
    const refreshed = await service.refreshReview(
      first.review.reviewId,
      reviewId,
    );
    expect(refreshed.kind).toBe("created");
    if (refreshed.kind !== "created") return;
    expect(refreshed.review.reviewId).not.toBe(first.review.reviewId);
    observations.observe(path);
    const stale = await service.admit({
      reviewId: refreshed.review.reviewId,
      sessionId: reviewId,
      action: { kind: RECONCILIATION_ACTION.defer },
    });
    expect(stale.kind).toBe("rejected");
    if (stale.kind === "rejected") expect(stale.reason).toBe("stale-review");

    const overlap = makeService();
    const secondPath = "notes/second.md" as typeof path;
    overlap.local.list.mockResolvedValue({
      kind: LocalInspectionKind.ok,
      entries: [
        { path, sizeBytes: 4 },
        { path: secondPath, sizeBytes: 4 },
      ],
      skipped: {
        unsupported_file: 0,
        excluded_location: 0,
        invalid_path: 0,
        oversized: 0,
      },
    });
    overlap.remote.listNotes.mockResolvedValue({
      kind: "success",
      value: { notes: [path, secondPath], nextCursor: null },
    });
    await overlap.service.discover();
    const overlapReview = await overlap.service.createReview({
      targetPath: path,
      sessionId: reviewId,
    });
    expect(overlapReview.kind).toBe("created");
    if (overlapReview.kind !== "created") return;
    const second = await overlap.service.createReview({
      targetPath: secondPath,
      relatedPaths: [path],
      sessionId: reviewId,
    });
    expect(second.kind).toBe("created");
    expect(overlap.service.listOpen(reviewId)).toHaveLength(1);
  });

  it("recovers an exact prepared local postcondition before opening fresh gap authority", async () => {
    const fixture = makeService();
    const predecessorOperationId = await createGapFencedOperation(fixture, {
      kind: RECONCILIATION_ACTION.useRemote,
    });
    const preservationPath = createReconciliationPreservationPath(
      operationId,
      RECONCILIATION_PRESERVATION_SIDE.local,
    );
    if (preservationPath === undefined) {
      throw new Error("Preservation fixture failed.");
    }
    const prepared = await fixture.owner.transition((current) => ({
      ...current,
      reconciliationOperations: current.reconciliationOperations.map(
        (operation) =>
          operation.operationId === predecessorOperationId &&
          isNonHistoryReconciliationOperation(operation)
            ? {
                ...operation,
                phase: RECONCILIATION_OPERATION_PHASE.evidenceRequired,
                localEffect: MUTATION_EFFECT_CERTAINTY.unknown,
                preservationReceipts: [
                  {
                    scope: "operation",
                    operationId: operation.operationId,
                    originalPath: path,
                    side: RECONCILIATION_PRESERVATION_SIDE.local,
                    sourceRevision: null,
                    contentSha256: hash,
                    preservationPath,
                    proofState:
                      RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
                  },
                ],
                localEffectObservation: {
                  kind: LOCAL_EFFECT_OBSERVATION_KIND.prepared,
                  effectId,
                  path,
                  expectedHash: hash,
                  listenerEpoch: operation.snapshot.runtime.listenerEpoch,
                  beforeGeneration: 1,
                  postconditionHash: null,
                  successor: null,
                },
              }
            : operation,
      ),
    }));
    expect(prepared.kind).toBe("committed");
    fixture.remote.inspectNote.mockResolvedValue({
      kind: "success",
      value: {
        kind: "live",
        path,
        revision,
        contentSha256: hash,
        receipt: {
          action: "create",
          associationId: association,
          operationId,
          precondition: { kind: "absent" },
          contentSha256: hash,
        },
      },
    });
    fixture.remote.readNote.mockResolvedValue({
      kind: "success",
      value: { kind: "live", revision, content: "same" },
    });

    const fresh = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    expect(fresh.kind).toBe("created");
    if (fresh.kind !== "created") return;
    const recovered = fixture.owner
      .snapshot()
      .state.reconciliationOperations.find(
        (operation) => operation.operationId === predecessorOperationId,
      );
    expect(recovered).toMatchObject({
      observationCoverage:
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
      phase: RECONCILIATION_OPERATION_PHASE.partial,
      localEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
      localEffectObservation: {
        kind: LOCAL_EFFECT_OBSERVATION_KIND.confirmed,
        expectedHash: hash,
        postconditionHash: hash,
      },
    });
    expect(fixture.remote.mutateNote).not.toHaveBeenCalled();
  });

  it("retains recovered certainty when the resampled local observation becomes unknown", async () => {
    const fixture = makeService();
    const predecessorOperationId = await prepareLocalGapEffect(fixture);
    fixture.local.read
      .mockResolvedValueOnce({
        kind: LocalInspectionKind.ok,
        content: "same",
        sizeBytes: 4,
      })
      .mockResolvedValue({
        kind: LocalInspectionKind.failed,
        reason: LocalVaultFailureReason.changedDuringRead,
      });

    await expect(
      fixture.service.createGapGroupReview({
        predecessorOperationId,
        sessionId: reviewId,
      }),
    ).resolves.toEqual({ kind: "failure", reason: "evidence-unavailable" });
    expect(
      fixture.owner
        .snapshot()
        .state.reconciliationOperations.find(
          (operation) => operation.operationId === predecessorOperationId,
        ),
    ).toMatchObject({
      observationCoverage:
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
      localEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
      reservations: [{ path }],
    });
    expect(fixture.remote.mutateNote).not.toHaveBeenCalled();
  });

  it("keeps every reservation when a fresh group sample is unavailable", async () => {
    const fixture = makeService();
    const predecessorOperationId = await createGapFencedOperation(fixture);
    fixture.remote.inspectNote.mockResolvedValue({
      kind: "failure",
      failure: "malformed-response",
    });

    await expect(
      fixture.service.createGapGroupReview({
        predecessorOperationId,
        sessionId: reviewId,
      }),
    ).resolves.toEqual({ kind: "failure", reason: "evidence-unavailable" });
    expect(
      fixture.owner
        .snapshot()
        .state.reconciliationOperations.find(
          (operation) => operation.operationId === predecessorOperationId,
        ),
    ).toMatchObject({
      observationCoverage:
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
    });
  });

  it("keeps a gap fenced when one reserved local sample is unstable", async () => {
    const fixture = makeService();
    const predecessorOperationId = await createGapFencedOperation(fixture);
    fixture.local.read.mockResolvedValue({
      kind: LocalInspectionKind.failed,
      reason: LocalVaultFailureReason.unavailable,
    });

    await expect(
      fixture.service.createGapGroupReview({
        predecessorOperationId,
        sessionId: reviewId,
      }),
    ).resolves.toEqual({ kind: "failure", reason: "evidence-unavailable" });
    expect(
      fixture.owner
        .snapshot()
        .state.reconciliationOperations.find(
          (operation) => operation.operationId === predecessorOperationId,
        ),
    ).toMatchObject({
      observationCoverage:
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
      reservations: [{ path }],
    });
    expect(fixture.remote.mutateNote).not.toHaveBeenCalled();
  });

  it("sorts every unreviewable path in a complete multi-reservation gap", async () => {
    const secondaryPath = required(
      normalizeNotePath("notes/review-secondary.md"),
    );
    const initial = state();
    const fixture = makeService(snapshot().runtime, {
      ...initial,
      paths: [
        ...initial.paths,
        {
          path: secondaryPath,
          acknowledgement: {
            kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
            revision,
            contentSha256: hash,
          },
          unresolvedMutation: null,
          desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
          blockedReason: null,
        },
      ],
    });
    fixture.local.list.mockResolvedValue({
      kind: LocalInspectionKind.ok,
      entries: [path, secondaryPath].map((candidatePath) => ({
        path: candidatePath,
        sizeBytes: 4,
      })),
      skipped: {
        unsupported_file: 0,
        excluded_location: 0,
        invalid_path: 0,
        oversized: 0,
      },
    });
    fixture.remote.listNotes.mockResolvedValue({
      kind: "success",
      value: { notes: [path, secondaryPath], nextCursor: null },
    });
    fixture.remote.inspectNote.mockImplementation(async (candidatePath) => ({
      kind: "success",
      value: {
        kind: "live",
        path: candidatePath,
        revision: candidatePath === path ? otherRevision : revision,
        contentSha256: hash,
        receipt: {
          action: "create",
          associationId: association,
          operationId,
          precondition: { kind: "absent" },
          contentSha256: hash,
        },
      },
    }));
    fixture.remote.readNote.mockImplementation(async (candidatePath) => ({
      kind: "success",
      value: {
        kind: "live",
        revision: candidatePath === path ? otherRevision : revision,
        content: "same",
      },
    }));
    const predecessorOperationId = await createGapFencedOperation(
      fixture,
      { kind: RECONCILIATION_ACTION.adoptRevision },
      { relatedPaths: [secondaryPath] },
    );
    const unassociated = await fixture.owner.transition((current) => ({
      ...current,
      paths: current.paths.map((entry) => ({
        ...entry,
        acknowledgement: { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
      })),
    }));
    expect(unassociated.kind).toBe("committed");
    fixture.remote.inspectNote.mockImplementation(async (candidatePath) => ({
      kind: "success",
      value: { kind: "absent", path: candidatePath },
    }));
    fixture.remote.readNote.mockResolvedValue({
      kind: "success",
      value: { kind: "missing" },
    });

    const fresh = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    expect(fresh).toMatchObject({
      kind: "created",
      review: {
        group: { unreviewablePaths: [secondaryPath, path] },
        children: [],
      },
    });
  });

  it("refuses ordinary admission for children of an atomic gap review", async () => {
    const fixture = makeService();
    const predecessorOperationId = await createGapFencedOperation(fixture);
    const fresh = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    if (fresh.kind !== "created") throw new Error("Gap fixture failed.");
    const child = required(fresh.review.children[0]);

    await expect(
      fixture.service.admit({
        reviewId: child.reviewId,
        sessionId: reviewId,
        action: { kind: RECONCILIATION_ACTION.keepLocal },
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "action-not-allowed",
    });
    expect(
      fixture.owner
        .snapshot()
        .state.reconciliationOperations.find(
          (operation) => operation.operationId === predecessorOperationId,
        ),
    ).toMatchObject({
      observationCoverage:
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
    });
  });

  it("marks an unassociated local-only reservation unreviewable without releasing it", async () => {
    const fixture = makeService();
    const predecessorOperationId = await createGapFencedOperation(fixture);
    await fixture.owner.transition((current) => ({
      ...current,
      paths: current.paths.map((entry) =>
        entry.path === path
          ? {
              ...entry,
              acknowledgement: {
                kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated,
              },
            }
          : entry,
      ),
    }));
    fixture.remote.inspectNote.mockResolvedValue({
      kind: "success",
      value: { kind: "absent", path },
    });
    fixture.remote.readNote.mockResolvedValue({
      kind: "success",
      value: { kind: "missing" },
    });

    const fresh = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    expect(fresh).toMatchObject({
      kind: "created",
      review: {
        group: { unreviewablePaths: [path] },
        children: [],
      },
    });
    if (fresh.kind !== "created") return;
    await expect(
      fixture.service.admitGapGroup({
        reviewId: fresh.review.group.reviewId,
        sessionId: reviewId,
        actions: [],
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "action-not-allowed",
    });
    expect(
      fixture.owner
        .snapshot()
        .state.reconciliationOperations.find(
          (operation) => operation.operationId === predecessorOperationId,
        ),
    ).toMatchObject({
      observationCoverage:
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
    });
  });

  it("rejects generated review identities that collide with the fenced predecessor", async () => {
    const fixture = makeService(snapshot().runtime, state(), [
      reviewId,
      operationId,
      operationId,
    ]);
    const predecessorOperationId = await createGapFencedOperation(fixture);

    await expect(
      fixture.service.createGapGroupReview({
        predecessorOperationId,
        sessionId: reviewId,
      }),
    ).resolves.toEqual({ kind: "failure", reason: "stale-review" });
  });

  it("retains the original gap when exact local recovery cannot be durably saved", async () => {
    const fixture = makeService();
    const predecessorOperationId = await prepareLocalGapEffect(fixture);
    fixture.store.fail = true;

    await expect(
      fixture.service.createGapGroupReview({
        predecessorOperationId,
        sessionId: reviewId,
      }),
    ).resolves.toEqual({ kind: "failure", reason: "persistence-failure" });
    expect(
      fixture.owner
        .snapshot()
        .state.reconciliationOperations.find(
          (operation) => operation.operationId === predecessorOperationId,
        ),
    ).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.evidenceRequired,
      observationCoverage:
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
      localEffect: MUTATION_EFFECT_CERTAINTY.unknown,
      localEffectObservation: { kind: LOCAL_EFFECT_OBSERVATION_KIND.prepared },
    });
  });

  it("rechecks active runtime authority after exact recovery changes durable state", async () => {
    const fixture = makeService();
    const predecessorOperationId = await prepareLocalGapEffect(fixture);
    fixture.store.afterSave = () =>
      fixture.setRuntime({
        ...snapshot().runtime,
        lifecycle: { kind: MIRROR_DEVICE_LIFECYCLE_KIND.disabled },
      });

    await expect(
      fixture.service.createGapGroupReview({
        predecessorOperationId,
        sessionId: reviewId,
      }),
    ).resolves.toEqual({
      kind: "failure",
      reason: "invalid-lifecycle-or-authority",
    });
    expect(
      fixture.owner
        .snapshot()
        .state.reconciliationOperations.find(
          (operation) => operation.operationId === predecessorOperationId,
        ),
    ).toMatchObject({
      observationCoverage:
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
      localEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
    });
  });

  it("refuses stale exact-effect recovery after concurrent durable settlement", async () => {
    const fixture = makeService();
    const predecessorOperationId = await prepareLocalGapEffect(fixture);
    const predecessor = fixture.owner
      .snapshot()
      .state.reconciliationOperations.find(
        (operation) => operation.operationId === predecessorOperationId,
      );
    if (
      predecessor === undefined ||
      !isNonHistoryReconciliationOperation(predecessor) ||
      predecessor.localEffectObservation.kind !==
        LOCAL_EFFECT_OBSERVATION_KIND.prepared
    ) {
      throw new Error("Expected a prepared local-effect predecessor.");
    }
    fixture.remote.readNote.mockImplementation(async () => {
      const settled = await fixture.owner.transition((current) => ({
        ...current,
        reconciliationOperations: current.reconciliationOperations.map(
          (operation) =>
            operation.operationId === predecessorOperationId &&
            isNonHistoryReconciliationOperation(operation) &&
            operation.localEffectObservation.kind ===
              LOCAL_EFFECT_OBSERVATION_KIND.prepared
              ? {
                  ...operation,
                  phase: RECONCILIATION_OPERATION_PHASE.partial,
                  localEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
                  localEffectObservation: {
                    ...operation.localEffectObservation,
                    kind: LOCAL_EFFECT_OBSERVATION_KIND.confirmed,
                    postconditionHash: hash,
                  },
                }
              : operation,
        ),
      }));
      expect(settled.kind).toBe("committed");
      return {
        kind: "success",
        value: { kind: "live", revision: otherRevision, content: "same" },
      };
    });

    await expect(
      fixture.service.createGapGroupReview({
        predecessorOperationId,
        sessionId: reviewId,
      }),
    ).resolves.toEqual({ kind: "failure", reason: "stale-review" });
    expect(fixture.remote.mutateNote).not.toHaveBeenCalled();
  });

  it("recovers only a current exact operation-bound remote receipt before transfer", async () => {
    const fixture = makeService();
    fixture.remote.inspectNote.mockResolvedValue({
      kind: "success",
      value: {
        kind: "tombstone",
        path,
        revision: otherRevision,
        deletedRevision: revision,
        recoveryId: operationId,
        receipt: {
          action: "tombstone",
          associationId: association,
          operationId,
          precondition: { kind: "matching-revision", revision },
        },
      },
    });
    const predecessorOperationId = await createGapFencedOperation(fixture, {
      kind: RECONCILIATION_ACTION.recreateRemote,
    });
    const preservationPath = createReconciliationPreservationPath(
      operationId,
      RECONCILIATION_PRESERVATION_SIDE.local,
    );
    if (preservationPath === undefined) {
      throw new Error("Preservation fixture failed.");
    }
    const uncertain = await fixture.owner.transition((current) => ({
      ...current,
      reconciliationOperations: current.reconciliationOperations.map(
        (operation) =>
          operation.operationId === predecessorOperationId &&
          isNonHistoryReconciliationOperation(operation)
            ? {
                ...operation,
                phase: RECONCILIATION_OPERATION_PHASE.evidenceRequired,
                remoteEffect: MUTATION_EFFECT_CERTAINTY.unknown,
                preservationReceipts: [
                  {
                    scope: "operation",
                    operationId: operation.operationId,
                    originalPath: path,
                    side: RECONCILIATION_PRESERVATION_SIDE.local,
                    sourceRevision: null,
                    contentSha256: hash,
                    preservationPath,
                    proofState:
                      RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
                  },
                ],
              }
            : operation,
      ),
    }));
    expect(uncertain.kind).toBe("committed");
    fixture.remote.inspectNote.mockResolvedValue({
      kind: "success",
      value: {
        kind: "live",
        path,
        revision: recoveredRevision,
        contentSha256: hash,
        receipt: {
          action: "recreate",
          associationId: association,
          operationId: predecessorOperationId,
          precondition: {
            kind: "matching-revision",
            revision: otherRevision,
          },
          contentSha256: hash,
        },
      },
    });
    fixture.remote.readNote.mockResolvedValue({
      kind: "success",
      value: {
        kind: "live",
        revision: recoveredRevision,
        content: "same",
      },
    });

    const fresh = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    expect(fresh.kind).toBe("created");
    const recovered = fixture.owner
      .snapshot()
      .state.reconciliationOperations.find(
        (operation) => operation.operationId === predecessorOperationId,
      );
    expect(recovered).toMatchObject({
      observationCoverage:
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
      phase: RECONCILIATION_OPERATION_PHASE.partial,
      remoteEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
    });
    expect(fixture.remote.mutateNote).not.toHaveBeenCalled();
  });

  it("recovers a fork-legacy write only from its exact absent-destination receipt", async () => {
    const fixture = makeService();
    const destination = required(normalizeNotePath("notes/forked-legacy.md"));
    fixture.local.read.mockImplementation(async (candidatePath) =>
      candidatePath === path
        ? { kind: LocalInspectionKind.ok, content: "same", sizeBytes: 4 }
        : {
            kind: LocalInspectionKind.failed,
            reason: LocalVaultFailureReason.missingFile,
          },
    );
    fixture.remote.inspectNote.mockImplementation(async (candidatePath) =>
      candidatePath === path
        ? {
            kind: "success",
            value: { kind: "legacy", path, contentSha256: hash },
          }
        : { kind: "success", value: { kind: "absent", path: destination } },
    );
    fixture.remote.readNote.mockImplementation(async (candidatePath) =>
      candidatePath === path
        ? { kind: "success", value: { kind: "legacy", content: "same" } }
        : { kind: "success", value: { kind: "missing" } },
    );
    const predecessorOperationId = await createGapFencedOperation(
      fixture,
      { kind: RECONCILIATION_ACTION.forkLegacy },
      { relatedPaths: [destination], destinationPath: destination },
    );
    const preservationPath = createReconciliationPreservationPath(
      predecessorOperationId,
      RECONCILIATION_PRESERVATION_SIDE.remote,
    );
    if (preservationPath === undefined) {
      throw new Error("Legacy preservation fixture failed.");
    }
    const uncertain = await fixture.owner.transition((current) => ({
      ...current,
      reconciliationOperations: current.reconciliationOperations.map(
        (operation) =>
          operation.operationId === predecessorOperationId &&
          isNonHistoryReconciliationOperation(operation)
            ? {
                ...operation,
                phase: RECONCILIATION_OPERATION_PHASE.evidenceRequired,
                remoteEffect: MUTATION_EFFECT_CERTAINTY.unknown,
                preservationReceipts: [
                  {
                    scope: "operation",
                    operationId: predecessorOperationId,
                    originalPath: path,
                    side: RECONCILIATION_PRESERVATION_SIDE.remote,
                    sourceRevision: null,
                    contentSha256: hash,
                    preservationPath,
                    proofState:
                      RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
                  },
                ],
              }
            : operation,
      ),
    }));
    expect(uncertain.kind).toBe("committed");
    fixture.remote.inspectNote.mockImplementation(async (candidatePath) =>
      candidatePath === path
        ? {
            kind: "success",
            value: { kind: "legacy", path, contentSha256: hash },
          }
        : {
            kind: "success",
            value: {
              kind: "live",
              path: destination,
              revision: recoveredRevision,
              contentSha256: hash,
              receipt: {
                action: "create",
                associationId: association,
                operationId: predecessorOperationId,
                precondition: { kind: "absent" },
                contentSha256: hash,
              },
            },
          },
    );
    fixture.remote.readNote.mockImplementation(async (candidatePath) =>
      candidatePath === path
        ? { kind: "success", value: { kind: "legacy", content: "same" } }
        : {
            kind: "success",
            value: {
              kind: "live",
              revision: recoveredRevision,
              content: "same",
            },
          },
    );

    const fresh = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    expect(fresh.kind).toBe("created");
    expect(
      fixture.owner
        .snapshot()
        .state.reconciliationOperations.find(
          (operation) => operation.operationId === predecessorOperationId,
        ),
    ).toMatchObject({ remoteEffect: MUTATION_EFFECT_CERTAINTY.confirmed });
    expect(fixture.remote.mutateNote).not.toHaveBeenCalled();
  });

  it("recovers a keep-local mutation only from its exact current update receipt", async () => {
    const fixture = makeService();
    fixture.local.read.mockResolvedValue({
      kind: LocalInspectionKind.ok,
      content: "local changed",
      sizeBytes: 13,
    });
    fixture.hashContent.mockImplementation(async (content) =>
      content === "local changed" ? otherHash : hash,
    );
    const predecessorOperationId = await createGapFencedOperation(fixture, {
      kind: RECONCILIATION_ACTION.keepLocal,
    });
    const preservationPath = createReconciliationPreservationPath(
      predecessorOperationId,
      RECONCILIATION_PRESERVATION_SIDE.remote,
    );
    if (preservationPath === undefined) {
      throw new Error("Remote preservation fixture failed.");
    }
    const uncertain = await fixture.owner.transition((current) => ({
      ...current,
      reconciliationOperations: current.reconciliationOperations.map(
        (operation) =>
          operation.operationId === predecessorOperationId &&
          isNonHistoryReconciliationOperation(operation)
            ? {
                ...operation,
                phase: RECONCILIATION_OPERATION_PHASE.evidenceRequired,
                remoteEffect: MUTATION_EFFECT_CERTAINTY.unknown,
                preservationReceipts: [
                  {
                    scope: "operation",
                    operationId: predecessorOperationId,
                    originalPath: path,
                    side: RECONCILIATION_PRESERVATION_SIDE.remote,
                    sourceRevision: otherRevision,
                    contentSha256: hash,
                    preservationPath,
                    proofState:
                      RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
                  },
                ],
              }
            : operation,
      ),
    }));
    expect(uncertain.kind).toBe("committed");
    fixture.remote.inspectNote.mockResolvedValue({
      kind: "success",
      value: {
        kind: "live",
        path,
        revision: recoveredRevision,
        contentSha256: otherHash,
        receipt: {
          action: "update",
          associationId: association,
          operationId: predecessorOperationId,
          precondition: { kind: "matching-revision", revision: otherRevision },
          contentSha256: otherHash,
        },
      },
    });
    fixture.remote.readNote.mockResolvedValue({
      kind: "success",
      value: {
        kind: "live",
        revision: recoveredRevision,
        content: "local changed",
      },
    });

    const fresh = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    expect(fresh.kind).toBe("created");
    expect(
      fixture.owner
        .snapshot()
        .state.reconciliationOperations.find(
          (operation) => operation.operationId === predecessorOperationId,
        ),
    ).toMatchObject({ remoteEffect: MUTATION_EFFECT_CERTAINTY.confirmed });
    expect(fixture.remote.mutateNote).not.toHaveBeenCalled();
  });

  it.each([
    { primarySide: RECONCILIATION_PRESERVATION_SIDE.local },
    { primarySide: RECONCILIATION_PRESERVATION_SIDE.remote },
  ])(
    "recovers the exact remote effect of gap-fenced keep-both with $primarySide primary",
    async ({ primarySide }) => {
      const fixture = makeService();
      const primaryIsLocal =
        primarySide === RECONCILIATION_PRESERVATION_SIDE.local;
      let predecessorOperationId = operationId;
      let remoteUpdated = false;
      fixture.local.read.mockImplementation(async (candidatePath) => {
        if (candidatePath === path) {
          return {
            kind: LocalInspectionKind.ok,
            content: "same",
            sizeBytes: 4,
          };
        }
        if (candidatePath === historyDestination && remoteUpdated) {
          const content = primaryIsLocal ? "other" : "same";
          return {
            kind: LocalInspectionKind.ok,
            content,
            sizeBytes: content.length,
          };
        }
        return {
          kind: LocalInspectionKind.failed,
          reason: LocalVaultFailureReason.missingFile,
        };
      });
      fixture.hashContent.mockImplementation(async (content) =>
        content === "same" ? hash : otherHash,
      );
      fixture.remote.inspectNote.mockImplementation(async (candidatePath) => {
        if (candidatePath !== path) {
          if (remoteUpdated && !primaryIsLocal) {
            return {
              kind: "success",
              value: {
                kind: "live",
                path: candidatePath,
                revision: recoveredRevision,
                contentSha256: hash,
                receipt: {
                  action: "create",
                  associationId: association,
                  operationId: predecessorOperationId,
                  precondition: { kind: "absent" },
                  contentSha256: hash,
                },
              },
            };
          }
          return {
            kind: "success",
            value: { kind: "absent", path: candidatePath },
          };
        }
        if (remoteUpdated && primaryIsLocal) {
          return {
            kind: "success",
            value: {
              kind: "live",
              path,
              revision: recoveredRevision,
              contentSha256: hash,
              receipt: {
                action: "update",
                associationId: association,
                operationId: predecessorOperationId,
                precondition: {
                  kind: "matching-revision",
                  revision: otherRevision,
                },
                contentSha256: hash,
              },
            },
          };
        }
        return {
          kind: "success",
          value: {
            kind: "live",
            path,
            revision: otherRevision,
            contentSha256: otherHash,
            receipt: {
              action: "create",
              associationId: association,
              operationId,
              precondition: { kind: "absent" },
              contentSha256: otherHash,
            },
          },
        };
      });
      fixture.remote.readNote.mockImplementation(async (candidatePath) => ({
        kind: "success",
        value: {
          kind: "live",
          revision:
            remoteUpdated &&
            (primaryIsLocal ? candidatePath === path : candidatePath !== path)
              ? recoveredRevision
              : otherRevision,
          content:
            candidatePath !== path || (remoteUpdated && primaryIsLocal)
              ? "same"
              : "other",
        },
      }));
      await fixture.service.discover();
      const review = await fixture.service.createReview({
        targetPath: path,
        destinationPath: historyDestination,
        sessionId: reviewId,
      });
      if (review.kind !== "created") {
        throw new Error(`Keep-both review fixture failed: ${review.kind}`);
      }
      const admitted = await fixture.service.admit({
        reviewId: review.review.reviewId,
        sessionId: reviewId,
        action: {
          kind: RECONCILIATION_ACTION.keepBoth,
          primarySide,
        },
        destinationPath: historyDestination,
      });
      if (admitted.kind !== "admitted") {
        throw new Error(`Keep-both admission failed: ${admitted.reason}`);
      }
      predecessorOperationId = admitted.operation.operationId;
      const preservationSide = primaryIsLocal
        ? RECONCILIATION_PRESERVATION_SIDE.remote
        : RECONCILIATION_PRESERVATION_SIDE.local;
      const preservedHash = primaryIsLocal ? otherHash : hash;
      const preservationPath = createReconciliationPreservationPath(
        predecessorOperationId,
        preservationSide,
      );
      if (preservationPath === undefined) {
        throw new Error("Keep-both preservation fixture failed.");
      }
      const destination = admitted.operation.snapshot.paths.find(
        (evidence) => evidence.path === historyDestination,
      );
      if (destination === undefined || destination.local.kind !== "absent") {
        throw new Error("Keep-both destination fixture failed.");
      }
      const destinationGeneration = destination.local.observationGeneration;
      const uncertain = await fixture.owner.transition((current) => ({
        ...current,
        reconciliationOperations: current.reconciliationOperations.map(
          (operation) =>
            operation.operationId === predecessorOperationId &&
            isNonHistoryReconciliationOperation(operation)
              ? {
                  ...operation,
                  phase: RECONCILIATION_OPERATION_PHASE.evidenceRequired,
                  localEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
                  localEffectObservation: {
                    kind: LOCAL_EFFECT_OBSERVATION_KIND.confirmed,
                    effectId,
                    path: historyDestination,
                    expectedHash: preservedHash,
                    listenerEpoch: operation.snapshot.runtime.listenerEpoch,
                    beforeGeneration: destinationGeneration,
                    postconditionHash: preservedHash,
                    successor: null,
                  },
                  remoteEffect: MUTATION_EFFECT_CERTAINTY.unknown,
                  preservationReceipts: [
                    {
                      scope: "operation",
                      operationId: predecessorOperationId,
                      originalPath: path,
                      side: preservationSide,
                      sourceRevision: primaryIsLocal ? otherRevision : null,
                      contentSha256: preservedHash,
                      preservationPath,
                      proofState:
                        RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
                    },
                  ],
                }
              : operation,
        ),
      }));
      expect(uncertain.kind).toBe("committed");
      const fenced = await fixture.owner.transition(
        fenceActiveReconciliationForObservationGap,
      );
      expect(fenced.kind).toBe("committed");
      remoteUpdated = true;

      const fresh = await fixture.service.createGapGroupReview({
        predecessorOperationId,
        sessionId: reviewId,
      });
      expect(fresh.kind).toBe("created");
      expect(
        fixture.owner
          .snapshot()
          .state.reconciliationOperations.find(
            (operation) => operation.operationId === predecessorOperationId,
          ),
      ).toMatchObject({
        observationCoverage:
          RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
        remoteEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
      });
      expect(fixture.remote.mutateNote).not.toHaveBeenCalled();
    },
  );

  it("refuses transfer when exact local-effect recovery remains uncertain", async () => {
    const fixture = makeService();
    const predecessorOperationId = await prepareLocalGapEffect(fixture);
    fixture.local.read.mockResolvedValue({
      kind: LocalInspectionKind.ok,
      content: "external change",
      sizeBytes: 15,
    });
    fixture.hashContent.mockResolvedValue(otherHash);
    const fresh = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    if (fresh.kind !== "created") throw new Error("Gap fixture failed.");
    const child = required(fresh.review.children[0]);

    await expect(
      fixture.service.admitGapGroup({
        reviewId: fresh.review.group.reviewId,
        sessionId: reviewId,
        actions: [
          {
            reviewId: child.reviewId,
            action: { kind: RECONCILIATION_ACTION.useRemote },
          },
        ],
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "action-not-allowed",
    });
    expect(
      fixture.owner
        .snapshot()
        .state.reconciliationOperations.find(
          (operation) => operation.operationId === predecessorOperationId,
        ),
    ).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.evidenceRequired,
      localEffect: MUTATION_EFFECT_CERTAINTY.unknown,
      observationCoverage:
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
    });
  });

  it("retains an aligned predecessor when no-effect settlement persistence fails", async () => {
    const fixture = makeService();
    const predecessorOperationId = await createGapFencedOperation(fixture);
    const aligned = await fixture.owner.transition((current) => ({
      ...current,
      paths: current.paths.map((entry) => ({
        ...entry,
        acknowledgement: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision: otherRevision,
          contentSha256: hash,
        },
      })),
    }));
    expect(aligned.kind).toBe("committed");
    const fresh = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    expect(fresh).toMatchObject({ kind: "created", review: { children: [] } });
    if (fresh.kind !== "created") return;
    fixture.store.fail = true;

    await expect(
      fixture.service.admitGapGroup({
        reviewId: fresh.review.group.reviewId,
        sessionId: reviewId,
        actions: [],
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "persistence-failure",
    });
    expect(
      fixture.owner
        .snapshot()
        .state.reconciliationOperations.find(
          (operation) => operation.operationId === predecessorOperationId,
        ),
    ).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.admitted,
      observationCoverage:
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
    });
  });

  it("retains predecessor and child authority when atomic transfer persistence fails", async () => {
    const fixture = makeService();
    const predecessorOperationId = await createGapFencedOperation(fixture);
    const fresh = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    if (fresh.kind !== "created") throw new Error("Gap fixture failed.");
    const child = required(fresh.review.children[0]);
    fixture.store.fail = true;

    await expect(
      fixture.service.admitGapGroup({
        reviewId: fresh.review.group.reviewId,
        sessionId: reviewId,
        actions: [
          {
            reviewId: child.reviewId,
            action: { kind: RECONCILIATION_ACTION.adoptRevision },
          },
        ],
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "persistence-failure",
    });
    expect(
      fixture.owner
        .snapshot()
        .state.reconciliationOperations.find(
          (operation) => operation.operationId === predecessorOperationId,
        ),
    ).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.admitted,
      observationCoverage:
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
      gapSuccessorOperationIds: [],
    });
  });

  it("refuses missing, stale-session, and incomplete gap submissions without releasing reservations", async () => {
    const fixture = makeService();
    const predecessorOperationId = await createGapFencedOperation(fixture);
    expect(
      await fixture.service.createGapGroupReview({
        predecessorOperationId: sixthOperationId,
        sessionId: reviewId,
      }),
    ).toEqual({ kind: "not-reviewable" });
    const fresh = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    if (fresh.kind !== "created") throw new Error("Gap fixture failed.");

    await expect(
      fixture.service.admitGapGroup({
        reviewId: fresh.review.group.reviewId,
        sessionId: operationId,
        actions: [],
      }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "stale-review" });
    const child = required(fresh.review.children[0]);
    await expect(
      fixture.service.admitGapGroup({
        reviewId: sixthOperationId,
        sessionId: reviewId,
        actions: [],
      }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "review-not-found" });
    await expect(
      fixture.service.admitGapGroup({
        reviewId: fresh.review.group.reviewId,
        sessionId: reviewId,
        actions: [],
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "action-not-allowed",
    });
    await expect(
      fixture.service.admitGapGroup({
        reviewId: fresh.review.group.reviewId,
        sessionId: reviewId,
        actions: [
          {
            reviewId: sixthOperationId,
            action: { kind: RECONCILIATION_ACTION.keepLocal },
          },
        ],
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "action-not-allowed",
    });
    await expect(
      fixture.service.admitGapGroup({
        reviewId: fresh.review.group.reviewId,
        sessionId: reviewId,
        actions: [
          {
            reviewId: child.reviewId,
            action: { kind: RECONCILIATION_ACTION.defer },
          },
        ],
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "action-not-allowed",
    });
    await expect(
      fixture.service.admitGapGroup({
        reviewId: fresh.review.group.reviewId,
        sessionId: reviewId,
        actions: [
          {
            reviewId: child.reviewId,
            action: { kind: RECONCILIATION_ACTION.useRemote },
            destinationPath: historyDestination,
          },
        ],
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "action-not-allowed",
    });
    fixture.setRuntime({
      ...snapshot().runtime,
      lifecycle: { kind: MIRROR_DEVICE_LIFECYCLE_KIND.disabled },
    });
    await expect(
      fixture.service.admitGapGroup({
        reviewId: fresh.review.group.reviewId,
        sessionId: reviewId,
        actions: [],
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "invalid-lifecycle-or-authority",
    });
    expect(
      fixture.owner
        .snapshot()
        .state.reconciliationOperations.find(
          (operation) => operation.operationId === predecessorOperationId,
        ),
    ).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.admitted,
      observationCoverage:
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
      gapSuccessorOperationIds: [],
    });
  });

  it("rejects a successor identity that collides with persisted gap authority", async () => {
    const fixture = makeService(snapshot().runtime, state(), [
      reviewId,
      operationId,
      secondOperationId,
      thirdOperationId,
      operationId,
    ]);
    const predecessorOperationId = await createGapFencedOperation(fixture);
    const fresh = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    if (fresh.kind !== "created") throw new Error("Gap fixture failed.");
    const child = required(fresh.review.children[0]);

    await expect(
      fixture.service.admitGapGroup({
        reviewId: fresh.review.group.reviewId,
        sessionId: reviewId,
        actions: [
          {
            reviewId: child.reviewId,
            action: { kind: RECONCILIATION_ACTION.adoptRevision },
          },
        ],
      }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "stale-review" });
    expect(
      fixture.owner
        .snapshot()
        .state.reconciliationOperations.find(
          (operation) => operation.operationId === predecessorOperationId,
        ),
    ).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.admitted,
      observationCoverage:
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
      gapSuccessorOperationIds: [],
    });
  });

  it("rejects a group transfer after one child review loses presentation ownership", async () => {
    const fixture = makeService();
    const predecessorOperationId = await createGapFencedOperation(fixture);
    const fresh = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    if (fresh.kind !== "created") throw new Error("Gap fixture failed.");
    const child = required(fresh.review.children[0]);
    expect(fixture.service.closeReview(child.reviewId, reviewId)).toBe(true);

    await expect(
      fixture.service.admitGapGroup({
        reviewId: fresh.review.group.reviewId,
        sessionId: reviewId,
        actions: [
          {
            reviewId: child.reviewId,
            action: { kind: RECONCILIATION_ACTION.adoptRevision },
          },
        ],
      }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "stale-review" });
    expect(
      fixture.owner
        .snapshot()
        .state.reconciliationOperations.find(
          (operation) => operation.operationId === predecessorOperationId,
        ),
    ).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.admitted,
      observationCoverage:
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
      gapSuccessorOperationIds: [],
    });
  });

  it("invalidates a complete gap group when any freshly sampled identity changes", async () => {
    const fixture = makeService();
    const predecessorOperationId = await createGapFencedOperation(fixture);
    const fresh = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    if (fresh.kind !== "created") throw new Error("Gap fixture failed.");
    fixture.remote.inspectNote.mockResolvedValue({
      kind: "success",
      value: {
        kind: "live",
        path,
        revision,
        contentSha256: hash,
        receipt: {
          action: "create",
          associationId: association,
          operationId,
          precondition: { kind: "absent" },
          contentSha256: hash,
        },
      },
    });
    fixture.remote.readNote.mockResolvedValue({
      kind: "success",
      value: { kind: "live", revision, content: "same" },
    });

    await expect(
      fixture.service.admitGapGroup({
        reviewId: fresh.review.group.reviewId,
        sessionId: reviewId,
        actions: [],
      }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "stale-review" });
    expect(
      fixture.owner.snapshot().state.reconciliationGapGroupReviews,
    ).toContainEqual(
      expect.objectContaining({
        reviewId: fresh.review.group.reviewId,
        status: RECONCILIATION_GAP_REVIEW_STATUS.stale,
      }),
    );
    expect(
      fixture.owner
        .snapshot()
        .state.reconciliationOperations.find(
          (operation) => operation.operationId === predecessorOperationId,
        ),
    ).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.admitted,
      gapSuccessorOperationIds: [],
    });
  });

  it("does not create gap review authority from invalid runtime or unavailable remote evidence", async () => {
    const fixture = makeService();
    const predecessorOperationId = await createGapFencedOperation(fixture);
    fixture.setRuntime({
      ...snapshot().runtime,
      lifecycle: { kind: MIRROR_DEVICE_LIFECYCLE_KIND.disabled },
    });
    await expect(
      fixture.service.createGapGroupReview({
        predecessorOperationId,
        sessionId: reviewId,
      }),
    ).resolves.toEqual({
      kind: "failure",
      reason: "invalid-lifecycle-or-authority",
    });
    fixture.setRuntime(snapshot().runtime);
    fixture.remote.inspectNote.mockResolvedValue({
      kind: "failure",
      failure: REMOTE_BRIDGE_FAILURE.networkUnavailable,
    });

    await expect(
      fixture.service.createGapGroupReview({
        predecessorOperationId,
        sessionId: reviewId,
      }),
    ).resolves.toEqual({ kind: "failure", reason: "evidence-unavailable" });
    expect(fixture.remote.mutateNote).not.toHaveBeenCalled();
    expect(
      fixture.owner
        .snapshot()
        .state.reconciliationOperations.find(
          (operation) => operation.operationId === predecessorOperationId,
        ),
    ).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.admitted,
      observationCoverage:
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
    });
  });

  it("rejects a generated complete-gap review identity that collides with its predecessor", async () => {
    const fixture = makeService(snapshot().runtime, state(), [
      reviewId,
      operationId,
      operationId,
    ]);
    const predecessorOperationId = await createGapFencedOperation(fixture);

    await expect(
      fixture.service.createGapGroupReview({
        predecessorOperationId,
        sessionId: reviewId,
      }),
    ).resolves.toEqual({ kind: "failure", reason: "stale-review" });
  });

  it("rejects a generated child identity that collides with its group", async () => {
    const fixture = makeService(snapshot().runtime, state(), [
      reviewId,
      operationId,
      secondOperationId,
      secondOperationId,
    ]);
    const predecessorOperationId = await createGapFencedOperation(fixture);

    await expect(
      fixture.service.createGapGroupReview({
        predecessorOperationId,
        sessionId: reviewId,
      }),
    ).resolves.toEqual({ kind: "failure", reason: "stale-review" });
  });

  it("invalidates older overlapping gap samples before publishing a replacement", async () => {
    const fixture = makeService();
    const predecessorOperationId = await createGapFencedOperation(fixture);
    const first = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    if (first.kind !== "created") throw new Error("First gap fixture failed.");
    const firstChild = required(first.review.children[0]);
    expect(
      fixture.service.preview(firstChild.reviewId, reviewId, "local"),
    ).toBe("same");

    const replacement = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    expect(replacement.kind).toBe("created");
    expect(
      fixture.service.preview(firstChild.reviewId, reviewId, "local"),
    ).toBeNull();
    if (replacement.kind !== "created") return;
    const replacementChild = required(replacement.review.children[0]);
    expect(
      fixture.service.preview(replacementChild.reviewId, reviewId, "local"),
    ).toBe("same");
  });

  it("closes a complete gap review only for its exact presentation owner", async () => {
    const fixture = makeService();
    const predecessorOperationId = await createGapFencedOperation(fixture);
    const fresh = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    if (fresh.kind !== "created") throw new Error("Gap fixture failed.");
    const child = required(fresh.review.children[0]);

    expect(
      fixture.service.closeGapGroupReview(
        fresh.review.group.reviewId,
        operationId,
      ),
    ).toBe(false);
    expect(
      fixture.service.closeGapGroupReview(
        fresh.review.group.reviewId,
        reviewId,
      ),
    ).toBe(true);
    expect(
      fixture.service.preview(child.reviewId, reviewId, "local"),
    ).toBeNull();
    await expect(
      fixture.service.admitGapGroup({
        reviewId: fresh.review.group.reviewId,
        sessionId: reviewId,
        actions: [],
      }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "review-not-found" });
  });

  it("discards every group-owned body on session invalidation or service replacement", async () => {
    const sessionFixture = makeService();
    const sessionPredecessor = await createGapFencedOperation(sessionFixture);
    const sessionGroup = await sessionFixture.service.createGapGroupReview({
      predecessorOperationId: sessionPredecessor,
      sessionId: reviewId,
    });
    if (sessionGroup.kind !== "created") {
      throw new Error("Session gap fixture failed.");
    }
    const sessionChild = required(sessionGroup.review.children[0]);
    sessionFixture.service.invalidateSession(operationId);
    expect(
      sessionFixture.service.preview(sessionChild.reviewId, reviewId, "local"),
    ).toBe("same");
    sessionFixture.service.invalidateSession(reviewId);
    expect(
      sessionFixture.service.preview(sessionChild.reviewId, reviewId, "local"),
    ).toBeNull();

    const replacementFixture = makeService();
    const replacementPredecessor =
      await createGapFencedOperation(replacementFixture);
    const replacementGroup =
      await replacementFixture.service.createGapGroupReview({
        predecessorOperationId: replacementPredecessor,
        sessionId: reviewId,
      });
    if (replacementGroup.kind !== "created") {
      throw new Error("Replacement gap fixture failed.");
    }
    const replacementChild = required(replacementGroup.review.children[0]);
    replacementFixture.service.invalidate();
    expect(
      replacementFixture.service.preview(
        replacementChild.reviewId,
        reviewId,
        "local",
      ),
    ).toBeNull();
  });

  it("transfers a complete history group to an explicit no-cleanup decision", async () => {
    const fixture = makeHistoryService();
    await fixture.service.discover();
    const review = await fixture.service.createReview({
      targetPath: historySource,
      sessionId: reviewId,
    });
    if (review.kind !== "created") throw new Error("History review failed.");
    const admitted = await fixture.service.admit({
      reviewId: review.review.reviewId,
      sessionId: reviewId,
      action: {
        kind: RECONCILIATION_ACTION.resolveHistory,
        decision: {
          kind: HISTORY_DECISION_KIND.executeCleanupPlan,
          selectedCandidatePath: historyDestination,
        },
      },
    });
    if (admitted.kind !== "admitted") {
      throw new Error("History operation was not admitted.");
    }
    const predecessorOperationId = admitted.operation.operationId;
    expect(
      await fixture.owner.transition(
        fenceActiveReconciliationForObservationGap,
      ),
    ).toMatchObject({ kind: "committed" });
    const fresh = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    if (fresh.kind !== "created") throw new Error("History gap review failed.");
    const child = required(fresh.review.children[0]);

    const transferred = await fixture.service.admitGapGroup({
      reviewId: fresh.review.group.reviewId,
      sessionId: reviewId,
      actions: [
        {
          reviewId: child.reviewId,
          action: {
            kind: RECONCILIATION_ACTION.resolveHistory,
            decision: { kind: HISTORY_DECISION_KIND.retainIndependent },
          },
        },
      ],
    });
    expect(transferred.kind).toBe("transferred");
    if (transferred.kind !== "transferred") return;
    expect(transferred.operations[0]).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.completed,
      historyProgress: {
        kind: HISTORY_PROGRESS_KIND.refined,
        decision: { kind: HISTORY_DECISION_KIND.retainIndependent },
        steps: [],
        nextStepIndex: null,
      },
    });
  });

  it("transfers a complete deferred-history gap through a fresh history decision", async () => {
    const fixture = makeHistoryService();
    await fixture.service.discover();
    const review = await fixture.service.createReview({
      targetPath: historySource,
      sessionId: reviewId,
    });
    if (review.kind !== "created") {
      throw new Error(
        `History review fixture failed: ${JSON.stringify(review)}`,
      );
    }
    const admitted = await fixture.service.admit({
      reviewId: review.review.reviewId,
      sessionId: reviewId,
      action: {
        kind: RECONCILIATION_ACTION.resolveHistory,
        decision: {
          kind: HISTORY_DECISION_KIND.executeCleanupPlan,
          selectedCandidatePath: historyDestination,
        },
      },
    });
    if (admitted.kind !== "admitted") {
      throw new Error(
        `History operation fixture failed: ${JSON.stringify(admitted)}`,
      );
    }
    const predecessorOperationId = admitted.operation.operationId;
    const fenced = await fixture.owner.transition(
      fenceActiveReconciliationForObservationGap,
    );
    expect(fenced.kind).toBe("committed");

    const fresh = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    expect(fresh.kind).toBe("created");
    if (fresh.kind !== "created") return;
    expect(
      fresh.review.group.snapshot.paths.map((entry) => entry.path),
    ).toEqual([historyDestination, historySource]);
    expect(fresh.review.children).toHaveLength(1);
    const child = required(fresh.review.children[0]);
    expect(child.snapshot.paths).toHaveLength(2);
    expect(child.allowedActions).toEqual([
      RECONCILIATION_ACTION.resolveHistory,
    ]);

    const deferred = await fixture.service.admitGapGroup({
      reviewId: fresh.review.group.reviewId,
      sessionId: reviewId,
      actions: [
        {
          reviewId: child.reviewId,
          action: {
            kind: RECONCILIATION_ACTION.resolveHistory,
            decision: { kind: HISTORY_DECISION_KIND.deferHistory },
          },
        },
      ],
    });
    expect(deferred).toMatchObject({
      kind: "rejected",
      reason: "action-not-allowed",
    });
    expect(
      fixture.owner
        .snapshot()
        .state.reconciliationOperations.find(
          (operation) => operation.operationId === predecessorOperationId,
        ),
    ).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.admitted,
      observationCoverage:
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
    });

    const transferred = await fixture.service.admitGapGroup({
      reviewId: fresh.review.group.reviewId,
      sessionId: reviewId,
      actions: [
        {
          reviewId: child.reviewId,
          action: {
            kind: RECONCILIATION_ACTION.resolveHistory,
            decision: {
              kind: HISTORY_DECISION_KIND.executeCleanupPlan,
              selectedCandidatePath: historyDestination,
            },
          },
        },
      ],
    });
    if (transferred.kind !== "transferred") {
      throw new Error(
        `History gap transfer failed: ${JSON.stringify(transferred)}`,
      );
    }
    expect(transferred.operations).toHaveLength(1);
    expect(transferred.operations[0]).toMatchObject({
      reviewId: child.reviewId,
      authority: RECONCILIATION_AUTHORITY_SOURCE.historyDecision,
      phase: RECONCILIATION_OPERATION_PHASE.admitted,
      observationCoverage: RECONCILIATION_OBSERVATION_COVERAGE.continuous,
      action: {
        kind: RECONCILIATION_ACTION.resolveHistory,
        decision: {
          kind: HISTORY_DECISION_KIND.executeCleanupPlan,
          canonicalPath: historyDestination,
        },
      },
      historyProgress: {
        nextStepIndex: 0,
        steps: [
          expect.objectContaining({
            sourcePath: historySource,
            prerequisitePath: historyDestination,
          }),
        ],
      },
    });
    expect(transferred.snapshot.state.reconciliationOperations).toContainEqual(
      expect.objectContaining({
        operationId: predecessorOperationId,
        phase: RECONCILIATION_OPERATION_PHASE.completed,
        gapSuccessorOperationIds: [transferred.operations[0]?.operationId],
      }),
    );
    expect(
      transferred.snapshot.state.reconciliationGapGroupReviews,
    ).toContainEqual(
      expect.objectContaining({
        reviewId: fresh.review.group.reviewId,
        predecessorOperationId,
        status: "completed",
        childReviewIds: [child.reviewId],
      }),
    );
  });

  it("persists a stale gap-group sample without releasing predecessor reservations", async () => {
    const fixture = makeService();
    const predecessorOperationId = await createGapFencedOperation(fixture);
    const fresh = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    if (fresh.kind !== "created") throw new Error("Gap fixture failed.");

    fixture.remote.inspectNote.mockResolvedValue({
      kind: "success",
      value: {
        kind: "live",
        path,
        revision: otherRevision,
        contentSha256: hash,
        receipt: {
          action: "create",
          associationId: association,
          operationId: thirdOperationId,
          precondition: { kind: "absent" },
          contentSha256: hash,
        },
      },
    });
    fixture.remote.readNote.mockResolvedValue({
      kind: "success",
      value: { kind: "live", revision: otherRevision, content: "same" },
    });

    await expect(
      fixture.service.admitGapGroup({
        reviewId: fresh.review.group.reviewId,
        sessionId: reviewId,
        actions: [],
      }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "stale-review" });
    expect(
      fixture.owner.snapshot().state.reconciliationGapGroupReviews,
    ).toContainEqual(
      expect.objectContaining({
        reviewId: fresh.review.group.reviewId,
        predecessorOperationId,
        status: "stale",
        childReviewIds: [],
      }),
    );
    expect(
      fixture.owner
        .snapshot()
        .state.reconciliationOperations.find(
          (operation) => operation.operationId === predecessorOperationId,
        ),
    ).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.admitted,
      observationCoverage:
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
      reservations: [{ path }],
    });
  });

  it("settles a gap only through a fresh fully aligned no-effect group review", async () => {
    const fixture = makeService();
    const predecessorOperationId = await createGapFencedOperation(fixture);
    const baselineRemote = {
      kind: "live" as const,
      path,
      revision,
      contentSha256: hash,
      receipt: {
        action: "create" as const,
        associationId: association,
        operationId,
        precondition: { kind: "absent" as const },
        contentSha256: hash,
      },
    };
    fixture.remote.inspectNote.mockResolvedValue({
      kind: "success",
      value: baselineRemote,
    });
    fixture.remote.readNote.mockResolvedValue({
      kind: "success",
      value: { kind: "live", revision, content: "same" },
    });

    const fresh = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    expect(fresh.kind).toBe("created");
    if (fresh.kind !== "created") return;
    expect(fresh.review.children).toEqual([]);
    expect(fresh.review.group.unreviewablePaths).toEqual([]);

    const settled = await fixture.service.admitGapGroup({
      reviewId: fresh.review.group.reviewId,
      sessionId: reviewId,
      actions: [],
    });
    expect(settled.kind).toBe("settled");
    const state = fixture.owner.snapshot().state;
    expect(state.reconciliationOperations).toContainEqual(
      expect.objectContaining({
        operationId: predecessorOperationId,
        phase: RECONCILIATION_OPERATION_PHASE.completed,
        observationCoverage:
          RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
        gapSuccessorOperationIds: [],
      }),
    );
    expect(state.reconciliationGapGroupReviews).toContainEqual(
      expect.objectContaining({
        predecessorOperationId,
        status: "completed",
        childReviewIds: [],
      }),
    );
  });

  it("settles the final exact history cleanup receipt after a fresh aligned gap sample", async () => {
    const fixture = makeHistoryService();
    await fixture.service.discover();
    const review = await fixture.service.createReview({
      targetPath: historySource,
      sessionId: reviewId,
    });
    if (review.kind !== "created") throw new Error("History review failed.");
    const admitted = await fixture.service.admit({
      reviewId: review.review.reviewId,
      sessionId: reviewId,
      action: {
        kind: RECONCILIATION_ACTION.resolveHistory,
        decision: {
          kind: HISTORY_DECISION_KIND.executeCleanupPlan,
          selectedCandidatePath: historyDestination,
        },
      },
    });
    if (admitted.kind !== "admitted") {
      throw new Error("History operation admission failed.");
    }
    const predecessorOperationId = admitted.operation.operationId;
    const fenced = await fixture.owner.transition(
      fenceActiveReconciliationForObservationGap,
    );
    expect(fenced.kind).toBe("committed");
    const confirmed = await fixture.owner.transition((current) => {
      const predecessor = current.reconciliationOperations.find(
        (candidate) => candidate.operationId === predecessorOperationId,
      );
      if (
        predecessor === undefined ||
        !isRefinedHistoryReconciliationOperation(predecessor)
      ) {
        return undefined;
      }
      const step = predecessor.historyProgress.steps[0];
      if (step === undefined) return undefined;
      const preservationPath = createReconciliationPreservationPath(
        predecessorOperationId,
        RECONCILIATION_PRESERVATION_SIDE.remote,
        step.stepId,
      );
      if (preservationPath === undefined) {
        throw new Error("History preservation fixture path is invalid.");
      }
      const receipt = {
        action: "tombstone" as const,
        associationId: association,
        operationId: step.stepId,
        precondition: {
          kind: "matching-revision" as const,
          revision: step.sourceRevision,
        },
      };
      const preservation = {
        scope: RECONCILIATION_PRESERVATION_SCOPE.historyStep,
        stepId: step.stepId,
        operationId: predecessorOperationId,
        originalPath: step.sourcePath,
        side: RECONCILIATION_PRESERVATION_SIDE.remote,
        sourceRevision: step.sourceRevision,
        contentSha256: step.sourceContentSha256,
        preservationPath,
        proofState: RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
      } as const;
      return {
        ...current,
        paths: current.paths.map((entry) =>
          entry.path === historySource
            ? {
                ...entry,
                acknowledgement: {
                  kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
                  revision: otherRevision,
                  recoveryId: step.stepId,
                },
                desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
                blockedReason: null,
              }
            : entry,
        ),
        reconciliationOperations: current.reconciliationOperations.map(
          (candidate) =>
            candidate.operationId !== predecessorOperationId
              ? candidate
              : {
                  ...predecessor,
                  phase: RECONCILIATION_OPERATION_PHASE.partial,
                  historyProgress: {
                    ...predecessor.historyProgress,
                    nextStepIndex: null,
                    steps: [
                      {
                        ...step,
                        phase: HISTORY_CLEANUP_STEP_PHASE.completed,
                        remoteEffect: {
                          kind: HISTORY_REMOTE_EFFECT_KIND.confirmedExactTombstoneReceipt,
                          revision: otherRevision,
                          receipt,
                        },
                      },
                    ],
                  },
                  preservationReceipts: [preservation],
                },
        ),
      };
    });
    expect(confirmed.kind).toBe("committed");
    const predecessor = required(
      fixture.owner
        .snapshot()
        .state.reconciliationOperations.find(
          (candidate) => candidate.operationId === predecessorOperationId,
        ),
    );
    if (!isRefinedHistoryReconciliationOperation(predecessor)) {
      throw new Error("Expected a durable refined history predecessor.");
    }
    const step = predecessor.historyProgress.steps[0];
    if (
      step === undefined ||
      step.remoteEffect.kind !==
        HISTORY_REMOTE_EFFECT_KIND.confirmedExactTombstoneReceipt
    ) {
      throw new Error("Expected an exact final cleanup receipt.");
    }
    const tombstone = {
      kind: "tombstone" as const,
      path: historySource,
      revision: otherRevision,
      deletedRevision: step.sourceRevision,
      recoveryId: step.stepId,
      receipt: step.remoteEffect.receipt,
    };
    fixture.remote.inspectNote.mockImplementation(async (candidatePath) => ({
      kind: "success",
      value:
        candidatePath === historySource
          ? tombstone
          : historyNoteState(
              historyDestination,
              otherRevision,
              secondOperationId,
            ),
    }));

    const fresh = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    expect(fresh.kind).toBe("created");
    if (fresh.kind !== "created") return;
    expect(fresh.review.children).toEqual([]);
    const settled = await fixture.service.admitGapGroup({
      reviewId: fresh.review.group.reviewId,
      sessionId: reviewId,
      actions: [],
    });

    expect(settled.kind).toBe("settled");
    expect(
      fixture.owner.snapshot().state.reconciliationOperations,
    ).toContainEqual(
      expect.objectContaining({
        operationId: predecessorOperationId,
        phase: RECONCILIATION_OPERATION_PHASE.completed,
        historyProgress: expect.objectContaining({ nextStepIndex: null }),
      }),
    );
  });

  it("settles an aligned gap only after a fresh sample covers the exact observed successor range", async () => {
    const fixture = makeService();
    fixture.hashContent.mockImplementation(async (content) =>
      content === "same" ? hash : otherHash,
    );
    fixture.remote.inspectNote.mockResolvedValue({
      kind: "success",
      value: {
        kind: "live",
        path,
        revision: otherRevision,
        contentSha256: otherHash,
        receipt: {
          action: "create",
          associationId: association,
          operationId,
          precondition: { kind: "absent" },
          contentSha256: otherHash,
        },
      },
    });
    fixture.remote.readNote.mockResolvedValue({
      kind: "success",
      value: { kind: "live", revision: otherRevision, content: "other" },
    });
    await fixture.service.discover();
    const review = await fixture.service.createReview({
      targetPath: path,
      sessionId: reviewId,
    });
    if (review.kind !== "created") throw new Error("Review fixture failed.");
    const admitted = await fixture.service.admit({
      reviewId: review.review.reviewId,
      sessionId: reviewId,
      action: { kind: RECONCILIATION_ACTION.useRemote },
    });
    if (admitted.kind !== "admitted") {
      throw new Error(`Admission fixture failed: ${JSON.stringify(admitted)}`);
    }
    const predecessorOperationId = admitted.operation.operationId;
    const latestGeneration = fixture.observations.observe(path);
    const preservationPath = createReconciliationPreservationPath(
      predecessorOperationId,
      RECONCILIATION_PRESERVATION_SIDE.local,
    );
    if (preservationPath === undefined) {
      throw new Error("Preservation fixture failed.");
    }
    const effectCommitted = await fixture.owner.transition((current) => ({
      ...current,
      paths: current.paths.map((entry) => ({
        ...entry,
        acknowledgement: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision: otherRevision,
          contentSha256: otherHash,
        },
      })),
      reconciliationOperations: current.reconciliationOperations.map(
        (operation) =>
          isNonHistoryReconciliationOperation(operation)
            ? {
                ...operation,
                phase: RECONCILIATION_OPERATION_PHASE.successorReviewRequired,
                preservationReceipts: [
                  {
                    scope: "operation",
                    operationId: operation.operationId,
                    originalPath: path,
                    side: RECONCILIATION_PRESERVATION_SIDE.local,
                    sourceRevision: null,
                    contentSha256: hash,
                    preservationPath,
                    proofState:
                      RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
                  },
                ],
                localEffectObservation: {
                  kind: LOCAL_EFFECT_OBSERVATION_KIND.confirmed,
                  effectId,
                  path,
                  expectedHash: otherHash,
                  listenerEpoch: 1,
                  beforeGeneration: 1,
                  postconditionHash: otherHash,
                  successor: {
                    firstGeneration: latestGeneration,
                    latestGeneration,
                    eventKinds: [RECONCILIATION_EVENT_KIND.modify],
                  },
                },
                localEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
              }
            : operation,
      ),
    }));
    expect(effectCommitted.kind).toBe("committed");
    const fenced = await fixture.owner.transition(
      fenceActiveReconciliationForObservationGap,
    );
    expect(fenced.kind).toBe("committed");
    fixture.local.read.mockResolvedValue({
      kind: LocalInspectionKind.ok,
      content: "other",
      sizeBytes: 5,
    });

    const fresh = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    expect(fresh.kind).toBe("created");
    if (fresh.kind !== "created") return;
    expect(fresh.review.children).toEqual([]);
    const settled = await fixture.service.admitGapGroup({
      reviewId: fresh.review.group.reviewId,
      sessionId: reviewId,
      actions: [],
    });
    expect(settled.kind).toBe("settled");
    if (settled.kind !== "settled") return;
    expect(settled.review.childReviewIds).toEqual([]);
    expect(settled.review.snapshot.paths[0]?.local).toMatchObject({
      kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.live,
      observationGeneration: latestGeneration,
    });
    expect(
      settled.snapshot.state.reconciliationOperations.find(
        (operation) => operation.operationId === predecessorOperationId,
      ),
    ).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.completed,
      localEffectObservation: {
        successor: {
          firstGeneration: latestGeneration,
          latestGeneration,
          eventKinds: [RECONCILIATION_EVENT_KIND.modify],
        },
      },
    });
  });

  it("atomically transfers a complete multi-path gap to distinct reviewed successors", async () => {
    const relatedPath = required(normalizeNotePath("notes/related.md"));
    const base = state();
    const fixture = makeService(snapshot().runtime, {
      ...base,
      paths: [
        ...base.paths,
        {
          path: relatedPath,
          acknowledgement: {
            kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
            revision,
            contentSha256: hash,
          },
          unresolvedMutation: null,
          desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
          blockedReason: null,
        },
      ],
    });
    fixture.local.list.mockResolvedValue({
      kind: LocalInspectionKind.ok,
      entries: [path, relatedPath].map((candidatePath) => ({
        path: candidatePath,
        sizeBytes: 4,
      })),
      skipped: {
        unsupported_file: 0,
        excluded_location: 0,
        invalid_path: 0,
        oversized: 0,
      },
    });
    fixture.remote.listNotes.mockResolvedValue({
      kind: "success",
      value: { notes: [path, relatedPath], nextCursor: null },
    });
    fixture.remote.inspectNote.mockImplementation(async (candidatePath) => ({
      kind: "success",
      value: {
        kind: "live",
        path: candidatePath,
        revision: otherRevision,
        contentSha256: hash,
        receipt: {
          action: "create",
          associationId: association,
          operationId,
          precondition: { kind: "absent" },
          contentSha256: hash,
        },
      },
    }));
    fixture.remote.readNote.mockImplementation(async () => ({
      kind: "success",
      value: { kind: "live", revision: otherRevision, content: "same" },
    }));
    const predecessorOperationId = await createGapFencedOperation(
      fixture,
      { kind: RECONCILIATION_ACTION.adoptRevision },
      { relatedPaths: [relatedPath] },
    );
    const fresh = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    if (fresh.kind !== "created") {
      throw new Error(`Complete gap review failed: ${JSON.stringify(fresh)}`);
    }
    expect(
      fresh.review.children.map((child) => child.snapshot.targetPath),
    ).toEqual(
      [path, relatedPath].toSorted((left, right) => left.localeCompare(right)),
    );

    const transferred = await fixture.service.admitGapGroup({
      reviewId: fresh.review.group.reviewId,
      sessionId: reviewId,
      actions: fresh.review.children.map((child) => ({
        reviewId: child.reviewId,
        action: { kind: RECONCILIATION_ACTION.adoptRevision },
      })),
    });

    expect(transferred.kind).toBe("transferred");
    if (transferred.kind !== "transferred") return;
    expect(transferred.operations).toHaveLength(2);
    expect(
      transferred.snapshot.state.reconciliationOperations.find(
        (operation) => operation.operationId === predecessorOperationId,
      ),
    ).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.completed,
      observationCoverage:
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
      gapSuccessorOperationIds: transferred.operations.map(
        (operation) => operation.operationId,
      ),
      reservations: expect.arrayContaining([
        { path, kind: RECONCILIATION_PATH_REFERENCE_KIND.reviewTarget },
        {
          path: relatedPath,
          kind: RECONCILIATION_PATH_REFERENCE_KIND.tracked,
        },
      ]),
    });
    expect(
      transferred.snapshot.state.reconciliationGapGroupReviews,
    ).toContainEqual(
      expect.objectContaining({
        reviewId: fresh.review.group.reviewId,
        predecessorOperationId,
        status: RECONCILIATION_GAP_REVIEW_STATUS.completed,
        childReviewIds: fresh.review.children.map((child) => child.reviewId),
      }),
    );
  });

  it("atomically transfers changed gap authority after a planned local write was never dispatched", async () => {
    const fixture = makeService();
    fixture.hashContent.mockImplementation(async (content) =>
      content === "remote" ? otherHash : hash,
    );
    const changedRemote = {
      kind: "live" as const,
      path,
      revision: otherRevision,
      contentSha256: otherHash,
      receipt: {
        action: "create" as const,
        associationId: association,
        operationId,
        precondition: { kind: "absent" as const },
        contentSha256: otherHash,
      },
    };
    fixture.remote.inspectNote.mockResolvedValue({
      kind: "success",
      value: changedRemote,
    });
    fixture.remote.readNote.mockResolvedValue({
      kind: "success",
      value: { kind: "live", revision: otherRevision, content: "remote" },
    });
    const predecessorOperationId = await createGapFencedOperation(fixture, {
      kind: RECONCILIATION_ACTION.useRemote,
    });
    const predecessorBeforeTransfer = fixture.owner
      .snapshot()
      .state.reconciliationOperations.find(
        (operation) => operation.operationId === predecessorOperationId,
      );
    expect(predecessorBeforeTransfer).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.admitted,
      localEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
    });
    fixture.local.list.mockResolvedValue({
      kind: LocalInspectionKind.ok,
      entries: [],
      skipped: {
        unsupported_file: 0,
        excluded_location: 0,
        invalid_path: 0,
        oversized: 0,
      },
    });
    fixture.local.read.mockResolvedValue({
      kind: LocalInspectionKind.failed,
      reason: LocalVaultFailureReason.missingFile,
    });
    await fixture.service.discover();

    const fresh = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    if (fresh.kind !== "created") {
      throw new Error(`Gap review fixture failed: ${JSON.stringify(fresh)}`);
    }
    expect(fresh.review.children).toHaveLength(1);
    const child = required(fresh.review.children[0]);
    expect(child.gapPredecessorId).toBe(predecessorOperationId);

    const transferred = await fixture.service.admitGapGroup({
      reviewId: fresh.review.group.reviewId,
      sessionId: reviewId,
      actions: [
        {
          reviewId: child.reviewId,
          action: { kind: RECONCILIATION_ACTION.useRemote },
        },
      ],
    });
    expect(transferred.kind).toBe("transferred");
    if (transferred.kind !== "transferred") return;
    expect(transferred.operations).toHaveLength(1);
    expect(transferred.operations[0]).toMatchObject({
      reviewId: child.reviewId,
      phase: RECONCILIATION_OPERATION_PHASE.admitted,
      observationCoverage: RECONCILIATION_OBSERVATION_COVERAGE.continuous,
      reservations: [{ path }],
    });
    expect(transferred.snapshot.state.reconciliationOperations).toContainEqual(
      expect.objectContaining({
        operationId: predecessorOperationId,
        localEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
        gapSuccessorOperationIds: [transferred.operations[0]?.operationId],
      }),
    );
    expect(transferred.snapshot.state.reconciliationOperations).toContainEqual(
      expect.objectContaining({
        operationId: predecessorOperationId,
        phase: RECONCILIATION_OPERATION_PHASE.completed,
        gapSuccessorOperationIds: [transferred.operations[0]?.operationId],
      }),
    );
    expect(
      transferred.snapshot.state.reconciliationGapGroupReviews,
    ).toContainEqual(
      expect.objectContaining({
        reviewId: fresh.review.group.reviewId,
        predecessorOperationId,
        status: "completed",
        childReviewIds: [child.reviewId],
      }),
    );
    const successorId = transferred.operations[0]?.operationId;
    if (successorId === undefined) throw new Error("Successor fixture failed.");
    expect(
      await fixture.owner.transition(
        fenceActiveReconciliationForObservationGap,
      ),
    ).toMatchObject({ kind: "committed" });
    expect(
      fixture.owner
        .snapshot()
        .state.reconciliationOperations.find(
          (operation) => operation.operationId === successorId,
        ),
    ).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.admitted,
      observationCoverage:
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
    });
    const successorReview = await fixture.service.createGapGroupReview({
      predecessorOperationId: successorId,
      sessionId: reviewId,
    });
    expect(successorReview.kind).toBe("created");
  });

  it("keeps every gap reservation when atomic child transfer persistence fails", async () => {
    const fixture = makeService();
    const predecessorOperationId = await createGapFencedOperation(fixture);
    fixture.remote.inspectNote.mockResolvedValue({
      kind: "success",
      value: {
        kind: "live",
        path,
        revision: otherRevision,
        contentSha256: hash,
        receipt: {
          action: "create",
          associationId: association,
          operationId,
          precondition: { kind: "absent" },
          contentSha256: hash,
        },
      },
    });
    fixture.remote.readNote.mockResolvedValue({
      kind: "success",
      value: { kind: "live", revision: otherRevision, content: "same" },
    });
    const fresh = await fixture.service.createGapGroupReview({
      predecessorOperationId,
      sessionId: reviewId,
    });
    if (fresh.kind !== "created") throw new Error("Gap review fixture failed.");
    const child = required(fresh.review.children[0]);
    fixture.store.fail = true;

    const result = await fixture.service.admitGapGroup({
      reviewId: fresh.review.group.reviewId,
      sessionId: reviewId,
      actions: [
        {
          reviewId: child.reviewId,
          action: { kind: RECONCILIATION_ACTION.adoptRevision },
        },
      ],
    });
    expect(result).toMatchObject({
      kind: "rejected",
      reason: "persistence-failure",
    });
    const predecessor = fixture.owner
      .snapshot()
      .state.reconciliationOperations.find(
        (operation) => operation.operationId === predecessorOperationId,
      );
    expect(predecessor).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.admitted,
      observationCoverage:
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
      gapSuccessorOperationIds: [],
    });
    expect(
      fixture.owner.snapshot().state.reconciliationGapGroupReviews,
    ).toEqual([]);
  });
});
