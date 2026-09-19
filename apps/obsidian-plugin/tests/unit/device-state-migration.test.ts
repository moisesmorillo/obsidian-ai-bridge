import {
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  createRecoverySnapshotId,
  MAX_MIRROR_TRACKED_PATHS,
  MAX_MUTATION_ATTEMPTS,
  MAX_MUTATION_EVIDENCE_ATTEMPTS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_DEVICE_STATE_V2_VERSION,
  MIRROR_GLOBAL_BLOCK_REASON,
  MIRROR_MUTATION_PHASE,
  MIRROR_PATH_BLOCK_REASON,
  MIRROR_RENAME_PHASE,
  type MirrorDeviceState,
  type MirrorDeviceStateV2,
  type MirrorPathState,
  MUTATION_ACTION,
  normalizeNotePath,
} from "@obsidian-ai-bridge/core";
import {
  decodeMirrorDeviceState,
  encodeMirrorDeviceState,
  MAX_MIRROR_DEVICE_STATE_BYTES,
  MIRROR_DEVICE_STATE_FORMAT,
  MIRROR_DEVICE_STATE_STORAGE_KEY,
} from "@obsidian-plugin/state/device-state-codec";
import {
  migrateMirrorDeviceStateV2ToV3,
  migrateMirrorDeviceStateV3ToV4,
} from "@obsidian-plugin/state/device-state-migration";
import { decodeMirrorDeviceStateV2 } from "@obsidian-plugin/state/device-state-v2.codec";
import { encodeMirrorDeviceStateV3 } from "@obsidian-plugin/state/device-state-v3.codec";
import type { HandoffIntegrity } from "@obsidian-plugin/state/handoff-codec";
import {
  type MirrorDeviceStateMigrationBoundary,
  ObsidianMirrorStateStore,
} from "@obsidian-plugin/state/obsidian-mirror-state-store";
import { describe, expect, it, vi } from "vitest";

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid fixture.");
  return value;
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

const DEVICE = required(createMirrorWriterId(uuid(1)));
const ASSOCIATION = required(createMirrorAssociationId(uuid(2)));
const HASH = required(createContentSha256("ab".repeat(32)));
const ORIGIN = "https://bridge.example";

function revision(index: number) {
  return required(createApplicationRevision(uuid(index)));
}

function operationId(index: number) {
  return required(createMirrorOperationId(uuid(index)));
}

function recoveryId(index: number) {
  return required(createRecoverySnapshotId(uuid(index)));
}

function path(index: number) {
  return required(
    normalizeNotePath(`notes/${index.toString().padStart(5, "0")}.md`),
  );
}

function emptyV2(): MirrorDeviceStateV2 {
  return {
    deviceId: DEVICE,
    lifecycle: {
      kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
      associationId: ASSOCIATION,
      origin: ORIGIN,
    },
    globalBlockReason: null,
    paths: [],
    stagedHandoff: null,
  };
}

function encodeV2(state: MirrorDeviceStateV2): string {
  return JSON.stringify({
    format: MIRROR_DEVICE_STATE_FORMAT,
    version: MIRROR_DEVICE_STATE_V2_VERSION,
    ...state,
  });
}

const integrity: HandoffIntegrity = {
  digest: vi.fn(async () => HASH),
};

class MemoryHost {
  value: unknown;
  readonly loadLocalStorage = vi.fn(async () => this.value);
  readonly saveLocalStorage = vi.fn(
    async (_key: string, value: string | null) => {
      this.value = value;
    },
  );

  constructor(value: unknown) {
    this.value = value;
  }
}

