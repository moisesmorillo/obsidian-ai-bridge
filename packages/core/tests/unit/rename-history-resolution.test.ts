import { createHash } from "node:crypto";
import {
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  ConflictPreservationService,
  CURRENT_NOTE_STATE_KIND,
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  createReconciliationPreservationPath,
  HISTORY_CLEANUP_STEP_KIND,
  HISTORY_CLEANUP_STEP_PHASE,
  HISTORY_DECISION_KIND,
  HISTORY_PROGRESS_KIND,
  LOCAL_RECONCILIATION_WRITE_OUTCOME,
  LocalInspectionKind,
  type LocalReconciliationWriter,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_RENAME_PHASE,
  type MirrorDeviceState,
  MirrorStateOwner,
  type MirrorStateStore,
  MUTATION_ACTION,
  MUTATION_EFFECT_CERTAINTY,
  type NotePath,
  normalizeNotePath,
  RECONCILIATION_ACTION,
  RECONCILIATION_AUTHORITY_SOURCE,
  RECONCILIATION_CLASSIFICATION,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_LOCAL_STABILITY,
  RECONCILIATION_OPERATION_PHASE,
  RECONCILIATION_PATH_REFERENCE_KIND,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
  RECONCILIATION_REVIEW_RETENTION,
  RECONCILIATION_REVIEW_STATUS,
  ReconciliationObservationGenerationOwner,
  type RemoteBridge,
  type RemoteBridgeMutationResult,
  RenameHistoryResolutionService,
} from "@obsidian-ai-bridge/core";
import { describe, expect, it, vi } from "vitest";

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid history fixture.");
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
const SOURCE_RECEIPT = required(
  createMirrorOperationId("55555555-5555-4555-8555-555555555555"),
);
const DESTINATION_RECEIPT = required(
  createMirrorOperationId("66666666-6666-4666-8666-666666666666"),
);
const STEP = required(
  createMirrorOperationId("77777777-7777-4777-8777-777777777777"),
);
const SOURCE_REVISION = required(
  createApplicationRevision("88888888-8888-4888-8888-888888888888"),
);
const DESTINATION_REVISION = required(
  createApplicationRevision("99999999-9999-4999-8999-999999999999"),
);
const TOMBSTONE_REVISION = required(
  createApplicationRevision("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
);
const SOURCE = required(normalizeNotePath("notes/former.md"));
const DESTINATION = required(normalizeNotePath("notes/current.md"));
const SOURCE_TEXT = "former remote bytes";
const DESTINATION_TEXT = "current remote bytes";
const SOURCE_HASH = digest(SOURCE_TEXT);
const DESTINATION_HASH = digest(DESTINATION_TEXT);

function digest(content: string) {
  return required(
    createContentSha256(createHash("sha256").update(content).digest("hex")),
  );
}

function liveReceipt(
  operationId: typeof SOURCE_RECEIPT,
  contentSha256: typeof SOURCE_HASH,
) {
  return {
    action: MUTATION_ACTION.create,
    associationId: ASSOCIATION,
    operationId,
    precondition: { kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent },
    contentSha256,
  } as const;
}

function deferredHistory() {
  return {
    kind: MIRROR_DESIRED_STATE_KIND.renameDeferred,
    observationGeneration: 1,
    renameId: SOURCE_RECEIPT,
    associationId: ASSOCIATION,
    sourcePath: SOURCE,
    destinationPath: DESTINATION,
    sourceExpectedRevision: SOURCE_REVISION,
    destinationObservationGeneration: 1,
    destinationAcknowledgedRevision: DESTINATION_REVISION,
    graceDeadlineMilliseconds: 1,
    phase: MIRROR_RENAME_PHASE.sourceCleanupRequired,
  } as const;
}

function state(): MirrorDeviceState {
  const deferred = deferredHistory();
  const snapshot = {
    runtime: {
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
    },
    targetPath: SOURCE,
    paths: [
      {
        path: SOURCE,
        local: {
          kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.absent,
          stability: RECONCILIATION_LOCAL_STABILITY.stable,
          observationGeneration: 1,
        },
        baseline: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision: SOURCE_REVISION,
          contentSha256: SOURCE_HASH,
        },
        remote: {
          kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
          associationId: ASSOCIATION,
          revision: SOURCE_REVISION,
          contentSha256: SOURCE_HASH,
          receipt: liveReceipt(SOURCE_RECEIPT, SOURCE_HASH),
        },
        m3: { unresolvedMutation: null, deferredHistory: deferred },
      },
      {
        path: DESTINATION,
        local: {
          kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.live,
          stability: RECONCILIATION_LOCAL_STABILITY.stable,
          observationGeneration: 1,
          byteSize: DESTINATION_TEXT.length,
          contentSha256: DESTINATION_HASH,
        },
        baseline: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision: DESTINATION_REVISION,
          contentSha256: DESTINATION_HASH,
        },
        remote: {
          kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
          associationId: ASSOCIATION,
          revision: DESTINATION_REVISION,
          contentSha256: DESTINATION_HASH,
          receipt: liveReceipt(DESTINATION_RECEIPT, DESTINATION_HASH),
        },
        m3: { unresolvedMutation: null, deferredHistory: null },
      },
    ],
    recovery: null,
  } as const;
  const decision = {
    kind: HISTORY_DECISION_KIND.executeCleanupPlan,
    canonicalPath: DESTINATION,
  } as const;
  return {
    deviceId: DEVICE,
    lifecycle: snapshot.runtime.lifecycle,
    globalBlockReason: null,
    paths: [
      {
        path: SOURCE,
        acknowledgement: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision: SOURCE_REVISION,
          contentSha256: SOURCE_HASH,
        },
        unresolvedMutation: null,
        desired: deferred,
        blockedReason: "rename-deferred",
      },
      {
        path: DESTINATION,
        acknowledgement: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision: DESTINATION_REVISION,
          contentSha256: DESTINATION_HASH,
        },
        unresolvedMutation: null,
        desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
        blockedReason: null,
      },
    ],
    stagedHandoff: null,
    reconciliationReviews: [
      {
        retention: RECONCILIATION_REVIEW_RETENTION.durable,
        reviewId: REVIEW,
        classification: RECONCILIATION_CLASSIFICATION.deferredHistory,
        status: RECONCILIATION_REVIEW_STATUS.staged,
        snapshot,
        operationId: OPERATION,
      },
    ],
    reconciliationOperations: [
      {
        operationId: OPERATION,
        reviewId: REVIEW,
        authority: RECONCILIATION_AUTHORITY_SOURCE.historyDecision,
        action: { kind: RECONCILIATION_ACTION.resolveHistory, decision },
        phase: RECONCILIATION_OPERATION_PHASE.admitted,
        snapshot,
        destinationPath: null,
        reservations: [
          {
            path: DESTINATION,
            kind: RECONCILIATION_PATH_REFERENCE_KIND.tracked,
          },
          {
            path: SOURCE,
            kind: RECONCILIATION_PATH_REFERENCE_KIND.tracked,
          },
        ],
        preservationReceipts: [],
        successorOperationId: null,
        historyProgress: {
          kind: HISTORY_PROGRESS_KIND.refined,
          decision,
          steps: [
            {
              stepId: STEP,
              kind: HISTORY_CLEANUP_STEP_KIND.remoteFormerSourceCleanup,
              sourcePath: SOURCE,
              prerequisitePath: DESTINATION,
              sourceRevision: SOURCE_REVISION,
              sourceContentSha256: SOURCE_HASH,
              prerequisiteRevision: DESTINATION_REVISION,
              localAbsenceGeneration: 1,
              phase: HISTORY_CLEANUP_STEP_PHASE.pending,
              remoteEffect: {
                kind: MUTATION_EFFECT_CERTAINTY.notDispatched,
              },
            },
          ],
          nextStepIndex: 0,
        },
      },
    ],
  };
}

