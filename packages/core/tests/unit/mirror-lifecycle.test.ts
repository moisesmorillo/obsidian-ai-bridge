import {
  destructiveEvidenceIdentity,
  persistTombstoneIntent,
} from "@core/mirror/mirror-lifecycle-state";
import {
  type ApplicationRevision,
  type ConditionalMutationRequest,
  type ContentSha256,
  type CurrentNoteState,
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  isNormalizedNotePath,
  LocalInspectionKind,
  MAX_MIRROR_TRACKED_PATHS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DELETION_GRACE_MILLISECONDS,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_MUTATION_PHASE,
  MIRROR_RENAME_PHASE,
  MIRROR_STATE_STORE_FAILURE,
  type MirrorDeviceState,
  type MirrorOperationId,
  type MirrorPathState,
  MirrorStateOwner,
  type MirrorStateSaveResult,
  type MirrorStateStore,
  MirrorSynchronizer,
  type MirrorSynchronizerRuntime,
  MUTATION_ACTION,
  type MutationAcknowledgement,
  type NotePath,
  normalizeNotePath,
  RECOVERY_SNAPSHOT_STATE_KIND,
  type ReadOnlyLocalVault,
  type RecoverySnapshotState,
  type RemoteBridge,
} from "@obsidian-ai-bridge/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DEVICE = required(
  createMirrorWriterId("11111111-1111-4111-8111-111111111111"),
);
const ASSOCIATION = required(
  createMirrorAssociationId("22222222-2222-4222-8222-222222222222"),
);
const REVISION_A = revision(1);
const HASH_A = required(createContentSha256("aa".repeat(32)));
const HASH_B = required(createContentSha256("bb".repeat(32)));
const PATH_A = path("notes/a.md");
const PATH_B = path("notes/b.md");
const PATH_C = path("notes/c.md");
const PATH_BOUNDARY = path("notes-archive/other.md");
const SKIPPED = {
  unsupported_file: 0,
  excluded_location: 0,
  invalid_path: 0,
  oversized: 0,
};

class LifecycleStore implements MirrorStateStore {
  readonly states: MirrorDeviceState[] = [];
  failNext = false;

  async save(state: MirrorDeviceState): Promise<MirrorStateSaveResult> {
    if (this.failNext) {
      this.failNext = false;
      return {
        kind: "failed",
        reason: MIRROR_STATE_STORE_FAILURE.quotaOrStorageError,
      };
    }
    this.states.push(state);
    return { kind: "saved" };
  }
}

class LifecycleLocal implements ReadOnlyLocalVault {
  listed: NotePath[] = [PATH_A];
  readonly contents = new Map<NotePath, string>([[PATH_A, "A"]]);
  readonly list = vi.fn<ReadOnlyLocalVault["list"]>(async () => ({
    kind: LocalInspectionKind.ok,
    entries: this.listed.map((entryPath) => ({
      path: entryPath,
      sizeBytes: this.contents.get(entryPath)?.length ?? 0,
    })),
    skipped: SKIPPED,
  }));
  readonly read = vi.fn<ReadOnlyLocalVault["read"]>(async (notePath) => {
    const content = this.contents.get(notePath);
    return content === undefined
      ? {
          kind: "failed" as const,
          reason: "missing_file" as const,
        }
      : {
          kind: "ok" as const,
          content,
          sizeBytes: content.length,
        };
  });
}

class LifecycleRuntime implements MirrorSynchronizerRuntime {
  now = 0;
  operationSequence = 1;

  nowMilliseconds(): number {
    return this.now;
  }

  async hashContent(content: string): Promise<ContentSha256> {
    return content === "A" ? HASH_A : HASH_B;
  }

  createOperationId(): MirrorOperationId {
    const value = required(
      createMirrorOperationId(
        `30000000-0000-4000-8000-${String(this.operationSequence).padStart(12, "0")}`,
      ),
    );
    this.operationSequence += 1;
    return value;
  }
}

class LifecycleRemote implements RemoteBridge {
  revisionSequence = 10;
  readonly states = new Map<NotePath, CurrentNoteState>();
  readonly recoveries = new Map<MirrorOperationId, RecoverySnapshotState>();
  readonly describe = vi.fn<RemoteBridge["describe"]>(async () => ({
    kind: "success",
    value: {
      protocol: "obsidian-ai-bridge-mirror-v2",
      associationId: ASSOCIATION,
      writerId: DEVICE,
      maxNoteSizeBytes: 1024 * 1024,
      maxPageSize: 50,
      recoveryRetentionSeconds: 2_592_000,
    },
  }));
  readonly listNotes = vi.fn<RemoteBridge["listNotes"]>(async () => ({
    kind: "success",
    value: { notes: [], nextCursor: null },
  }));
  readonly readNote = vi.fn<RemoteBridge["readNote"]>();
  readonly inspectNote = vi.fn<RemoteBridge["inspectNote"]>(
    async (notePath) => ({
      kind: "success",
      value:
        this.states.get(notePath) ??
        ({ kind: "absent", path: notePath } satisfies CurrentNoteState),
    }),
  );
  readonly mutateNote = vi.fn<RemoteBridge["mutateNote"]>(async (request) => {
    const acknowledgement = this.confirm(request);
    return { kind: "confirmed", confirmed: acknowledgement };
  });
  readonly listRecovery = vi.fn<RemoteBridge["listRecovery"]>();
  readonly inspectRecovery = vi.fn<RemoteBridge["inspectRecovery"]>(
    async (id) => ({
      kind: "success",
      value: this.recoveries.get(id) ?? null,
    }),
  );
  readonly readRecoveryContent = vi.fn<RemoteBridge["readRecoveryContent"]>();
  readonly sealRecovery = vi.fn<RemoteBridge["sealRecovery"]>();
  readonly purgeRecovery = vi.fn<RemoteBridge["purgeRecovery"]>();