function representativePaths(): readonly MirrorPathState[] {
  const liveRevision = revision(100);
  const paths: MirrorPathState[] = [
    {
      path: path(1),
      acknowledgement: { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
      unresolvedMutation: {
        intent: {
          action: MUTATION_ACTION.create,
          associationId: ASSOCIATION,
          writerId: DEVICE,
          operationId: operationId(101),
          path: path(1),
          precondition: { kind: "absent" },
          contentSha256: HASH,
          mutationAttempts: MAX_MUTATION_ATTEMPTS,
          evidenceAttempts: MAX_MUTATION_EVIDENCE_ATTEMPTS,
        },
        phase: MIRROR_MUTATION_PHASE.dispatched,
      },
      desired: {
        kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent,
        observationGeneration: 9,
      },
      blockedReason: MIRROR_PATH_BLOCK_REASON.unresolvedEffect,
    },
    {
      path: path(2),
      acknowledgement: {
        kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
        revision: liveRevision,
        contentSha256: HASH,
      },
      unresolvedMutation: {
        intent: {
          action: MUTATION_ACTION.update,
          associationId: ASSOCIATION,
          writerId: DEVICE,
          operationId: operationId(102),
          path: path(2),
          precondition: { kind: "matching-revision", revision: liveRevision },
          contentSha256: HASH,
          mutationAttempts: 1,
          evidenceAttempts: MAX_MUTATION_EVIDENCE_ATTEMPTS,
        },
        phase: MIRROR_MUTATION_PHASE.evidenceRequired,
      },
      desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
      blockedReason: MIRROR_PATH_BLOCK_REASON.retryExhausted,
    },
    {
      path: path(3),
      acknowledgement: {
        kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
        revision: revision(103),
        contentSha256: HASH,
      },
      unresolvedMutation: null,
      desired: {
        kind: MIRROR_DESIRED_STATE_KIND.runtimeDelete,
        observationGeneration: 10,
        evidenceId: operationId(104),
        associationId: ASSOCIATION,
        expectedRevision: revision(103),
        graceDeadlineMilliseconds: 5_000,
      },
      blockedReason: null,
    },
    {
      path: path(4),
      acknowledgement: {
        kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
        revision: revision(105),
        contentSha256: HASH,
      },
      unresolvedMutation: {
        intent: {
          action: MUTATION_ACTION.tombstone,
          associationId: ASSOCIATION,
          writerId: DEVICE,
          operationId: operationId(106),
          path: path(4),
          precondition: {
            kind: "matching-revision",
            revision: revision(105),
          },
          mutationAttempts: 2,
          evidenceAttempts: 1,
        },
        phase: MIRROR_MUTATION_PHASE.recoveryPreparation,
      },
      desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
      blockedReason: null,
    },
    {
      path: path(5),
      acknowledgement: {
        kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
        revision: revision(107),
        recoveryId: recoveryId(108),
      },
      unresolvedMutation: {
        intent: {
          action: MUTATION_ACTION.recreate,
          associationId: ASSOCIATION,
          writerId: DEVICE,
          operationId: operationId(109),
          path: path(5),
          precondition: {
            kind: "matching-revision",
            revision: revision(107),
          },
          contentSha256: HASH,
          mutationAttempts: 0,
          evidenceAttempts: 0,
        },
        phase: MIRROR_MUTATION_PHASE.intentPersisted,
      },
      desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
      blockedReason: MIRROR_PATH_BLOCK_REASON.diverged,
    },
    {
      path: path(6),
      acknowledgement: {
        kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
        revision: revision(110),
        contentSha256: HASH,
      },
      unresolvedMutation: null,
      desired: {
        kind: MIRROR_DESIRED_STATE_KIND.renameDeferred,
        observationGeneration: 11,
        renameId: operationId(111),
        associationId: ASSOCIATION,
        sourcePath: path(6),
        destinationPath: path(7),
        sourceExpectedRevision: revision(110),
        destinationObservationGeneration: 12,
        destinationAcknowledgedRevision: null,
        graceDeadlineMilliseconds: 6_000,
        phase: MIRROR_RENAME_PHASE.invalidated,
      },
      blockedReason: MIRROR_PATH_BLOCK_REASON.renameDeferred,
    },
  ];
  return paths;
}

describe("frozen version-2 codec and deterministic version-3 migration", () => {
  it("strictly rejects missing, malformed, oversized, and invalid-identity v2 input", async () => {
    expect(await decodeMirrorDeviceStateV2(null, integrity)).toEqual({
      kind: "missing",
    });
    expect(await decodeMirrorDeviceStateV2("{", integrity)).toEqual({
      kind: "corrupt",
    });
    expect(
      await decodeMirrorDeviceStateV2(
        `"${"x".repeat(MAX_MIRROR_DEVICE_STATE_BYTES)}"`,
        integrity,
      ),
    ).toEqual({ kind: "corrupt" });
    const invalidIdentity = JSON.parse(encodeV2(emptyV2()));
    invalidIdentity.deviceId = "invalid";
    expect(
      await decodeMirrorDeviceStateV2(
        JSON.stringify(invalidIdentity),
        integrity,
      ),
    ).toEqual({ kind: "corrupt" });

    const paused: MirrorDeviceStateV2 = {
      ...emptyV2(),
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.paused,
        associationId: ASSOCIATION,
        origin: ORIGIN,
        reason: "manual",
      },
    };
    expect(
      await decodeMirrorDeviceStateV2(encodeV2(paused), integrity),
    ).toEqual({
      kind: "valid",
      state: paused,
    });
  });

  it("projects every representative M3 field exactly and adds only empty sparse M4 state", async () => {
    const state: MirrorDeviceStateV2 = {
      ...emptyV2(),
      globalBlockReason: MIRROR_GLOBAL_BLOCK_REASON.persistenceFailed,
      paths: representativePaths(),
    };
    const decoded = await decodeMirrorDeviceStateV2(encodeV2(state), integrity);
    expect(decoded).toEqual({ kind: "valid", state });
    if (decoded.kind !== "valid") throw new Error("Expected valid v2 state.");

    const first = migrateMirrorDeviceStateV2ToV3(decoded.state);
    const second = migrateMirrorDeviceStateV2ToV3(decoded.state);
    expect(first).toEqual({
      ...state,
      reconciliationReviews: [],
      reconciliationOperations: [],
    });
    expect(second).toEqual(first);
    expect(encodeMirrorDeviceStateV3(second)).toBe(
      encodeMirrorDeviceStateV3(first),
    );
  });

  it.each([
    MIRROR_DEVICE_LIFECYCLE_KIND.active,
    MIRROR_DEVICE_LIFECYCLE_KIND.paused,
    MIRROR_DEVICE_LIFECYCLE_KIND.handoffDraining,
    MIRROR_DEVICE_LIFECYCLE_KIND.handoffDrained,
  ] as const)("preserves %s lifecycle without activating anything", (kind) => {
    const state: MirrorDeviceStateV2 = {
      ...emptyV2(),
      lifecycle:
        kind === MIRROR_DEVICE_LIFECYCLE_KIND.paused
          ? {
              kind,
              associationId: ASSOCIATION,
              origin: ORIGIN,
              reason: "manual",
            }
          : { kind, associationId: ASSOCIATION, origin: ORIGIN },
    };
    expect(migrateMirrorDeviceStateV2ToV3(state).lifecycle).toEqual(
      state.lifecycle,
    );
  });

  it("preserves disabled and staged-handoff state without auto-activation", async () => {
    const disabled: MirrorDeviceStateV2 = {
      ...emptyV2(),
      lifecycle: { kind: MIRROR_DEVICE_LIFECYCLE_KIND.disabled },
    };
    expect(migrateMirrorDeviceStateV2ToV3(disabled).lifecycle.kind).toBe(
      MIRROR_DEVICE_LIFECYCLE_KIND.disabled,
    );

    const staged: MirrorDeviceStateV2 = {
      ...emptyV2(),
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged,
        associationId: ASSOCIATION,
        origin: ORIGIN,
      },
      stagedHandoff: {
        associationId: ASSOCIATION,
        origin: ORIGIN,
        checksum: HASH,
        entries: [
          {
            path: path(1),
            acknowledgement: {
              kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
              revision: revision(120),
              recoveryId: recoveryId(121),
            },
            localAlignment: "pending",
            remoteVerification: "matched",
            observationGeneration: 4,
          },
        ],
      },
    };
    const host = new MemoryHost(encodeV2(staged));
    const loaded = await new ObsidianMirrorStateStore(host, integrity).load();
    expect(loaded.kind).toBe("valid");
    if (loaded.kind !== "valid") throw new Error("Expected migrated state.");
    expect(loaded.state.lifecycle).toEqual(staged.lifecycle);
    expect(loaded.state.stagedHandoff).toEqual(staged.stagedHandoff);
    expect(loaded.state.paths).toEqual([]);
    expect(host.saveLocalStorage).toHaveBeenCalledTimes(1);
    expect(host.loadLocalStorage).toHaveBeenCalledTimes(2);
  });

  it("fails closed on staged-handoff integrity mismatch before migration", async () => {
    const staged: MirrorDeviceStateV2 = {
      ...emptyV2(),
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged,
        associationId: ASSOCIATION,
        origin: ORIGIN,
      },
      stagedHandoff: {
        associationId: ASSOCIATION,
        origin: ORIGIN,
        checksum: HASH,
        entries: [],
      },
    };
    const host = new MemoryHost(encodeV2(staged));
    const mismatchingIntegrity: HandoffIntegrity = {
      digest: async () => required(createContentSha256("cd".repeat(32))),
    };
    expect(
      await new ObsidianMirrorStateStore(host, mismatchingIntegrity).load(),
    ).toEqual({ kind: "corrupt" });
    expect(host.saveLocalStorage).not.toHaveBeenCalled();
  });

  it("refuses version 4 in the frozen v2 decoder and version 2 in the current decoder", async () => {
    const current: MirrorDeviceState = {
      ...emptyV2(),
      reconciliationReviews: [],
      reconciliationOperations: [],
    };
    expect(
      await decodeMirrorDeviceStateV2(
        encodeMirrorDeviceState(current),
        integrity,
      ),
    ).toEqual({ kind: "unsupported-version", version: 4 });
    expect(
      await decodeMirrorDeviceState(encodeV2(emptyV2()), integrity),
    ).toEqual({
      kind: "unsupported-version",
      version: 2,
    });
  });

  it("migrates once, saves to the same key, and requires exact read-back", async () => {
    const host = new MemoryHost(encodeV2(emptyV2()));
    const loaded = await new ObsidianMirrorStateStore(host, integrity).load();
    expect(loaded.kind).toBe("valid");
    expect(host.saveLocalStorage).toHaveBeenCalledTimes(1);
    expect(host.saveLocalStorage).toHaveBeenCalledWith(
      MIRROR_DEVICE_STATE_STORAGE_KEY,
      expect.any(String),
    );
    expect(host.loadLocalStorage).toHaveBeenCalledTimes(2);
    expect(typeof host.value).toBe("string");
    expect(await decodeMirrorDeviceState(host.value, integrity)).toEqual(
      loaded,
    );
  });

  it.each([
    {
      name: "version 1",
      value: JSON.stringify({ format: MIRROR_DEVICE_STATE_FORMAT, version: 1 }),
    },
    {
      name: "future version",
      value: JSON.stringify({ format: MIRROR_DEVICE_STATE_FORMAT, version: 5 }),
    },
    {
      name: "malformed version",
      value: JSON.stringify({
        format: MIRROR_DEVICE_STATE_FORMAT,
        version: "2",
      }),
    },
    {
      name: "corrupt v2",
      value: JSON.stringify({ format: MIRROR_DEVICE_STATE_FORMAT, version: 2 }),
    },
    { name: "invalid JSON", value: "{" },
  ])("fails closed and leaves $name untouched", async ({ value }) => {
    const host = new MemoryHost(value);
    const loaded = await new ObsidianMirrorStateStore(host, integrity).load();
    expect(["corrupt", "unsupported-version"]).toContain(loaded.kind);
    expect(host.value).toBe(value);
    expect(host.saveLocalStorage).not.toHaveBeenCalled();
  });

  it("rejects an invalid migration projection even when called outside the decoder", () => {
    const invalid: MirrorDeviceStateV2 = {
      ...emptyV2(),
      lifecycle: { kind: MIRROR_DEVICE_LIFECYCLE_KIND.disabled },
      paths: representativePaths(),
    };
    expect(() => migrateMirrorDeviceStateV2ToV3(invalid)).toThrow(
      "version-3 invariants",
    );
  });

  it("maps raw load, migration invariant, and v3 encode failures to unavailable", async () => {
    const loadFailure = new MemoryHost(encodeV2(emptyV2()));
    loadFailure.loadLocalStorage.mockRejectedValueOnce(new Error("load"));
    expect(
      await new ObsidianMirrorStateStore(loadFailure, integrity).load(),
    ).toEqual({ kind: "unavailable" });

    for (const failingMember of ["migrateV2", "migrateV3", "encode"] as const) {
      const host = new MemoryHost(encodeV2(emptyV2()));
      const migration: MirrorDeviceStateMigrationBoundary = {
        migrateV2: (state) => {
          if (failingMember === "migrateV2") throw new Error("invariant");
          return migrateMirrorDeviceStateV2ToV3(state);
        },
        migrateV3: (state) => {
          if (failingMember === "migrateV3") throw new Error("invariant");
          return migrateMirrorDeviceStateV3ToV4(state);
        },
        encode: (state) => {
          if (failingMember === "encode") throw new Error("encode");
          return encodeMirrorDeviceState(state);
        },
      };
      expect(
        await new ObsidianMirrorStateStore(host, integrity, migration).load(),
      ).toEqual({ kind: "unavailable" });
      expect(host.value).toBe(encodeV2(emptyV2()));
    }
  });

  it("contains integrity-provider failures at current, historical, verification, and save boundaries", async () => {
    const stagedV2: MirrorDeviceStateV2 = {
      ...emptyV2(),
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged,
        associationId: ASSOCIATION,
        origin: ORIGIN,
      },
      stagedHandoff: {
        associationId: ASSOCIATION,
        origin: ORIGIN,
        checksum: HASH,
        entries: [],
      },
    };
    const stagedV3 = migrateMirrorDeviceStateV2ToV3(stagedV2);
    const throwingIntegrity: HandoffIntegrity = {
      digest: async () => {
        throw new Error("digest");
      },
    };
    expect(
      await new ObsidianMirrorStateStore(
        new MemoryHost(encodeMirrorDeviceStateV3(stagedV3)),
        throwingIntegrity,
      ).load(),
    ).toEqual({ kind: "unavailable" });
    expect(
      await new ObsidianMirrorStateStore(
        new MemoryHost(encodeV2(stagedV2)),
        throwingIntegrity,
      ).load(),
    ).toEqual({ kind: "unavailable" });

    let digests = 0;
    const verificationFailure: HandoffIntegrity = {
      digest: async () => {
        digests += 1;
        if (digests === 1) return HASH;
        throw new Error("read-back integrity");
      },
    };
    expect(
      await new ObsidianMirrorStateStore(
        new MemoryHost(encodeV2(stagedV2)),
        verificationFailure,
      ).load(),
    ).toEqual({ kind: "unavailable" });

    expect(
      await new ObsidianMirrorStateStore(
        new MemoryHost(null),
        throwingIntegrity,
      ).save(migrateMirrorDeviceStateV3ToV4(stagedV3)),
    ).toEqual({ kind: "failed", reason: "unavailable" });
  });

  it("fails closed for save/quota, read-back failure, and read-back mismatch", async () => {
    const saveFailure = new MemoryHost(encodeV2(emptyV2()));
    saveFailure.saveLocalStorage.mockRejectedValueOnce(new Error("quota"));
    expect(
      await new ObsidianMirrorStateStore(saveFailure, integrity).load(),
    ).toEqual({ kind: "unavailable" });

    const readFailure = new MemoryHost(encodeV2(emptyV2()));
    readFailure.loadLocalStorage
      .mockResolvedValueOnce(readFailure.value)
      .mockRejectedValueOnce(new Error("read-back"));
    expect(
      await new ObsidianMirrorStateStore(readFailure, integrity).load(),
    ).toEqual({ kind: "unavailable" });

    const mismatch = new MemoryHost(encodeV2(emptyV2()));
    mismatch.saveLocalStorage.mockImplementationOnce(async () => {
      mismatch.value = `${encodeMirrorDeviceState(
        migrateMirrorDeviceStateV3ToV4(
          migrateMirrorDeviceStateV2ToV3(emptyV2()),
        ),
      )} `;
    });
    expect(
      await new ObsidianMirrorStateStore(mismatch, integrity).load(),
    ).toEqual({ kind: "unavailable" });
  });

  it("does not publish while save or read-back is pending", async () => {
    let releaseSave: (() => void) | undefined;
    const saveBarrier = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const host = new MemoryHost(encodeV2(emptyV2()));
    host.saveLocalStorage.mockImplementationOnce(async (_key, value) => {
      await saveBarrier;
      host.value = value;
    });
    let published = false;
    const loading = new ObsidianMirrorStateStore(host, integrity)
      .load()
      .then((result) => {
        published = true;
        return result;
      });
    await Promise.resolve();
    expect(published).toBe(false);
    required(releaseSave)();
    expect((await loading).kind).toBe("valid");

    let releaseRead: (() => void) | undefined;
    const readBarrier = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readHost = new MemoryHost(encodeV2(emptyV2()));
    let loads = 0;
    readHost.loadLocalStorage.mockImplementation(async () => {
      loads += 1;
      if (loads === 2) await readBarrier;
      return readHost.value;
    });
    published = false;
    const reading = new ObsidianMirrorStateStore(readHost, integrity)
      .load()
      .then((result) => {
        published = true;
        return result;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(published).toBe(false);
    required(releaseRead)();
    expect((await reading).kind).toBe("valid");
  });

  it("retries untouched v2 and safely loads a committed v3 after read-back failure", async () => {
    const untouched = new MemoryHost(encodeV2(emptyV2()));
    untouched.saveLocalStorage.mockRejectedValueOnce(new Error("quota"));
    expect(
      await new ObsidianMirrorStateStore(untouched, integrity).load(),
    ).toEqual({ kind: "unavailable" });
    untouched.saveLocalStorage.mockImplementation(async (_key, value) => {
      untouched.value = value;
    });
    expect(
      (await new ObsidianMirrorStateStore(untouched, integrity).load()).kind,
    ).toBe("valid");
    expect(untouched.saveLocalStorage).toHaveBeenCalledTimes(2);

    const committed = new MemoryHost(encodeV2(emptyV2()));
    committed.loadLocalStorage
      .mockResolvedValueOnce(committed.value)
      .mockRejectedValueOnce(new Error("read-back"));
    expect(
      await new ObsidianMirrorStateStore(committed, integrity).load(),
    ).toEqual({ kind: "unavailable" });
    committed.loadLocalStorage.mockImplementation(async () => committed.value);
    const saveCalls = committed.saveLocalStorage.mock.calls.length;
    expect(
      (await new ObsidianMirrorStateStore(committed, integrity).load()).kind,
    ).toBe("valid");
    expect(committed.saveLocalStorage).toHaveBeenCalledTimes(saveCalls);
  });

  it("recovers safely when a same-key save commits and then reports interruption", async () => {
    const host = new MemoryHost(encodeV2(emptyV2()));
    host.saveLocalStorage.mockImplementationOnce(async (_key, value) => {
      host.value = value;
      throw new Error("interrupted after commit");
    });
    expect(await new ObsidianMirrorStateStore(host, integrity).load()).toEqual({
      kind: "unavailable",
    });
    const saveCalls = host.saveLocalStorage.mock.calls.length;
    expect(
      (await new ObsidianMirrorStateStore(host, integrity).load()).kind,
    ).toBe("valid");
    expect(host.saveLocalStorage).toHaveBeenCalledTimes(saveCalls);
  });

  it("migrates exactly 50,000 paths without per-path M4 growth and stays bounded", () => {
    const paths: MirrorPathState[] = Array.from(
      { length: MAX_MIRROR_TRACKED_PATHS },
      (_, index) => ({
        path: path(index),
        acknowledgement: { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
        unresolvedMutation: null,
        desired: { kind: MIRROR_DESIRED_STATE_KIND.none },
        blockedReason: null,
      }),
    );
    const migrated = migrateMirrorDeviceStateV2ToV3({
      ...emptyV2(),
      paths,
    });
    expect(migrated.paths).toHaveLength(MAX_MIRROR_TRACKED_PATHS);
    expect(migrated.reconciliationReviews).toEqual([]);
    expect(migrated.reconciliationOperations).toEqual([]);
    const encoded = encodeMirrorDeviceState(
      migrateMirrorDeviceStateV3ToV4(migrated),
    );
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(
      MAX_MIRROR_DEVICE_STATE_BYTES,
    );
  });
});
