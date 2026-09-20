import {
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  createReconciliationPreservationPath,
  createRecoverySnapshotId,
  FairMirrorScheduler,
  HISTORY_DECISION_KIND,
  LocalInspectionKind,
  LocalVaultFailureReason,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_RENAME_PHASE,
  type MirrorDeviceState,
  MirrorStateOwner,
  type MirrorStateStore,
  normalizeNotePath,
  RECONCILIATION_ACTION,
  type ReadOnlyLocalVault,
  ReconciliationObservationGenerationOwner,
  type RemoteBridge,
} from "@obsidian-ai-bridge/core";
import { ReconciliationRuntimeOwner } from "@obsidian-plugin/runtime/reconciliation-runtime-owner";
import { describe, expect, it, vi } from "vitest";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Invalid runtime fixture.");
  return value;
}

const PATH = required(normalizeNotePath("notes/runtime.md"));
const HISTORY_SOURCE = required(normalizeNotePath("notes/former.md"));
const DEVICE = required(
  createMirrorWriterId("11111111-1111-4111-8111-111111111111"),
);
const ASSOCIATION = required(
  createMirrorAssociationId("22222222-2222-4222-8222-222222222222"),
);
const BASE_REVISION = required(
  createApplicationRevision("33333333-3333-4333-8333-333333333333"),
);
const REMOTE_REVISION = required(
  createApplicationRevision("44444444-4444-4444-8444-444444444444"),
);
const RECEIPT_OPERATION = required(
  createMirrorOperationId("55555555-5555-4555-8555-555555555555"),
);
const RECOVERY = required(
  createRecoverySnapshotId("88888888-8888-4888-8888-888888888888"),
);
const SEALED_RECOVERY = required(
  createRecoverySnapshotId("99999999-9999-4999-8999-999999999999"),
);
const EXPIRED_RECOVERY = required(
  createRecoverySnapshotId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
);
const SESSION = required(
  createMirrorOperationId("66666666-6666-4666-8666-666666666666"),
);
const SECOND_SESSION = required(
  createMirrorOperationId("77777777-7777-4777-8777-777777777777"),
);
const BASE_HASH = required(createContentSha256("11".repeat(32)));
const LOCAL_HASH = required(createContentSha256("22".repeat(32)));
const REMOTE_HASH = required(createContentSha256("33".repeat(32)));

class Store implements MirrorStateStore {
  async save(): Promise<{ readonly kind: "saved" }> {
    return { kind: "saved" };
  }
}

function initialState(): MirrorDeviceState {
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
          revision: BASE_REVISION,
          contentSha256: BASE_HASH,
        },
        unresolvedMutation: null,
        desired: { kind: "none" },
        blockedReason: null,
      },
    ],
    stagedHandoff: null,
    reconciliationReviews: [],
    reconciliationOperations: [],
  };
}

function historyState(): MirrorDeviceState {
  return {
    ...initialState(),
    paths: [
      {
        path: HISTORY_SOURCE,
        acknowledgement: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision: BASE_REVISION,
          contentSha256: REMOTE_HASH,
        },
        unresolvedMutation: null,
        desired: {
          kind: MIRROR_DESIRED_STATE_KIND.renameDeferred,
          observationGeneration: 1,
          renameId: RECEIPT_OPERATION,
          associationId: ASSOCIATION,
          sourcePath: HISTORY_SOURCE,
          destinationPath: PATH,
          sourceExpectedRevision: BASE_REVISION,
          destinationObservationGeneration: 1,
          destinationAcknowledgedRevision: REMOTE_REVISION,
          graceDeadlineMilliseconds: 10_000,
          phase: MIRROR_RENAME_PHASE.sourceCleanupRequired,
        },
        blockedReason: null,
      },
      {
        path: PATH,
        acknowledgement: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision: REMOTE_REVISION,
          contentSha256: LOCAL_HASH,
        },
        unresolvedMutation: null,
        desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
        blockedReason: null,
      },
    ],
  };
}

