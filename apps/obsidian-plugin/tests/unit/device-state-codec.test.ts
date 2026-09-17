import {
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  isNormalizedNotePath,
  MAX_MUTATION_ATTEMPTS,
  MAX_MUTATION_EVIDENCE_ATTEMPTS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_DEVICE_STATE_VERSION,
  type MirrorDeviceState,
  MUTATION_ACTION,
  type NotePath,
  normalizeNotePath,
} from "@obsidian-ai-bridge/core";
import {
  decodeMirrorDeviceState,
  encodeMirrorDeviceState,
  MAX_MIRROR_DEVICE_STATE_BYTES,
  MIRROR_DEVICE_STATE_FORMAT,
} from "@obsidian-plugin/state/device-state-codec";
import {
  createHandoffRecord,
  WebCryptoHandoffIntegrity,
} from "@obsidian-plugin/state/handoff-codec";
import { describe, expect, it } from "vitest";

const DEVICE_ID = required(
  createMirrorWriterId("11111111-1111-4111-8111-111111111111"),
);
const ASSOCIATION_ID = required(
  createMirrorAssociationId("22222222-2222-4222-8222-222222222222"),
);
const OPERATION_ID = required(
  createMirrorOperationId("33333333-3333-4333-8333-333333333333"),
);
const OTHER_OPERATION_ID = required(
  createMirrorOperationId("66666666-6666-4666-8666-666666666666"),
);
const REVISION = required(
  createApplicationRevision("44444444-4444-4444-8444-444444444444"),
);
const OTHER_REVISION = required(
  createApplicationRevision("55555555-5555-4555-8555-555555555555"),
);
const HASH = required(createContentSha256("ab".repeat(32)));
const PATH = required(normalizeNotePath("notes/example.md"));

function state(): MirrorDeviceState {
  return {
    deviceId: DEVICE_ID,
    lifecycle: {
      kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
      associationId: ASSOCIATION_ID,
      origin: "https://bridge.example",
    },
    globalBlockReason: null,
    paths: [
      {
        path: PATH,
        acknowledgement: {
          kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
          revision: REVISION,
          contentSha256: HASH,
        },
        unresolvedMutation: {
          intent: {
            action: MUTATION_ACTION.update,
            associationId: ASSOCIATION_ID,
            writerId: DEVICE_ID,
            operationId: OPERATION_ID,
            path: PATH,
            precondition: { kind: "matching-revision", revision: REVISION },
            contentSha256: HASH,
            mutationAttempts: MAX_MUTATION_ATTEMPTS,
            evidenceAttempts: MAX_MUTATION_EVIDENCE_ATTEMPTS,
          },
          phase: "evidence-required",
        },
        desired: {
          kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent,
          observationGeneration: 7,
        },
        blockedReason: "unresolved-effect",
      },
    ],
    stagedHandoff: null,
    reconciliationReviews: [],
    reconciliationOperations: [],
  };
}

