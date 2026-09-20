import {
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  HISTORY_DECISION_KIND,
  MAX_MIRROR_TRACKED_PATHS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_RENAME_PHASE,
  type MirrorDeviceState,
  type MirrorPathState,
  type NotePath,
  normalizeNotePath,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_LOCAL_STABILITY,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
  type ReconciliationPathEvidence,
  type ReconciliationReviewSnapshot,
  RenameHistoryGroupPolicy,
} from "@obsidian-ai-bridge/core";
import { describe, expect, it } from "vitest";

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
const REVISION = required(
  createApplicationRevision("33333333-3333-4333-8333-333333333333"),
);
const HASH = required(createContentSha256("ab".repeat(32)));

function path(value: string): NotePath {
  return required(normalizeNotePath(value));
}

function deferred(
  index: number,
  sourcePath: NotePath,
  destinationPath: NotePath | null,
): MirrorPathState {
  return {
    path: sourcePath,
    acknowledgement: {
      kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
      revision: REVISION,
      contentSha256: HASH,
    },
    unresolvedMutation: null,
    desired: {
      kind: MIRROR_DESIRED_STATE_KIND.renameDeferred,
      observationGeneration: index,
      renameId: required(
        createMirrorOperationId(
          `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
        ),
      ),
      associationId: ASSOCIATION,
      sourcePath,
      destinationPath,
      sourceExpectedRevision: REVISION,
      destinationObservationGeneration: destinationPath === null ? null : index,
      destinationAcknowledgedRevision:
        destinationPath === null ? null : REVISION,
      graceDeadlineMilliseconds: index,
      phase: MIRROR_RENAME_PHASE.destinationRequired,
    },
    blockedReason: null,
  };
}

function state(paths: readonly MirrorPathState[]): MirrorDeviceState {
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

function snapshot(
  targetPath: NotePath,
  paths: readonly NotePath[],
  mirrorState: MirrorDeviceState,
): ReconciliationReviewSnapshot {
  return {
    runtime: {
      runtimeOwnerVersion: 4,
      configurationGeneration: 1,
      listenerEpoch: 1,
      deviceId: DEVICE,
      designatedWriterId: DEVICE,
      lifecycle: mirrorState.lifecycle,
    },
    targetPath,
    paths: paths.map((currentPath, index): ReconciliationPathEvidence => {
      const desired = mirrorState.paths.find(
        (entry) => entry.path === currentPath,
      )?.desired;
      const deferredHistory =
        desired?.kind === MIRROR_DESIRED_STATE_KIND.renameDeferred
          ? desired
          : null;
      return {
        path: currentPath,
        local: {
          kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.absent,
          stability: RECONCILIATION_LOCAL_STABILITY.stable,
          observationGeneration: index + 1,
        },
        baseline: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision: REVISION,
          contentSha256: HASH,
        },
        remote: {
          kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
          associationId: ASSOCIATION,
          revision: REVISION,
          contentSha256: HASH,
          receipt: {
            action: "create",
            associationId: ASSOCIATION,
            operationId: required(
              createMirrorOperationId(
                `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
              ),
            ),
            precondition: { kind: "absent" },
            contentSha256: HASH,
          },
        },
        m3: { unresolvedMutation: null, deferredHistory },
      };
    }),
    recovery: null,
  };
}