class Store implements MirrorStateStore {
  readonly saved: MirrorDeviceState[] = [];
  fail = false;
  failAt: number | null = null;
  attempts = 0;

  async save(next: MirrorDeviceState) {
    this.attempts += 1;
    if (this.fail || this.failAt === this.attempts) {
      return { kind: "failed", reason: "unavailable" } as const;
    }
    this.saved.push(next);
    return { kind: "saved" } as const;
  }
}

class LocalWriter implements LocalReconciliationWriter {
  failPreservation = false;
  unknownPreservation = false;

  async list() {
    return {
      kind: LocalInspectionKind.ok,
      entries: [],
      skipped: {
        unsupported_file: 0,
        excluded_location: 0,
        invalid_path: 0,
        oversized: 0,
      },
    } as const;
  }

  async read(_path: NotePath) {
    return {
      kind: LocalInspectionKind.failed,
      reason: "missing_file",
    } as const;
  }

  async createEligible(
    _request: Parameters<LocalReconciliationWriter["createEligible"]>[0],
  ): Promise<never> {
    throw new Error("History must not create eligible local notes.");
  }

  async replaceEligible(
    _request: Parameters<LocalReconciliationWriter["replaceEligible"]>[0],
  ): Promise<never> {
    throw new Error("History must not replace local notes.");
  }