function historyLocal(): ReadOnlyLocalVault {
  return {
    list: vi.fn(async () => ({
      kind: LocalInspectionKind.ok,
      entries: [{ path: PATH, sizeBytes: 5 }],
      skipped: {
        unsupported_file: 0,
        excluded_location: 0,
        invalid_path: 0,
        oversized: 0,
      },
    })),
    read: vi.fn(async (path) =>
      path === PATH
        ? {
            kind: LocalInspectionKind.ok,
            content: "local",
            sizeBytes: 5,
          }
        : {
            kind: LocalInspectionKind.failed,
            reason: "missing_file" as const,
          },
    ),
  };
}

function historyRemote(): RemoteBridge {
  const baseline = remote();
  return {
    ...baseline,
    listNotes: vi.fn(async () => ({
      kind: "success" as const,
      value: { notes: [HISTORY_SOURCE, PATH], nextCursor: null },
    })),
    readNote: vi.fn(async (path) => ({
      kind: "success" as const,
      value:
        path === HISTORY_SOURCE
          ? {
              kind: "live" as const,
              revision: BASE_REVISION,
              content: "remote",
            }
          : {
              kind: "live" as const,
              revision: REMOTE_REVISION,
              content: "local",
            },
    })),
    inspectNote: vi.fn(async (path) => ({
      kind: "success" as const,
      value: {
        kind: "live" as const,
        path,
        revision: path === HISTORY_SOURCE ? BASE_REVISION : REMOTE_REVISION,
        contentSha256: path === HISTORY_SOURCE ? REMOTE_HASH : LOCAL_HASH,
        receipt: {
          action: "create" as const,
          associationId: ASSOCIATION,
          operationId: RECEIPT_OPERATION,
          precondition: { kind: "absent" as const },
          contentSha256: path === HISTORY_SOURCE ? REMOTE_HASH : LOCAL_HASH,
        },
      },
    })),
    mutateNote: vi.fn<RemoteBridge["mutateNote"]>(async (request) => {
      if (request.action !== "tombstone") {
        throw new Error("Expected history tombstone.");
      }
      return {
        kind: "confirmed",
        confirmed: {
          path: request.path,
          revision: REMOTE_REVISION,
          receipt: {
            action: request.action,
            associationId: request.associationId,
            operationId: request.operationId,
            precondition: request.precondition,
          },
        },
      };
    }),
  };
}

function remote(): RemoteBridge {
  return {
    describe: vi.fn(async () => ({
      kind: "success" as const,
      value: {
        protocol: "obsidian-ai-bridge-mirror-v2" as const,
        associationId: ASSOCIATION,
        writerId: DEVICE,
        maxNoteSizeBytes: 1_048_576,
        maxPageSize: 50,
        recoveryRetentionSeconds: 2_592_000,
      },
    })),
    listNotes: vi.fn(async () => ({
      kind: "success" as const,
      value: { notes: [PATH], nextCursor: null },
    })),
    readNote: vi.fn(async (path) => ({
      kind: "success" as const,
      value:
        path === PATH
          ? {
              kind: "live" as const,
              revision: REMOTE_REVISION,
              content: "remote",
            }
          : { kind: "missing" as const },
    })),
    inspectNote: vi.fn(async (path) => ({
      kind: "success" as const,
      value:
        path === PATH
          ? {
              kind: "live" as const,
              path: PATH,
              revision: REMOTE_REVISION,
              contentSha256: REMOTE_HASH,
              receipt: {
                action: "create" as const,
                associationId: ASSOCIATION,
                operationId: RECEIPT_OPERATION,
                precondition: { kind: "absent" as const },
                contentSha256: REMOTE_HASH,
              },
            }
          : { kind: "absent" as const, path },
    })),
    mutateNote: vi.fn<RemoteBridge["mutateNote"]>(async (request) => {
      if (request.action === "tombstone") {
        throw new Error("Unexpected tombstone mutation.");
      }
      if (request.action === "create") {
        return {
          kind: "confirmed",
          confirmed: {
            path: request.path,
            revision: REMOTE_REVISION,
            receipt: {
              action: request.action,
              associationId: request.associationId,
              operationId: request.operationId,
              precondition: request.precondition,
              contentSha256: LOCAL_HASH,
            },
          },
        };
      }
      return {
        kind: "confirmed",
        confirmed: {
          path: request.path,
          revision: REMOTE_REVISION,
          receipt: {
            action: request.action,
            associationId: request.associationId,
            operationId: request.operationId,
            precondition: request.precondition,
            contentSha256: LOCAL_HASH,
          },
        },
      };
    }),
    listRecovery: vi.fn(async () => ({
      kind: "success" as const,
      value: { recoveries: [], nextCursor: null },
    })),
    inspectRecovery: vi.fn(async () => ({
      kind: "success" as const,
      value: null,
    })),
    readRecoveryContent: vi.fn(async () => ({
      kind: "success" as const,
      value: { kind: "missing" as const },
    })),
    sealRecovery: vi.fn(async () => {
      throw new Error("Unexpected seal.");
    }),
    purgeRecovery: vi.fn(async () => {
      throw new Error("Unexpected purge.");
    }),
  };
}