  confirm(request: ConditionalMutationRequest): MutationAcknowledgement {
    const nextRevision = revision(this.revisionSequence);
    this.revisionSequence += 1;
    if (request.action === MUTATION_ACTION.tombstone) {
      const receipt = {
        action: request.action,
        associationId: request.associationId,
        operationId: request.operationId,
        precondition: request.precondition,
      };
      this.states.set(request.path, {
        kind: "tombstone",
        path: request.path,
        revision: nextRevision,
        deletedRevision: request.precondition.revision,
        recoveryId: request.operationId,
        receipt,
      });
      this.recoveries.set(request.operationId, {
        kind: RECOVERY_SNAPSHOT_STATE_KIND.sealed,
        id: request.operationId,
        associationId: request.associationId,
        path: request.path,
        revision: revision(this.revisionSequence + 100),
        sourceRevision: request.precondition.revision,
        contentSha256: HASH_A,
        recoverUntil: "2030-01-01T00:00:00.000Z",
      });
      return { path: request.path, revision: nextRevision, receipt };
    }
    const contentSha256 = request.content === "A" ? HASH_A : HASH_B;
    if (request.action === MUTATION_ACTION.create) {
      const receipt = {
        action: request.action,
        associationId: request.associationId,
        operationId: request.operationId,
        precondition: request.precondition,
        contentSha256,
      };
      this.states.set(request.path, {
        kind: "live",
        path: request.path,
        revision: nextRevision,
        contentSha256,
        receipt,
      });
      return { path: request.path, revision: nextRevision, receipt };
    }
    const receipt = {
      action: request.action,
      associationId: request.associationId,
      operationId: request.operationId,
      precondition: request.precondition,
      contentSha256,
    };
    this.states.set(request.path, {
      kind: "live",
      path: request.path,
      revision: nextRevision,
      contentSha256,
      receipt,
    });
    return { path: request.path, revision: nextRevision, receipt };
  }
}

let local: LifecycleLocal;
let remote: LifecycleRemote;
let runtime: LifecycleRuntime;
let store: LifecycleStore;

beforeEach(() => {
  local = new LifecycleLocal();
  remote = new LifecycleRemote();
  runtime = new LifecycleRuntime();
  store = new LifecycleStore();
  remote.states.set(PATH_A, liveState(PATH_A, REVISION_A, HASH_A));
});

describe("runtime delete authority and grace", () => {
  it("accepts associated post-bootstrap runtime events regardless of external origin", async () => {
    const { owner, synchronizer } = await activeSynchronizer();

    await expect(synchronizer.observeDelete(PATH_A)).resolves.toEqual({
      kind: "accepted",
    });
    expect(owner.snapshot().state.paths[0]?.desired).toMatchObject({
      kind: MIRROR_DESIRED_STATE_KIND.runtimeDelete,
      expectedRevision: REVISION_A,
      graceDeadlineMilliseconds: MIRROR_DELETION_GRACE_MILLISECONDS,
    });
    expect(remote.mutateNote).not.toHaveBeenCalled();
    expect(synchronizer.nextWakeAtMilliseconds()).toBe(
      MIRROR_DELETION_GRACE_MILLISECONDS,
    );
    await expect(synchronizer.observeDelete(PATH_A)).resolves.toEqual({
      kind: "accepted",
    });
  });

  it("refuses pre-bootstrap, startup, inventory, unassociated, and first-create absence", async () => {
    const owner = new MirrorStateOwner(activeState(), store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    await expect(synchronizer.observeDelete(PATH_A)).resolves.toEqual({
      kind: "inactive",
    });
    await expect(synchronizer.observeRename(PATH_A, PATH_B)).resolves.toEqual({
      kind: "inactive",
    });
    await expect(
      synchronizer.observeRenameOutOfEligibility(PATH_A),
    ).resolves.toEqual({ kind: "inactive" });
    await expect(
      synchronizer.observeFolderRename("notes", "archive"),
    ).resolves.toEqual({ planned: 0, deferred: 0, knownDescendants: 0 });

    const unassociated = new MirrorStateOwner(
      activeState([
        pathState(PATH_A, { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated }),
      ]),
      new LifecycleStore(),
    );
    remote.states.set(PATH_A, { kind: "absent", path: PATH_A });
    const unassociatedSync = new MirrorSynchronizer(
      local,
      remote,
      unassociated,
      runtime,
    );
    await unassociatedSync.bootstrap();
    await expect(unassociatedSync.observeDelete(PATH_A)).resolves.toEqual({
      kind: "no-authority",
    });

    local.listed = [];
    const startupOwner = new MirrorStateOwner(
      activeState(),
      new LifecycleStore(),
    );
    const startup = new MirrorSynchronizer(
      local,
      remote,
      startupOwner,
      runtime,
    );
    await startup.bootstrap();
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;
    await startup.synchronizeReady();
    expect(remote.mutateNote).not.toHaveBeenCalled();
    expect(startupOwner.snapshot().state.paths[0]?.acknowledgement.kind).toBe(
      MIRROR_ACKNOWLEDGEMENT_KIND.live,
    );
  });

  it("loses authority safely when evidence persistence fails and cannot rebuild it after restart", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    store.failNext = true;
    local.contents.delete(PATH_A);

    await expect(synchronizer.observeDelete(PATH_A)).resolves.toEqual({
      kind: "persistence-failed",
    });
    expect(owner.snapshot().state.paths[0]?.desired.kind).not.toBe(
      MIRROR_DESIRED_STATE_KIND.runtimeDelete,
    );
    await synchronizer.synchronizeReady();
    expect(remote.mutateNote).not.toHaveBeenCalled();

    const restartStore = new LifecycleStore();
    const restartOwner = new MirrorStateOwner(
      owner.snapshot().state,
      restartStore,
    );
    local.listed = [];
    const restarted = new MirrorSynchronizer(
      local,
      remote,
      restartOwner,
      runtime,
    );
    await restarted.bootstrap();
    await restarted.synchronizeReady();
    expect(remote.mutateNote).not.toHaveBeenCalled();
  });

  it("rearms a full grace period when a persisted deadline crosses restart clocks", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    runtime.now = 100_000;
    local.contents.delete(PATH_A);
    local.listed = [];
    await synchronizer.observeDelete(PATH_A);

    runtime.now = 0;
    const restarted = new MirrorSynchronizer(local, remote, owner, runtime);
    await restarted.bootstrap();
    expect(restarted.nextWakeAtMilliseconds()).toBe(
      MIRROR_DELETION_GRACE_MILLISECONDS,
    );
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS - 1;
    await restarted.synchronizeReady();
    expect(remote.mutateNote).not.toHaveBeenCalled();

    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;
    await restarted.synchronizeReady();
    expect(remote.mutateNote.mock.calls.at(-1)?.[0].action).toBe(
      MUTATION_ACTION.tombstone,
    );
  });

  it("cancels deletion when the exact path is recreated during grace", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    await synchronizer.observeDelete(PATH_A);
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;
    await synchronizer.synchronizeReady();

    expect(
      remote.mutateNote.mock.calls.some(
        ([request]) => request.action === MUTATION_ACTION.tombstone,
      ),
    ).toBe(false);
    expect(owner.snapshot().state.paths[0]?.desired.kind).not.toBe(
      MIRROR_DESIRED_STATE_KIND.runtimeDelete,
    );
  });

  it("retains authority without mutation when exact absence cannot be confirmed", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    await synchronizer.observeDelete(PATH_A);
    local.read.mockResolvedValueOnce({
      kind: LocalInspectionKind.failed,
      reason: "changed_during_read",
    });
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;

    await synchronizer.synchronizeReady();

    expect(remote.mutateNote).not.toHaveBeenCalled();
    expect(owner.snapshot().state.paths[0]?.desired.kind).toBe(
      MIRROR_DESIRED_STATE_KIND.runtimeDelete,
    );
    expect(synchronizer.outcome(PATH_A)?.kind).toBe("local-unavailable");
  });

  it("retains authority on remote inspection failure without tombstoning", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    local.contents.delete(PATH_A);
    await synchronizer.observeDelete(PATH_A);
    remote.inspectNote.mockResolvedValueOnce({
      kind: "failure",
      failure: "network-unavailable",
    });
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;

    await synchronizer.synchronizeReady();

    expect(remote.mutateNote).not.toHaveBeenCalled();
    expect(owner.snapshot().state.paths[0]?.desired.kind).toBe(
      MIRROR_DESIRED_STATE_KIND.runtimeDelete,
    );
    expect(synchronizer.outcome(PATH_A)).toMatchObject({
      kind: "remote-failure",
      failure: "network-unavailable",
    });
  });

  it("waits five seconds, confirms exact missing-file evidence, then tombstones", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    local.contents.delete(PATH_A);
    await synchronizer.observeDelete(PATH_A);

    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS - 1;
    await synchronizer.synchronizeReady();
    expect(remote.mutateNote).not.toHaveBeenCalled();

    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;
    await synchronizer.synchronizeReady();
    expect(remote.mutateNote).toHaveBeenCalledTimes(1);
    expect(remote.mutateNote.mock.calls[0]?.[0]).toMatchObject({
      action: MUTATION_ACTION.tombstone,
      precondition: { revision: REVISION_A },
    });
    expect(owner.snapshot().state.paths[0]?.acknowledgement.kind).toBe(
      MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
    );
    expect(synchronizer.outcome(PATH_A)).toMatchObject({
      kind: "deletion-acknowledged",
      recoveryStatus: RECOVERY_SNAPSHOT_STATE_KIND.sealed,
    });
  });
});

