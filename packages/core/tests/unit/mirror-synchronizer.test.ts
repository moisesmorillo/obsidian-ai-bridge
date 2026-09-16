import {
  type ConditionalMutationRequest,
  type ContentSha256,
  type CurrentNoteState,
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  LocalInspectionKind,
  type LocalListResult,
  type LocalReadResult,
  MAX_MIRROR_TRACKED_PATHS,
  MAX_MUTATION_ATTEMPTS,
  MAX_MUTATION_EVIDENCE_ATTEMPTS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_BOOTSTRAP_INCOMPLETE_REASON,
  MIRROR_COALESCING_QUIET_PERIOD_MILLISECONDS,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_MUTATION_RETRY_DELAY_MILLISECONDS,
  MIRROR_PATH_BLOCK_REASON,
  MIRROR_STATE_STORE_FAILURE,
  type MirrorDeviceState,
  type MirrorOperationId,
  MirrorStateOwner,
  type MirrorStateSaveResult,
  type MirrorStateStore,
  MirrorSynchronizer,
  type MirrorSynchronizerRuntime,
  MUTATION_ACTION,
  type MutationAcknowledgement,
  normalizeNotePath,
  type ReadOnlyLocalVault,
  type RemoteBridge,
  type RemoteBridgeMutationResult,
} from "@obsidian-ai-bridge/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DEVICE = required(
  createMirrorWriterId("11111111-1111-4111-8111-111111111111"),
);
const ASSOCIATION = required(
  createMirrorAssociationId("22222222-2222-4222-8222-222222222222"),
);
const OPERATION_A = required(
  createMirrorOperationId("33333333-3333-4333-8333-333333333333"),
);
const OPERATION_B = required(
  createMirrorOperationId("44444444-4444-4444-8444-444444444444"),
);
const OPERATION_C = required(
  createMirrorOperationId("77777777-7777-4777-8777-777777777777"),
);
const REVISION_A = required(
  createApplicationRevision("55555555-5555-4555-8555-555555555555"),
);
const REVISION_B = required(
  createApplicationRevision("66666666-6666-4666-8666-666666666666"),
);
const HASH_A = required(createContentSha256("aa".repeat(32)));
const HASH_B = required(createContentSha256("bb".repeat(32)));
const PATH_A = required(normalizeNotePath("notes/a.md"));
const PATH_B = required(normalizeNotePath("notes/b.md"));
const PATH_REMOTE = required(normalizeNotePath("notes/remote.md"));
const SKIPPED = {
  unsupported_file: 0,
  excluded_location: 0,
  invalid_path: 0,
  oversized: 0,
};

class FakeStore implements MirrorStateStore {
  readonly states: MirrorDeviceState[] = [];
  readonly save = vi.fn(
    async (state: MirrorDeviceState): Promise<MirrorStateSaveResult> => {
      this.states.push(state);
      return { kind: "saved" };
    },
  );
}

class FakeLocal implements ReadOnlyLocalVault {
  readonly list = vi.fn<ReadOnlyLocalVault["list"]>();
  readonly read = vi.fn<ReadOnlyLocalVault["read"]>();
}

class FakeRemote implements RemoteBridge {
  readonly describe = vi.fn<RemoteBridge["describe"]>();
  readonly listNotes = vi.fn<RemoteBridge["listNotes"]>();
  readonly readNote = vi.fn<RemoteBridge["readNote"]>();
  readonly inspectNote = vi.fn<RemoteBridge["inspectNote"]>();
  readonly mutateNote = vi.fn<RemoteBridge["mutateNote"]>();
  readonly listRecovery = vi.fn<RemoteBridge["listRecovery"]>();
  readonly inspectRecovery = vi.fn<RemoteBridge["inspectRecovery"]>();
  readonly readRecoveryContent = vi.fn<RemoteBridge["readRecoveryContent"]>();
  readonly sealRecovery = vi.fn<RemoteBridge["sealRecovery"]>();
  readonly purgeRecovery = vi.fn<RemoteBridge["purgeRecovery"]>();
}

class FakeRuntime implements MirrorSynchronizerRuntime {
  now = 0;
  operationIndex = 0;
  readonly operations: readonly MirrorOperationId[] = [
    OPERATION_A,
    OPERATION_B,
    OPERATION_C,
  ];

  nowMilliseconds(): number {
    return this.now;
  }

  async hashContent(content: string): Promise<ContentSha256> {
    return content === "A" ? HASH_A : HASH_B;
  }

  createOperationId(): MirrorOperationId {
    const operation = this.operations[this.operationIndex];
    this.operationIndex += 1;
    return required(operation);
  }
}

let local: FakeLocal;
let remote: FakeRemote;
let runtime: FakeRuntime;
let store: FakeStore;

beforeEach(() => {
  local = new FakeLocal();
  remote = new FakeRemote();
  runtime = new FakeRuntime();
  store = new FakeStore();
  local.list.mockResolvedValue(listResult([PATH_A]));
  local.read.mockResolvedValue(readResult("A"));
  remote.describe.mockResolvedValue({
    kind: "success",
    value: {
      protocol: "obsidian-ai-bridge-mirror-v2",
      associationId: ASSOCIATION,
      writerId: DEVICE,
      maxNoteSizeBytes: 1024 * 1024,
      maxPageSize: 50,
      recoveryRetentionSeconds: 2_592_000,
    },
  });
  remote.listNotes.mockResolvedValue({
    kind: "success",
    value: { notes: [], nextCursor: null },
  });
  remote.inspectNote.mockImplementation(async (path) => ({
    kind: "success",
    value: { kind: "absent", path },
  }));
  remote.mutateNote.mockImplementation(async (request) =>
    confirmed(request, REVISION_A),
  );
});