function subject(
  cryptography: Crypto = crypto,
  options: {
    readonly state?: MirrorDeviceState;
    readonly local?: ReadOnlyLocalVault;
    readonly remote?: RemoteBridge;
    readonly nowMilliseconds?: () => number;
  } = {},
) {
  const stateOwner = new MirrorStateOwner(
    options.state ?? initialState(),
    new Store(),
  );
  const scheduler = new FairMirrorScheduler();
  const observations = new ReconciliationObservationGenerationOwner();
  const local =
    options.local ??
    ({
      list: vi.fn(async () => ({
        kind: LocalInspectionKind.ok,
        entries: [{ path: PATH, sizeBytes: 5 }],
        skipped: {
          unsupported_file: 0,
          excluded_location: 0,
          invalid_path: 0,
          oversized: 0,
        },
      })),
      read: vi.fn(async () => ({
        kind: LocalInspectionKind.ok,
        content: "local",
        sizeBytes: 5,
      })),
    } satisfies ReadOnlyLocalVault);
  const localWriter = {
    createEligible: vi.fn(async (request) => ({
      kind: "confirmed" as const,
      outcome: "created" as const,
      path: request.path,
      contentSha256: request.contentSha256,
      sizeBytes: request.content.length,
    })),
    replaceEligible: vi.fn(async (request) => ({
      kind: "confirmed" as const,
      outcome: "replaced" as const,
      path: request.path,
      contentSha256: request.replacementContentSha256,
      sizeBytes: request.replacementContent.length,
    })),
    createPreservation: vi.fn(async (request) => ({
      kind: "confirmed" as const,
      outcome: "created" as const,
      path: required(
        createReconciliationPreservationPath(
          request.operationId,
          request.side,
          request.stepId,
        ),
      ),
      contentSha256: request.contentSha256,
      sizeBytes: request.content.length,
    })),
  };
  const remoteBridge = options.remote ?? remote();
  const owner = new ReconciliationRuntimeOwner({
    local,
    localWriter,
    remote: remoteBridge,
    stateOwner,
    runtime: {
      nowMilliseconds: options.nowMilliseconds ?? (() => 1_000),
      hashContent: async (content) =>
        content === "local" ? LOCAL_HASH : REMOTE_HASH,
      createOperationId: () =>
        required(createMirrorOperationId(crypto.randomUUID())),
    },
    observations,
    scheduler,
    cryptography,
    currentIdentity: () => ({
      runtimeOwnerVersion: 4,
      configurationGeneration: 1,
      listenerEpoch: 1,
      deviceId: DEVICE,
      designatedWriterId: DEVICE,
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
        associationId: ASSOCIATION,
        origin: "https://bridge.example",
      },
    }),
  });
  return { owner, scheduler, stateOwner, localWriter, remoteBridge };
}