describe("delete mutation races and recreation", () => {
  it("preserves a source when its persisted update was never dispatched", async () => {
    const updateOperation = operation(79);
    const { owner, synchronizer } = await activeSynchronizer();
    await owner.transition((state) => ({
      ...state,
      paths: state.paths.map((entry) => ({
        ...entry,
        unresolvedMutation: {
          intent: {
            action: MUTATION_ACTION.update,
            associationId: ASSOCIATION,
            writerId: DEVICE,
            operationId: updateOperation,
            path: PATH_A,
            precondition: { kind: "matching-revision", revision: REVISION_A },
            contentSha256: HASH_B,
            mutationAttempts: 0,
            evidenceAttempts: 0,
          },
          phase: MIRROR_MUTATION_PHASE.intentPersisted,
        },
      })),
    }));
    local.contents.delete(PATH_A);
    await synchronizer.observeDelete(PATH_A);
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;

    await synchronizer.synchronizeReady();

    expect(remote.mutateNote).not.toHaveBeenCalled();
    expect(owner.snapshot().state.paths[0]?.acknowledgement.kind).toBe(
      MIRROR_ACKNOWLEDGEMENT_KIND.live,
    );
    expect(owner.snapshot().state.paths[0]?.blockedReason).toBe(
      "unresolved-effect",
    );
  });

  it("settles exact own update evidence and tombstones from the resulting ACK", async () => {
    const updateOperation = operation(80);
    const updateRevision = revision(80);
    const pending: MirrorPathState = {
      ...pathState(PATH_A, {
        kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
        revision: REVISION_A,
        contentSha256: HASH_A,
      }),
      unresolvedMutation: {
        intent: {
          action: MUTATION_ACTION.update,
          associationId: ASSOCIATION,
          writerId: DEVICE,
          operationId: updateOperation,
          path: PATH_A,
          precondition: { kind: "matching-revision", revision: REVISION_A },
          contentSha256: HASH_B,
          mutationAttempts: 1,
          evidenceAttempts: 0,
        },
        phase: MIRROR_MUTATION_PHASE.evidenceRequired,
      },
    };
    const owner = new MirrorStateOwner(activeState([pending]), store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    remote.states.set(PATH_A, {
      kind: "live",
      path: PATH_A,
      revision: updateRevision,
      contentSha256: HASH_B,
      receipt: {
        action: MUTATION_ACTION.update,
        associationId: ASSOCIATION,
        operationId: updateOperation,
        precondition: { kind: "matching-revision", revision: REVISION_A },
        contentSha256: HASH_B,
      },
    });
    await synchronizer.bootstrap();
    local.contents.delete(PATH_A);
    await synchronizer.observeDelete(PATH_A);
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;

    await synchronizer.synchronizeReady();

    const tombstone = remote.mutateNote.mock.calls.find(
      ([request]) => request.action === MUTATION_ACTION.tombstone,
    )?.[0];
    expect(tombstone).toMatchObject({
      precondition: { revision: updateRevision },
    });
  });

  it("blocks when a remote competitor replaces the acknowledged generation", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    local.contents.delete(PATH_A);
    await synchronizer.observeDelete(PATH_A);
    remote.states.set(PATH_A, liveState(PATH_A, revision(99), HASH_B));
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;

    await synchronizer.synchronizeReady();

    expect(remote.mutateNote).not.toHaveBeenCalled();
    expect(owner.snapshot().state.paths[0]?.blockedReason).toBe("diverged");
  });

  it("recovers an ambiguous tombstone only from its exact own receipt", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    local.contents.delete(PATH_A);
    remote.mutateNote.mockImplementationOnce(async (request) => {
      remote.confirm(request);
      return { kind: "failure", failure: "timed-out", effect: "unknown" };
    });
    await synchronizer.observeDelete(PATH_A);
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;

    await synchronizer.synchronizeReady();
    expect(
      owner.snapshot().state.paths[0]?.unresolvedMutation?.intent.action,
    ).toBe(MUTATION_ACTION.tombstone);
    await synchronizer.synchronizeReady();

    expect(owner.snapshot().state.paths[0]?.acknowledgement.kind).toBe(
      MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
    );
    expect(remote.mutateNote).toHaveBeenCalledTimes(1);
  });

  it("keeps a confirmed deletion when retention inspection is unavailable", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    local.contents.delete(PATH_A);
    remote.inspectRecovery.mockResolvedValueOnce({
      kind: "failure",
      failure: "network-unavailable",
    });
    await synchronizer.observeDelete(PATH_A);
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;

    await synchronizer.synchronizeReady();

    expect(owner.snapshot().state.paths[0]?.acknowledgement.kind).toBe(
      MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
    );
    expect(synchronizer.outcome(PATH_A)).toMatchObject({
      kind: "deletion-acknowledged",
      recoveryStatus: "unknown",
    });
  });

  it("keeps a confirmed deletion distinct from prepared over-retained recovery", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    local.contents.delete(PATH_A);
    remote.mutateNote.mockImplementationOnce(async (request) => {
      const acknowledgement = remote.confirm(request);
      if (request.action === MUTATION_ACTION.tombstone) {
        remote.recoveries.set(request.operationId, {
          kind: RECOVERY_SNAPSHOT_STATE_KIND.prepared,
          id: request.operationId,
          associationId: ASSOCIATION,
          path: request.path,
          revision: revision(98),
          sourceRevision: request.precondition.revision,
          contentSha256: HASH_A,
        });
      }
      return { kind: "confirmed", confirmed: acknowledgement };
    });
    await synchronizer.observeDelete(PATH_A);
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;

    await synchronizer.synchronizeReady();

    expect(owner.snapshot().state.paths[0]?.acknowledgement.kind).toBe(
      MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
    );
    expect(synchronizer.outcome(PATH_A)).toMatchObject({
      kind: "deletion-acknowledged",
      recoveryStatus: RECOVERY_SNAPSHOT_STATE_KIND.prepared,
    });
    expect(remote.purgeRecovery).not.toHaveBeenCalled();
  });

  it("recreates only from an exactly verified acknowledged tombstone and preserves recovery", async () => {
    const recoveryId = operation(90);
    const tombstoneRevision = revision(90);
    const tombstoneState = pathState(PATH_A, {
      kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
      revision: tombstoneRevision,
      recoveryId,
    });
    const owner = new MirrorStateOwner(activeState([tombstoneState]), store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    remote.states.set(PATH_A, {
      kind: "tombstone",
      path: PATH_A,
      revision: tombstoneRevision,
      deletedRevision: REVISION_A,
      recoveryId,
      receipt: {
        action: MUTATION_ACTION.tombstone,
        associationId: ASSOCIATION,
        operationId: recoveryId,
        precondition: { kind: "matching-revision", revision: REVISION_A },
      },
    });
    remote.recoveries.set(recoveryId, {
      kind: RECOVERY_SNAPSHOT_STATE_KIND.prepared,
      id: recoveryId,
      associationId: ASSOCIATION,
      path: PATH_A,
      revision: revision(91),
      sourceRevision: REVISION_A,
      contentSha256: HASH_A,
    });
    await synchronizer.bootstrap();
    await synchronizer.observePresent(PATH_A);
    runtime.now = 750;

    await synchronizer.synchronizeReady();

    expect(remote.mutateNote.mock.calls.at(-1)?.[0]).toMatchObject({
      action: MUTATION_ACTION.recreate,
      precondition: { revision: tombstoneRevision },
    });
    expect(remote.recoveries.get(recoveryId)?.kind).toBe(
      RECOVERY_SNAPSHOT_STATE_KIND.prepared,
    );
  });

  it("blocks recreation against a mismatched tombstone or remote live competitor", async () => {
    for (const competitor of [
      liveState(PATH_A, revision(92), HASH_B),
      {
        kind: "tombstone" as const,
        path: PATH_A,
        revision: revision(93),
        deletedRevision: REVISION_A,
        recoveryId: operation(93),
        receipt: {
          action: MUTATION_ACTION.tombstone,
          associationId: ASSOCIATION,
          operationId: operation(93),
          precondition: {
            kind: "matching-revision" as const,
            revision: REVISION_A,
          },
        },
      },
    ]) {
      const recoveryId = operation(94);
      const owner = new MirrorStateOwner(
        activeState([
          pathState(PATH_A, {
            kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
            revision: revision(94),
            recoveryId,
          }),
        ]),
        new LifecycleStore(),
      );
      remote.states.set(PATH_A, competitor);
      const synchronizer = new MirrorSynchronizer(
        local,
        remote,
        owner,
        runtime,
      );
      await synchronizer.bootstrap();
      await synchronizer.observePresent(PATH_A);
      runtime.now += 750;
      await synchronizer.synchronizeReady();
      expect(owner.snapshot().state.paths[0]?.blockedReason).toBe("diverged");
    }
  });
});