describe("device-local mirror state codec", () => {
  it("distinguishes missing state without synthesizing deletion evidence", async () => {
    expect(await decodeMirrorDeviceState(null)).toEqual({ kind: "missing" });
    expect(await decodeMirrorDeviceState(undefined)).toEqual({
      kind: "missing",
    });
  });

  it("round-trips current state and preserves finite retry/evidence budgets", async () => {
    const encoded = encodeMirrorDeviceState(state());
    const decoded = await decodeMirrorDeviceState(encoded);
    expect(decoded).toEqual({ kind: "valid", state: state() });
    if (decoded.kind !== "valid") throw new Error("Expected valid state.");
    expect(decoded.state.paths[0]?.unresolvedMutation).toMatchObject({
      phase: "evidence-required",
      intent: {
        mutationAttempts: MAX_MUTATION_ATTEMPTS,
        evidenceAttempts: MAX_MUTATION_EVIDENCE_ATTEMPTS,
      },
    });
  });

  it("round-trips literal local paths without URI decoding", async () => {
    const literal = literalPath("notes/literal%20name.md");
    const literalState: MirrorDeviceState = {
      ...state(),
      paths: [
        {
          ...required(state().paths[0]),
          path: literal,
          unresolvedMutation: null,
          desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
          blockedReason: null,
        },
      ],
    };

    await expect(
      decodeMirrorDeviceState(encodeMirrorDeviceState(literalState)),
    ).resolves.toEqual({ kind: "valid", state: literalState });
  });

  it.each(["{", "[]", "null", "{}"])(
    "rejects corrupt JSON/object state: %s",
    async (encoded) => {
      expect(await decodeMirrorDeviceState(encoded)).toEqual({
        kind: "corrupt",
      });
    },
  );

  it("classifies incompatible legacy state as unsupported", async () => {
    expect(
      await decodeMirrorDeviceState(
        JSON.stringify({ format: MIRROR_DEVICE_STATE_FORMAT, version: 1 }),
      ),
    ).toEqual({ kind: "unsupported-version", version: 1 });
  });

  it("distinguishes an unsupported future version and rejects unknown fields", async () => {
    expect(
      await decodeMirrorDeviceState(
        JSON.stringify({ format: MIRROR_DEVICE_STATE_FORMAT, version: 4 }),
      ),
    ).toEqual({ kind: "unsupported-version", version: 4 });
    const raw = rawState();
    expect(
      await decodeMirrorDeviceState(JSON.stringify({ ...raw, surprise: true })),
    ).toEqual({
      kind: "corrupt",
    });
  });

  it("rejects duplicate path entries and inconsistent intent ownership", async () => {
    const raw = rawState();
    const first = required(raw.paths[0]);
    expect(
      await decodeMirrorDeviceState(
        JSON.stringify({ ...raw, paths: [first, first] }),
      ),
    ).toEqual({
      kind: "corrupt",
    });
    expect(
      await decodeMirrorDeviceState(
        JSON.stringify({
          ...raw,
          paths: [
            {
              ...first,
              unresolvedMutation: {
                ...required(first.unresolvedMutation),
                intent: {
                  ...required(first.unresolvedMutation).intent,
                  writerId: "99999999-9999-4999-8999-999999999999",
                },
              },
            },
          ],
        }),
      ),
    ).toEqual({ kind: "corrupt" });
  });

  it.each([
    ["invalid NotePath", { path: "../bad.md" }],
    ["invalid device UUID", { deviceId: "not-a-uuid" }],
    [
      "invalid revision",
      {
        acknowledgement: { kind: "live", revision: "bad", contentSha256: HASH },
      },
    ],
    [
      "invalid hash",
      {
        acknowledgement: {
          kind: "live",
          revision: REVISION,
          contentSha256: "BAD",
        },
      },
    ],
    [
      "invalid recovery ID",
      {
        acknowledgement: {
          kind: "tombstone",
          revision: REVISION,
          recoveryId: "bad",
        },
      },
    ],
  ])("rejects %s", async (_label, replacement) => {
    const raw = rawState();
    const first = required(raw.paths[0]);
    const rootReplacement = "deviceId" in replacement ? replacement : {};
    const pathReplacement = "deviceId" in replacement ? {} : replacement;
    expect(
      await decodeMirrorDeviceState(
        JSON.stringify({
          ...raw,
          ...rootReplacement,
          paths: [{ ...first, ...pathReplacement, unresolvedMutation: null }],
        }),
      ),
    ).toEqual({ kind: "corrupt" });
  });

  it("decodes closed lifecycle, acknowledgement, intent-phase, and desired-state variants", async () => {
    const disabled: MirrorDeviceState = {
      ...state(),
      lifecycle: { kind: MIRROR_DEVICE_LIFECYCLE_KIND.disabled },
      paths: [],
    };
    const createIntent: MirrorDeviceState = {
      ...state(),
      paths: [
        {
          path: PATH,
          acknowledgement: { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
          unresolvedMutation: {
            intent: {
              action: MUTATION_ACTION.create,
              associationId: ASSOCIATION_ID,
              writerId: DEVICE_ID,
              operationId: OPERATION_ID,
              path: PATH,
              precondition: { kind: "absent" },
              contentSha256: HASH,
              mutationAttempts: 1,
              evidenceAttempts: 0,
            },
            phase: "intent-persisted",
          },
          desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
          blockedReason: null,
        },
      ],
    };
    const tombstone = {
      kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
      revision: REVISION,
      recoveryId: OPERATION_ID,
    } as const;
    const recreate: MirrorDeviceState = {
      ...state(),
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.paused,
        associationId: ASSOCIATION_ID,
        origin: "https://bridge.example",
        reason: "manual",
      },
      paths: [
        {
          path: PATH,
          acknowledgement: tombstone,
          unresolvedMutation: {
            intent: {
              action: MUTATION_ACTION.recreate,
              associationId: ASSOCIATION_ID,
              writerId: DEVICE_ID,
              operationId: OTHER_OPERATION_ID,
              path: PATH,
              precondition: { kind: "matching-revision", revision: REVISION },
              contentSha256: HASH,
              mutationAttempts: 2,
              evidenceAttempts: 1,
            },
            phase: "dispatched",
          },
          desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
          blockedReason: null,
        },
      ],
    };
    const renameDeferred: MirrorDeviceState = {
      ...state(),
      paths: state().paths.map((entry) => ({
        ...entry,
        unresolvedMutation: null,
        desired: {
          kind: MIRROR_DESIRED_STATE_KIND.renameDeferred,
          observationGeneration: 3,
          renameId: OTHER_OPERATION_ID,
          associationId: ASSOCIATION_ID,
          sourcePath: PATH,
          destinationPath: required(normalizeNotePath("notes/renamed.md")),
          sourceExpectedRevision: REVISION,
          destinationObservationGeneration: 4,
          destinationAcknowledgedRevision: null,
          graceDeadlineMilliseconds: 5_000,
          phase: "destination-required",
        },
        blockedReason: null,
      })),
    };
    const handoffRecord = await createHandoffRecord(
      {
        associationId: ASSOCIATION_ID,
        origin: "https://bridge.example",
        entries: [{ path: PATH, acknowledgement: tombstone }],
      },
      new WebCryptoHandoffIntegrity(),
    );
    const draining: MirrorDeviceState = {
      ...state(),
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.handoffDraining,
        associationId: ASSOCIATION_ID,
        origin: "https://bridge.example",
      },
    };
    const drained: MirrorDeviceState = {
      ...state(),
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.handoffDrained,
        associationId: ASSOCIATION_ID,
        origin: "https://bridge.example",
      },
      paths: [],
    };
    const staged: MirrorDeviceState = {
      ...state(),
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged,
        associationId: ASSOCIATION_ID,
        origin: "https://bridge.example",
      },
      paths: [],
      stagedHandoff: {
        associationId: ASSOCIATION_ID,
        origin: "https://bridge.example",
        checksum: handoffRecord.checksum,
        entries: [
          {
            path: PATH,
            acknowledgement: tombstone,
            localAlignment: "matched",
            remoteVerification: "matched",
            observationGeneration: 4,
          },
        ],
      },
    };
    for (const candidate of [
      disabled,
      createIntent,
      recreate,
      renameDeferred,
      draining,
      drained,
      staged,
    ]) {
      expect(
        await decodeMirrorDeviceState(encodeMirrorDeviceState(candidate)),
      ).toEqual({
        kind: "valid",
        state: candidate,
      });
    }
    expect(
      await decodeMirrorDeviceState(
        JSON.stringify({
          ...rawState(),
          lifecycle: {
            kind: MIRROR_DEVICE_LIFECYCLE_KIND.paused,
            associationId: ASSOCIATION_ID,
            origin: "https://bridge.example",
            reason: "handoff",
          },
        }),
      ),
    ).toEqual({ kind: "corrupt" });
    const runtimeDelete: MirrorDeviceState = {
      ...state(),
      paths: state().paths.map((entry) => ({
        ...entry,
        unresolvedMutation: null,
        desired: {
          kind: MIRROR_DESIRED_STATE_KIND.runtimeDelete,
          observationGeneration: 9,
          evidenceId: OTHER_OPERATION_ID,
          associationId: ASSOCIATION_ID,
          expectedRevision: REVISION,
          graceDeadlineMilliseconds: 5_000,
        },
      })),
    };
    expect(
      await decodeMirrorDeviceState(encodeMirrorDeviceState(runtimeDelete)),
    ).toEqual({
      kind: "valid",
      state: runtimeDelete,
    });
  });

  it("rejects persisted intents whose precondition is not the current ACK", async () => {
    const raw = rawState();
    const path = required(raw.paths[0]);
    const unresolved = required(path.unresolvedMutation);
    expect(
      await decodeMirrorDeviceState(
        JSON.stringify({
          ...raw,
          paths: [
            {
              ...path,
              unresolvedMutation: {
                ...unresolved,
                intent: {
                  ...unresolved.intent,
                  precondition: {
                    kind: "matching-revision",
                    revision: OTHER_REVISION,
                  },
                },
              },
            },
          ],
        }),
      ),
    ).toEqual({ kind: "corrupt" });
  });

  it("rejects operation/recovery collisions and self-referential renames", async () => {
    const raw = rawState();
    const path = required(raw.paths[0]);
    const unresolved = required(path.unresolvedMutation);
    expect(
      await decodeMirrorDeviceState(
        JSON.stringify({
          ...raw,
          paths: [
            {
              ...path,
              acknowledgement: {
                kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
                revision: REVISION,
                recoveryId: OPERATION_ID,
              },
              unresolvedMutation: {
                ...unresolved,
                intent: {
                  ...unresolved.intent,
                  action: MUTATION_ACTION.recreate,
                  operationId: OPERATION_ID,
                },
              },
            },
          ],
        }),
      ),
    ).toEqual({ kind: "corrupt" });
    expect(
      await decodeMirrorDeviceState(
        JSON.stringify({
          ...raw,
          paths: [
            {
              ...path,
              unresolvedMutation: null,
              desired: {
                kind: MIRROR_DESIRED_STATE_KIND.renameDeferred,
                observationGeneration: 1,
                counterpartPath: PATH,
                phase: "destination-required",
              },
            },
          ],
        }),
      ),
    ).toEqual({ kind: "corrupt" });
  });

  it("projects every nested variant without structurally assignable private fields", () => {
    const current = state();
    const path = required(current.paths[0]);
    const unresolved = required(path.unresolvedMutation);
    const lifecycleWithPrivate = {
      ...current.lifecycle,
      token: "PRIVATE_TOKEN",
    };
    const acknowledgementWithPrivate = {
      ...path.acknowledgement,
      token: "PRIVATE_ACK_TOKEN",
    };
    const intentWithPrivate = {
      ...unresolved.intent,
      content: "PRIVATE_INTENT_CONTENT",
    };
    const unresolvedWithPrivate = {
      ...unresolved,
      body: "PRIVATE_UNRESOLVED_BODY",
      intent: intentWithPrivate,
    };
    const desiredWithPrivate = {
      ...path.desired,
      token: "PRIVATE_DESIRED_TOKEN",
      deviceId: "PRIVATE_DESIRED_DEVICE",
    };
    const pathWithPrivate = {
      ...path,
      activation: true,
      body: "PRIVATE_PATH_BODY",
      acknowledgement: acknowledgementWithPrivate,
      unresolvedMutation: unresolvedWithPrivate,
      desired: desiredWithPrivate,
    };
    const structurallyAssignable = {
      ...current,
      lifecycle: lifecycleWithPrivate,
      paths: [pathWithPrivate],
    };
    const encoded = encodeMirrorDeviceState(structurallyAssignable);
    expect(encoded).not.toMatch(/PRIVATE_|"(?:token|body|content|activation)"/);
    const projected = JSON.parse(encoded);
    expect(projected.paths[0].desired).not.toHaveProperty("deviceId");
  });

  it("rejects unsafe numeric state before persistence encoding or decode", async () => {
    const current = state();
    const path = required(current.paths[0]);
    const unresolved = required(path.unresolvedMutation);
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1]) {
      const candidate: MirrorDeviceState = {
        ...current,
        paths: [
          {
            ...path,
            unresolvedMutation: {
              ...unresolved,
              intent: { ...unresolved.intent, mutationAttempts: invalid },
            },
          },
        ],
      };
      expect(() => encodeMirrorDeviceState(candidate)).toThrow("invariant");
    }
    const raw = rawState();
    const rawPath = required(raw.paths[0]);
    expect(
      await decodeMirrorDeviceState(
        JSON.stringify({
          ...raw,
          paths: [
            {
              ...rawPath,
              desired: {
                kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent,
                observationGeneration: 1.5,
              },
            },
          ],
        }),
      ),
    ).toEqual({ kind: "corrupt" });
  });

  it("re-verifies a persisted staged baseline checksum before accepting it", async () => {
    const integrity = new WebCryptoHandoffIntegrity();
    const record = await createHandoffRecord(
      {
        associationId: ASSOCIATION_ID,
        origin: "https://bridge.example",
        entries: [
          {
            path: PATH,
            acknowledgement: {
              kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
              revision: REVISION,
              contentSha256: HASH,
            },
          },
        ],
      },
      integrity,
    );
    const staged: MirrorDeviceState = {
      deviceId: DEVICE_ID,
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged,
        associationId: ASSOCIATION_ID,
        origin: "https://bridge.example",
      },
      globalBlockReason: null,
      paths: [],
      stagedHandoff: {
        associationId: ASSOCIATION_ID,
        origin: "https://bridge.example",
        checksum: record.checksum,
        entries: record.entries.map((entry) => ({
          ...entry,
          localAlignment: "pending",
          remoteVerification: "pending",
          observationGeneration: 1,
        })),
      },
      reconciliationReviews: [],
      reconciliationOperations: [],
    };
    const stagedEntry = required(staged.stagedHandoff?.entries[0]);
    const stagedWithPrivate = {
      ...staged,
      stagedHandoff: {
        ...required(staged.stagedHandoff),
        deviceId: "PRIVATE_STAGED_DEVICE",
        entries: [
          {
            ...stagedEntry,
            body: "PRIVATE_STAGED_BODY",
            acknowledgement: {
              ...stagedEntry.acknowledgement,
              token: "PRIVATE_STAGED_ACK_TOKEN",
            },
          },
        ],
      },
    };
    const encoded = encodeMirrorDeviceState(stagedWithPrivate);
    expect(encoded).not.toMatch(/PRIVATE_|"(?:token|body|content)"/);
    const persisted = JSON.parse(encoded);
    persisted.stagedHandoff.entries[0].acknowledgement.contentSha256 =
      "cd".repeat(32);
    expect(
      await decodeMirrorDeviceState(JSON.stringify(persisted), integrity),
    ).toEqual({ kind: "corrupt" });
  });

  it("serializes no bearer, token, note body, or content field and stays bounded", async () => {
    const privateValues = ["BEARER_PRIVATE", "PRIVATE NOTE BODY"];
    const encoded = encodeMirrorDeviceState(state());
    for (const value of privateValues) expect(encoded).not.toContain(value);
    expect(encoded).not.toMatch(/"(?:bearer|token|body|content)"/i);
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(
      MAX_MIRROR_DEVICE_STATE_BYTES,
    );
    expect(
      await decodeMirrorDeviceState(
        `"${"x".repeat(MAX_MIRROR_DEVICE_STATE_BYTES)}"`,
      ),
    ).toEqual({
      kind: "corrupt",
    });
  });
});

function rawState() {
  const current = state();
  return {
    format: MIRROR_DEVICE_STATE_FORMAT,
    version: MIRROR_DEVICE_STATE_VERSION,
    deviceId: current.deviceId,
    lifecycle: current.lifecycle,
    globalBlockReason: current.globalBlockReason,
    paths: current.paths,
    stagedHandoff: current.stagedHandoff,
  };
}

function literalPath(value: string): NotePath {
  if (!isNormalizedNotePath(value))
    throw new Error(`Invalid local path: ${value}`);
  return value;
}

function required<Value>(value: Value | undefined | null): Value {
  if (value === undefined || value === null)
    throw new Error("Invalid fixture value.");
  return value;
}