describe("MirrorSynchronizer bootstrap and coalescing", () => {
  it("refuses dispatch before and during the admission-critical bootstrap", async () => {
    const pendingList = Promise.withResolvers<LocalListResult>();
    local.list.mockReturnValueOnce(pendingList.promise);
    const synchronizer = createInactiveSynchronizer();

    await synchronizer.observePresent(PATH_A);
    runtime.now = MIRROR_COALESCING_QUIET_PERIOD_MILLISECONDS;
    await synchronizer.synchronizeReady();
    expect(remote.mutateNote).not.toHaveBeenCalled();
    expect(synchronizer.currentPhase()).toBe("inactive");
    expect(synchronizer.nextWakeAtMilliseconds()).toBeNull();

    const bootstrap = synchronizer.bootstrap();
    await vi.waitFor(() => expect(local.list).toHaveBeenCalledTimes(1));
    await synchronizer.synchronizeReady();
    expect(remote.mutateNote).not.toHaveBeenCalled();
    expect(synchronizer.currentPhase()).toBe("bootstrapping");
    expect(synchronizer.nextWakeAtMilliseconds()).toBeNull();

    pendingList.resolve(listResult([PATH_A]));
    await bootstrap;
  });

  it("keeps failed local and handshake bootstrap closed", async () => {
    const localFailure = createInactiveSynchronizer();
    await localFailure.observePresent(PATH_A);
    local.list.mockResolvedValueOnce({
      kind: LocalInspectionKind.failed,
      reason: "unavailable",
    });
    expect(await localFailure.bootstrap()).toMatchObject({
      kind: "local-incomplete",
    });
    await localFailure.synchronizeReady();
    expect(remote.mutateNote).not.toHaveBeenCalled();
    expect(localFailure.currentPhase()).toBe("inactive");
    expect(localFailure.nextWakeAtMilliseconds()).toBeNull();

    remote.describe.mockResolvedValueOnce({
      kind: "failure",
      failure: "unauthenticated",
    });
    const handshakeFailure = createInactiveSynchronizer();
    await handshakeFailure.observePresent(PATH_B);
    expect(await handshakeFailure.bootstrap()).toMatchObject({
      kind: "inactive",
    });
    await handshakeFailure.synchronizeReady();
    expect(remote.mutateNote).not.toHaveBeenCalled();
    expect(handshakeFailure.nextWakeAtMilliseconds()).toBeNull();
  });

  it("reports a stale bootstrap transition when activation changes during enumeration", async () => {
    const pendingList = Promise.withResolvers<LocalListResult>();
    local.list.mockReturnValueOnce(pendingList.promise);
    const owner = new MirrorStateOwner(activeState(), store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    const bootstrap = synchronizer.bootstrap();
    await vi.waitFor(() => expect(local.list).toHaveBeenCalledTimes(1));
    await owner.transition((state) => ({
      ...state,
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.paused,
        associationId: ASSOCIATION,
        origin: "https://bridge.example",
        reason: "manual",
      },
    }));
    pendingList.resolve(listResult([PATH_A]));

    await expect(bootstrap).resolves.toMatchObject({
      kind: "state-incomplete",
      eligiblePaths: [],
      reason: MIRROR_BOOTSTRAP_INCOMPLETE_REASON.staleTransition,
    });
    expect(synchronizer.currentPhase()).toBe("inactive");
    expect(synchronizer.nextWakeAtMilliseconds()).toBeNull();
    expect(remote.mutateNote).not.toHaveBeenCalled();
  });

  it("merges positive events received during enumeration and only reports remote extras", async () => {
    const pending = Promise.withResolvers<LocalListResult>();
    local.list.mockReturnValueOnce(pending.promise);
    remote.listNotes.mockResolvedValueOnce({
      kind: "success",
      value: { notes: [PATH_REMOTE], nextCursor: null },
    });
    const owner = new MirrorStateOwner(activeState(), store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);

    const bootstrap = synchronizer.bootstrap();
    await vi.waitFor(() => expect(local.list).toHaveBeenCalled());
    expect(synchronizer.currentPhase()).toBe("bootstrapping");
    await synchronizer.observePresent(PATH_B);
    await synchronizer.synchronizeReady();
    expect(local.read).not.toHaveBeenCalled();
    pending.resolve(listResult([PATH_A, PATH_B]));
    const result = await bootstrap;

    expect(result).toMatchObject({
      kind: "complete",
      eligiblePaths: [PATH_A, PATH_B],
      unassociatedRemotePaths: [PATH_REMOTE],
      inventory: { kind: "complete", pagesRead: 1 },
    });
    expect(synchronizer.currentPhase()).toBe("observing");
    expect(
      owner
        .snapshot()
        .state.paths.map((entry) => entry.path)
        .toSorted(),
    ).toEqual([PATH_A, PATH_B]);
    expect(
      owner.snapshot().state.paths.find((entry) => entry.path === PATH_B)
        ?.desired,
    ).toMatchObject({ kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent });
  });

  it("does not enumerate or admit work for an inactive non-writer", async () => {
    const state: MirrorDeviceState = {
      ...activeState(),
      lifecycle: { kind: MIRROR_DEVICE_LIFECYCLE_KIND.disabled },
      paths: [],
    };
    const synchronizer = new MirrorSynchronizer(
      local,
      remote,
      new MirrorStateOwner(state, store),
      runtime,
    );
    expect(await synchronizer.bootstrap()).toEqual({
      kind: "inactive",
      eligiblePaths: [],
      inventory: null,
    });
    expect(synchronizer.currentPhase()).toBe("inactive");
    expect(local.list).not.toHaveBeenCalled();
    expect(remote.describe).not.toHaveBeenCalled();
    expect(remote.listNotes).not.toHaveBeenCalled();
    expect(remote.mutateNote).not.toHaveBeenCalled();
  });

  it("fails bootstrap closed on remote designation or handshake failure", async () => {
    remote.describe.mockResolvedValueOnce({
      kind: "failure",
      failure: "unauthenticated",
    });
    const failedOwner = new MirrorStateOwner(activeState(), store);
    const failed = new MirrorSynchronizer(local, remote, failedOwner, runtime);
    expect(await failed.bootstrap()).toMatchObject({ kind: "inactive" });
    expect(failedOwner.snapshot().state.globalBlockReason).toBe(
      "missing-secret",
    );

    remote.describe.mockResolvedValueOnce({
      kind: "failure",
      failure: "incompatible-protocol",
    });
    const incompatibleOwner = new MirrorStateOwner(
      activeState(),
      new FakeStore(),
    );
    const incompatible = new MirrorSynchronizer(
      local,
      remote,
      incompatibleOwner,
      runtime,
    );
    expect(await incompatible.bootstrap()).toMatchObject({ kind: "inactive" });
    expect(incompatibleOwner.snapshot().state.globalBlockReason).toBe(
      "configuration-unavailable",
    );

    remote.describe.mockResolvedValueOnce({
      kind: "success",
      value: {
        protocol: "obsidian-ai-bridge-mirror-v2",
        associationId: ASSOCIATION,
        writerId: required(
          createMirrorWriterId("88888888-8888-4888-8888-888888888888"),
        ),
        maxNoteSizeBytes: 1024 * 1024,
        maxPageSize: 50,
        recoveryRetentionSeconds: 2_592_000,
      },
    });
    const mismatchOwner = new MirrorStateOwner(activeState(), new FakeStore());
    const mismatch = new MirrorSynchronizer(
      local,
      remote,
      mismatchOwner,
      runtime,
    );
    expect(await mismatch.bootstrap()).toMatchObject({ kind: "inactive" });
    expect(mismatchOwner.snapshot().state.globalBlockReason).toBe(
      "designation-mismatch",
    );
    expect(local.list).not.toHaveBeenCalled();
  });

  it("makes failed local enumeration visible without deletion authority", async () => {
    local.list.mockResolvedValueOnce({
      kind: LocalInspectionKind.failed,
      reason: "unavailable",
    });
    const synchronizer = createInactiveSynchronizer();
    expect(await synchronizer.bootstrap()).toMatchObject({
      kind: "local-incomplete",
      eligiblePaths: [],
      inventory: { kind: "complete" },
    });
    expect(synchronizer.currentPhase()).toBe("inactive");
    expect(remote.mutateNote).not.toHaveBeenCalled();
  });

  it("admits the exact path-capacity boundary with one indexed batch", async () => {
    const paths = createCapacityPaths(MAX_MIRROR_TRACKED_PATHS);
    local.list.mockResolvedValueOnce(listResult(paths));
    const owner = new MirrorStateOwner(activeState(), store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);

    await expect(synchronizer.bootstrap()).resolves.toMatchObject({
      kind: "complete",
      eligiblePaths: paths,
    });
    expect(owner.snapshot().state.paths).toHaveLength(MAX_MIRROR_TRACKED_PATHS);
  });

  it("reports capacity overflow without claiming durable bootstrap admission", async () => {
    const paths = createCapacityPaths(MAX_MIRROR_TRACKED_PATHS + 1);
    local.list.mockResolvedValueOnce(listResult(paths));
    const owner = new MirrorStateOwner(activeState(), store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);

    await expect(synchronizer.bootstrap()).resolves.toMatchObject({
      kind: "state-incomplete",
      eligiblePaths: [],
      reason: MIRROR_BOOTSTRAP_INCOMPLETE_REASON.pathCapacityExceeded,
    });
    expect(owner.snapshot().state.paths).toEqual([]);
    expect(synchronizer.currentPhase()).toBe("inactive");
    expect(synchronizer.nextWakeAtMilliseconds()).toBeNull();
  });

  it("reports bootstrap persistence failure and keeps admission closed", async () => {
    store.save.mockResolvedValueOnce({
      kind: "failed",
      reason: MIRROR_STATE_STORE_FAILURE.quotaOrStorageError,
    });
    const owner = new MirrorStateOwner(activeState(), store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);

    await expect(synchronizer.bootstrap()).resolves.toMatchObject({
      kind: "state-incomplete",
      eligiblePaths: [],
      reason: MIRROR_BOOTSTRAP_INCOMPLETE_REASON.persistenceFailed,
    });
    expect(owner.snapshot().persistenceAvailable).toBe(false);
    expect(synchronizer.currentPhase()).toBe("inactive");
    expect(synchronizer.nextWakeAtMilliseconds()).toBeNull();
    await synchronizer.synchronizeReady();
    expect(remote.mutateNote).not.toHaveBeenCalled();
  });

  it("lets positive synchronization settle while reporting inventory remains pending", async () => {
    const inventoryPage =
      Promise.withResolvers<Awaited<ReturnType<RemoteBridge["listNotes"]>>>();
    remote.listNotes.mockReturnValueOnce(inventoryPage.promise);
    const synchronizer = createInactiveSynchronizer();
    const onPositiveAdmission = vi.fn();
    const bootstrap = synchronizer.bootstrap({ onPositiveAdmission });
    let bootstrapSettled = false;
    void bootstrap.then(() => {
      bootstrapSettled = true;
    });

    await vi.waitFor(() =>
      expect(synchronizer.currentPhase()).toBe("observing"),
    );
    expect(onPositiveAdmission).toHaveBeenCalledOnce();
    runtime.now = MIRROR_COALESCING_QUIET_PERIOD_MILLISECONDS;
    const positive = synchronizer.synchronizeReady();
    let positiveSettled = false;
    void positive.then(() => {
      positiveSettled = true;
    });
    await vi.waitFor(() => expect(remote.mutateNote).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(positiveSettled).toBe(true));
    expect(bootstrapSettled).toBe(false);

    inventoryPage.resolve({
      kind: "success",
      value: { notes: [], nextCursor: null },
    });
    await expect(bootstrap).resolves.toMatchObject({ kind: "complete" });
  });

  it("suppresses wake deadlines while a bootstrapped writer is paused", async () => {
    const owner = new MirrorStateOwner(activeState(), store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    await bootstrapSynchronizer(synchronizer);
    await synchronizer.observePresent(PATH_A);
    expect(synchronizer.nextWakeAtMilliseconds()).toBe(750);
    await owner.transition((state) => ({
      ...state,
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.paused,
        associationId: ASSOCIATION,
        origin: "https://bridge.example",
        reason: "manual",
      },
    }));
    expect(synchronizer.nextWakeAtMilliseconds()).toBeNull();
  });

  it("collapses rapid changes until quiet and sends only the latest saved bytes", async () => {
    const synchronizer = await createSynchronizer();
    await synchronizer.observePresent(PATH_A);
    runtime.now = 500;
    local.read.mockResolvedValue(readResult("B"));
    await synchronizer.observePresent(PATH_A);
    runtime.now = 1_249;
    await synchronizer.synchronizeReady();
    expect(remote.mutateNote).not.toHaveBeenCalled();

    runtime.now = 1_250;
    await synchronizer.synchronizeReady();
    expect(remote.mutateNote).toHaveBeenCalledTimes(1);
    expect(remote.mutateNote.mock.calls[0]?.[0]).toMatchObject({
      action: MUTATION_ACTION.create,
      content: "B",
    });
  });

  it("invalidates a saved read when a newer local generation arrives", async () => {
    const read = Promise.withResolvers<LocalReadResult>();
    local.read.mockReturnValueOnce(read.promise);
    const synchronizer = await createSynchronizer();
    await synchronizer.observePresent(PATH_A);
    runtime.now = MIRROR_COALESCING_QUIET_PERIOD_MILLISECONDS;
    const work = synchronizer.synchronizeReady();
    await vi.waitFor(() => expect(local.read).toHaveBeenCalledTimes(1));
    await synchronizer.observePresent(PATH_A);
    read.resolve(readResult("A"));
    await work;

    expect(remote.mutateNote).not.toHaveBeenCalled();
    expect(synchronizer.outcome(PATH_A)?.kind).toBe("stale-read");
  });

  it("invalidates a read when the generation changes during hashing", async () => {
    const hash = Promise.withResolvers<ContentSha256>();
    const hashContent = vi.fn(() => hash.promise);
    runtime.hashContent = hashContent;
    const synchronizer = await createSynchronizer();
    await synchronizer.observePresent(PATH_A);
    runtime.now = 750;
    const work = synchronizer.synchronizeReady();
    await vi.waitFor(() => expect(hashContent).toHaveBeenCalled());
    await synchronizer.observePresent(PATH_A);
    hash.resolve(HASH_A);
    await work;
    expect(synchronizer.outcome(PATH_A)?.kind).toBe("stale-read");
    expect(remote.mutateNote).not.toHaveBeenCalled();
  });

  it("uses two global path slots, never two jobs for one path, and then serves the third path", async () => {
    const pathC = required(normalizeNotePath("notes/c.md"));
    const reads = [
      Promise.withResolvers<LocalReadResult>(),
      Promise.withResolvers<LocalReadResult>(),
      Promise.withResolvers<LocalReadResult>(),
    ] as const;
    let readIndex = 0;
    local.read.mockImplementation(() => {
      const read = reads[readIndex];
      readIndex += 1;
      return required(read).promise;
    });
    const synchronizer = await createSynchronizer();
    await synchronizer.observePresent(PATH_A);
    await synchronizer.observePresent(PATH_B);
    await synchronizer.observePresent(pathC);
    runtime.now = 750;
    const work = synchronizer.synchronizeReady();
    await vi.waitFor(() => expect(local.read).toHaveBeenCalledTimes(2));
    expect(new Set(local.read.mock.calls.map(([path]) => path)).size).toBe(2);
    reads[0].resolve(readResult("A"));
    await vi.waitFor(() => expect(local.read).toHaveBeenCalledTimes(3));
    reads[1].resolve(readResult("A"));
    reads[2].resolve(readResult("A"));
    await work;
  });

  it("rejects intent persistence when a newer state transition wins admission", async () => {
    const owner = new MirrorStateOwner(activeState(), store);
    runtime.createOperationId = vi.fn(() => {
      void owner.transition((state) => ({
        ...state,
        paths: state.paths.map((entry) => ({
          ...entry,
          desired: {
            kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent,
            observationGeneration: 99,
          },
        })),
      }));
      return OPERATION_A;
    });
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    await bootstrapSynchronizer(synchronizer);
    await synchronizer.observePresent(PATH_A);
    runtime.now = 750;
    await synchronizer.synchronizeReady();
    expect(remote.mutateNote).not.toHaveBeenCalled();
    expect(owner.snapshot().state.paths[0]?.desired).toMatchObject({
      observationGeneration: 99,
    });
  });

  it("stops safely if writer activation changes while a saved hash is pending", async () => {
    const hash = Promise.withResolvers<ContentSha256>();
    const hashContent = vi.fn(() => hash.promise);
    runtime.hashContent = hashContent;
    const owner = new MirrorStateOwner(activeState(), store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    await bootstrapSynchronizer(synchronizer);
    await synchronizer.observePresent(PATH_A);
    runtime.now = 750;
    const work = synchronizer.synchronizeReady();
    await vi.waitFor(() => expect(hashContent).toHaveBeenCalled());
    await owner.transition((state) => ({
      ...state,
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.paused,
        associationId: ASSOCIATION,
        origin: "https://bridge.example",
        reason: "manual",
      },
    }));
    hash.resolve(HASH_A);
    await work;
    expect(remote.mutateNote).not.toHaveBeenCalled();
    expect(owner.snapshot().state.paths[0]?.blockedReason).toBe("diverged");
  });

  it("ignores settled paths and blocks an already exhausted persisted attempt", async () => {
    const settledOwner = new MirrorStateOwner(
      stateWithLiveAcknowledgement(HASH_A, REVISION_A),
      store,
    );
    const settled = new MirrorSynchronizer(
      local,
      remote,
      settledOwner,
      runtime,
    );
    await bootstrapSynchronizer(settled);
    await settled.synchronizeReady();
    expect(settled.nextWakeAtMilliseconds()).toBeNull();
    expect(local.read).not.toHaveBeenCalled();

    const exhausted = stateWithUnresolved(MAX_MUTATION_ATTEMPTS, 0);
    const entry = required(exhausted.paths[0]);
    const exhaustedOwner = new MirrorStateOwner(
      {
        ...exhausted,
        paths: [
          {
            ...entry,
            unresolvedMutation:
              entry.unresolvedMutation === null
                ? null
                : { ...entry.unresolvedMutation, phase: "intent-persisted" },
          },
        ],
      },
      new FakeStore(),
    );
    const resumed = new MirrorSynchronizer(
      local,
      remote,
      exhaustedOwner,
      runtime,
    );
    await bootstrapSynchronizer(resumed);
    await resumed.synchronizeReady();
    expect(exhaustedOwner.snapshot().state.paths[0]?.blockedReason).toBe(
      "retry-exhausted",
    );
  });

  it("bounds continuous coalescing and reports unavailable saved reads without mutation", async () => {
    const synchronizer = await createSynchronizer();
    await synchronizer.observePresent(PATH_A);
    expect(synchronizer.nextWakeAtMilliseconds()).toBe(750);
    for (const now of [700, 1_400, 2_100, 2_800, 3_500, 4_200, 4_900]) {
      runtime.now = now;
      await synchronizer.observePresent(PATH_A);
    }
    runtime.now = 5_000;
    local.read.mockResolvedValueOnce({
      kind: LocalInspectionKind.failed,
      reason: "missing_file",
    });
    await synchronizer.synchronizeReady();
    expect(local.read).toHaveBeenCalledTimes(1);
    expect(synchronizer.outcome(PATH_A)?.kind).toBe("local-unavailable");
    expect(remote.mutateNote).not.toHaveBeenCalled();
    expect(synchronizer.nextWakeAtMilliseconds()).toBe(5_000);
  });
});