describe("destination-first runtime rename", () => {
  it("retains source work when a pending predecessor cannot yet settle", async () => {
    const updateOperation = operation(82);
    const source: MirrorPathState = {
      ...pathState(PATH_A, liveAcknowledgement(REVISION_A, HASH_A)),
      unresolvedMutation: {
        intent: {
          action: MUTATION_ACTION.update,
          associationId: ASSOCIATION,
          writerId: DEVICE,
          operationId: updateOperation,
          path: PATH_A,
          precondition: { kind: "matching-revision", revision: REVISION_A },
          contentSha256: HASH_B,
          mutationAttempts: 1,
          evidenceAttempts: 0,
        },
        phase: MIRROR_MUTATION_PHASE.evidenceRequired,
      },
    };
    const owner = new MirrorStateOwner(activeState([source]), store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    await synchronizer.bootstrap();
    local.contents.delete(PATH_A);
    local.contents.set(PATH_B, "B");
    await synchronizer.observeRename(PATH_A, PATH_B);
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;

    await synchronizer.synchronizeReady();

    expect(owner.snapshot().state.paths[0]?.unresolvedMutation).not.toBeNull();
    expect(synchronizer.outcome(PATH_A)?.kind).toBe("rename-deferred");
    expect(remote.mutateNote).not.toHaveBeenCalled();
  });

  it("invalidates cleanup when the persisted destination dependency drifts", async () => {
    const destinationRevision = revision(83);
    const source: MirrorPathState = {
      ...pathState(PATH_A, liveAcknowledgement(REVISION_A, HASH_A)),
      desired: {
        kind: MIRROR_DESIRED_STATE_KIND.renameDeferred,
        observationGeneration: 1,
        renameId: operation(83),
        associationId: ASSOCIATION,
        sourcePath: PATH_A,
        destinationPath: PATH_B,
        sourceExpectedRevision: REVISION_A,
        destinationObservationGeneration: 2,
        destinationAcknowledgedRevision: revision(84),
        graceDeadlineMilliseconds: MIRROR_DELETION_GRACE_MILLISECONDS,
        phase: MIRROR_RENAME_PHASE.sourceCleanupRequired,
      },
    };
    const destination = pathState(
      PATH_B,
      liveAcknowledgement(destinationRevision, HASH_B),
    );
    const owner = new MirrorStateOwner(
      activeState([source, destination]),
      store,
    );
    local.listed = [];
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    await synchronizer.bootstrap();
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;

    await synchronizer.synchronizeReady();

    expect(owner.snapshot().state.paths[0]?.desired).toMatchObject({
      phase: MIRROR_RENAME_PHASE.invalidated,
    });
    expect(owner.snapshot().state.paths[0]?.blockedReason).toBe(
      "rename-deferred",
    );
    expect(remote.mutateNote).not.toHaveBeenCalled();
  });

  it("reports persistence failures without dispatching either path", async () => {
    const { synchronizer } = await activeSynchronizer();
    store.failNext = true;

    await expect(synchronizer.observeRename(PATH_A, PATH_B)).resolves.toEqual({
      kind: "persistence-failed",
    });
    expect(remote.mutateNote).not.toHaveBeenCalled();
  });
  it("does not clean the source when destination ACK persistence fails", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    local.contents.delete(PATH_A);
    local.contents.set(PATH_B, "B");
    await synchronizer.observeRename(PATH_A, PATH_B);
    remote.mutateNote.mockImplementationOnce(async (request) => {
      const acknowledgement = remote.confirm(request);
      store.failNext = true;
      return { kind: "confirmed", confirmed: acknowledgement };
    });
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;

    await synchronizer.synchronizeReady();

    expect(remote.mutateNote).toHaveBeenCalledTimes(1);
    expect(remote.mutateNote.mock.calls[0]?.[0].action).toBe(
      MUTATION_ACTION.create,
    );
    expect(
      owner.snapshot().state.paths.find((entry) => entry.path === PATH_A)
        ?.acknowledgement.kind,
    ).toBe(MIRROR_ACKNOWLEDGEMENT_KIND.live);
    expect(owner.snapshot().mutationAdmissionAllowed).toBe(false);
  });

  it("settles a pending source update before destination and cleanup", async () => {
    const updateOperation = operation(81);
    const updateRevision = revision(81);
    const source: MirrorPathState = {
      ...pathState(PATH_A, liveAcknowledgement(REVISION_A, HASH_A)),
      unresolvedMutation: {
        intent: {
          action: MUTATION_ACTION.update,
          associationId: ASSOCIATION,
          writerId: DEVICE,
          operationId: updateOperation,
          path: PATH_A,
          precondition: { kind: "matching-revision", revision: REVISION_A },
          contentSha256: HASH_B,
          mutationAttempts: 1,
          evidenceAttempts: 0,
        },
        phase: MIRROR_MUTATION_PHASE.evidenceRequired,
      },
    };
    const owner = new MirrorStateOwner(activeState([source]), store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    remote.states.set(PATH_A, {
      kind: "live",
      path: PATH_A,
      revision: updateRevision,
      contentSha256: HASH_B,
      receipt: {
        action: MUTATION_ACTION.update,
        associationId: ASSOCIATION,
        operationId: updateOperation,
        precondition: { kind: "matching-revision", revision: REVISION_A },
        contentSha256: HASH_B,
      },
    });
    await synchronizer.bootstrap();
    local.contents.delete(PATH_A);
    local.contents.set(PATH_B, "B");
    await synchronizer.observeRename(PATH_A, PATH_B);
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;

    await synchronizer.synchronizeReady();

    expect(remote.mutateNote.mock.calls.at(-1)?.[0]).toMatchObject({
      action: MUTATION_ACTION.tombstone,
      precondition: { revision: updateRevision },
    });
  });

  it("prioritizes the rename reservation when its destination sorts first", async () => {
    const sourceRevision = revision(80);
    const owner = new MirrorStateOwner(
      activeState([
        pathState(PATH_C, liveAcknowledgement(sourceRevision, HASH_A)),
      ]),
      store,
    );
    local.listed = [PATH_C];
    local.contents.clear();
    local.contents.set(PATH_C, "A");
    remote.states.set(PATH_C, liveState(PATH_C, sourceRevision, HASH_A));
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    await synchronizer.bootstrap();
    local.contents.delete(PATH_C);
    local.contents.set(PATH_B, "B");
    await synchronizer.observeRename(PATH_C, PATH_B);
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;

    await synchronizer.synchronizeReady();

    expect(
      remote.mutateNote.mock.calls.map(([request]) => request.action),
    ).toEqual([MUTATION_ACTION.create, MUTATION_ACTION.tombstone]);
  });

  it("cancels delete inspection when a newer recreation arrives", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    local.contents.delete(PATH_A);
    await synchronizer.observeDelete(PATH_A);
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;
    const inspection = Promise.withResolvers<CurrentNoteState>();
    remote.inspectNote.mockImplementationOnce(async () => ({
      kind: "success",
      value: await inspection.promise,
    }));

    const work = synchronizer.synchronizeReady();
    await vi.waitFor(() => expect(remote.inspectNote).toHaveBeenCalledTimes(1));
    local.contents.set(PATH_A, "B");
    await synchronizer.observePresent(PATH_A);
    inspection.resolve(liveState(PATH_A, REVISION_A, HASH_A));
    await work;

    const entry = owner
      .snapshot()
      .state.paths.find((candidate) => candidate.path === PATH_A);
    expect(entry?.desired.kind).toBe(MIRROR_DESIRED_STATE_KIND.dirtyPresent);
    expect(entry?.blockedReason).toBeNull();
    expect(remote.mutateNote).not.toHaveBeenCalled();

    runtime.now += 750;
    await synchronizer.synchronizeReady();
    expect(
      remote.mutateNote.mock.calls.map(([request]) => request.action),
    ).toEqual([MUTATION_ACTION.update]);
  });

  it("cancels an unsent tombstone when positive evidence supersedes it", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    local.contents.delete(PATH_A);
    await synchronizer.observeDelete(PATH_A);
    const entry = required(
      owner
        .snapshot()
        .state.paths.find((candidate) => candidate.path === PATH_A),
    );
    const evidenceId = required(destructiveEvidenceIdentity(entry));
    const prepared = await owner.transition((state) =>
      persistTombstoneIntent(
        state,
        PATH_A,
        evidenceId,
        runtime.createOperationId(),
      ),
    );
    expect(prepared.kind).toBe("committed");

    local.contents.set(PATH_A, "B");
    await synchronizer.observePresent(PATH_A);
    const superseded = owner
      .snapshot()
      .state.paths.find((candidate) => candidate.path === PATH_A);
    expect(superseded?.unresolvedMutation).toBeNull();
    expect(superseded?.desired.kind).toBe(
      MIRROR_DESIRED_STATE_KIND.dirtyPresent,
    );

    runtime.now = 750;
    await synchronizer.synchronizeReady();
    expect(
      remote.mutateNote.mock.calls.map(([request]) => request.action),
    ).toEqual([MUTATION_ACTION.update]);
  });

  it("preserves recreation while a dispatched tombstone is unresolved", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    local.contents.delete(PATH_A);
    await synchronizer.observeDelete(PATH_A);
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;
    const tombstoneResolution =
      Promise.withResolvers<MutationAcknowledgement>();
    remote.mutateNote.mockImplementationOnce(async () => ({
      kind: "confirmed",
      confirmed: await tombstoneResolution.promise,
    }));

    const work = synchronizer.synchronizeReady();
    await vi.waitFor(() => expect(remote.mutateNote).toHaveBeenCalledTimes(1));
    local.contents.set(PATH_A, "B");
    await synchronizer.observePresent(PATH_A);
    const request = required(remote.mutateNote.mock.calls[0]?.[0]);
    tombstoneResolution.resolve(remote.confirm(request));
    await work;

    const settled = owner
      .snapshot()
      .state.paths.find((candidate) => candidate.path === PATH_A);
    expect(settled?.acknowledgement.kind).toBe(
      MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
    );
    expect(settled?.unresolvedMutation).toBeNull();
    expect(settled?.desired.kind).toBe(MIRROR_DESIRED_STATE_KIND.dirtyPresent);

    runtime.now += 750;
    await synchronizer.synchronizeReady();
    expect(
      remote.mutateNote.mock.calls.map(([candidate]) => candidate.action),
    ).toEqual([MUTATION_ACTION.tombstone, MUTATION_ACTION.recreate]);
  });

  it("durably ACKs the destination before creating source cleanup intent", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    local.contents.delete(PATH_A);
    local.contents.set(PATH_B, "B");
    await synchronizer.observeRename(PATH_A, PATH_B);
    expect(synchronizer.nextWakeAtMilliseconds()).toBe(0);
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;

    await synchronizer.synchronizeReady();

    const actions = remote.mutateNote.mock.calls.map(
      ([request]) => request.action,
    );
    expect(actions).toEqual([
      MUTATION_ACTION.create,
      MUTATION_ACTION.tombstone,
    ]);
    const destinationAckSave = store.states.findIndex(
      (state) =>
        state.paths.find((entry) => entry.path === PATH_B)?.acknowledgement
          .kind === MIRROR_ACKNOWLEDGEMENT_KIND.live,
    );
    const sourceDeleteIntentSave = store.states.findIndex(
      (state) =>
        state.paths.find((entry) => entry.path === PATH_A)?.unresolvedMutation
          ?.intent.action === MUTATION_ACTION.tombstone,
    );
    expect(destinationAckSave).toBeGreaterThanOrEqual(0);
    expect(sourceDeleteIntentSave).toBeGreaterThan(destinationAckSave);
    expect(
      owner.snapshot().state.paths.find((entry) => entry.path === PATH_A)
        ?.acknowledgement.kind,
    ).toBe(MIRROR_ACKNOWLEDGEMENT_KIND.tombstone);
  });

  it("preserves source on destination collision or unknown destination effect", async () => {
    for (const mode of ["collision", "unknown"] as const) {
      const testStore = new LifecycleStore();
      const owner = new MirrorStateOwner(activeState(), testStore);
      const synchronizer = new MirrorSynchronizer(
        local,
        remote,
        owner,
        runtime,
      );
      await synchronizer.bootstrap();
      local.contents.delete(PATH_A);
      local.contents.set(PATH_B, "B");
      if (mode === "collision") {
        remote.states.set(PATH_B, liveState(PATH_B, revision(40), HASH_B));
      } else {
        remote.mutateNote.mockResolvedValueOnce({
          kind: "failure",
          failure: "timed-out",
          effect: "unknown",
        });
      }
      await synchronizer.observeRename(PATH_A, PATH_B);
      runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;
      await synchronizer.synchronizeReady();

      expect(
        remote.mutateNote.mock.calls.some(
          ([request]) => request.action === MUTATION_ACTION.tombstone,
        ),
      ).toBe(false);
      expect(
        owner.snapshot().state.paths.find((entry) => entry.path === PATH_A)
          ?.acknowledgement.kind,
      ).toBe(MIRROR_ACKNOWLEDGEMENT_KIND.live);
    }
  });

  it("resolves an unknown destination receipt before source cleanup", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    local.contents.delete(PATH_A);
    local.contents.set(PATH_B, "B");
    remote.mutateNote.mockImplementationOnce(async (request) => {
      remote.confirm(request);
      return { kind: "failure", failure: "timed-out", effect: "unknown" };
    });
    await synchronizer.observeRename(PATH_A, PATH_B);
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;

    await synchronizer.synchronizeReady();
    expect(
      owner.snapshot().state.paths.find((entry) => entry.path === PATH_A)
        ?.acknowledgement.kind,
    ).toBe(MIRROR_ACKNOWLEDGEMENT_KIND.live);
    await synchronizer.synchronizeReady();
    await synchronizer.synchronizeReady();

    expect(
      remote.mutateNote.mock.calls.map(([request]) => request.action),
    ).toEqual([MUTATION_ACTION.create, MUTATION_ACTION.tombstone]);
  });

  it("preserves source when remote source changes after destination ACK", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    local.contents.delete(PATH_A);
    local.contents.set(PATH_B, "B");
    const originalMutate = remote.mutateNote.getMockImplementation();
    remote.mutateNote.mockImplementation(async (request) => {
      const result = await required(originalMutate)(request);
      if (request.path === PATH_B) {
        remote.states.set(PATH_A, liveState(PATH_A, revision(55), HASH_B));
      }
      return result;
    });
    await synchronizer.observeRename(PATH_A, PATH_B);
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;

    await synchronizer.synchronizeReady();

    expect(
      owner.snapshot().state.paths.find((entry) => entry.path === PATH_A)
        ?.blockedReason,
    ).toBe("diverged");
    expect(
      remote.mutateNote.mock.calls.some(
        ([request]) => request.action === MUTATION_ACTION.tombstone,
      ),
    ).toBe(false);
  });

  it("invalidates cleanup when source is recreated during destination PUT", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    local.contents.delete(PATH_A);
    local.contents.set(PATH_B, "B");
    const destinationBarrier = Promise.withResolvers<MutationAcknowledgement>();
    remote.mutateNote.mockImplementationOnce(async () => ({
      kind: "confirmed",
      confirmed: await destinationBarrier.promise,
    }));
    await synchronizer.observeRename(PATH_A, PATH_B);
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;
    const work = synchronizer.synchronizeReady();
    await vi.waitFor(() => expect(remote.mutateNote).toHaveBeenCalledTimes(1));

    local.contents.set(PATH_A, "B");
    await synchronizer.observePresent(PATH_A);
    const request = required(remote.mutateNote.mock.calls[0]?.[0]);
    destinationBarrier.resolve(remote.confirm(request));
    await work;

    expect(
      remote.mutateNote.mock.calls.some(
        ([candidate]) => candidate.action === MUTATION_ACTION.tombstone,
      ),
    ).toBe(false);
    expect(
      owner.snapshot().state.paths.find((entry) => entry.path === PATH_A)
        ?.desired.kind,
    ).toBe(MIRROR_DESIRED_STATE_KIND.dirtyPresent);
    expect(
      owner.snapshot().state.paths.find((entry) => entry.path === PATH_A)
        ?.blockedReason,
    ).toBeNull();

    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS + 750;
    expect(synchronizer.nextWakeAtMilliseconds()).toBe(runtime.now);
    await synchronizer.synchronizeReady();
    expect(
      remote.mutateNote.mock.calls.map(([candidate]) => candidate.action),
    ).toEqual([MUTATION_ACTION.create, MUTATION_ACTION.update]);
  });

  it("invalidates stale cleanup on a chained second rename while destination PUT is pending", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    local.contents.delete(PATH_A);
    local.contents.set(PATH_B, "B");
    local.contents.set(PATH_C, "B");
    const destinationBarrier = Promise.withResolvers<MutationAcknowledgement>();
    remote.mutateNote.mockImplementationOnce(async () => ({
      kind: "confirmed",
      confirmed: await destinationBarrier.promise,
    }));
    await synchronizer.observeRename(PATH_A, PATH_B);
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;
    const work = synchronizer.synchronizeReady();
    await vi.waitFor(() => expect(remote.mutateNote).toHaveBeenCalledTimes(1));

    await synchronizer.observeRename(PATH_B, PATH_C);
    const request = required(remote.mutateNote.mock.calls[0]?.[0]);
    destinationBarrier.resolve(remote.confirm(request));
    await work;

    const source = owner
      .snapshot()
      .state.paths.find((entry) => entry.path === PATH_A);
    expect(source?.desired).toMatchObject({
      kind: MIRROR_DESIRED_STATE_KIND.renameDeferred,
      phase: MIRROR_RENAME_PHASE.invalidated,
    });
    expect(
      owner.snapshot().state.paths.some((entry) => entry.path === PATH_C),
    ).toBe(true);
    expect(
      remote.mutateNote.mock.calls.some(
        ([candidate]) => candidate.action === MUTATION_ACTION.tombstone,
      ),
    ).toBe(false);
  });

  it("preserves both materialized destinations across overlapping renames", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    local.contents.delete(PATH_A);
    local.contents.set(PATH_B, "B");
    local.contents.set(PATH_C, "B");
    await synchronizer.observeRename(PATH_A, PATH_B);
    await synchronizer.observeRename(PATH_A, PATH_C);
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;

    await synchronizer.synchronizeReady();
    await synchronizer.synchronizeReady();

    expect(
      owner.snapshot().state.paths.find((entry) => entry.path === PATH_B)
        ?.acknowledgement.kind,
    ).toBe(MIRROR_ACKNOWLEDGEMENT_KIND.live);
    expect(
      owner.snapshot().state.paths.find((entry) => entry.path === PATH_C)
        ?.acknowledgement.kind,
    ).toBe(MIRROR_ACKNOWLEDGEMENT_KIND.live);
    expect(
      remote.mutateNote.mock.calls.filter(
        ([request]) => request.action === MUTATION_ACTION.create,
      ),
    ).toHaveLength(2);
  });

  it("removes eligible sources moved out of eligibility without reading the destination", async () => {
    const { synchronizer } = await activeSynchronizer();
    local.contents.delete(PATH_A);
    await synchronizer.observeRenameOutOfEligibility(PATH_A);
    runtime.now = MIRROR_DELETION_GRACE_MILLISECONDS;

    await synchronizer.synchronizeReady();

    expect(local.read).toHaveBeenCalledWith(PATH_A);
    expect(local.read).toHaveBeenCalledTimes(1);
    expect(remote.mutateNote.mock.calls.at(-1)?.[0].action).toBe(
      MUTATION_ACTION.tombstone,
    );
  });

  it("treats excluded-to-eligible rename as positive discovery without source history", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    local.contents.set(PATH_B, "B");
    await synchronizer.observePresent(PATH_B);
    runtime.now = 750;

    await synchronizer.synchronizeReady();

    expect(remote.mutateNote.mock.calls.at(-1)?.[0]).toMatchObject({
      action: MUTATION_ACTION.create,
      path: PATH_B,
    });
    expect(
      owner.snapshot().state.paths.find((entry) => entry.path === PATH_B)
        ?.acknowledgement.kind,
    ).toBe(MIRROR_ACKNOWLEDGEMENT_KIND.live);
  });
});

