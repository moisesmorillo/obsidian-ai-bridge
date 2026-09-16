import {
  createApplicationRevision,
  createContentSha256,
  createDisabledMirrorState,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_GLOBAL_BLOCK_REASON,
  MIRROR_PATH_BLOCK_REASON,
  MIRROR_RENAME_PHASE,
  type MirrorPathState,
  type MirrorStateSnapshot,
  normalizeNotePath,
} from "@obsidian-ai-bridge/core";
import {
  createMirrorOperationalStatus,
  formatMirrorOperationalStatus,
} from "@obsidian-plugin/status/mirror-status";
import { describe, expect, it } from "vitest";

const DEVICE = required(
  createMirrorWriterId("11111111-1111-4111-8111-111111111111"),
);
const ASSOCIATION = required(
  createMirrorAssociationId("22222222-2222-4222-8222-222222222222"),
);
const OPERATION = required(
  createMirrorOperationId("33333333-3333-4333-8333-333333333333"),
);
const REVISION = required(
  createApplicationRevision("44444444-4444-4444-8444-444444444444"),
);
const HASH = required(createContentSha256("ab".repeat(32)));

function pathState(
  pathValue: string,
  blockedReason: MirrorPathState["blockedReason"],
  desired: MirrorPathState["desired"] = {
    kind: MIRROR_DESIRED_STATE_KIND.none,
  },
): MirrorPathState {
  return {
    path: required(normalizeNotePath(pathValue)),
    acknowledgement: {
      kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
      revision: REVISION,
      contentSha256: HASH,
    },
    unresolvedMutation: null,
    desired,
    blockedReason,
  };
}

describe("mirror status mapping", () => {
  it("maps every blocked/deferred state and only sanitized outcome kinds", () => {
    const paths: MirrorPathState[] = [
      pathState("retry.md", MIRROR_PATH_BLOCK_REASON.retryExhausted),
      pathState("unknown.md", MIRROR_PATH_BLOCK_REASON.unresolvedEffect),
      pathState("diverged.md", MIRROR_PATH_BLOCK_REASON.diverged),
      pathState("handoff.md", MIRROR_PATH_BLOCK_REASON.handoffMismatch),
      pathState("blocked-rename.md", MIRROR_PATH_BLOCK_REASON.renameDeferred),
      pathState("delete.md", null, {
        kind: MIRROR_DESIRED_STATE_KIND.runtimeDelete,
        observationGeneration: 1,
        evidenceId: OPERATION,
        associationId: ASSOCIATION,
        expectedRevision: REVISION,
        graceDeadlineMilliseconds: 10,
      }),
      pathState("rename.md", null, {
        kind: MIRROR_DESIRED_STATE_KIND.renameDeferred,
        observationGeneration: 1,
        renameId: OPERATION,
        associationId: ASSOCIATION,
        sourcePath: required(normalizeNotePath("rename.md")),
        destinationPath: required(normalizeNotePath("destination.md")),
        sourceExpectedRevision: REVISION,
        destinationObservationGeneration: 2,
        destinationAcknowledgedRevision: null,
        graceDeadlineMilliseconds: 10,
        phase: MIRROR_RENAME_PHASE.destinationRequired,
      }),
      pathState("pending.md", null, {
        kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent,
        observationGeneration: 1,
      }),
    ];
    const snapshot: MirrorStateSnapshot = {
      revision: 1,
      state: {
        ...createDisabledMirrorState(DEVICE),
        lifecycle: {
          kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
          associationId: ASSOCIATION,
          origin: "https://bridge.example",
        },
        paths,
      },
      persistenceAvailable: false,
      mutationAdmissionAllowed: false,
    };
    const outcomes = new Map([
      [
        paths[0]?.path ?? required(normalizeNotePath("retry.md")),
        {
          kind: "remote-failure" as const,
          path: paths[0]?.path ?? required(normalizeNotePath("retry.md")),
          failure: "timed-out" as const,
        },
      ],
    ]);
    const status = createMirrorOperationalStatus(
      "configured",
      snapshot,
      "observing",
      outcomes,
    );
    expect(status.pathStatuses.map((entry) => entry.state)).toEqual([
      "retry-exhausted",
      "unresolved-effect",
      "diverged",
      "diverged",
      "rename-deferred",
      "deletion-deferred",
      "rename-deferred",
      "pending",
    ]);
    expect(status.persistenceFenced).toBe(true);
    expect(status.lastOutcome?.kind).toBe("remote-failure");
    expect(formatMirrorOperationalStatus(status)).toContain(
      "retry.md: retry-exhausted",
    );
  });

  it("formats sanitized unavailable identity and global runtime fencing", () => {
    const disabled = createDisabledMirrorState(DEVICE);
    const status = createMirrorOperationalStatus(
      "configured",
      {
        revision: 2,
        state: {
          ...disabled,
          globalBlockReason: MIRROR_GLOBAL_BLOCK_REASON.runtimeUnavailable,
        },
        persistenceAvailable: true,
        mutationAdmissionAllowed: false,
      },
      null,
      new Map(),
      { kind: "unavailable" },
    );

    expect(formatMirrorOperationalStatus(status)).toContain(
      "Server designation: unavailable",
    );
    expect(formatMirrorOperationalStatus(status)).toContain(
      "Global block: runtime-unavailable",
    );
  });
});

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid fixture value.");
  return value;
}