describe("RenameHistoryGroupPolicy", () => {
  it("derives one source/destination edge in lexical order", () => {
    const source = path("notes/source.md");
    const destination = path("notes/destination.md");
    expect(
      new RenameHistoryGroupPolicy().derive(
        state([
          deferred(1, source, destination),
          deferred(2, path("notes/unrelated.md"), null),
        ]),
        source,
      ),
    ).toEqual({
      kind: "group",
      paths: [destination, source],
    });
  });

  it("closes chains and shared-destination overlaps without caller path authority", () => {
    const a = path("notes/a.md");
    const b = path("notes/b.md");
    const c = path("notes/c.md");
    const d = path("notes/d.md");
    expect(
      new RenameHistoryGroupPolicy().derive(
        state([deferred(1, a, b), deferred(2, b, c), deferred(3, d, c)]),
        b,
      ),
    ).toEqual({ kind: "group", paths: [a, b, c, d] });
  });

  it("orders chained cleanup from former source toward the final prerequisite", () => {
    const formerSource = path("notes/z.md");
    const intermediate = path("notes/a.md");
    const destination = path("notes/b.md");
    const mirrorState = state([
      deferred(1, formerSource, intermediate),
      deferred(2, intermediate, destination),
    ]);
    let nextId = 10;
    const progress = new RenameHistoryGroupPolicy().createProgress(
      mirrorState,
      snapshot(
        formerSource,
        [formerSource, intermediate, destination],
        mirrorState,
      ),
      { kind: HISTORY_DECISION_KIND.executeCleanupPlan, canonicalPath: null },
      required(createMirrorOperationId("ffffffff-ffff-4fff-8fff-ffffffffffff")),
      () => {
        const id = required(
          createMirrorOperationId(
            `20000000-0000-4000-8000-${nextId.toString(16).padStart(12, "0")}`,
          ),
        );
        nextId += 1;
        return id;
      },
    );

    expect(progress?.steps.map((step) => step.sourcePath)).toEqual([
      formerSource,
      intermediate,
    ]);
  });

  it("creates no-effect ledgers for retain and defer decisions", () => {
    const source = path("notes/source.md");
    const destination = path("notes/destination.md");
    const mirrorState = state([deferred(1, source, destination)]);
    const evidence = snapshot(source, [source, destination], mirrorState);
    const parent = required(
      createMirrorOperationId("ffffffff-ffff-4fff-8fff-ffffffffffff"),
    );
    const policy = new RenameHistoryGroupPolicy();

    for (const decision of [
      { kind: HISTORY_DECISION_KIND.retainIndependent },
      { kind: HISTORY_DECISION_KIND.deferHistory },
    ] as const) {
      expect(
        policy.createProgress(mirrorState, evidence, decision, parent, () =>
          required(
            createMirrorOperationId("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
          ),
        ),
      ).toMatchObject({ decision, steps: [], nextStepIndex: null });
    }
  });

  it("rejects incomplete groups, outside canonical paths, cycles, and duplicate step IDs", () => {
    const a = path("notes/a.md");
    const b = path("notes/b.md");
    const c = path("notes/c.md");
    const parent = required(
      createMirrorOperationId("ffffffff-ffff-4fff-8fff-ffffffffffff"),
    );
    const policy = new RenameHistoryGroupPolicy();
    const chain = state([deferred(1, a, b)]);

    expect(
      policy.createProgress(
        chain,
        snapshot(a, [a], chain),
        { kind: HISTORY_DECISION_KIND.executeCleanupPlan, canonicalPath: b },
        parent,
        () => parent,
      ),
    ).toBeUndefined();
    expect(
      policy.createProgress(
        chain,
        snapshot(a, [a, b], chain),
        { kind: HISTORY_DECISION_KIND.executeCleanupPlan, canonicalPath: c },
        parent,
        () => parent,
      ),
    ).toBeUndefined();
    expect(
      policy.createProgress(
        chain,
        snapshot(a, [a, b], chain),
        { kind: HISTORY_DECISION_KIND.executeCleanupPlan, canonicalPath: b },
        parent,
        () => parent,
      ),
    ).toBeUndefined();

    const cycle = state([deferred(1, a, b), deferred(2, b, a)]);
    expect(
      policy.createProgress(
        cycle,
        snapshot(a, [a, b], cycle),
        { kind: HISTORY_DECISION_KIND.executeCleanupPlan, canonicalPath: null },
        parent,
        () =>
          required(
            createMirrorOperationId("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
          ),
      ),
    ).toBeUndefined();
  });

  it("returns explicit capacity and null-destination boundaries", () => {
    const paths = Array.from(
      { length: MAX_MIRROR_TRACKED_PATHS + 2 },
      (_, index) => path(`notes/${index}.md`),
    );
    const oversized = state(
      paths
        .slice(0, -1)
        .map((source, index) =>
          deferred(index + 1, source, required(paths[index + 1])),
        ),
    );
    expect(
      new RenameHistoryGroupPolicy().derive(oversized, required(paths[0])),
    ).toEqual({
      kind: "capacity-exceeded",
    });

    const source = path("notes/source.md");
    expect(
      new RenameHistoryGroupPolicy().derive(
        state([deferred(1, source, null)]),
        source,
      ),
    ).toEqual({ kind: "group", paths: [source] });
  });

  it("rejects cleanup when sampled source evidence is no longer absent", () => {
    const source = path("notes/source.md");
    const destination = path("notes/destination.md");
    const mirrorState = state([deferred(1, source, destination)]);
    const sampled = snapshot(source, [source, destination], mirrorState);
    const changed: ReconciliationReviewSnapshot = {
      ...sampled,
      paths: sampled.paths.map((evidence) =>
        evidence.path === source
          ? {
              ...evidence,
              local: {
                kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.live,
                stability: RECONCILIATION_LOCAL_STABILITY.stable,
                observationGeneration: 2,
                byteSize: 1,
                contentSha256: HASH,
              },
            }
          : evidence,
      ),
    };
    expect(
      new RenameHistoryGroupPolicy().createProgress(
        mirrorState,
        changed,
        {
          kind: HISTORY_DECISION_KIND.executeCleanupPlan,
          canonicalPath: destination,
        },
        required(
          createMirrorOperationId("ffffffff-ffff-4fff-8fff-ffffffffffff"),
        ),
        () =>
          required(
            createMirrorOperationId("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
          ),
      ),
    ).toBeUndefined();
  });

  it("orders independent former sources lexically for one destination", () => {
    const a = path("notes/a.md");
    const b = path("notes/b.md");
    const destination = path("notes/destination.md");
    const mirrorState = state([
      deferred(1, b, destination),
      deferred(2, a, destination),
    ]);
    const progress = new RenameHistoryGroupPolicy().createProgress(
      mirrorState,
      snapshot(a, [a, b, destination], mirrorState),
      { kind: HISTORY_DECISION_KIND.executeCleanupPlan, canonicalPath: null },
      required(createMirrorOperationId("ffffffff-ffff-4fff-8fff-ffffffffffff")),
      (() => {
        let index = 20;
        return () => {
          const id = required(
            createMirrorOperationId(
              `30000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
            ),
          );
          index += 1;
          return id;
        };
      })(),
    );
    expect(progress?.steps.map((step) => step.sourcePath)).toEqual([a, b]);
  });

  it("derives durable canonical identity only from a current projected candidate", () => {
    const source = path("notes/source.md");
    const destination = path("notes/destination.md");
    const outside = path("notes/forged.md");
    const mirrorState = state([deferred(1, source, destination)]);
    const sampled = snapshot(source, [source, destination], mirrorState);
    const policy = new RenameHistoryGroupPolicy();

    expect(
      policy.deriveDecision(mirrorState, sampled, {
        kind: HISTORY_DECISION_KIND.executeCleanupPlan,
        selectedCandidatePath: destination,
      }),
    ).toEqual({
      kind: HISTORY_DECISION_KIND.executeCleanupPlan,
      canonicalPath: destination,
    });
    expect(
      policy.deriveDecision(mirrorState, sampled, {
        kind: HISTORY_DECISION_KIND.executeCleanupPlan,
        selectedCandidatePath: outside,
      }),
    ).toBeUndefined();
    expect(
      policy.deriveDecision(mirrorState, sampled, {
        kind: HISTORY_DECISION_KIND.retainIndependent,
      }),
    ).toEqual({ kind: HISTORY_DECISION_KIND.retainIndependent });
    expect(
      policy.deriveDecision(mirrorState, sampled, {
        kind: HISTORY_DECISION_KIND.deferHistory,
      }),
    ).toEqual({ kind: HISTORY_DECISION_KIND.deferHistory });
  });

  it("rejects a selected candidate after durable group membership changes", () => {
    const source = path("notes/source.md");
    const destination = path("notes/destination.md");
    const added = path("notes/added.md");
    const original = state([deferred(1, source, destination)]);
    const changed = state([
      deferred(1, source, destination),
      deferred(2, destination, added),
    ]);

    expect(
      new RenameHistoryGroupPolicy().deriveDecision(
        changed,
        snapshot(source, [source, destination], original),
        {
          kind: HISTORY_DECISION_KIND.executeCleanupPlan,
          selectedCandidatePath: destination,
        },
      ),
    ).toBeUndefined();
  });

  it("does not expand a seed that has no durable deferred-history edge", () => {
    const mirrorState = state([]);
    const seed = path("notes/a.md");
    expect(new RenameHistoryGroupPolicy().derive(mirrorState, seed)).toEqual({
      kind: "not-history",
    });
    expect(
      new RenameHistoryGroupPolicy().createProgress(
        mirrorState,
        snapshot(seed, [seed], mirrorState),
        { kind: HISTORY_DECISION_KIND.deferHistory },
        required(
          createMirrorOperationId("ffffffff-ffff-4fff-8fff-ffffffffffff"),
        ),
        () =>
          required(
            createMirrorOperationId("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
          ),
      ),
    ).toBeUndefined();
  });
});