describe("bounded observed folder rename expansion", () => {
  it("rejects invalid folder boundaries without touching durable state", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    const before = owner.snapshot().state;

    await expect(
      synchronizer.observeFolderRename("notes/", "archive"),
    ).resolves.toEqual({ planned: 0, deferred: 0, knownDescendants: 0 });
    expect(owner.snapshot().state).toEqual(before);
  });

  it("reports positive-only unassociated folder moves as deferred cleanup", async () => {
    const unassociatedPath = path("folder/unassociated.md");
    const owner = new MirrorStateOwner(
      activeState([
        pathState(unassociatedPath, {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated,
        }),
      ]),
      store,
    );
    local.listed = [unassociatedPath];
    local.contents.set(unassociatedPath, "A");
    remote.states.set(unassociatedPath, {
      kind: "absent",
      path: unassociatedPath,
    });
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    await synchronizer.bootstrap();

    await expect(
      synchronizer.observeFolderRename("folder", "archive"),
    ).resolves.toEqual({ planned: 0, deferred: 1, knownDescendants: 1 });
    expect(
      owner
        .snapshot()
        .state.paths.some(
          (entry) => entry.path === path("archive/unassociated.md"),
        ),
    ).toBe(true);
    await expect(
      synchronizer.observeRenameOutOfEligibility(unassociatedPath),
    ).resolves.toEqual({ kind: "no-authority" });
  });

  it("stops folder expansion after persistence becomes unavailable", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    store.failNext = true;

    await expect(
      synchronizer.observeFolderRename("notes", "archive"),
    ).resolves.toEqual({ planned: 0, deferred: 1, knownDescendants: 1 });
    expect(owner.snapshot().state.paths).toHaveLength(1);
  });

  it("fails positive observation closed when the state save is unavailable", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    store.failNext = true;

    await synchronizer.observePresent(PATH_B);

    expect(
      owner.snapshot().state.paths.some((entry) => entry.path === PATH_B),
    ).toBe(false);
  });
  it("expands known descendants only with path-boundary-safe matching", async () => {
    const initial = activeState([
      pathState(PATH_A, liveAcknowledgement(REVISION_A, HASH_A)),
      pathState(PATH_BOUNDARY, liveAcknowledgement(revision(2), HASH_A)),
    ]);
    local.listed = [PATH_A, PATH_BOUNDARY];
    remote.states.set(
      PATH_BOUNDARY,
      liveState(PATH_BOUNDARY, revision(2), HASH_A),
    );
    const owner = new MirrorStateOwner(initial, store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    await synchronizer.bootstrap();

    const result = await synchronizer.observeFolderRename("notes", "archive");

    expect(result).toEqual({ planned: 1, deferred: 0, knownDescendants: 1 });
    expect(
      owner
        .snapshot()
        .state.paths.some((entry) => entry.path === path("archive/a.md")),
    ).toBe(true);
    expect(
      owner.snapshot().state.paths.find((entry) => entry.path === PATH_BOUNDARY)
        ?.desired.kind,
    ).not.toBe(MIRROR_DESIRED_STATE_KIND.renameDeferred);
  });

  it("preserves literal local folder names without URI decoding", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    const expected = literalPath("archive%20raw/a.md");

    await synchronizer.observeFolderRename("notes", "archive%20raw");

    expect(
      owner.snapshot().state.paths.some((entry) => entry.path === expected),
    ).toBe(true);
    expect(
      owner
        .snapshot()
        .state.paths.some((entry) => entry.path === path("archive raw/a.md")),
    ).toBe(false);
  });

  it("coalesces duplicate folder events without duplicating destructive cleanup", async () => {
    const { owner, synchronizer } = await activeSynchronizer();
    const first = await synchronizer.observeFolderRename("notes", "archive");
    const desired = owner.snapshot().state.paths[0]?.desired;
    const second = await synchronizer.observeFolderRename("notes", "archive");

    expect(first.planned).toBe(1);
    expect(second.planned).toBe(1);
    expect(owner.snapshot().state.paths[0]?.desired).toEqual(desired);
  });

  it("reports bound exhaustion as deferred without adding an unbounded destination", async () => {
    const entries = Array.from(
      { length: MAX_MIRROR_TRACKED_PATHS },
      (_, index) =>
        pathState(
          path(`folder/note-${String(index).padStart(5, "0")}.md`),
          liveAcknowledgement(revision((index % 80) + 1), HASH_A),
        ),
    );
    const owner = new MirrorStateOwner(activeState(entries), store);
    const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
    // The phase gate is established by a bounded successful bootstrap over no new paths.
    local.listed = [];
    await synchronizer.bootstrap();

    await expect(
      synchronizer.observeRename(entries[0]?.path ?? PATH_A, PATH_B),
    ).resolves.toEqual({ kind: "capacity-exceeded" });
    const result = await synchronizer.observeFolderRename("folder", "archive");

    expect(result).toEqual({
      planned: 0,
      deferred: MAX_MIRROR_TRACKED_PATHS,
      knownDescendants: MAX_MIRROR_TRACKED_PATHS,
    });
    expect(owner.snapshot().state.paths).toHaveLength(MAX_MIRROR_TRACKED_PATHS);
  });
});