describe("ReconciliationRuntimeOwner", () => {
  it("owns sanitized review sessions, defer admission, recovery listing, and detach", async () => {
    const { owner, scheduler, stateOwner } = subject();

    await expect(owner.listCandidates()).resolves.toEqual({
      kind: "available",
      candidates: [PATH],
    });
    await expect(owner.listRecoveries()).resolves.toEqual({
      kind: "available",
      recoveries: [],
    });

    const detail = await owner.createReview(SESSION, PATH);
    expect(detail).toMatchObject({
      targetPath: PATH,
      destinationPath: null,
      allowedActions: expect.arrayContaining([RECONCILIATION_ACTION.defer]),
    });
    if (detail === null) throw new Error("Expected a review.");
    expect(owner.preview(SESSION, detail.reviewId, "local")).toBe("local");
    expect(owner.preview(SESSION, detail.reviewId, "remote")).toBe("remote");

    await expect(
      owner.submit(SESSION, detail.reviewId, {
        kind: RECONCILIATION_ACTION.defer,
      }),
    ).resolves.toEqual({ kind: "completed" });
    await scheduler.whenIdle();
    expect(stateOwner.snapshot().state.reconciliationOperations).toHaveLength(
      1,
    );
    await expect(
      owner.observeEvent(
        PATH,
        ReconciliationRuntimeOwner.eventKinds().modify,
        2,
      ),
    ).resolves.toBe(false);

    const closed = await owner.createReview(SECOND_SESSION, PATH);
    if (closed === null) throw new Error("Expected a second review.");
    owner.closeReview(SECOND_SESSION, closed.reviewId);
    expect(owner.preview(SECOND_SESSION, closed.reviewId, "local")).toBeNull();
    owner.invalidateSession(SECOND_SESSION);
    owner.resumePersisted();
    owner.detach();

    await expect(owner.listCandidates()).resolves.toEqual({
      kind: "unavailable",
    });
    await expect(owner.listRecoveries()).resolves.toEqual({
      kind: "unavailable",
    });
    await expect(owner.createReview(SESSION, PATH)).resolves.toBeNull();
    expect(owner.preview(SESSION, detail.reviewId, "local")).toBeNull();
    await expect(
      owner.submit(SESSION, detail.reviewId, {
        kind: RECONCILIATION_ACTION.defer,
      }),
    ).resolves.toEqual({ kind: "unavailable" });
  });

  it("fails closed for incomplete inventory, invalid destinations, and stale sessions", async () => {
    const { owner, remoteBridge } = subject();
    vi.spyOn(remoteBridge, "listNotes").mockResolvedValueOnce({
      kind: "failure",
      failure: "network-unavailable",
    });
    await expect(owner.listCandidates()).resolves.toEqual({
      kind: "incomplete",
      candidates: [PATH],
    });
    await expect(
      owner.createReview(SESSION, PATH, null, "../invalid.md"),
    ).resolves.toBeNull();
    await expect(
      owner.submit(SESSION, RECEIPT_OPERATION, {
        kind: RECONCILIATION_ACTION.defer,
      }),
    ).resolves.toEqual({ kind: "failed" });
  });

  it("truthfully projects prepared, active, expired, and purged recovery metadata", async () => {
    const { owner, remoteBridge } = subject();
    vi.spyOn(remoteBridge, "listRecovery").mockResolvedValueOnce({
      kind: "success",
      value: {
        recoveries: [
          {
            kind: "prepared",
            id: RECOVERY,
            associationId: ASSOCIATION,
            path: PATH,
            revision: REMOTE_REVISION,
            sourceRevision: BASE_REVISION,
            contentSha256: REMOTE_HASH,
          },
          {
            kind: "sealed",
            id: SEALED_RECOVERY,
            associationId: ASSOCIATION,
            path: PATH,
            revision: REMOTE_REVISION,
            sourceRevision: BASE_REVISION,
            contentSha256: REMOTE_HASH,
            recoverUntil: "2030-01-01T00:00:00.000Z",
          },
          {
            kind: "sealed",
            id: EXPIRED_RECOVERY,
            associationId: ASSOCIATION,
            path: PATH,
            revision: REMOTE_REVISION,
            sourceRevision: BASE_REVISION,
            contentSha256: REMOTE_HASH,
            recoverUntil: "1970-01-01T00:00:00.000Z",
          },
          {
            kind: "purged",
            id: RECOVERY,
            associationId: ASSOCIATION,
            path: PATH,
            revision: REMOTE_REVISION,
            sourceRevision: BASE_REVISION,
            contentSha256: REMOTE_HASH,
            recoverUntil: "2030-01-01T00:00:00.000Z",
          },
        ],
        nextCursor: null,
      },
    });

    await expect(owner.listRecoveries()).resolves.toEqual({
      kind: "available",
      recoveries: [
        {
          id: RECOVERY,
          path: PATH,
          state: "prepared",
          recoverUntil: null,
          actionable: true,
        },
        {
          id: SEALED_RECOVERY,
          path: PATH,
          state: "sealed-active",
          recoverUntil: "2030-01-01T00:00:00.000Z",
          actionable: true,
        },
        {
          id: EXPIRED_RECOVERY,
          path: PATH,
          state: "sealed-expired",
          recoverUntil: "1970-01-01T00:00:00.000Z",
          actionable: false,
        },
        {
          id: RECOVERY,
          path: PATH,
          state: "purged",
          recoverUntil: "2030-01-01T00:00:00.000Z",
          actionable: false,
        },
      ],
    });
  });

  it("keeps partial recovery inventory visible but non-actionable", async () => {
    const { owner, remoteBridge } = subject();
    vi.spyOn(remoteBridge, "listRecovery")
      .mockResolvedValueOnce({
        kind: "success",
        value: {
          recoveries: [
            {
              kind: "prepared",
              id: RECOVERY,
              associationId: ASSOCIATION,
              path: PATH,
              revision: REMOTE_REVISION,
              sourceRevision: BASE_REVISION,
              contentSha256: REMOTE_HASH,
            },
          ],
          nextCursor: "next-page",
        },
      })
      .mockResolvedValueOnce({
        kind: "failure",
        failure: "network-unavailable",
      });

    await expect(owner.listRecoveries()).resolves.toEqual({
      kind: "incomplete",
      recoveries: [
        {
          id: RECOVERY,
          path: PATH,
          state: "prepared",
          recoverUntil: null,
          actionable: false,
        },
      ],
    });
  });

  it("consumes an exact recovery selection after fresh metadata reinspection", async () => {
    const selected = {
      kind: "prepared" as const,
      id: RECOVERY,
      associationId: ASSOCIATION,
      path: PATH,
      revision: REMOTE_REVISION,
      sourceRevision: BASE_REVISION,
      contentSha256: REMOTE_HASH,
    };
    const remoteBridge = remote();
    vi.spyOn(remoteBridge, "listRecovery").mockResolvedValueOnce({
      kind: "success",
      value: { recoveries: [selected], nextCursor: null },
    });
    vi.spyOn(remoteBridge, "inspectRecovery").mockResolvedValue({
      kind: "success",
      value: selected,
    });
    vi.spyOn(remoteBridge, "inspectNote").mockResolvedValue({
      kind: "success",
      value: {
        kind: "tombstone",
        path: PATH,
        revision: REMOTE_REVISION,
        deletedRevision: BASE_REVISION,
        recoveryId: RECOVERY,
        receipt: {
          action: "tombstone",
          associationId: ASSOCIATION,
          operationId: RECEIPT_OPERATION,
          precondition: {
            kind: "matching-revision",
            revision: BASE_REVISION,
          },
        },
      },
    });
    const local: ReadOnlyLocalVault = {
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
      read: vi.fn(async () => ({
        kind: LocalInspectionKind.failed,
        reason: LocalVaultFailureReason.missingFile,
      })),
    };
    const { owner } = subject(undefined, { remote: remoteBridge, local });

    await owner.listRecoveries();
    await expect(
      owner.createReview(SESSION, PATH, RECOVERY),
    ).resolves.toMatchObject({
      targetPath: PATH,
      allowedActions: expect.arrayContaining([
        RECONCILIATION_ACTION.restoreRecovery,
      ]),
    });
    await expect(
      owner.createReview(SESSION, PATH, RECOVERY),
    ).resolves.toBeNull();
  });

  it("rejects recovery metadata that changes after process-local selection", async () => {
    const { owner, remoteBridge } = subject();
    const selected = {
      kind: "prepared" as const,
      id: RECOVERY,
      associationId: ASSOCIATION,
      path: PATH,
      revision: REMOTE_REVISION,
      sourceRevision: BASE_REVISION,
      contentSha256: REMOTE_HASH,
    };
    vi.spyOn(remoteBridge, "listRecovery").mockResolvedValueOnce({
      kind: "success",
      value: { recoveries: [selected], nextCursor: null },
    });
    vi.spyOn(remoteBridge, "inspectRecovery").mockResolvedValue({
      kind: "success",
      value: { ...selected, revision: BASE_REVISION },
    });

    await expect(owner.listRecoveries()).resolves.toMatchObject({
      kind: "available",
      recoveries: [{ id: RECOVERY, actionable: true }],
    });
    await expect(
      owner.createReview(SESSION, PATH, RECOVERY),
    ).resolves.toBeNull();
    await expect(
      owner.createReview(SESSION, PATH, RECOVERY),
    ).resolves.toBeNull();
  });

  it("consumes a sealed selection that expires before fresh review sampling", async () => {
    let nowMilliseconds = 1_000;
    const { owner, remoteBridge } = subject(undefined, {
      nowMilliseconds: () => nowMilliseconds,
    });
    const selected = {
      kind: "sealed" as const,
      id: SEALED_RECOVERY,
      associationId: ASSOCIATION,
      path: PATH,
      revision: REMOTE_REVISION,
      sourceRevision: BASE_REVISION,
      contentSha256: REMOTE_HASH,
      recoverUntil: "1970-01-01T00:00:02.000Z",
    };
    vi.spyOn(remoteBridge, "listRecovery").mockResolvedValueOnce({
      kind: "success",
      value: { recoveries: [selected], nextCursor: null },
    });
    const inspect = vi.spyOn(remoteBridge, "inspectRecovery");

    await expect(owner.listRecoveries()).resolves.toMatchObject({
      kind: "available",
      recoveries: [{ id: SEALED_RECOVERY, actionable: true }],
    });
    nowMilliseconds = 2_000;
    await expect(
      owner.createReview(SESSION, PATH, SEALED_RECOVERY),
    ).resolves.toBeNull();
    await expect(
      owner.createReview(SESSION, PATH, SEALED_RECOVERY),
    ).resolves.toBeNull();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("rejects a sealed selection that expires during fresh metadata inspection", async () => {
    let nowMilliseconds = 1_000;
    const { owner, remoteBridge } = subject(undefined, {
      nowMilliseconds: () => nowMilliseconds,
    });
    const selected = {
      kind: "sealed" as const,
      id: SEALED_RECOVERY,
      associationId: ASSOCIATION,
      path: PATH,
      revision: REMOTE_REVISION,
      sourceRevision: BASE_REVISION,
      contentSha256: REMOTE_HASH,
      recoverUntil: "1970-01-01T00:00:02.000Z",
    };
    vi.spyOn(remoteBridge, "listRecovery").mockResolvedValueOnce({
      kind: "success",
      value: { recoveries: [selected], nextCursor: null },
    });
    vi.spyOn(remoteBridge, "inspectRecovery").mockImplementationOnce(
      async () => {
        nowMilliseconds = 2_000;
        return { kind: "success", value: selected };
      },
    );

    await owner.listRecoveries();
    await expect(
      owner.createReview(SESSION, PATH, SEALED_RECOVERY),
    ).resolves.toBeNull();
    await expect(
      owner.createReview(SESSION, PATH, SEALED_RECOVERY),
    ).resolves.toBeNull();
  });

  it("normalizes sampled destinations and rejects candidates outside discovery", async () => {
    const { owner } = subject();
    const outside = required(normalizeNotePath("notes/outside.md"));
    await expect(owner.createReview(SESSION, outside)).resolves.toBeNull();
    await expect(
      owner.createReview(SESSION, PATH, null, "notes/copy.md"),
    ).resolves.toMatchObject({ destinationPath: "notes/copy.md" });
  });

  it("fails closed when cryptography cannot create a runtime identity", async () => {
    const invalidCrypto = new Proxy(crypto, {
      get(target, property, receiver) {
        if (property === "randomUUID") return () => "invalid";
        return Reflect.get(target, property, receiver);
      },
    });
    const { owner } = subject(invalidCrypto);

    await expect(owner.createReview(SESSION, PATH)).rejects.toThrow(
      "Runtime identity unavailable",
    );
  });

  it("admits and executes reviewed rename history through the shared scheduler", async () => {
    const historyBridge = historyRemote();
    const mutateNote = vi.spyOn(historyBridge, "mutateNote");
    const { owner, scheduler, stateOwner } = subject(crypto, {
      state: historyState(),
      local: historyLocal(),
      remote: historyBridge,
    });
    const detail = await owner.createReview(SESSION, HISTORY_SOURCE);
    if (detail === null) throw new Error("Expected a history review.");
    expect(detail.allowedActions).toContain(
      RECONCILIATION_ACTION.resolveHistory,
    );
    expect(detail.historyCandidates).toEqual([HISTORY_SOURCE, PATH]);
    await expect(
      owner.submit(SESSION, detail.reviewId, {
        kind: RECONCILIATION_ACTION.resolveHistory,
        decision: {
          kind: HISTORY_DECISION_KIND.executeCleanupPlan,
          selectedCandidatePath: required(normalizeNotePath("notes/forged.md")),
        },
      }),
    ).resolves.toEqual({ kind: "failed" });

    await expect(
      owner.submit(SESSION, detail.reviewId, {
        kind: RECONCILIATION_ACTION.resolveHistory,
        decision: {
          kind: HISTORY_DECISION_KIND.executeCleanupPlan,
          selectedCandidatePath: PATH,
        },
      }),
    ).resolves.toEqual({ kind: "admitted" });
    await scheduler.whenIdle();

    expect(mutateNote).toHaveBeenCalledOnce();
    expect(stateOwner.snapshot().state.reconciliationOperations).toMatchObject([
      {
        phase: "completed",
        action: {
          kind: RECONCILIATION_ACTION.resolveHistory,
          decision: {
            kind: HISTORY_DECISION_KIND.executeCleanupPlan,
            canonicalPath: PATH,
          },
        },
      },
    ]);
  });

  it("executes a reviewed conditional remote update under the shared scheduler", async () => {
    const { owner, scheduler, stateOwner, remoteBridge } = subject();
    const mutateNote = vi.spyOn(remoteBridge, "mutateNote");
    const detail = await owner.createReview(SESSION, PATH);
    if (detail === null) throw new Error("Expected a review.");

    await expect(
      owner.submit(SESSION, detail.reviewId, {
        kind: RECONCILIATION_ACTION.keepLocal,
      }),
    ).resolves.toEqual({ kind: "admitted" });
    await scheduler.whenIdle();

    expect(mutateNote).toHaveBeenCalledOnce();
    expect(stateOwner.snapshot().state.reconciliationOperations).toMatchObject([
      { phase: "completed" },
    ]);
  });

  it("retains evidence-required attention when a remote adapter throws", async () => {
    const { owner, scheduler, stateOwner, remoteBridge } = subject();
    vi.spyOn(remoteBridge, "mutateNote").mockRejectedValueOnce(
      new Error("Expected adapter failure."),
    );
    const detail = await owner.createReview(SESSION, PATH);
    if (detail === null) throw new Error("Expected a review.");

    await owner.submit(SESSION, detail.reviewId, {
      kind: RECONCILIATION_ACTION.keepLocal,
    });
    await scheduler.whenIdle();

    await vi.waitFor(() =>
      expect(stateOwner.snapshot().state.globalBlockReason).not.toBeNull(),
    );
    expect(stateOwner.snapshot().state.reconciliationOperations).toMatchObject([
      { phase: "mutating-remote" },
    ]);
  });

  it("executes a reviewed local replacement under the shared scheduler", async () => {
    const { owner, scheduler, stateOwner, localWriter } = subject();
    const detail = await owner.createReview(SESSION, PATH);
    if (detail === null) throw new Error("Expected a review.");

    await expect(
      owner.submit(SESSION, detail.reviewId, {
        kind: RECONCILIATION_ACTION.useRemote,
      }),
    ).resolves.toEqual({ kind: "admitted" });
    owner.resumePersisted();
    await scheduler.whenIdle();

    expect(localWriter.createPreservation).toHaveBeenCalledOnce();
    expect(localWriter.replaceEligible).toHaveBeenCalledOnce();
    expect(stateOwner.snapshot().state.reconciliationOperations).toMatchObject([
      { phase: "completed" },
    ]);
  });
});
