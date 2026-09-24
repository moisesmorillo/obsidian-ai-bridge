import {
  createApplicationRevision,
  createContentSha256,
  createDisabledMirrorState,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  createRecoverySnapshotId,
  isMirrorDeviceStateConsistent,
  type LocalReconciliationWriter,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_MUTATION_PHASE,
  MIRROR_PATH_BLOCK_REASON,
  MIRROR_STATE_STORE_FAILURE,
  type MirrorDeviceState,
  type MirrorPathState,
  MirrorStateOwner,
  type MirrorStateStore,
  MUTATION_EFFECT_CERTAINTY,
  type NotePath,
  normalizeNotePath,
  RECONCILIATION_ACTION,
  RECONCILIATION_AUTHORITY_SOURCE,
  RECONCILIATION_CLASSIFICATION,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_LOCAL_STABILITY,
  RECONCILIATION_OBSERVATION_COVERAGE,
  RECONCILIATION_OPERATION_PHASE,
  RECONCILIATION_PATH_REFERENCE_KIND,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
  RECONCILIATION_REVIEW_RETENTION,
  RECONCILIATION_REVIEW_STATUS,
  type ReconciliationOperation,
  type ReconciliationReview,
} from "@obsidian-ai-bridge/core";
import type { MirrorPreferences } from "@obsidian-plugin/configuration/mirror-preferences";
import { ObsidianLocalVault } from "@obsidian-plugin/infrastructure/obsidian-local-vault";
import type { RemoteFetch } from "@obsidian-plugin/remote/fetch-remote-bridge.types";
import { MirrorRuntimeOwner } from "@obsidian-plugin/runtime/mirror-runtime-owner";
import {
  createHandoffRecord,
  encodeHandoffRecord,
  WebCryptoHandoffIntegrity,
} from "@obsidian-plugin/state/handoff-codec";
import {
  FakeVaultHost,
  fakeFile,
} from "@obsidian-plugin-tests/support/fake-vault-host";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DEVICE_ID = required(
  createMirrorWriterId("11111111-1111-4111-8111-111111111111"),
);
const OTHER_DEVICE_ID = required(
  createMirrorWriterId("99999999-9999-4999-8999-999999999999"),
);
const ASSOCIATION_ID = required(
  createMirrorAssociationId("22222222-2222-4222-8222-222222222222"),
);
const OPERATION_ID = required(
  createMirrorOperationId("33333333-3333-4333-8333-333333333333"),
);
const OTHER_OPERATION_ID = required(
  createMirrorOperationId("77777777-7777-4777-8777-777777777777"),
);
const REVISION_ID = required(
  createApplicationRevision("44444444-4444-4444-8444-444444444444"),
);
const PARENT_REVISION_ID = required(
  createApplicationRevision("66666666-6666-4666-8666-666666666666"),
);
const RECOVERY_ID = required(
  createRecoverySnapshotId("33333333-3333-4333-8333-333333333333"),
);
const CONTENT_HASH = required(createContentSha256("ab".repeat(32)));
const preferences: MirrorPreferences = {
  origin: "https://bridge.example",
  loopbackHttpOrigin: null,
  secretReference: "bridge-token",
};

function state(active = false) {
  const disabled = createDisabledMirrorState(DEVICE_ID);
  return active
    ? {
        ...disabled,
        lifecycle: {
          kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
          associationId: ASSOCIATION_ID,
          origin: preferences.origin ?? "",
        },
      }
    : disabled;
}

function description(writerId = DEVICE_ID): Response {
  return json({
    protocol: "obsidian-ai-bridge-mirror-v2",
    associationId: ASSOCIATION_ID,
    writerId,
    maxNoteSizeBytes: 1024 * 1024,
    maxPageSize: 50,
    recoveryRetentionSeconds: 2_592_000,
  });
}

const localWriter: LocalReconciliationWriter = {
  createEligible: async () => {
    throw new Error("Unexpected reviewed local creation.");
  },
  replaceEligible: async () => {
    throw new Error("Unexpected reviewed local replacement.");
  },
  createPreservation: async () => {
    throw new Error("Unexpected reviewed preservation.");
  },
};