async function activeSynchronizer(): Promise<{
  owner: MirrorStateOwner;
  synchronizer: MirrorSynchronizer;
}> {
  const owner = new MirrorStateOwner(activeState(), store);
  const synchronizer = new MirrorSynchronizer(local, remote, owner, runtime);
  await synchronizer.bootstrap();
  return { owner, synchronizer };
}

function activeState(
  paths: readonly ReturnType<typeof pathState>[] = [
    pathState(PATH_A, liveAcknowledgement(REVISION_A, HASH_A)),
  ],
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
    reconciliationReviews: [],
    reconciliationOperations: [],
  };
}

function pathState(
  notePath: NotePath,
  acknowledgement: MirrorDeviceState["paths"][number]["acknowledgement"],
): MirrorDeviceState["paths"][number] {
  return {
    path: notePath,
    acknowledgement,
    unresolvedMutation: null,
    desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
    blockedReason: null,
  };
}

function liveAcknowledgement(
  liveRevision: ApplicationRevision,
  contentSha256: ContentSha256,
) {
  return {
    kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
    revision: liveRevision,
    contentSha256,
  } as const;
}

function liveState(
  notePath: NotePath,
  liveRevision: ApplicationRevision,
  contentSha256: ContentSha256,
): Extract<CurrentNoteState, { readonly kind: "live" }> {
  return {
    kind: "live",
    path: notePath,
    revision: liveRevision,
    contentSha256,
    receipt: {
      action: MUTATION_ACTION.update,
      associationId: ASSOCIATION,
      operationId: operation(70),
      precondition: { kind: "matching-revision", revision: revision(70) },
      contentSha256,
    },
  };
}

function literalPath(value: string): NotePath {
  if (!isNormalizedNotePath(value))
    throw new Error(`Invalid local path: ${value}`);
  return value;
}

function path(value: string): NotePath {
  return required(normalizeNotePath(value));
}

function revision(index: number): ApplicationRevision {
  return required(
    createApplicationRevision(
      `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    ),
  );
}

function operation(index: number): MirrorOperationId {
  return required(
    createMirrorOperationId(
      `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    ),
  );
}

function required<Value>(value: Value | null | undefined): Value {
  if (value === null || value === undefined) {
    throw new Error("Invalid lifecycle fixture value.");
  }
  return value;
}