  async createPreservation(
    request: Parameters<LocalReconciliationWriter["createPreservation"]>[0],
  ): ReturnType<LocalReconciliationWriter["createPreservation"]> {
    if (this.unknownPreservation) {
      return Promise.resolve({
        kind: "failed",
        reason: "host-unavailable",
        effect: MUTATION_EFFECT_CERTAINTY.unknown,
      });
    }
    if (this.failPreservation) {
      return Promise.resolve({
        kind: "refused",
        reason: "preservation-collision",
        effect: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
      });
    }
    return {
      kind: "confirmed",
      outcome: LOCAL_RECONCILIATION_WRITE_OUTCOME.created,
      path: required(
        createReconciliationPreservationPath(
          request.operationId,
          request.side,
          request.stepId,
        ),
      ),
      contentSha256: request.contentSha256,
      sizeBytes: request.content.length,
    } as const;
  }
}

class Remote implements RemoteBridge {
  source: "live" | "tombstone" | "absent" = "live";
  loseMutationResponse = false;
  inspectFailure = false;
  readonly mutateNote = vi.fn(
    async (): Promise<
      RemoteBridgeMutationResult<
        import("@obsidian-ai-bridge/core").MutationAcknowledgement
      >
    > => {
      this.source = "tombstone";
      if (this.loseMutationResponse) {
        return { kind: "failure", failure: "timed-out", effect: "unknown" };
      }
      return {
        kind: MUTATION_EFFECT_CERTAINTY.confirmed,
        confirmed: tombstoneAcknowledgement(),
      };
    },
  );

  async describe() {
    return { kind: "failure", failure: "network-unavailable" } as const;
  }

  async listNotes() {
    return { kind: "success", value: { notes: [], nextCursor: null } } as const;
  }

  async inspectNote(path: NotePath) {
    if (this.inspectFailure) {
      return { kind: "failure", failure: "network-unavailable" } as const;
    }
    if (path === SOURCE && this.source === "absent") {
      return {
        kind: "success",
        value: { kind: CURRENT_NOTE_STATE_KIND.absent, path: SOURCE },
      } as const;
    }
    if (path === SOURCE && this.source === "tombstone") {
      return {
        kind: "success",
        value: {
          kind: CURRENT_NOTE_STATE_KIND.tombstone,
          path: SOURCE,
          revision: TOMBSTONE_REVISION,
          deletedRevision: SOURCE_REVISION,
          recoveryId: STEP,
          receipt: tombstoneAcknowledgement().receipt,
        },
      } as const;
    }
    const source = path === SOURCE;
    return {
      kind: "success",
      value: {
        kind: CURRENT_NOTE_STATE_KIND.live,
        path,
        revision: source ? SOURCE_REVISION : DESTINATION_REVISION,
        contentSha256: source ? SOURCE_HASH : DESTINATION_HASH,
        receipt: source
          ? liveReceipt(SOURCE_RECEIPT, SOURCE_HASH)
          : liveReceipt(DESTINATION_RECEIPT, DESTINATION_HASH),
      },
    } as const;
  }

  async readNote(path: NotePath) {
    if (path !== SOURCE || this.source !== "live") {
      return { kind: "success", value: { kind: "missing" } } as const;
    }
    return {
      kind: "success",
      value: {
        kind: "live",
        revision: SOURCE_REVISION,
        content: SOURCE_TEXT,
      },
    } as const;
  }

  async listRecovery() {
    return {
      kind: "success",
      value: { recoveries: [], nextCursor: null },
    } as const;
  }

  async inspectRecovery() {
    return { kind: "success", value: null } as const;
  }