describe("MirrorSynchronizer acknowledgement and divergence", () => {
  it("keeps newer desired state dirty during PUT and uses the actual ACK as prior state", async () => {
    const mutation =
      Promise.withResolvers<
        RemoteBridgeMutationResult<MutationAcknowledgement>
      >();
    remote.mutateNote.mockReturnValueOnce(mutation.promise);
    const owner = new MirrorStateOwner(activeState(), store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    await bootstrapSynchronizer(synchronizer);
    await synchronizer.observePresent(PATH_A);
    runtime.now = 750;
    const first = synchronizer.synchronizeReady();
    await vi.waitFor(() => expect(remote.mutateNote).toHaveBeenCalledTimes(1));

    runtime.now = 800;
    local.read.mockResolvedValue(readResult("B"));
    await synchronizer.observePresent(PATH_A);
    mutation.resolve(
      confirmed(required(remote.mutateNote.mock.calls[0]?.[0]), REVISION_A),
    );
    await first;
    expect(owner.snapshot().state.paths[0]).toMatchObject({
      acknowledgement: {
        kind: "live",
        revision: REVISION_A,
        contentSha256: HASH_A,
      },
      desired: { kind: "dirty-present" },
    });

    runtime.now = 1_550;
    remote.inspectNote.mockResolvedValue({
      kind: "success",
      value: liveState(PATH_A, REVISION_A, HASH_A, OPERATION_A),
    });
    remote.mutateNote.mockImplementationOnce(async (request) =>
      confirmed(request, REVISION_B),
    );
    await synchronizer.synchronizeReady();
    expect(remote.mutateNote.mock.calls[1]?.[0]).toMatchObject({
      action: MUTATION_ACTION.update,
      precondition: { kind: "matching-revision", revision: REVISION_A },
      content: "B",
    });
  });

  it("starts a fresh coalescing window after a settled generation", async () => {
    const synchronizer = await createSynchronizer();
    await synchronizer.observePresent(PATH_A);
    runtime.now = 750;
    await synchronizer.synchronizeReady();
    runtime.now = 10_000;
    await synchronizer.observePresent(PATH_A);
    expect(synchronizer.nextWakeAtMilliseconds()).toBe(10_750);
  });

  it("avoids a mutation for matching acknowledged hash and remote revision at bootstrap", async () => {
    const owner = new MirrorStateOwner(
      stateWithLiveAcknowledgement(HASH_A, REVISION_A),
      store,
    );
    remote.inspectNote.mockResolvedValue({
      kind: "success",
      value: liveState(PATH_A, REVISION_A, HASH_A, OPERATION_A),
    });
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    await synchronizer.bootstrap();
    runtime.now = 750;
    await synchronizer.synchronizeReady();
    expect(remote.inspectNote).toHaveBeenCalledWith(PATH_A);
    expect(remote.mutateNote).not.toHaveBeenCalled();
    expect(synchronizer.outcome(PATH_A)?.kind).toBe("unchanged");
  });

  it.each(["absent", "legacy", "tombstone"] as const)(
    "blocks acknowledged bootstrap when remote state is %s",
    async (kind) => {
      const owner = new MirrorStateOwner(
        stateWithLiveAcknowledgement(HASH_A, REVISION_A),
        store,
      );
      remote.inspectNote.mockResolvedValue({
        kind: "success",
        value: divergentState(kind),
      });
      const synchronizer = new MirrorSynchronizer(
        local,
        remote,
        owner,
        runtime,
      );
      await synchronizer.bootstrap();
      runtime.now = 750;
      await synchronizer.synchronizeReady();
      expect(owner.snapshot().state.paths[0]?.blockedReason).toBe(
        MIRROR_PATH_BLOCK_REASON.diverged,
      );
      expect(remote.mutateNote).not.toHaveBeenCalled();
    },
  );

  it("keeps unrelated positive sync running when inventory fails", async () => {
    remote.listNotes.mockResolvedValueOnce({
      kind: "failure",
      failure: "network-unavailable",
    });
    const synchronizer = createInactiveSynchronizer();
    expect(await synchronizer.bootstrap()).toMatchObject({
      inventory: { kind: "incomplete", reason: "remote-failure" },
    });
    expect(synchronizer.inventoryResult()).toMatchObject({
      kind: "incomplete",
    });
    runtime.now = 750;
    await synchronizer.synchronizeReady();
    expect(remote.mutateNote).toHaveBeenCalledTimes(1);
  });

  it("blocks an unassociated collision and a failed bootstrap state inspection", async () => {
    const owner = new MirrorStateOwner(activeState(), store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    await bootstrapSynchronizer(synchronizer);
    await synchronizer.observePresent(PATH_A);
    remote.inspectNote.mockResolvedValueOnce({
      kind: "success",
      value: liveState(PATH_A, REVISION_A, HASH_A, OPERATION_A),
    });
    runtime.now = 750;
    await synchronizer.synchronizeReady();
    expect(owner.snapshot().state.paths[0]?.blockedReason).toBe("diverged");

    const otherOwner = new MirrorStateOwner(activeState(), new FakeStore());
    const other = new MirrorSynchronizer(local, remote, otherOwner, runtime);
    await bootstrapSynchronizer(other);
    await other.observePresent(PATH_B);
    remote.inspectNote.mockResolvedValueOnce({
      kind: "failure",
      failure: "network-unavailable",
    });
    runtime.now = 1_500;
    await other.synchronizeReady();
    expect(other.outcome(PATH_B)).toMatchObject({
      kind: "remote-failure",
      failure: "network-unavailable",
    });
  });

  it("recreates only from its acknowledged tombstone revision", async () => {
    const tombstone: MirrorDeviceState = {
      ...activeState(),
      paths: [
        {
          path: PATH_A,
          acknowledgement: {
            kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
            revision: REVISION_A,
            recoveryId: OPERATION_A,
          },
          unresolvedMutation: null,
          desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
          blockedReason: null,
        },
      ],
    };
    remote.inspectNote.mockResolvedValueOnce({
      kind: "success",
      value: {
        kind: "tombstone",
        path: PATH_A,
        revision: REVISION_A,
        deletedRevision: REVISION_B,
        recoveryId: OPERATION_A,
        receipt: {
          action: MUTATION_ACTION.tombstone,
          associationId: ASSOCIATION,
          operationId: OPERATION_A,
          precondition: { kind: "matching-revision", revision: REVISION_B },
        },
      },
    });
    remote.mutateNote.mockImplementationOnce(async (request) =>
      confirmed(request, REVISION_B),
    );
    runtime.operationIndex = 1;
    const owner = new MirrorStateOwner(tombstone, store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    await bootstrapSynchronizer(synchronizer);
    await synchronizer.observePresent(PATH_A);
    runtime.now = 750;
    await synchronizer.synchronizeReady();
    expect(remote.mutateNote).toHaveBeenCalledTimes(1);
    expect(remote.mutateNote.mock.calls[0]?.[0]).toMatchObject({
      action: MUTATION_ACTION.recreate,
      precondition: { kind: "matching-revision", revision: REVISION_A },
    });
  });
});

describe("MirrorSynchronizer uncertainty and durable budgets", () => {
  it("blocks an intent-persisted retry when saved content no longer matches", async () => {
    const state = stateWithUnresolved(1, 0);
    const entry = required(state.paths[0]);
    const owner = new MirrorStateOwner(
      {
        ...state,
        paths: [
          {
            ...entry,
            unresolvedMutation:
              entry.unresolvedMutation === null
                ? null
                : {
                    ...entry.unresolvedMutation,
                    phase: "intent-persisted",
                  },
          },
        ],
      },
      store,
    );
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    await bootstrapSynchronizer(synchronizer);
    local.read.mockResolvedValueOnce(readResult("B"));

    await synchronizer.synchronizeReady();

    expect(owner.snapshot().state.paths[0]?.blockedReason).toBe(
      MIRROR_PATH_BLOCK_REASON.unresolvedEffect,
    );
    expect(remote.mutateNote).not.toHaveBeenCalled();
  });

  it("discovers an exact own receipt after an ambiguous mutation", async () => {
    remote.mutateNote.mockResolvedValueOnce({
      kind: "failure",
      failure: "timed-out",
      effect: "unknown",
    });
    const owner = new MirrorStateOwner(activeState(), store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    await bootstrapSynchronizer(synchronizer);
    await synchronizer.observePresent(PATH_A);
    runtime.now = 750;
    await synchronizer.synchronizeReady();
    const intent = required(
      owner.snapshot().state.paths[0]?.unresolvedMutation?.intent,
    );
    remote.inspectNote.mockResolvedValueOnce({
      kind: "success",
      value: liveState(PATH_A, REVISION_A, HASH_A, intent.operationId),
    });
    await synchronizer.synchronizeReady();

    expect(owner.snapshot().state.paths[0]).toMatchObject({
      acknowledgement: {
        kind: "live",
        revision: REVISION_A,
        contentSha256: HASH_A,
      },
      unresolvedMutation: null,
    });
  });

  it("performs only an original-condition exact retry after evidence and delay", async () => {
    remote.mutateNote
      .mockResolvedValueOnce({
        kind: "failure",
        failure: "network-unavailable",
        effect: "unknown",
      })
      .mockImplementationOnce(async (request) =>
        confirmed(request, REVISION_A),
      );
    const owner = new MirrorStateOwner(activeState(), store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    await bootstrapSynchronizer(synchronizer);
    await synchronizer.observePresent(PATH_A);
    runtime.now = 750;
    await synchronizer.synchronizeReady();
    remote.inspectNote.mockResolvedValueOnce({
      kind: "success",
      value: { kind: "absent", path: PATH_A },
    });
    await synchronizer.synchronizeReady();
    runtime.now += MIRROR_MUTATION_RETRY_DELAY_MILLISECONDS - 1;
    await synchronizer.synchronizeReady();
    expect(remote.mutateNote).toHaveBeenCalledTimes(1);
    runtime.now += 1;
    await synchronizer.synchronizeReady();
    expect(remote.mutateNote).toHaveBeenCalledTimes(2);
    expect(remote.mutateNote.mock.calls[1]?.[0]).toMatchObject({
      operationId: OPERATION_A,
      precondition: { kind: "absent" },
      content: "A",
    });
  });

  it("retries a provably not-dispatched attempt without spending evidence", async () => {
    remote.mutateNote
      .mockResolvedValueOnce({
        kind: "failure",
        failure: "admission-denied",
        effect: "not-dispatched",
      })
      .mockImplementationOnce(async (request) =>
        confirmed(request, REVISION_A),
      );
    const owner = new MirrorStateOwner(activeState(), store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    await bootstrapSynchronizer(synchronizer);
    await synchronizer.observePresent(PATH_A);
    runtime.now = 750;
    await synchronizer.synchronizeReady();
    expect(owner.snapshot().state.paths[0]?.unresolvedMutation).toMatchObject({
      phase: "intent-persisted",
      intent: { mutationAttempts: 1, evidenceAttempts: 0 },
    });
    runtime.now += MIRROR_MUTATION_RETRY_DELAY_MILLISECONDS;
    await synchronizer.synchronizeReady();
    expect(remote.inspectNote).toHaveBeenCalledTimes(1);
    expect(remote.mutateNote).toHaveBeenCalledTimes(2);
  });

  it("blocks a first exact refusal without treating it as an ambiguous effect", async () => {
    remote.mutateNote.mockResolvedValueOnce({
      kind: "failure",
      failure: "precondition-failed",
      effect: "definitely-refused",
    });
    const owner = new MirrorStateOwner(activeState(), store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    await bootstrapSynchronizer(synchronizer);
    await synchronizer.observePresent(PATH_A);
    runtime.now = 750;
    await synchronizer.synchronizeReady();
    expect(owner.snapshot().state.paths[0]?.blockedReason).toBe("diverged");
    expect(remote.inspectNote).toHaveBeenCalledTimes(1);

    const forbiddenOwner = new MirrorStateOwner(activeState(), new FakeStore());
    const forbidden = new MirrorSynchronizer(
      local,
      remote,
      forbiddenOwner,
      runtime,
    );
    await bootstrapSynchronizer(forbidden);
    await forbidden.observePresent(PATH_B);
    remote.inspectNote.mockResolvedValueOnce({
      kind: "success",
      value: { kind: "absent", path: PATH_B },
    });
    remote.mutateNote.mockResolvedValueOnce({
      kind: "failure",
      failure: "forbidden",
      effect: "definitely-refused",
    });
    runtime.now += 750;
    await forbidden.synchronizeReady();
    expect(forbiddenOwner.snapshot().state.globalBlockReason).toBe(
      "designation-mismatch",
    );
    expect(forbidden.nextWakeAtMilliseconds()).toBeNull();
  });

  it("persists evidence consumption before a failed evidence request", async () => {
    const owner = new MirrorStateOwner(stateWithUnresolved(1, 0), store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    await bootstrapSynchronizer(synchronizer);
    remote.inspectNote.mockResolvedValueOnce({
      kind: "failure",
      failure: "server-failed",
    });
    await synchronizer.synchronizeReady();
    expect(
      owner.snapshot().state.paths[0]?.unresolvedMutation?.intent
        .evidenceAttempts,
    ).toBe(1);
    expect(synchronizer.outcome(PATH_A)).toMatchObject({
      kind: "remote-failure",
      failure: "server-failed",
    });
  });

  it("blocks exhausted mutation attempts after original-condition evidence", async () => {
    const owner = new MirrorStateOwner(
      stateWithUnresolved(MAX_MUTATION_ATTEMPTS, 0),
      store,
    );
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    await bootstrapSynchronizer(synchronizer);
    remote.inspectNote.mockResolvedValueOnce({
      kind: "success",
      value: { kind: "absent", path: PATH_A },
    });
    await synchronizer.synchronizeReady();
    expect(owner.snapshot().state.paths[0]?.blockedReason).toBe(
      "retry-exhausted",
    );
    expect(remote.mutateNote).not.toHaveBeenCalled();
  });

  it.each([MUTATION_ACTION.update, MUTATION_ACTION.recreate] as const)(
    "exhausts mutation budget only after %s original-condition evidence",
    async (action) => {
      const state = stateWithMatchingUnresolved(action);
      const owner = new MirrorStateOwner(state, store);
      const synchronizer = new MirrorSynchronizer(
        local,
        remote,
        owner,
        runtime,
      );
      await bootstrapSynchronizer(synchronizer);
      remote.inspectNote.mockResolvedValueOnce({
        kind: "success",
        value:
          action === MUTATION_ACTION.update
            ? liveState(PATH_A, REVISION_A, HASH_A, OPERATION_B)
            : {
                kind: "tombstone",
                path: PATH_A,
                revision: REVISION_A,
                deletedRevision: REVISION_B,
                recoveryId: OPERATION_B,
                receipt: {
                  action: MUTATION_ACTION.tombstone,
                  associationId: ASSOCIATION,
                  operationId: OPERATION_B,
                  precondition: {
                    kind: "matching-revision",
                    revision: REVISION_B,
                  },
                },
              },
      });
      await synchronizer.synchronizeReady();
      expect(owner.snapshot().state.paths[0]?.blockedReason).toBe(
        "retry-exhausted",
      );
    },
  );

  it("blocks arbitrary evidence instead of accepting equal text or a different receipt", async () => {
    const owner = new MirrorStateOwner(stateWithUnresolved(1, 0), store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    await bootstrapSynchronizer(synchronizer);
    expect(synchronizer.nextWakeAtMilliseconds()).toBe(0);
    remote.inspectNote.mockResolvedValueOnce({
      kind: "success",
      value: liveState(PATH_A, REVISION_A, HASH_A, OPERATION_B),
    });
    await synchronizer.synchronizeReady();
    expect(owner.snapshot().state.paths[0]?.blockedReason).toBe("diverged");
    await synchronizer.synchronizeReady();
    expect(remote.inspectNote).toHaveBeenCalledTimes(1);

    const updateOwner = new MirrorStateOwner(
      stateWithMatchingUnresolved(MUTATION_ACTION.update),
      new FakeStore(),
    );
    const update = new MirrorSynchronizer(local, remote, updateOwner, runtime);
    await bootstrapSynchronizer(update);
    remote.inspectNote.mockResolvedValueOnce({
      kind: "success",
      value: {
        kind: "live",
        path: PATH_A,
        revision: REVISION_A,
        contentSha256: HASH_A,
        receipt: {
          action: MUTATION_ACTION.update,
          associationId: ASSOCIATION,
          operationId: OPERATION_A,
          precondition: { kind: "matching-revision", revision: REVISION_B },
          contentSha256: HASH_A,
        },
      },
    });
    await update.synchronizeReady();
    expect(updateOwner.snapshot().state.paths[0]?.blockedReason).toBe(
      "retry-exhausted",
    );
  });

  it("retains the original unresolved hash when current saved bytes change", async () => {
    remote.mutateNote.mockResolvedValueOnce({
      kind: "failure",
      failure: "timed-out",
      effect: "unknown",
    });
    const owner = new MirrorStateOwner(activeState(), store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    await bootstrapSynchronizer(synchronizer);
    await synchronizer.observePresent(PATH_A);
    runtime.now = 750;
    await synchronizer.synchronizeReady();
    local.read.mockResolvedValue(readResult("B"));
    await synchronizer.observePresent(PATH_A);
    remote.inspectNote.mockResolvedValueOnce({
      kind: "success",
      value: { kind: "absent", path: PATH_A },
    });
    await synchronizer.synchronizeReady();
    expect(owner.snapshot().state.paths[0]).toMatchObject({
      unresolvedMutation: { intent: { contentSha256: HASH_A } },
      desired: { kind: "dirty-present" },
      blockedReason: MIRROR_PATH_BLOCK_REASON.unresolvedEffect,
    });
  });

  it("does not reset persisted exhausted budgets on restart, event, or read-only bootstrap", async () => {
    const exhausted = stateWithUnresolved(
      MAX_MUTATION_ATTEMPTS,
      MAX_MUTATION_EVIDENCE_ATTEMPTS,
    );
    const owner = new MirrorStateOwner(exhausted, store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    await synchronizer.bootstrap();
    await synchronizer.observePresent(PATH_A);
    await synchronizer.synchronizeReady();
    expect(owner.snapshot().state.paths[0]).toMatchObject({
      unresolvedMutation: {
        intent: {
          mutationAttempts: MAX_MUTATION_ATTEMPTS,
          evidenceAttempts: MAX_MUTATION_EVIDENCE_ATTEMPTS,
        },
      },
      blockedReason: MIRROR_PATH_BLOCK_REASON.unresolvedEffect,
    });
    expect(remote.mutateNote).not.toHaveBeenCalled();
    expect(remote.inspectNote).not.toHaveBeenCalled();
  });

  it("explicit retry grants only a fresh finite budget to the same intent", async () => {
    const owner = new MirrorStateOwner(
      stateWithUnresolved(
        MAX_MUTATION_ATTEMPTS,
        MAX_MUTATION_EVIDENCE_ATTEMPTS,
      ),
      store,
    );
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    expect(await synchronizer.grantRetry(PATH_A)).toBe(true);
    expect(
      owner.snapshot().state.paths[0]?.unresolvedMutation?.intent,
    ).toMatchObject({
      operationId: OPERATION_A,
      precondition: { kind: "absent" },
      contentSha256: HASH_A,
      mutationAttempts: 0,
      evidenceAttempts: 0,
    });

    local.read.mockResolvedValueOnce(readResult("B"));
    const unsafeOwner = new MirrorStateOwner(
      stateWithUnresolved(
        MAX_MUTATION_ATTEMPTS,
        MAX_MUTATION_EVIDENCE_ATTEMPTS,
      ),
      new FakeStore(),
    );
    const unsafe = new MirrorSynchronizer(local, remote, unsafeOwner, runtime);
    expect(await unsafe.grantRetry(PATH_A)).toBe(false);
    expect(
      unsafeOwner.snapshot().state.paths[0]?.unresolvedMutation?.intent,
    ).toMatchObject({
      mutationAttempts: MAX_MUTATION_ATTEMPTS,
      evidenceAttempts: MAX_MUTATION_EVIDENCE_ATTEMPTS,
    });
  });

  it("globally fences new mutations after confirmed ACK persistence failure and recovers via evidence", async () => {
    const owner = new MirrorStateOwner(activeState(), store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    await bootstrapSynchronizer(synchronizer);
    await synchronizer.observePresent(PATH_A);
    runtime.now = 750;
    store.save.mockResolvedValueOnce({ kind: "saved" });
    store.save.mockResolvedValueOnce({ kind: "saved" });
    store.save.mockResolvedValueOnce({
      kind: "failed",
      reason: MIRROR_STATE_STORE_FAILURE.quotaOrStorageError,
    });
    await synchronizer.synchronizeReady();
    expect(owner.snapshot().persistenceAvailable).toBe(false);
    expect(owner.snapshot().state.paths[0]?.unresolvedMutation).not.toBeNull();
    expect(synchronizer.nextWakeAtMilliseconds()).toBeNull();

    await synchronizer.observePresent(PATH_B);
    await synchronizer.synchronizeReady();
    expect(remote.mutateNote).toHaveBeenCalledTimes(1);
    store.save.mockResolvedValue({ kind: "saved" });
    expect((await owner.verifyPersistence()).persistenceAvailable).toBe(true);
    const intent = required(
      owner.snapshot().state.paths[0]?.unresolvedMutation?.intent,
    );
    remote.inspectNote.mockResolvedValueOnce({
      kind: "success",
      value: liveState(PATH_A, REVISION_A, HASH_A, intent.operationId),
    });
    await synchronizer.synchronizeReady();
    expect(owner.snapshot().state.paths[0]?.unresolvedMutation).toBeNull();
  });
});

function createInactiveSynchronizer(): MirrorSynchronizer {
  return new MirrorSynchronizer(
    local,
    remote,
    new MirrorStateOwner(activeState(), store),
    runtime,
  );
}

async function createSynchronizer(): Promise<MirrorSynchronizer> {
  const synchronizer = createInactiveSynchronizer();
  await bootstrapSynchronizer(synchronizer);
  return synchronizer;
}

async function bootstrapSynchronizer(
  synchronizer: MirrorSynchronizer,
): Promise<void> {
  local.list.mockResolvedValueOnce(listResult([]));
  await expect(synchronizer.bootstrap()).resolves.toMatchObject({
    kind: "complete",
  });
}

function activeState(): MirrorDeviceState {
  return {
    deviceId: DEVICE,
    lifecycle: {
      kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
      associationId: ASSOCIATION,
      origin: "https://bridge.example",
    },
    globalBlockReason: null,
    paths: [],
    stagedHandoff: null,
  };
}

function stateWithLiveAcknowledgement(
  hash: ContentSha256,
  revision: typeof REVISION_A,
): MirrorDeviceState {
  return {
    ...activeState(),
    paths: [
      {
        path: PATH_A,
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
  };
}

function stateWithMatchingUnresolved(
  action: typeof MUTATION_ACTION.update | typeof MUTATION_ACTION.recreate,
): MirrorDeviceState {
  return {
    ...activeState(),
    paths: [
      {
        path: PATH_A,
        acknowledgement:
          action === MUTATION_ACTION.update
            ? {
                kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
                revision: REVISION_A,
                contentSha256: HASH_A,
              }
            : {
                kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
                revision: REVISION_A,
                recoveryId: OPERATION_B,
              },
        unresolvedMutation: {
          phase: "evidence-required",
          intent: {
            action,
            associationId: ASSOCIATION,
            writerId: DEVICE,
            operationId: OPERATION_A,
            path: PATH_A,
            precondition: { kind: "matching-revision", revision: REVISION_A },
            contentSha256: HASH_A,
            mutationAttempts: MAX_MUTATION_ATTEMPTS,
            evidenceAttempts: 0,
          },
        },
        desired: {
          kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent,
          observationGeneration: 1,
        },
        blockedReason: null,
      },
    ],
  };
}

function stateWithUnresolved(
  mutationAttempts: number,
  evidenceAttempts: number,
): MirrorDeviceState {
  return {
    ...activeState(),
    paths: [
      {
        path: PATH_A,
        acknowledgement: { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
        unresolvedMutation: {
          phase: "evidence-required",
          intent: {
            action: MUTATION_ACTION.create,
            associationId: ASSOCIATION,
            writerId: DEVICE,
            operationId: OPERATION_A,
            path: PATH_A,
            precondition: { kind: "absent" },
            contentSha256: HASH_A,
            mutationAttempts,
            evidenceAttempts,
          },
        },
        desired: {
          kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent,
          observationGeneration: 1,
        },
        blockedReason: null,
      },
    ],
  };
}

function listResult(paths: readonly (typeof PATH_A)[]): LocalListResult {
  return {
    kind: LocalInspectionKind.ok,
    entries: paths.map((path) => ({ path, sizeBytes: 1 })),
    skipped: SKIPPED,
  };
}

function readResult(content: string): LocalReadResult {
  return { kind: LocalInspectionKind.ok, content, sizeBytes: 1 };
}

function confirmed(
  request: ConditionalMutationRequest,
  revision: typeof REVISION_A,
): RemoteBridgeMutationResult<MutationAcknowledgement> {
  switch (request.action) {
    case MUTATION_ACTION.tombstone:
      return {
        kind: "confirmed",
        confirmed: {
          path: request.path,
          revision,
          receipt: {
            action: request.action,
            associationId: request.associationId,
            operationId: request.operationId,
            precondition: request.precondition,
          },
        },
      };
    case MUTATION_ACTION.create:
      return {
        kind: "confirmed",
        confirmed: {
          path: request.path,
          revision,
          receipt: {
            action: request.action,
            associationId: request.associationId,
            operationId: request.operationId,
            precondition: request.precondition,
            contentSha256: request.content === "A" ? HASH_A : HASH_B,
          },
        },
      };
    case MUTATION_ACTION.update:
    case MUTATION_ACTION.recreate:
      return {
        kind: "confirmed",
        confirmed: {
          path: request.path,
          revision,
          receipt: {
            action: request.action,
            associationId: request.associationId,
            operationId: request.operationId,
            precondition: request.precondition,
            contentSha256: request.content === "A" ? HASH_A : HASH_B,
          },
        },
      };
  }
}

function liveState(
  path: typeof PATH_A,
  revision: typeof REVISION_A,
  hash: ContentSha256,
  operationId: MirrorOperationId,
): CurrentNoteState {
  return {
    kind: "live",
    path,
    revision,
    contentSha256: hash,
    receipt: {
      action: MUTATION_ACTION.create,
      associationId: ASSOCIATION,
      operationId,
      precondition: { kind: "absent" },
      contentSha256: hash,
    },
  };
}

function divergentState(
  kind: "absent" | "legacy" | "tombstone",
): CurrentNoteState {
  if (kind === "absent" || kind === "legacy") return { kind, path: PATH_A };
  return {
    kind,
    path: PATH_A,
    revision: REVISION_B,
    deletedRevision: REVISION_A,
    recoveryId: OPERATION_B,
    receipt: {
      action: MUTATION_ACTION.tombstone,
      associationId: ASSOCIATION,
      operationId: OPERATION_B,
      precondition: { kind: "matching-revision", revision: REVISION_A },
    },
  };
}

function createCapacityPaths(count: number): readonly (typeof PATH_A)[] {
  return Array.from({ length: count }, (_, index) =>
    required(normalizeNotePath(`notes/capacity-${index}.md`)),
  );
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid fixture value.");
  return value;
}