function owner(
  fetch: RemoteFetch,
  initial: boolean | MirrorDeviceState = false,
  vault = new FakeVaultHost(),
  store: MirrorStateStore = { save: async () => ({ kind: "saved" }) },
  hashContent: (content: string) => Promise<typeof CONTENT_HASH> = async () => {
    throw new Error("No content expected.");
  },
  cryptography: Crypto = globalThis.crypto,
  secret: string | null = "bearer",
): MirrorRuntimeOwner {
  return new MirrorRuntimeOwner({
    stateOwner: new MirrorStateOwner(
      typeof initial === "boolean" ? state(initial) : initial,
      store,
    ),
    local: new ObsidianLocalVault(vault),
    localWriter,
    secretStorage: { getSecret: () => secret },
    runtime: {
      nowMilliseconds: () => 100,
      hashContent,
      createOperationId: () => OPERATION_ID,
    },
    fetch,
    cryptography,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("MirrorRuntimeOwner composition", () => {
  it("keeps reviewed UI methods unavailable before a current ready session", async () => {
    const runtime = owner(vi.fn<RemoteFetch>());
    const session = "33333333-3333-4333-8333-333333333333";

    await expect(
      runtime.listReconciliationCandidates(session),
    ).resolves.toEqual({
      kind: "unavailable",
    });
    await expect(runtime.listRecoverySelections(session)).resolves.toEqual({
      kind: "unavailable",
    });
    await expect(
      runtime.createReconciliationReview(
        session,
        required(normalizeNotePath("notes/a.md")),
      ),
    ).resolves.toBeNull();
    await expect(
      runtime.createReconciliationReview(
        "invalid",
        required(normalizeNotePath("notes/a.md")),
      ),
    ).resolves.toBeNull();
    expect(
      runtime.reconciliationPreview("invalid", OPERATION_ID, "local"),
    ).toBeNull();
    runtime.closeReconciliationReview("invalid", OPERATION_ID);
    await expect(runtime.verifyServerIdentity()).resolves.toEqual({
      kind: "not-ready",
    });
    await expect(runtime.activate(true)).resolves.toEqual({
      kind: "not-ready",
    });
    await expect(runtime.resume()).resolves.toEqual({ kind: "not-ready" });
    await expect(
      runtime.createObservationGapReview(session, OPERATION_ID),
    ).resolves.toEqual({ kind: "unavailable" });
    runtime.closeObservationGapReview(session, OPERATION_ID);
    await expect(
      runtime.submitObservationGapReview(session, OPERATION_ID, []),
    ).resolves.toEqual({ kind: "unavailable" });
    await expect(
      runtime.submitReconciliation(session, OPERATION_ID, { kind: "defer" }),
    ).resolves.toEqual({ kind: "unavailable" });
  });

  it("enforces one attached presentation session and ignores stale detach", () => {
    const runtime = owner(vi.fn<RemoteFetch>());
    expect(runtime.attach({ id: "first", onChanged: vi.fn() })).toEqual({
      kind: "attached",
    });
    expect(runtime.attach({ id: "second", onChanged: vi.fn() })).toEqual({
      kind: "already-attached",
    });
    runtime.detach("second");
    expect(runtime.isAttached("first")).toBe(true);
    runtime.detach("first");
    expect(runtime.isAttached("first")).toBe(false);
  });

  it("returns bounded refusals without a compatible connection", async () => {
    const runtime = owner(vi.fn<RemoteFetch>());
    const path = required(normalizeNotePath("note.md"));
    await runtime.synchronizeReady();
    await runtime.observePresent(path);
    await runtime.observeDelete(path);
    await runtime.observeRename(path, null);
    await expect(
      runtime.observeFolderRename("folder", null),
    ).resolves.toBeNull();
    await runtime.onLayoutReady("other-session");
    expect(runtime.nextWakeAtMilliseconds()).toBeNull();
    await expect(runtime.checkNow()).resolves.toEqual({ kind: "not-ready" });
    await expect(runtime.activate(true)).resolves.toEqual({
      kind: "not-ready",
    });
    await expect(runtime.resume()).resolves.toEqual({ kind: "not-ready" });
    await expect(runtime.importHandoff("invalid", true)).resolves.toEqual({
      kind: "not-ready",
    });
    await expect(runtime.prepareHandoff()).resolves.toEqual({
      kind: "not-ready",
    });
  });

  it("keeps unconfigured and configured-disabled sessions passive", async () => {
    const fetch = vi.fn<RemoteFetch>();
    const vault = new FakeVaultHost();
    const runtime = owner(fetch, false, vault);
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "missing" });
    await runtime.onLayoutReady("session");
    expect(fetch).not.toHaveBeenCalled();
    expect(vault.getFiles).not.toHaveBeenCalled();

    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    expect(fetch).not.toHaveBeenCalled();
    expect(vault.getFiles).not.toHaveBeenCalled();
  });

  it("durably pauses an active writer when the referenced native secret is missing", async () => {
    const fetch = vi.fn<RemoteFetch>();
    const runtime = owner(
      fetch,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      null,
    );
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    expect(fetch).not.toHaveBeenCalled();
    expect(runtime.stateOwner.snapshot().state.lifecycle.kind).toBe(
      MIRROR_DEVICE_LIFECYCLE_KIND.paused,
    );
  });

  it("automatically bootstraps only a configured active designated writer", async () => {
    const fetch = vi.fn<RemoteFetch>(async (input) =>
      input.pathname.endsWith("/mirror")
        ? description()
        : json({ notes: [], nextCursor: null }),
    );
    const vault = new FakeVaultHost();
    const runtime = owner(fetch, true, vault);
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vault.getFiles).toHaveBeenCalledOnce();
    expect(runtime.status().writer).toBe("active-writer");
    expect(runtime.status().bootstrap).toBe("observing");
  });

  it("keeps persisted destructive M3 work behind the startup event barrier", async () => {
    const session = "88888888-8888-4888-8888-888888888888";
    const path = requiredNotePath("notes/deleting.md");
    let now = 0;
    const vault = new FakeVaultHost();
    const fetch = vi.fn<RemoteFetch>(async (input) =>
      input.pathname.endsWith("/mirror")
        ? description()
        : json({ notes: [], nextCursor: null }),
    );
    const pathState: MirrorPathState = {
      path,
      acknowledgement: {
        kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
        revision: REVISION_ID,
        contentSha256: CONTENT_HASH,
      },
      unresolvedMutation: null,
      desired: {
        kind: MIRROR_DESIRED_STATE_KIND.runtimeDelete,
        observationGeneration: 1,
        evidenceId: OTHER_OPERATION_ID,
        associationId: ASSOCIATION_ID,
        expectedRevision: REVISION_ID,
        graceDeadlineMilliseconds: 0,
      },
      blockedReason: null,
    };
    const runtime = new MirrorRuntimeOwner({
      stateOwner: new MirrorStateOwner(
        { ...state(true), paths: [pathState] },
        { save: async () => ({ kind: "saved" }) },
      ),
      local: new ObsidianLocalVault(vault),
      localWriter,
      secretStorage: { getSecret: () => "bearer" },
      runtime: {
        nowMilliseconds: () => now,
        hashContent: async () => CONTENT_HASH,
        createOperationId: () => OPERATION_ID,
      },
      fetch,
    });
    runtime.attach({ id: session, onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    now = 6_000;
    const drain = Promise.withResolvers<boolean>();
    const drainQueuedEvents = vi.fn(() => drain.promise);
    const startup = runtime.onLayoutReady(
      session,
      drainQueuedEvents,
      () => true,
    );
    await vi.waitFor(() => expect(drainQueuedEvents).toHaveBeenCalledOnce());

    await runtime.synchronizeReady();
    expect(vault.getFile).not.toHaveBeenCalledWith(path);

    drain.resolve(true);
    await startup;
    await runtime.synchronizeReady();
    expect(vault.getFile).toHaveBeenCalledWith(path);
  });

  it("revokes the current effect lease after active event delivery failure", async () => {
    const fetch = vi.fn<RemoteFetch>(async (input) =>
      input.pathname.endsWith("/mirror")
        ? description()
        : json({ notes: [], nextCursor: null }),
    );
    const runtime = owner(fetch, true);
    const session = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    runtime.attach({ id: session, onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady(session);

    await runtime.failObservationDelivery();

    await expect(runtime.checkNow()).resolves.toEqual({ kind: "not-ready" });
    expect(runtime.nextWakeAtMilliseconds()).toBeNull();

    runtime.detach(session);
    const nextSession = "99999999-8888-4888-8888-999999999999";
    runtime.attach({ id: nextSession, onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady(nextSession);
    await expect(runtime.verifyServerIdentity()).resolves.toEqual({
      kind: "completed",
    });
    expect(runtime.listObservationGaps(nextSession)).toEqual({
      kind: "available",
      candidates: [],
    });
  });

  it("keeps the startup effect lease unpublished after pre-ready observation loss", async () => {
    const fetch = vi.fn<RemoteFetch>(async (input) =>
      input.pathname.endsWith("/mirror")
        ? description()
        : json({ notes: [], nextCursor: null }),
    );
    const runtime = owner(fetch, true);
    const session = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    runtime.attach({ id: session, onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });

    await runtime.failObservationDelivery();
    await runtime.onLayoutReady(session);

    expect(fetch).not.toHaveBeenCalled();
    expect(runtime.nextWakeAtMilliseconds()).toBeNull();
  });

  it("records reserved descendants of a same-realm folder rename before core expansion", async () => {
    const path = requiredNotePath("notes/folder/locked.md");
    const reviewId = required(
      createMirrorOperationId("77777777-7777-4777-8777-777777777777"),
    );
    const lifecycle = {
      kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
      associationId: ASSOCIATION_ID,
      origin: preferences.origin ?? "",
    } as const;
    const pathState: MirrorPathState = {
      path,
      acknowledgement: {
        kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
        revision: REVISION_ID,
        contentSha256: CONTENT_HASH,
      },
      unresolvedMutation: null,
      desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
      blockedReason: null,
    };
    const snapshot = {
      runtime: {
        runtimeOwnerVersion: 3,
        configurationGeneration: 1,
        listenerEpoch: 1,
        deviceId: DEVICE_ID,
        designatedWriterId: DEVICE_ID,
        lifecycle,
      },
      targetPath: path,
      paths: [
        {
          path,
          local: {
            kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.live,
            stability: RECONCILIATION_LOCAL_STABILITY.stable,
            observationGeneration: 1,
            byteSize: 4,
            contentSha256: CONTENT_HASH,
          },
          baseline: pathState.acknowledgement,
          remote: {
            kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
            associationId: ASSOCIATION_ID,
            revision: PARENT_REVISION_ID,
            contentSha256: CONTENT_HASH,
            receipt: {
              action: "create",
              associationId: ASSOCIATION_ID,
              operationId: OPERATION_ID,
              precondition: { kind: "absent" },
              contentSha256: CONTENT_HASH,
            },
          },
          m3: { unresolvedMutation: null, deferredHistory: null },
        },
      ],
      recovery: null,
    } as const;
    const operation: ReconciliationOperation = {
      observationCoverage: RECONCILIATION_OBSERVATION_COVERAGE.continuous,
      gapSuccessorOperationIds: [],
      operationId: OPERATION_ID,
      reviewId,
      authority: RECONCILIATION_AUTHORITY_SOURCE.adoptionDecision,
      action: { kind: RECONCILIATION_ACTION.adoptRevision },
      phase: RECONCILIATION_OPERATION_PHASE.admitted,
      snapshot,
      destinationPath: null,
      reservations: [
        { path, kind: RECONCILIATION_PATH_REFERENCE_KIND.reviewTarget },
      ],
      preservationReceipts: [],
      successorOperationId: null,
      localEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
      remoteEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
      localEffectObservation: {
        kind: "not-required",
        path,
        listenerEpoch: 1,
        beforeGeneration: 1,
        successor: null,
      },
    };
    const review: ReconciliationReview = {
      retention: RECONCILIATION_REVIEW_RETENTION.durable,
      reviewId,
      classification: RECONCILIATION_CLASSIFICATION.remoteAhead,
      status: RECONCILIATION_REVIEW_STATUS.staged,
      snapshot,
      operationId: OPERATION_ID,
    };
    const initial: MirrorDeviceState = {
      ...state(true),
      paths: [pathState],
      reconciliationReviews: [review],
      reconciliationOperations: [operation],
    };
    expect(isMirrorDeviceStateConsistent(initial)).toBe(true);
    const fetch = vi.fn<RemoteFetch>(async (input) =>
      input.pathname.endsWith("/mirror")
        ? description()
        : json({ notes: [], nextCursor: null }),
    );
    const runtime = owner(fetch, initial);
    await runtime.observePresent(path);
    runtime.attach({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      onChanged: vi.fn(),
    });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    await runtime.observeFolderRename("notes/folder", "moved/folder");

    expect(
      runtime.stateOwner.snapshot().state.reconciliationOperations[0],
    ).toMatchObject({
      observationCoverage:
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired,
      localEffectObservation: {
        kind: "not-required",
        successor: {
          firstGeneration: 2,
          latestGeneration: 2,
          eventKinds: ["rename"],
        },
      },
    });
  });

  it("keeps reconciliation UI unavailable until the startup observation drain is durable", async () => {
    const session = "88888888-8888-4888-8888-888888888888";
    const fetch = vi.fn<RemoteFetch>(async (input) => {
      if (input.pathname.endsWith("/mirror")) return description();
      if (input.pathname.includes("/recovery")) {
        return json({ recoveries: [], nextCursor: null });
      }
      return json({ notes: [], nextCursor: null });
    });
    const runtime = owner(fetch, true);
    const drain = Promise.withResolvers<boolean>();
    const drainQueuedEvents = vi
      .fn<() => Promise<boolean>>()
      .mockImplementationOnce(() => drain.promise)
      .mockResolvedValue(true);
    runtime.attach({ id: session, onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    const startup = runtime.onLayoutReady(
      session,
      drainQueuedEvents,
      () => true,
    );
    await vi.waitFor(() => expect(drainQueuedEvents).toHaveBeenCalledOnce());
    await expect(runtime.verifyServerIdentity()).resolves.toEqual({
      kind: "completed",
    });
    expect(runtime.status().serverIdentity.kind).toBe("matched");
    expect(runtime.listObservationGaps(session)).toEqual({
      kind: "unavailable",
    });

    const reconfiguration = runtime.applyConfiguration({
      kind: "valid",
      preferences,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drainQueuedEvents).toHaveBeenCalledOnce();
    expect(runtime.listObservationGaps(session)).toEqual({
      kind: "unavailable",
    });

    drain.resolve(true);
    await Promise.all([startup, reconfiguration]);
    expect(runtime.listObservationGaps(session)).toEqual({
      kind: "available",
      candidates: [],
    });
    await expect(
      runtime.listReconciliationCandidates(session),
    ).resolves.toEqual({
      kind: "available",
      candidates: [],
    });
    await expect(runtime.listRecoverySelections(session)).resolves.toEqual({
      kind: "available",
      recoveries: [],
    });
    await expect(
      runtime.createObservationGapReview(session, OPERATION_ID),
    ).resolves.toEqual({ kind: "not-reviewable" });
    runtime.closeObservationGapReview(session, OPERATION_ID);
    await expect(
      runtime.submitObservationGapReview(session, OPERATION_ID, []),
    ).resolves.toEqual({ kind: "failed" });
    const absentPath = required(normalizeNotePath("notes/not-listed.md"));
    await expect(
      runtime.createReconciliationReview(session, absentPath),
    ).resolves.toBeNull();
    expect(
      runtime.reconciliationPreview(session, OPERATION_ID, "local"),
    ).toBeNull();
    runtime.closeReconciliationReview(session, OPERATION_ID);
    await expect(
      runtime.submitReconciliation(session, OPERATION_ID, { kind: "defer" }),
    ).resolves.toEqual({ kind: "failed" });
  });

  it("revokes readiness when startup observations cannot be durably drained", async () => {
    const session = "99999999-9999-4999-8999-999999999999";
    const fetch = vi.fn<RemoteFetch>(async (input) => {
      if (input.pathname.endsWith("/mirror")) return description();
      if (input.pathname.includes("/recovery")) {
        return json({ recoveries: [], nextCursor: null });
      }
      return json({ notes: [], nextCursor: null });
    });
    const runtime = owner(fetch, true);
    const drain = vi.fn(async () => false);
    const activate = vi.fn(() => true);
    runtime.attach({ id: session, onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });

    await runtime.onLayoutReady(session, drain, activate);

    expect(drain).toHaveBeenCalledOnce();
    expect(activate).not.toHaveBeenCalled();
    expect(runtime.listObservationGaps(session)).toEqual({
      kind: "unavailable",
    });
  });

  it("revokes readiness when event activation fails after a durable drain", async () => {
    const session = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const fetch = vi.fn<RemoteFetch>(async (input) => {
      if (input.pathname.endsWith("/mirror")) return description();
      if (input.pathname.includes("/recovery")) {
        return json({ recoveries: [], nextCursor: null });
      }
      return json({ notes: [], nextCursor: null });
    });
    const runtime = owner(fetch, true);
    const drain = vi.fn(async () => true);
    const activate = vi.fn(() => false);
    runtime.attach({ id: session, onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });

    await runtime.onLayoutReady(session, drain, activate);

    expect(drain).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledOnce();
    expect(runtime.listObservationGaps(session)).toEqual({
      kind: "unavailable",
    });
  });

  it("exposes only bounded reviewed projections for a ready UUID session", async () => {
    const session = "77777777-7777-4777-8777-777777777777";
    const fetch = vi.fn<RemoteFetch>(async (input) => {
      if (input.pathname.endsWith("/mirror")) return description();
      if (input.pathname.includes("/recovery")) {
        return json({ recoveries: [], nextCursor: null });
      }
      return json({ notes: [], nextCursor: null });
    });
    const runtime = owner(fetch, true);
    runtime.attach({ id: session, onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady(session);
    await runtime.synchronizeReady();
    const path = required(normalizeNotePath("notes/review.md"));

    await expect(
      runtime.listReconciliationCandidates(session),
    ).resolves.toEqual({
      kind: "unavailable",
    });
    await expect(runtime.listRecoverySelections(session)).resolves.toEqual({
      kind: "unavailable",
    });
    await expect(
      runtime.createReconciliationReview(session, path),
    ).resolves.toBeNull();
    expect(
      runtime.reconciliationPreview(session, OPERATION_ID, "local"),
    ).toBeNull();
    runtime.closeReconciliationReview(session, OPERATION_ID);
    await expect(
      runtime.submitReconciliation(session, OPERATION_ID, { kind: "defer" }),
    ).resolves.toEqual({ kind: "unavailable" });
  });

  it("fails a non-designated active state before local enumeration", async () => {
    const fetch = vi.fn<RemoteFetch>(async () => description(OTHER_DEVICE_ID));
    const vault = new FakeVaultHost();
    const runtime = owner(fetch, true, vault);
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    expect(fetch).toHaveBeenCalledOnce();
    expect(vault.getFiles).not.toHaveBeenCalled();
    expect(runtime.status().writer).toBe("designation-mismatch");
  });

  it("retires an active connection and durably pauses when configuration is removed", async () => {
    const fetch = vi.fn<RemoteFetch>(async (input) =>
      input.pathname.endsWith("/mirror")
        ? description()
        : json({ notes: [], nextCursor: null }),
    );
    const runtime = owner(fetch, true);
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    await runtime.applyConfiguration({ kind: "missing" });
    expect(runtime.stateOwner.snapshot().state.lifecycle.kind).toBe(
      MIRROR_DEVICE_LIFECYCLE_KIND.paused,
    );
    expect(runtime.nextWakeAtMilliseconds()).toBeNull();
    expect(runtime.status().configuration).toBe("unconfigured");
  });

  it("replaces a changed secret reference only for the same paused origin", async () => {
    const fetch = vi.fn<RemoteFetch>(async (input) =>
      input.pathname.endsWith("/mirror")
        ? description()
        : json({ notes: [], nextCursor: null }),
    );
    const runtime = owner(fetch, true);
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    await runtime.applyConfiguration({
      kind: "valid",
      preferences: { ...preferences, secretReference: "replacement-token" },
    });
    expect(runtime.stateOwner.snapshot().state.lifecycle.kind).toBe(
      MIRROR_DEVICE_LIFECYCLE_KIND.paused,
    );
    await expect(runtime.resume()).resolves.toEqual({ kind: "completed" });
  });

  it("activates only an isolated association designated to this device", async () => {
    const successfulFetch = vi.fn<RemoteFetch>(async (input) =>
      input.pathname.endsWith("/mirror")
        ? description()
        : json({ notes: [], nextCursor: null }),
    );
    const activated = owner(successfulFetch);
    activated.attach({ id: "active", onChanged: vi.fn() });
    await activated.applyConfiguration({ kind: "valid", preferences });
    await activated.onLayoutReady("active");
    await expect(activated.activate(true)).resolves.toEqual({
      kind: "completed",
    });
    expect(activated.stateOwner.snapshot().state.lifecycle.kind).toBe(
      MIRROR_DEVICE_LIFECYCLE_KIND.active,
    );

    const mismatched = owner(
      vi.fn<RemoteFetch>(async () => description(OTHER_DEVICE_ID)),
    );
    mismatched.attach({ id: "mismatch", onChanged: vi.fn() });
    await mismatched.applyConfiguration({ kind: "valid", preferences });
    await mismatched.onLayoutReady("mismatch");
    await expect(mismatched.activate(true)).resolves.toEqual({
      kind: "not-ready",
    });
  });

  it("publishes sanitized association/designation status and refuses mismatch", async () => {
    const runtime = owner(
      vi.fn<RemoteFetch>(async () => description(OTHER_DEVICE_ID)),
    );
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    await expect(runtime.verifyServerIdentity()).resolves.toEqual({
      kind: "completed",
    });
    expect(runtime.status().serverIdentity).toEqual({
      kind: "mismatch",
      associationId: ASSOCIATION_ID,
      designatedWriterId: OTHER_DEVICE_ID,
    });
    await expect(runtime.activate(true)).resolves.toEqual({
      kind: "not-ready",
    });
  });

  it("rejects an endpoint change that cannot resume the paused association", async () => {
    const fetch = vi.fn<RemoteFetch>(async (input) =>
      input.pathname.endsWith("/mirror")
        ? description()
        : json({ notes: [], nextCursor: null }),
    );
    const runtime = owner(fetch, true);
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    await runtime.applyConfiguration({
      kind: "valid",
      preferences: { ...preferences, origin: "https://other.example" },
    });
    expect(runtime.stateOwner.snapshot().state.lifecycle.kind).toBe(
      MIRROR_DEVICE_LIFECYCLE_KIND.paused,
    );
    expect(runtime.nextWakeAtMilliseconds()).toBeNull();
  });

  it("refuses handoff while already admitted bootstrap work is unsettled", async () => {
    const pending = Promise.withResolvers<Response>();
    const fetch = vi.fn<RemoteFetch>(() => pending.promise);
    const runtime = owner(fetch, true);
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    const bootstrap = runtime.onLayoutReady("session");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await expect(runtime.prepareHandoff()).resolves.toEqual({
      kind: "not-ready",
    });
    pending.resolve(description());
    await bootstrap;
  });

  it("reports a failed explicit check when remote bootstrap cannot complete", async () => {
    const fetch = vi.fn<RemoteFetch>(async () =>
      json({ code: "INTERNAL", message: "safe" }, 503),
    );
    const runtime = owner(fetch, true);
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    await expect(runtime.checkNow()).resolves.toEqual({ kind: "failed" });
  });

  it("fails closed on remote activation and resume verification failures", async () => {
    const fetch = vi.fn<RemoteFetch>(async () =>
      json({ code: "INTERNAL", message: "safe" }, 503),
    );
    const disabled = owner(fetch);
    disabled.attach({ id: "session", onChanged: vi.fn() });
    await disabled.applyConfiguration({ kind: "valid", preferences });
    await disabled.onLayoutReady("session");
    await expect(disabled.activate(true)).resolves.toEqual({ kind: "failed" });

    const active = owner(fetch, true);
    active.attach({ id: "active", onChanged: vi.fn() });
    await active.applyConfiguration({ kind: "valid", preferences });
    await active.onLayoutReady("active");
    await active.pause();
    await expect(active.resume()).resolves.toEqual({ kind: "failed" });

    const mismatch = owner(
      vi.fn<RemoteFetch>(async () => description(OTHER_DEVICE_ID)),
      true,
    );
    mismatch.attach({ id: "mismatch", onChanged: vi.fn() });
    await mismatch.applyConfiguration({ kind: "valid", preferences });
    await mismatch.pause();
    await mismatch.onLayoutReady("mismatch");
    await expect(mismatch.resume()).resolves.toEqual({ kind: "not-ready" });
  });

  it("contains handoff cryptography failure without exposing provider errors", async () => {
    const fetch = vi.fn<RemoteFetch>(async (input) =>
      input.pathname.endsWith("/mirror")
        ? description()
        : json({ notes: [], nextCursor: null }),
    );
    const failingCryptography = cryptoWithFailingDigest();
    const exporting = owner(
      fetch,
      true,
      undefined,
      undefined,
      undefined,
      failingCryptography,
    );
    exporting.attach({ id: "export", onChanged: vi.fn() });
    await exporting.applyConfiguration({ kind: "valid", preferences });
    await exporting.onLayoutReady("export");
    await expect(exporting.prepareHandoff()).resolves.toEqual({
      kind: "failed",
    });

    const validRecord = await createHandoffRecord(
      {
        origin: preferences.origin ?? "",
        associationId: ASSOCIATION_ID,
        entries: [],
      },
      new WebCryptoHandoffIntegrity(),
    );
    const importing = owner(
      fetch,
      false,
      undefined,
      undefined,
      undefined,
      failingCryptography,
    );
    importing.attach({ id: "import", onChanged: vi.fn() });
    await importing.applyConfiguration({ kind: "valid", preferences });
    await importing.onLayoutReady("import");
    await expect(
      importing.importHandoff(encodeHandoffRecord(validRecord), true),
    ).resolves.toEqual({ kind: "failed" });
  });

  it("records unavailable authenticated server identity without exposing remote failure", async () => {
    const runtime = owner(
      vi.fn<RemoteFetch>(async () =>
        json({ code: "INTERNAL", message: "PRIVATE RAW FAILURE" }, 503),
      ),
    );
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    await expect(runtime.verifyServerIdentity()).resolves.toEqual({
      kind: "failed",
    });
    expect(runtime.status().serverIdentity).toEqual({ kind: "unavailable" });
    expect(JSON.stringify(runtime.status())).not.toContain(
      "PRIVATE RAW FAILURE",
    );
  });

  it("leaves a handoff inactive when authenticated identity is unavailable", async () => {
    const record = await liveHandoffRecord(requiredNotePath("live.md"));
    const runtime = owner(
      vi.fn<RemoteFetch>(async () =>
        json({ code: "INTERNAL", message: "PRIVATE RAW FAILURE" }, 503),
      ),
    );
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    await expect(
      runtime.importHandoff(encodeHandoffRecord(record), true),
    ).resolves.toEqual({ kind: "not-ready" });
    expect(runtime.status().serverIdentity).toEqual({ kind: "unavailable" });
    expect(runtime.stateOwner.snapshot().state.lifecycle.kind).toBe(
      MIRROR_DEVICE_LIFECYCLE_KIND.disabled,
    );
  });

  it("rejects malformed handoff input after readiness is established", async () => {
    const fetch = vi.fn<RemoteFetch>(async (input) =>
      input.pathname.endsWith("/mirror")
        ? description()
        : json({ notes: [], nextCursor: null }),
    );
    const runtime = owner(fetch);
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    await expect(runtime.importHandoff("not-json", true)).resolves.toEqual({
      kind: "failed",
    });
  });

  it("collects transient live and absent handoff evidence without importing content", async () => {
    const livePath = required(normalizeNotePath("live.md"));
    const deletedPath = required(normalizeNotePath("deleted.md"));
    const record = await createHandoffRecord(
      {
        origin: preferences.origin ?? "",
        associationId: ASSOCIATION_ID,
        entries: [
          {
            path: livePath,
            acknowledgement: {
              kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
              revision: REVISION_ID,
              contentSha256: CONTENT_HASH,
            },
          },
          {
            path: deletedPath,
            acknowledgement: {
              kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
              revision: REVISION_ID,
              recoveryId: RECOVERY_ID,
            },
          },
        ],
      },
      new WebCryptoHandoffIntegrity(),
    );
    const inspections = [
      stateJson({
        kind: "tombstone",
        path: deletedPath,
        revision: REVISION_ID,
        deletedRevision: PARENT_REVISION_ID,
        recoveryId: RECOVERY_ID,
        receipt: {
          action: "tombstone",
          associationId: ASSOCIATION_ID,
          operationId: OPERATION_ID,
          precondition: {
            kind: "matching-revision",
            revision: PARENT_REVISION_ID,
          },
        },
      }),
      stateJson({
        kind: "live",
        path: livePath,
        revision: REVISION_ID,
        contentSha256: CONTENT_HASH,
        receipt: {
          action: "create",
          associationId: ASSOCIATION_ID,
          operationId: OPERATION_ID,
          precondition: { kind: "absent" },
          contentSha256: CONTENT_HASH,
        },
      }),
    ];
    const fetch = vi.fn<RemoteFetch>(async (input) => {
      if (input.pathname.endsWith("/mirror")) return description();
      if (input.pathname.includes("/notes/")) {
        return required(inspections.shift());
      }
      return json({ notes: [], nextCursor: null });
    });
    const runtime = owner(
      fetch,
      false,
      new FakeVaultHost([fakeFile("live.md", "saved")]),
      undefined,
      async () => CONTENT_HASH,
    );
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    await expect(
      runtime.importHandoff(encodeHandoffRecord(record), true),
    ).resolves.toEqual({ kind: "completed" });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(runtime.stateOwner.snapshot())).not.toContain(
      "saved",
    );
  });

  it("fences a runtime digest failure during staged handoff evidence", async () => {
    const path = requiredNotePath("live.md");
    const record = await liveHandoffRecord(path);
    const runtime = owner(
      vi.fn<RemoteFetch>(async (input) =>
        input.pathname.endsWith("/mirror")
          ? description()
          : liveStateResponse(path),
      ),
      false,
      new FakeVaultHost([fakeFile(path, "saved")]),
      undefined,
      async () => Promise.reject(new Error("PRIVATE PROVIDER FAILURE")),
    );
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    await expect(
      runtime.importHandoff(encodeHandoffRecord(record), true),
    ).resolves.toEqual({ kind: "failed" });
    expect(runtime.status().globalBlockReason).toBe("runtime-unavailable");
    expect(JSON.stringify(runtime.status())).not.toContain(
      "PRIVATE PROVIDER FAILURE",
    );
  });

  it("prevents a retired handoff connection from dispatching after a pending local read", async () => {
    const livePath = required(normalizeNotePath("live.md"));
    const record = await createHandoffRecord(
      {
        origin: preferences.origin ?? "",
        associationId: ASSOCIATION_ID,
        entries: [
          {
            path: livePath,
            acknowledgement: {
              kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
              revision: REVISION_ID,
              contentSha256: CONTENT_HASH,
            },
          },
        ],
      },
      new WebCryptoHandoffIntegrity(),
    );
    const fetch = vi.fn<RemoteFetch>(async () => description());
    const vault = new FakeVaultHost([fakeFile("live.md", "saved")]);
    const pendingRead = Promise.withResolvers<string>();
    vault.read.mockReturnValue(pendingRead.promise);
    const runtime = owner(
      fetch,
      false,
      vault,
      undefined,
      async () => CONTENT_HASH,
    );
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    const importing = runtime.importHandoff(encodeHandoffRecord(record), true);
    await vi.waitFor(() => expect(vault.read).toHaveBeenCalledOnce());

    await runtime.applyConfiguration({
      kind: "valid",
      preferences: { ...preferences, secretReference: "replacement-token" },
    });
    pendingRead.resolve("saved");

    await expect(importing).resolves.toEqual({ kind: "failed" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(runtime.stateOwner.snapshot().state.lifecycle.kind).toBe(
      MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged,
    );
  });

  it("maps explicit remote absence to handoff misalignment", async () => {
    const livePath = required(normalizeNotePath("live.md"));
    const record = await createHandoffRecord(
      {
        origin: preferences.origin ?? "",
        associationId: ASSOCIATION_ID,
        entries: [
          {
            path: livePath,
            acknowledgement: {
              kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
              revision: REVISION_ID,
              contentSha256: CONTENT_HASH,
            },
          },
        ],
      },
      new WebCryptoHandoffIntegrity(),
    );
    const fetch = vi.fn<RemoteFetch>(async (input) =>
      input.pathname.endsWith("/mirror")
        ? description()
        : json({ kind: "absent", path: livePath }),
    );
    const runtime = owner(
      fetch,
      false,
      new FakeVaultHost([fakeFile("live.md", "saved")]),
      undefined,
      async () => CONTENT_HASH,
    );
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    await expect(
      runtime.importHandoff(encodeHandoffRecord(record), true),
    ).resolves.toEqual({ kind: "not-ready" });
    expect(runtime.status().globalBlockReason).toBe("handoff-mismatch");
  });

  it("does not activate against a stale connection after secret removal while describe is pending", async () => {
    const pending = Promise.withResolvers<Response>();
    const fetch = vi.fn<RemoteFetch>(() => pending.promise);
    const runtime = owner(fetch);
    runtime.attach({ id: "a", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("a");
    const activation = runtime.activate(true);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const signal = fetch.mock.calls[0]?.[1].signal;

    await runtime.applyConfiguration({
      kind: "valid",
      preferences: { ...preferences, secretReference: null },
    });
    expect(signal?.aborted).toBe(true);
    pending.resolve(description());
    await expect(activation).resolves.toEqual({ kind: "failed" });
    expect(runtime.stateOwner.snapshot().state.lifecycle.kind).toBe(
      MIRROR_DEVICE_LIFECYCLE_KIND.disabled,
    );
  });

  it("durably pauses an activation whose state save settles after configuration replacement", async () => {
    const pendingSave = Promise.withResolvers<{ readonly kind: "saved" }>();
    const save = vi
      .fn<MirrorStateStore["save"]>()
      .mockImplementationOnce(() => pendingSave.promise)
      .mockResolvedValue({ kind: "saved" });
    const store: MirrorStateStore = { save };
    const fetch = vi.fn<RemoteFetch>(async () => description());
    const runtime = owner(fetch, false, undefined, store);
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    const activation = runtime.activate(true);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());

    await runtime.applyConfiguration({
      kind: "valid",
      preferences: { ...preferences, secretReference: "replacement-token" },
    });
    pendingSave.resolve({ kind: "saved" });

    await expect(activation).resolves.toEqual({ kind: "failed" });
    expect(runtime.stateOwner.snapshot().state.lifecycle.kind).toBe(
      MIRROR_DEVICE_LIFECYCLE_KIND.paused,
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps bootstrap closed while incompatible preferences wait for a durable pause", async () => {
    const pendingPause = Promise.withResolvers<{ readonly kind: "saved" }>();
    const save = vi.fn<MirrorStateStore["save"]>(() => pendingPause.promise);
    const fetch = vi.fn<RemoteFetch>();
    const runtime = owner(fetch, true, undefined, { save });
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });

    const replacing = runtime.applyConfiguration({
      kind: "valid",
      preferences: { ...preferences, secretReference: "replacement-token" },
    });
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    let layoutReadySettled = false;
    const layoutReady = runtime.onLayoutReady("session").then(() => {
      layoutReadySettled = true;
    });
    await Promise.resolve();
    expect(layoutReadySettled).toBe(false);
    expect(fetch).not.toHaveBeenCalled();

    pendingPause.resolve({ kind: "saved" });
    await Promise.all([replacing, layoutReady]);

    expect(fetch).not.toHaveBeenCalled();
    expect(runtime.stateOwner.snapshot().state.lifecycle.kind).toBe(
      MIRROR_DEVICE_LIFECYCLE_KIND.paused,
    );
  });

  it("rejects activation when its queued transition belongs to a retired connection", async () => {
    const pendingBlocker = Promise.withResolvers<{ readonly kind: "saved" }>();
    const save = vi
      .fn<MirrorStateStore["save"]>()
      .mockImplementationOnce(() => pendingBlocker.promise)
      .mockResolvedValue({ kind: "saved" });
    const runtime = owner(
      vi.fn<RemoteFetch>(async () => description()),
      false,
      undefined,
      { save },
    );
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    const blocker = runtime.stateOwner.transition((current) => current);
    const activation = runtime.activate(true);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    await runtime.applyConfiguration({
      kind: "valid",
      preferences: { ...preferences, secretReference: "replacement-token" },
    });
    pendingBlocker.resolve({ kind: "saved" });
    await blocker;

    await expect(activation).resolves.toEqual({ kind: "not-ready" });
    expect(runtime.stateOwner.snapshot().state.lifecycle.kind).toBe(
      MIRROR_DEVICE_LIFECYCLE_KIND.disabled,
    );
  });

  it("rejects handoff staging queued behind a retired configuration", async () => {
    const pendingBlocker = Promise.withResolvers<{ readonly kind: "saved" }>();
    const save = vi
      .fn<MirrorStateStore["save"]>()
      .mockImplementationOnce(() => pendingBlocker.promise)
      .mockResolvedValue({ kind: "saved" });
    const runtime = owner(
      vi.fn<RemoteFetch>(async () => description()),
      false,
      undefined,
      { save },
    );
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    const record = await createHandoffRecord(
      {
        origin: preferences.origin ?? "",
        associationId: ASSOCIATION_ID,
        entries: [],
      },
      new WebCryptoHandoffIntegrity(),
    );
    const blocker = runtime.stateOwner.transition((current) => current);
    const importing = runtime.importHandoff(encodeHandoffRecord(record), true);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    await runtime.applyConfiguration({
      kind: "valid",
      preferences: { ...preferences, secretReference: "replacement-token" },
    });
    pendingBlocker.resolve({ kind: "saved" });
    await blocker;

    await expect(importing).resolves.toEqual({ kind: "not-ready" });
    expect(runtime.stateOwner.snapshot().state.stagedHandoff).toBeNull();
  });

  it("rejects handoff alignment queued behind a retired configuration", async () => {
    const livePath = required(normalizeNotePath("live.md"));
    const record = await createHandoffRecord(
      {
        origin: preferences.origin ?? "",
        associationId: ASSOCIATION_ID,
        entries: [
          {
            path: livePath,
            acknowledgement: {
              kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
              revision: REVISION_ID,
              contentSha256: CONTENT_HASH,
            },
          },
        ],
      },
      new WebCryptoHandoffIntegrity(),
    );
    const pendingRead = Promise.withResolvers<string>();
    const pendingBlocker = Promise.withResolvers<{ readonly kind: "saved" }>();
    const save = vi
      .fn<MirrorStateStore["save"]>()
      .mockResolvedValueOnce({ kind: "saved" })
      .mockImplementationOnce(() => pendingBlocker.promise)
      .mockResolvedValue({ kind: "saved" });
    const vault = new FakeVaultHost([fakeFile("live.md", "saved")]);
    vault.read.mockReturnValue(pendingRead.promise);
    const fetch = vi.fn<RemoteFetch>(async (input) =>
      input.pathname.endsWith("/mirror")
        ? description()
        : stateJson({
            kind: "live",
            path: livePath,
            revision: REVISION_ID,
            contentSha256: CONTENT_HASH,
            receipt: {
              action: "create",
              associationId: ASSOCIATION_ID,
              operationId: OPERATION_ID,
              precondition: { kind: "absent" },
              contentSha256: CONTENT_HASH,
            },
          }),
    );
    const runtime = owner(
      fetch,
      false,
      vault,
      { save },
      async () => CONTENT_HASH,
    );
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    const importing = runtime.importHandoff(encodeHandoffRecord(record), true);
    await vi.waitFor(() => expect(vault.read).toHaveBeenCalledOnce());
    const blocker = runtime.stateOwner.transition((current) => current);
    pendingRead.resolve("saved");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await runtime.applyConfiguration({
      kind: "valid",
      preferences: { ...preferences, secretReference: "replacement-token" },
    });
    pendingBlocker.resolve({ kind: "saved" });
    await blocker;

    await expect(importing).resolves.toEqual({ kind: "not-ready" });
  });

  it("pauses a handoff activation whose durable save settles under new settings", async () => {
    const pendingActivation = Promise.withResolvers<{
      readonly kind: "saved";
    }>();
    const save = vi
      .fn<MirrorStateStore["save"]>()
      .mockResolvedValueOnce({ kind: "saved" })
      .mockImplementationOnce(() => pendingActivation.promise)
      .mockResolvedValue({ kind: "saved" });
    const runtime = owner(
      vi.fn<RemoteFetch>(async (input) =>
        input.pathname.endsWith("/mirror")
          ? description()
          : json({ notes: [], nextCursor: null }),
      ),
      false,
      undefined,
      { save },
    );
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    const record = await createHandoffRecord(
      {
        origin: preferences.origin ?? "",
        associationId: ASSOCIATION_ID,
        entries: [],
      },
      new WebCryptoHandoffIntegrity(),
    );
    const importing = runtime.importHandoff(encodeHandoffRecord(record), true);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await runtime.applyConfiguration({
      kind: "valid",
      preferences: { ...preferences, secretReference: "replacement-token" },
    });
    pendingActivation.resolve({ kind: "saved" });

    await expect(importing).resolves.toEqual({ kind: "not-ready" });
    expect(runtime.stateOwner.snapshot().state.lifecycle.kind).toBe(
      MIRROR_DEVICE_LIFECYCLE_KIND.paused,
    );
  });

  it("grants retry only to a reconstructible retry-exhausted intent", async () => {
    const retryPath = required(normalizeNotePath("retry.md"));
    const ordinaryPath = required(normalizeNotePath("ordinary.md"));
    const initial: MirrorDeviceState = {
      ...state(true),
      paths: [
        {
          path: ordinaryPath,
          acknowledgement: {
            kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated,
          },
          desired: {
            kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent,
            observationGeneration: 1,
          },
          unresolvedMutation: null,
          blockedReason: null,
        },
        {
          path: retryPath,
          acknowledgement: {
            kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated,
          },
          desired: {
            kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent,
            observationGeneration: 1,
          },
          unresolvedMutation: {
            intent: {
              action: "create",
              associationId: ASSOCIATION_ID,
              writerId: DEVICE_ID,
              operationId: OPERATION_ID,
              path: retryPath,
              precondition: { kind: "absent" },
              contentSha256: CONTENT_HASH,
              mutationAttempts: 3,
              evidenceAttempts: 3,
            },
            phase: MIRROR_MUTATION_PHASE.evidenceRequired,
          },
          blockedReason: MIRROR_PATH_BLOCK_REASON.retryExhausted,
        },
      ],
    };
    const runtime = owner(
      vi.fn<RemoteFetch>(),
      initial,
      new FakeVaultHost([fakeFile("retry.md", "saved")]),
      undefined,
      async () => CONTENT_HASH,
    );
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await expect(runtime.retryFailures()).resolves.toEqual({
      kind: "completed",
    });
    expect(
      runtime.stateOwner.snapshot().state.paths[1]?.blockedReason,
    ).toBeNull();
  });

  it("supports bounded check, pause, verified resume, and quiescent handoff export", async () => {
    const fetch = vi.fn<RemoteFetch>(async (input) =>
      input.pathname.endsWith("/mirror")
        ? description()
        : json({ notes: [], nextCursor: null }),
    );
    const runtime = owner(fetch, true);
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    await expect(runtime.checkNow()).resolves.toEqual({ kind: "completed" });
    await expect(runtime.pause()).resolves.toEqual({ kind: "completed" });
    expect(runtime.nextWakeAtMilliseconds()).toBeNull();
    await expect(runtime.resume()).resolves.toEqual({ kind: "completed" });
    await expect(runtime.retryFailures()).resolves.toEqual({
      kind: "not-ready",
    });
    const exported = await runtime.prepareHandoff();
    expect(exported.kind).toBe("exported");
    if (exported.kind !== "exported") throw new Error("Expected export.");
    expect(exported.encoded).not.toMatch(/bearer|content/i);
  });

  it("refuses a valid handoff when remote designation does not match", async () => {
    const fetch = vi.fn<RemoteFetch>(async () => description(OTHER_DEVICE_ID));
    const runtime = owner(fetch);
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    const record = await createHandoffRecord(
      {
        origin: preferences.origin ?? "",
        associationId: ASSOCIATION_ID,
        entries: [],
      },
      new WebCryptoHandoffIntegrity(),
    );
    await expect(
      runtime.importHandoff(encodeHandoffRecord(record), true),
    ).resolves.toEqual({ kind: "not-ready" });
  });

  it("imports and aligns an explicit empty metadata handoff before activation", async () => {
    const fetch = vi.fn<RemoteFetch>(async (input) =>
      input.pathname.endsWith("/mirror")
        ? description()
        : json({ notes: [], nextCursor: null }),
    );
    const runtime = owner(fetch);
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    const record = await createHandoffRecord(
      {
        origin: preferences.origin ?? "",
        associationId: ASSOCIATION_ID,
        entries: [],
      },
      new WebCryptoHandoffIntegrity(),
    );
    await expect(
      runtime.importHandoff(encodeHandoffRecord(record), true),
    ).resolves.toEqual({ kind: "completed" });
    expect(runtime.stateOwner.snapshot().state.lifecycle.kind).toBe(
      MIRROR_DEVICE_LIFECYCLE_KIND.active,
    );
  });

  it("rejects host event delivery after an observation persistence failure", async () => {
    let failWrites = false;
    const store: MirrorStateStore = {
      save: async () =>
        failWrites
          ? {
              kind: "failed",
              reason: MIRROR_STATE_STORE_FAILURE.unavailable,
            }
          : { kind: "saved" },
    };
    const runtime = owner(
      vi.fn<RemoteFetch>(),
      true,
      new FakeVaultHost(),
      store,
    );
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    failWrites = true;
    await expect(
      runtime.observePresent(requiredNotePath("event.md")),
    ).rejects.toThrow("Observation persistence is unavailable.");
    expect(runtime.stateOwner.snapshot().persistenceAvailable).toBe(false);
  });

  it("keeps pre-bootstrap deletion and rename observations non-destructive", async () => {
    const fetch = vi.fn<RemoteFetch>();
    const runtime = owner(fetch, true);
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    const path = required(normalizeNotePath("event.md"));
    await runtime.observeDelete(path);
    await runtime.observeRename(path, null);
    await runtime.observeRename(
      path,
      required(normalizeNotePath("destination.md")),
    );
    await runtime.observeFolderRename("folder", null);
    expect(runtime.stateOwner.snapshot().state.paths).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "create or modify",
      (
        runtime: MirrorRuntimeOwner,
        path: ReturnType<typeof requiredNotePath>,
      ) => runtime.observePresent(path),
    ],
    [
      "delete",
      (
        runtime: MirrorRuntimeOwner,
        path: ReturnType<typeof requiredNotePath>,
      ) => runtime.observeDelete(path),
    ],
    [
      "file rename",
      (
        runtime: MirrorRuntimeOwner,
        path: ReturnType<typeof requiredNotePath>,
      ) => runtime.observeRename(path, requiredNotePath("renamed.md")),
    ],
    [
      "folder rename",
      (runtime: MirrorRuntimeOwner) =>
        runtime.observeFolderRename("folder", "renamed-folder"),
    ],
  ])(
    "invalidates sampled staged handoff evidence for a %s event while the local read is pending",
    async (_name, observe) => {
      const path = requiredNotePath("folder/live.md");
      const record = await liveHandoffRecord(path);
      const pendingRead = Promise.withResolvers<string>();
      const vault = new FakeVaultHost([fakeFile(path, "saved")]);
      vault.read.mockReturnValue(pendingRead.promise);
      const fetch = vi.fn<RemoteFetch>(async (input) =>
        input.pathname.endsWith("/mirror")
          ? description()
          : liveStateResponse(path),
      );
      const runtime = owner(
        fetch,
        false,
        vault,
        undefined,
        async () => CONTENT_HASH,
      );
      runtime.attach({ id: "session", onChanged: vi.fn() });
      await runtime.applyConfiguration({ kind: "valid", preferences });
      await runtime.onLayoutReady("session");
      const importing = runtime.importHandoff(
        encodeHandoffRecord(record),
        true,
      );
      await vi.waitFor(() => expect(vault.read).toHaveBeenCalledOnce());

      await observe(runtime, path);
      pendingRead.resolve("saved");

      await expect(importing).resolves.toEqual({ kind: "not-ready" });
      const staged = runtime.stateOwner.snapshot().state.stagedHandoff;
      expect(staged?.entries[0]).toMatchObject({
        localAlignment: "pending",
      });
      expect(staged?.entries[0]?.observationGeneration).toBeGreaterThan(1);
    },
  );

  it("invalidates staged evidence when a relevant event arrives during remote inspection", async () => {
    const path = requiredNotePath("live.md");
    const record = await liveHandoffRecord(path);
    const pendingRemote = Promise.withResolvers<Response>();
    const fetch = vi
      .fn<RemoteFetch>()
      .mockResolvedValueOnce(description())
      .mockImplementationOnce(() => pendingRemote.promise);
    const runtime = owner(
      fetch,
      false,
      new FakeVaultHost([fakeFile(path, "saved")]),
      undefined,
      async () => CONTENT_HASH,
    );
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    const importing = runtime.importHandoff(encodeHandoffRecord(record), true);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    await runtime.observePresent(path);
    pendingRemote.resolve(liveStateResponse(path));

    await expect(importing).resolves.toEqual({ kind: "not-ready" });
    expect(
      runtime.stateOwner.snapshot().state.stagedHandoff?.entries[0]
        ?.observationGeneration,
    ).toBeGreaterThan(1);
  });

  it("does not invalidate unrelated staged evidence", async () => {
    const path = requiredNotePath("live.md");
    const record = await liveHandoffRecord(path);
    const pendingRead = Promise.withResolvers<string>();
    const vault = new FakeVaultHost([fakeFile(path, "saved")]);
    vault.read.mockReturnValue(pendingRead.promise);
    const fetch = vi.fn<RemoteFetch>(async (input) => {
      if (input.pathname.endsWith("/mirror")) return description();
      if (input.pathname.includes("/notes/")) return liveStateResponse(path);
      return json({ notes: [], nextCursor: null });
    });
    const runtime = owner(
      fetch,
      false,
      vault,
      undefined,
      async () => CONTENT_HASH,
    );
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    const importing = runtime.importHandoff(encodeHandoffRecord(record), true);
    await vi.waitFor(() => expect(vault.read).toHaveBeenCalledOnce());

    await runtime.observePresent(requiredNotePath("unrelated.md"));
    pendingRead.resolve("saved");

    await expect(importing).resolves.toEqual({ kind: "completed" });
    expect(runtime.stateOwner.snapshot().state.lifecycle.kind).toBe(
      MIRROR_DEVICE_LIFECYCLE_KIND.active,
    );
  });

  it("serializes events arriving during the atomic activation save after activation", async () => {
    const path = requiredNotePath("live.md");
    const record = await liveHandoffRecord(path);
    const pendingActivation = Promise.withResolvers<{
      readonly kind: "saved";
    }>();
    const save = vi
      .fn<MirrorStateStore["save"]>()
      .mockResolvedValueOnce({ kind: "saved" })
      .mockImplementationOnce(() => pendingActivation.promise)
      .mockResolvedValue({ kind: "saved" });
    const fetch = vi.fn<RemoteFetch>(async (input) => {
      if (input.pathname.endsWith("/mirror")) return description();
      if (input.pathname.includes("/notes/")) return liveStateResponse(path);
      return json({ notes: [], nextCursor: null });
    });
    const runtime = owner(
      fetch,
      false,
      new FakeVaultHost([fakeFile(path, "saved")]),
      { save },
      async () => CONTENT_HASH,
    );
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    const importing = runtime.importHandoff(encodeHandoffRecord(record), true);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    const observed = runtime.observePresent(path);
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(2);

    pendingActivation.resolve({ kind: "saved" });
    await expect(observed).resolves.toBeUndefined();
    await expect(importing).resolves.toEqual({ kind: "completed" });
    expect(runtime.stateOwner.snapshot().state.paths[0]?.desired.kind).toBe(
      MIRROR_DESIRED_STATE_KIND.dirtyPresent,
    );
  });

  it("performs one fresh positive-only scan after every detached listener gap", async () => {
    const source = requiredNotePath("source.md");
    const destination = requiredNotePath("destination.md");
    const initial: MirrorDeviceState = {
      ...state(true),
      paths: [associatedLivePath(source)],
    };
    const vault = new FakeVaultHost([fakeFile(source, "before")]);
    const fetch = vi.fn<RemoteFetch>(async (input) =>
      input.pathname.endsWith("/mirror")
        ? description()
        : json({ notes: [], nextCursor: null }),
    );
    const runtime = owner(
      fetch,
      initial,
      vault,
      undefined,
      async () => CONTENT_HASH,
    );
    runtime.attach({ id: "first", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("first");
    const firstGeneration =
      runtime.stateOwner.snapshot().state.paths[0]?.desired;
    expect(firstGeneration?.kind).toBe(MIRROR_DESIRED_STATE_KIND.dirtyPresent);

    runtime.detach("first");
    const sourceFile = vault.files.get(source);
    if (sourceFile === undefined) throw new Error("Missing source fixture.");
    sourceFile.content = "modified during gap";
    sourceFile.stat = { size: sourceFile.content.length, mtime: 2000 };
    runtime.attach({ id: "second", onChanged: vi.fn() });
    await runtime.onLayoutReady("second");
    const modifiedGeneration =
      runtime.stateOwner.snapshot().state.paths[0]?.desired;
    expect(modifiedGeneration).toMatchObject({ kind: "dirty-present" });
    if (
      firstGeneration?.kind !== MIRROR_DESIRED_STATE_KIND.dirtyPresent ||
      modifiedGeneration?.kind !== MIRROR_DESIRED_STATE_KIND.dirtyPresent
    ) {
      throw new Error("Expected positive observations.");
    }
    expect(modifiedGeneration.observationGeneration).toBeGreaterThan(
      firstGeneration.observationGeneration,
    );

    runtime.detach("second");
    vault.files.delete(source);
    vault.files.set(destination, fakeFile(destination, "renamed during gap"));
    runtime.attach({ id: "third", onChanged: vi.fn() });
    await runtime.onLayoutReady("third");
    const paths = runtime.stateOwner.snapshot().state.paths;
    expect(paths.find((entry) => entry.path === source)?.desired.kind).not.toBe(
      MIRROR_DESIRED_STATE_KIND.runtimeDelete,
    );
    expect(
      paths.find((entry) => entry.path === destination)?.desired.kind,
    ).toBe(MIRROR_DESIRED_STATE_KIND.dirtyPresent);
    expect(vault.getFiles).toHaveBeenCalledTimes(3);
  });

  it("fences an unexpected bootstrap capability failure", async () => {
    const adapter = new ObsidianLocalVault(new FakeVaultHost());
    const runtime = new MirrorRuntimeOwner({
      stateOwner: new MirrorStateOwner(state(true), {
        save: async () => ({ kind: "saved" }),
      }),
      local: {
        list: async () => Promise.reject(new Error("PRIVATE HOST FAILURE")),
        read: (path) => adapter.read(path),
      },
      secretStorage: { getSecret: () => "bearer" },
      runtime: {
        nowMilliseconds: () => 0,
        hashContent: async () => CONTENT_HASH,
        createOperationId: () => OPERATION_ID,
      },
      fetch: vi.fn<RemoteFetch>(async (input) =>
        input.pathname.endsWith("/mirror")
          ? description()
          : json({ notes: [], nextCursor: null }),
      ),
      cryptography: globalThis.crypto,
    });
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    expect(runtime.status().globalBlockReason).toBe("runtime-unavailable");
    expect(JSON.stringify(runtime.status())).not.toContain(
      "PRIVATE HOST FAILURE",
    );
  });

  it("durably fences a digest failure without losing dirty work or retaining a hot wake", async () => {
    const path = requiredNotePath("dirty.md");
    const hashContent = vi
      .fn<(content: string) => Promise<typeof CONTENT_HASH>>()
      .mockRejectedValueOnce(new Error("provider failed"))
      .mockResolvedValue(CONTENT_HASH);
    let now = 0;
    let runtimeAvailable = false;
    const runtime = new MirrorRuntimeOwner({
      stateOwner: new MirrorStateOwner(state(true), {
        save: async () => ({ kind: "saved" }),
      }),
      local: new ObsidianLocalVault(
        new FakeVaultHost([fakeFile(path, "saved")]),
      ),
      secretStorage: { getSecret: () => "bearer" },
      runtime: {
        nowMilliseconds: () => now,
        hashContent,
        createOperationId: () => OPERATION_ID,
      },
      fetch: vi.fn<RemoteFetch>(async (input) =>
        input.pathname.endsWith("/mirror")
          ? description()
          : json({ notes: [], nextCursor: null }),
      ),
      cryptography: globalThis.crypto,
      probeRuntime: async () => runtimeAvailable,
    });
    runtime.attach({ id: "session", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    await runtime.onLayoutReady("session");
    expect(runtime.nextWakeAtMilliseconds()).not.toBeNull();
    now = 10_000;

    const synchronization = await runtime.synchronizeReady();
    expect(hashContent).toHaveBeenCalledOnce();
    expect(synchronization).toEqual({ kind: "fenced" });
    expect(runtime.status().globalBlockReason).toBe("runtime-unavailable");
    expect(runtime.nextWakeAtMilliseconds()).toBeNull();
    expect(runtime.stateOwner.snapshot().state.paths[0]?.desired.kind).toBe(
      MIRROR_DESIRED_STATE_KIND.dirtyPresent,
    );
    await expect(runtime.checkNow()).resolves.toEqual({ kind: "failed" });
    expect(runtime.status().globalBlockReason).toBe("runtime-unavailable");

    runtimeAvailable = true;
    await expect(runtime.checkNow()).resolves.toEqual({ kind: "completed" });
    expect(runtime.status().globalBlockReason).toBeNull();
    expect(runtime.nextWakeAtMilliseconds()).not.toBeNull();
  });

  it("settles then restarts one inherited bootstrap after replacement attachment", async () => {
    const first = Promise.withResolvers<Response>();
    const fetch = vi
      .fn<RemoteFetch>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (input) =>
        input.pathname.endsWith("/mirror")
          ? description()
          : json({ notes: [], nextCursor: null }),
      );
    const runtime = owner(fetch, true);
    runtime.attach({ id: "a", onChanged: vi.fn() });
    await runtime.applyConfiguration({ kind: "valid", preferences });
    const bootstrapA = runtime.onLayoutReady("a");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    runtime.detach("a");
    expect(runtime.attach({ id: "b", onChanged: vi.fn() })).toEqual({
      kind: "attached",
    });
    const bootstrapB = runtime.onLayoutReady("b");
    expect(fetch).toHaveBeenCalledOnce();
    first.resolve(description());
    await Promise.all([bootstrapA, bootstrapB]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(runtime.status().bootstrap).toBe("observing");
  });
});

async function liveHandoffRecord(path: NotePath) {
  return createHandoffRecord(
    {
      origin: preferences.origin ?? "",
      associationId: ASSOCIATION_ID,
      entries: [
        {
          path,
          acknowledgement: {
            kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
            revision: REVISION_ID,
            contentSha256: CONTENT_HASH,
          },
        },
      ],
    },
    new WebCryptoHandoffIntegrity(),
  );
}

function liveStateResponse(path: NotePath): Response {
  return stateJson({
    kind: "live",
    path,
    revision: REVISION_ID,
    contentSha256: CONTENT_HASH,
    receipt: {
      action: "create",
      associationId: ASSOCIATION_ID,
      operationId: OPERATION_ID,
      precondition: { kind: "absent" },
      contentSha256: CONTENT_HASH,
    },
  });
}

function associatedLivePath(path: NotePath): MirrorPathState {
  return {
    path,
    acknowledgement: {
      kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
      revision: REVISION_ID,
      contentSha256: CONTENT_HASH,
    },
    unresolvedMutation: null,
    desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
    blockedReason: null,
  };
}

function requiredNotePath(path: string): NotePath {
  return required(normalizeNotePath(path));
}

function json(value: object, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stateJson(value: object): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json",
      etag: `"m3-${REVISION_ID}"`,
    },
  });
}

function cryptoWithFailingDigest(): Crypto {
  const subtle = new Proxy(globalThis.crypto.subtle, {
    get(target, property, receiver) {
      if (property === "digest") {
        return async () => Promise.reject(new Error("expected"));
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return new Proxy(globalThis.crypto, {
    get(target, property, receiver) {
      if (property === "subtle") return subtle;
      return Reflect.get(target, property, receiver);
    },
  });
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid fixture value.");
  return value;
}