  async readRecoveryContent() {
    return { kind: "success", value: { kind: "missing" } } as const;
  }

  async sealRecovery() {
    return {
      kind: "failure",
      failure: "precondition-failed",
      effect: "definitely-refused",
    } as const;
  }

  async purgeRecovery() {
    return {
      kind: "failure",
      failure: "precondition-failed",
      effect: "definitely-refused",
    } as const;
  }
}

function tombstoneAcknowledgement() {
  return {
    path: SOURCE,
    revision: TOMBSTONE_REVISION,
    receipt: {
      action: MUTATION_ACTION.tombstone,
      associationId: ASSOCIATION,
      operationId: STEP,
      precondition: {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
        revision: SOURCE_REVISION,
      },
    },
  } as const;
}

function harness(initial: MirrorDeviceState = state()) {
  const store = new Store();
  const owner = new MirrorStateOwner(initial, store);
  const local = new LocalWriter();
  const remote = new Remote();
  const observations = new ReconciliationObservationGenerationOwner();
  observations.observe(SOURCE);
  const preservation = new ConflictPreservationService(local, owner, {
    hashContent: async (content) => digest(content),
  });
  const runtime = {
    hashFails: false,
    observations,
    hashContent: async (content: string) => {
      if (runtime.hashFails) throw new Error("Expected hash failure.");
      return digest(content);
    },
  };
  const service = new RenameHistoryResolutionService(
    local,
    remote,
    preservation,
    owner,
    runtime,
  );
  return { owner, remote, service, store, local, runtime };
}

describe("RenameHistoryResolutionService", () => {
  it("keeps migrated legacy history blocked and event-owned", async () => {
    const initial = state();
    const operation = required(initial.reconciliationOperations[0]);
    const legacy: MirrorDeviceState = {
      ...initial,
      reconciliationOperations: [
        {
          operationId: operation.operationId,
          reviewId: operation.reviewId,
          authority: operation.authority,
          action: { kind: RECONCILIATION_ACTION.resolveHistory },
          phase: RECONCILIATION_OPERATION_PHASE.blocked,
          snapshot: operation.snapshot,
          destinationPath: operation.destinationPath,
          reservations: operation.reservations,
          preservationReceipts: [],
          successorOperationId: null,
          historyProgress: {
            kind: HISTORY_PROGRESS_KIND.legacyV3Unrefined,
            aggregateLocalEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
            aggregateRemoteEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
          },
        },
      ],
    };
    const subject = harness(legacy);

    await expect(
      subject.service.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "legacy-migration-attention",
    });
    await expect(subject.service.observeReservedEvent(SOURCE)).resolves.toBe(
      true,
    );
  });

  it("rejects absent operations and ignores unreserved events", async () => {
    const subject = harness();
    const missing = required(
      createMirrorOperationId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
    );

    await expect(
      subject.service.execute({ operationId: missing }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "operation-not-found",
    });
    await expect(
      subject.service.observeReservedEvent(
        required(normalizeNotePath("notes/other.md")),
      ),
    ).resolves.toBe(false);
  });

  it("blocks when archived source bytes are unavailable or cannot be hashed", async () => {
    const unavailable = harness();
    vi.spyOn(unavailable.remote, "readNote").mockRejectedValueOnce(
      new Error("Expected read failure."),
    );
    await expect(
      unavailable.service.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "blocked" });

    const unhashed = harness();
    unhashed.runtime.hashFails = true;
    await expect(
      unhashed.service.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "blocked" });
    expect(unavailable.remote.mutateNote).not.toHaveBeenCalled();
    expect(unhashed.remote.mutateNote).not.toHaveBeenCalled();
  });

  it("blocks when exact revalidation throws before remote dispatch", async () => {
    const subject = harness();
    vi.spyOn(subject.remote, "inspectNote").mockRejectedValueOnce(
      new Error("Expected inspection failure."),
    );

    await expect(
      subject.service.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "blocked" });
    expect(subject.remote.mutateNote).not.toHaveBeenCalled();
  });

  it("does not dispatch cleanup when preservation certainty is unknown", async () => {
    const subject = harness();
    subject.local.unknownPreservation = true;

    await expect(
      subject.service.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected" });
    expect(subject.remote.mutateNote).not.toHaveBeenCalled();
  });

  it("blocks archive sampling when the exact source revision changed", async () => {
    const subject = harness();
    vi.spyOn(subject.remote, "readNote").mockResolvedValueOnce({
      kind: "success",
      value: {
        kind: "live",
        revision: DESTINATION_REVISION,
        content: SOURCE_TEXT,
      },
    });

    await expect(
      subject.service.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "blocked" });
    expect(subject.remote.mutateNote).not.toHaveBeenCalled();
  });

  it("blocks before remote cleanup when archive preservation is refused", async () => {
    const subject = harness();
    subject.local.failPreservation = true;

    await expect(
      subject.service.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected" });
    expect(subject.remote.mutateNote).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3, 4])(
    "fails closed when persistence attempt %s is unavailable",
    async (failAt) => {
      const subject = harness();
      subject.store.failAt = failAt;

      await expect(
        subject.service.execute({ operationId: OPERATION }),
      ).resolves.toMatchObject({ kind: "rejected" });
    },
  );

  it("reports definitely-refused remote cleanup without inventing success", async () => {
    const subject = harness();
    subject.remote.mutateNote.mockResolvedValueOnce({
      kind: "failure",
      failure: "precondition-failed",
      effect: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
    });

    await expect(
      subject.service.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "blocked" });
    expect(
      subject.owner.snapshot().state.reconciliationOperations,
    ).toMatchObject([
      {
        phase: RECONCILIATION_OPERATION_PHASE.blocked,
        historyProgress: {
          steps: [
            {
              remoteEffect: {
                kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
              },
            },
          ],
        },
      },
    ]);
  });

  it("fails closed when event blocking cannot be persisted", async () => {
    const subject = harness();
    subject.store.fail = true;

    await expect(subject.service.observeReservedEvent(SOURCE)).rejects.toThrow(
      "History event persistence failed",
    );
  });

  it("preserves and completes exactly one remote cleanup step", async () => {
    const subject = harness();

    await expect(
      subject.service.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({
      kind: "completed",
    });

    await expect(
      subject.service.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "completed" });

    expect(subject.remote.mutateNote).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        operationId: STEP,
        path: SOURCE,
        action: MUTATION_ACTION.tombstone,
      }),
    );
    expect(subject.owner.snapshot().state).toMatchObject({
      reconciliationReviews: [
        { status: RECONCILIATION_REVIEW_STATUS.completed },
      ],
      reconciliationOperations: [
        {
          phase: RECONCILIATION_OPERATION_PHASE.completed,
          historyProgress: {
            nextStepIndex: null,
            steps: [{ phase: HISTORY_CLEANUP_STEP_PHASE.completed }],
          },
          preservationReceipts: [
            {
              scope: "history-step",
              stepId: STEP,
              preservationPath: createReconciliationPreservationPath(
                OPERATION,
                "remote",
                STEP,
              ),
            },
          ],
        },
      ],
    });
  });

  it("recovers an unknown same-step tombstone after restart without redispatch", async () => {
    const subject = harness();
    subject.remote.loseMutationResponse = true;

    await expect(
      subject.service.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({
      kind: "evidence-required",
    });
    expect(subject.remote.mutateNote).toHaveBeenCalledTimes(1);

    const restartedObservations =
      new ReconciliationObservationGenerationOwner();
    restartedObservations.observe(SOURCE);
    const restarted = new RenameHistoryResolutionService(
      new LocalWriter(),
      subject.remote,
      new ConflictPreservationService(new LocalWriter(), subject.owner, {
        hashContent: async (content) => digest(content),
      }),
      subject.owner,
      {
        observations: restartedObservations,
        hashContent: async (content) => digest(content),
      },
    );
    await expect(
      restarted.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({
      kind: "completed",
    });
    expect(subject.remote.mutateNote).toHaveBeenCalledTimes(1);
  });

  it("persists unknown recovery while a dispatched cleanup response remains pending", async () => {
    const subject = harness();
    const pending =
      Promise.withResolvers<Awaited<ReturnType<RemoteBridge["mutateNote"]>>>();
    subject.remote.mutateNote.mockReturnValueOnce(pending.promise);
    const first = subject.service.execute({ operationId: OPERATION });
    await vi.waitFor(() =>
      expect(subject.remote.mutateNote).toHaveBeenCalledOnce(),
    );

    await expect(
      subject.service.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "evidence-required" });
    pending.resolve({
      kind: MUTATION_EFFECT_CERTAINTY.confirmed,
      confirmed: tombstoneAcknowledgement(),
    });
    await expect(first).resolves.toMatchObject({ kind: "completed" });
    expect(subject.remote.mutateNote).toHaveBeenCalledOnce();
  });

  it("keeps unknown restart evidence when remote inspection is unavailable", async () => {
    const subject = harness();
    subject.remote.loseMutationResponse = true;
    await subject.service.execute({ operationId: OPERATION });
    vi.spyOn(subject.remote, "inspectNote").mockRejectedValueOnce(
      new Error("Expected recovery inspection failure."),
    );

    await expect(
      subject.service.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "evidence-required" });
    expect(subject.remote.mutateNote).toHaveBeenCalledOnce();
  });

  it("keeps unknown restart evidence when exact source absence cannot prove the effect", async () => {
    const subject = harness();
    subject.remote.loseMutationResponse = true;
    await subject.service.execute({ operationId: OPERATION });
    subject.remote.source = "absent";

    await expect(
      subject.service.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "evidence-required" });
    expect(subject.remote.mutateNote).toHaveBeenCalledOnce();
  });

  it("persists unknown certainty when the remote adapter throws after preparation", async () => {
    const subject = harness();
    subject.remote.mutateNote.mockRejectedValueOnce(
      new Error("untrusted adapter failure"),
    );

    await expect(
      subject.service.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "evidence-required" });
    expect(subject.owner.snapshot().state).toMatchObject({
      reconciliationOperations: [
        {
          phase: RECONCILIATION_OPERATION_PHASE.evidenceRequired,
          historyProgress: {
            steps: [
              {
                phase: HISTORY_CLEANUP_STEP_PHASE.evidenceRequired,
                remoteEffect: { kind: MUTATION_EFFECT_CERTAINTY.unknown },
              },
            ],
          },
        },
      ],
    });
  });

  it("retains unknown certainty when a reserved event races a dispatched cleanup", async () => {
    const subject = harness();
    const pending =
      Promise.withResolvers<Awaited<ReturnType<RemoteBridge["mutateNote"]>>>();
    subject.remote.mutateNote.mockReturnValueOnce(pending.promise);

    const execution = subject.service.execute({ operationId: OPERATION });
    await vi.waitFor(() =>
      expect(subject.remote.mutateNote).toHaveBeenCalledOnce(),
    );
    await expect(subject.service.observeReservedEvent(SOURCE)).resolves.toBe(
      true,
    );
    pending.resolve({
      kind: MUTATION_EFFECT_CERTAINTY.confirmed,
      confirmed: tombstoneAcknowledgement(),
    });
    await expect(execution).resolves.toMatchObject({ kind: "rejected" });
    expect(
      subject.owner.snapshot().state.reconciliationOperations,
    ).toMatchObject([
      {
        phase: RECONCILIATION_OPERATION_PHASE.blocked,
        historyProgress: {
          steps: [
            {
              phase: HISTORY_CLEANUP_STEP_PHASE.blocked,
              remoteEffect: { kind: MUTATION_EFFECT_CERTAINTY.unknown },
            },
          ],
        },
      },
    ]);
  });

  it("durably blocks history when a reserved local path receives an event", async () => {
    const subject = harness();

    await expect(subject.service.observeReservedEvent(SOURCE)).resolves.toBe(
      true,
    );
    await expect(
      subject.service.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "blocked" });

    expect(subject.remote.mutateNote).not.toHaveBeenCalled();
    expect(subject.owner.snapshot().state).toMatchObject({
      reconciliationOperations: [
        {
          phase: RECONCILIATION_OPERATION_PHASE.blocked,
          historyProgress: {
            steps: [
              {
                phase: HISTORY_CLEANUP_STEP_PHASE.blocked,
                remoteEffect: {
                  kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
                },
              },
            ],
          },
        },
      ],
    });
  });

  it("blocks changed source evidence before remote mutation", async () => {
    const subject = harness();
    subject.remote.source = "tombstone";

    await expect(
      subject.service.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({
      kind: "blocked",
    });
    expect(subject.remote.mutateNote).not.toHaveBeenCalled();
  });
});
