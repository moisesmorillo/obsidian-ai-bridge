import { createContentSha256 } from "@obsidian-ai-bridge/core";
import {
  syncInventoryActiveKey,
  syncInventoryChunkKey,
  syncInventoryClaimKey,
  syncInventoryCursorWitnessKey,
  syncInventoryManifestKey,
} from "@protocol/sync.codec";
import {
  syncInventoryIdSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type { SyncRecordObservation } from "@worker/infrastructure/sync/sync-r2.types";
import type { SyncR2InventoryScratch } from "@worker/infrastructure/sync/sync-r2-inventory";
import { checkSyncInventoryCursor } from "@worker/infrastructure/sync/sync-r2-inventory-cursor";
import { createSyncR2Key } from "@worker/infrastructure/sync/sync-r2-key";
import { encodeSyncRecord } from "@worker/infrastructure/sync/sync-record.codec";
import { syncInventoryCursorJournalSchema } from "@worker/infrastructure/sync/sync-record.schemas";
import type {
  SyncInventoryChunk,
  SyncInventoryCursorJournal,
  SyncInventoryManifest,
} from "@worker/infrastructure/sync/sync-record.types";
import { describe, expect, it, vi } from "vitest";

const vaultId = syncVaultIdSchema.parse("11111111-1111-4111-8111-111111111111");
const inventoryId = syncInventoryIdSchema.parse(
  "22222222-2222-4222-8222-222222222222",
);
const digest = createContentSha256(
  "559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd",
);
const emptyDigest = createContentSha256(
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
);
const root = createContentSha256("b".repeat(64));
const epoch = 2_000_000_000_000;

/** Models exact strict storage observations while keeping external R2 effects behind fakes.
 * @returns One reserved v2 step and mutable fake journal for crash-boundary tests.
 */
async function fixture() {
  if (!digest || !emptyDigest || !root)
    throw new Error("Invalid SHA-256 fixture");
  const manifestKey = createSyncR2Key(
    syncInventoryManifestKey(vaultId, inventoryId),
    vaultId,
  );
  const activeKey = createSyncR2Key(syncInventoryActiveKey(vaultId), vaultId);
  const journalKey = createSyncR2Key(
    syncInventoryClaimKey(vaultId, inventoryId, 0),
    vaultId,
  );
  const chunkKey = createSyncR2Key(
    syncInventoryChunkKey(vaultId, inventoryId, 0),
    vaultId,
  );
  if (!manifestKey || !activeKey || !journalKey || !chunkKey)
    throw new Error("Invalid R2 fixture keys");
  const manifestValue: SyncInventoryManifest = {
    schemaVersion: 2,
    cursorWitnessMode: 1,
    protocolMajor: 1,
    vaultId,
    inventoryId,
    phase: "scanning",
    startVector: Array.from({ length: 64 }, () =>
      syncSequenceSchema.parse("00000000000000000000"),
    ),
    cursor: null,
    lastKey: null,
    emptyPageCount: 0,
    nextStep: 0,
    listPageCount: 0,
    headCount: 0,
    listAttemptCount: 0,
    headGetAttemptCount: 0,
    uniqueHeadBodyBytes: 0,
    actualHeadBodyBytes: 0,
    evidenceBytes: 0,
    chunkCount: 0,
    chunkHash: null,
    reservedAttempt: 1,
    expiresAtEpochMs: epoch + 86_400_000,
  };
  const manifest: SyncRecordObservation<SyncInventoryManifest> = {
    value: manifestValue,
    observed: {
      key: manifestKey,
      etag: "manifest-etag",
      bytes: await encodeSyncRecord({
        kind: "manifest",
        record: manifestValue,
      }),
      uploaded: new Date(epoch - 2_000),
    },
  };
  const chunkValue: SyncInventoryChunk = {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    inventoryId,
    step: 0,
    previousChunkHash: null,
    inputCursorDigest: emptyDigest,
    outputCursorDigest: digest,
    outputCursor: "QQ",
    truncated: true,
    transcript: JSON.stringify({
      objectCount: 0,
      keySha256: null,
      headBodyBytes: 0,
      truncated: true,
    }),
    headSummary: null,
  };
  const chunk: SyncRecordObservation<SyncInventoryChunk> = {
    value: chunkValue,
    observed: {
      key: chunkKey,
      etag: "chunk-etag",
      bytes: await encodeSyncRecord({ kind: "chunk", record: chunkValue }),
      uploaded: new Date(epoch - 2_000),
    },
  };
  let currentEpoch = epoch;
  let current: SyncInventoryCursorJournal =
    syncInventoryCursorJournalSchema.parse({
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      inventoryId,
      step: 0,
      chunkHash: root,
      cursorDigest: digest,
      state: "attempting",
      claimId: "33333333-3333-4333-8333-333333333333",
    });
  let journalPresent = true;
  let journalUploaded = epoch - 2_000;
  let generation = 0;
  const fail = () => {
    throw new Error("Unexpected cursor scratch operation");
  };
  const replaceCursorJournal = vi.fn<
    SyncR2InventoryScratch["replaceCursorJournal"]
  >(async (_observed, next) => {
    current = next;
    journalUploaded = currentEpoch;
    generation += 1;
    return { kind: "confirmed" };
  });
  const createCursorWitness = vi.fn<
    SyncR2InventoryScratch["createCursorWitness"]
  >(async () => ({ kind: "confirmed" }));
  const createCursorJournal = vi.fn<
    SyncR2InventoryScratch["createCursorJournal"]
  >(async (record) => {
    if (journalPresent) return { kind: "refused" };
    journalPresent = true;
    current = record;
    journalUploaded = currentEpoch;
    generation += 1;
    return { kind: "confirmed" };
  });
  const scratch: SyncR2InventoryScratch = {
    readManifest: async () => ({ kind: "observed", observation: manifest }),
    readActive: async () => ({
      kind: "observed",
      observation: {
        value: {
          schemaVersion: 1,
          protocolMajor: 1,
          vaultId,
          state: "active",
          inventoryId,
        },
        observed: {
          key: activeKey,
          etag: "slot-etag",
          bytes: new Uint8Array(),
          uploaded: new Date(epoch - 2_000),
        },
      },
    }),
    readCursorWitness: async () => ({ kind: "absent" }),
    readCursorJournal: async () =>
      journalPresent
        ? {
            kind: "observed",
            observation: {
              value: current,
              observed: {
                key: journalKey,
                etag: `claim-${generation}`,
                bytes: await encodeSyncRecord({
                  kind: "cursorJournal",
                  record: current,
                }),
                uploaded: new Date(journalUploaded),
              },
            },
          }
        : { kind: "absent" },
    replaceCursorJournal,
    createCursorWitness,
    createManifest: fail,
    replaceManifest: fail,
    createActive: fail,
    replaceActive: fail,
    readChunk: fail,
    createChunk: fail,
    createCursorJournal,
  };
  return {
    manifest,
    chunk,
    next: { ...manifestValue, chunkHash: root },
    scratch,
    replaceCursorJournal,
    createCursorWitness,
    createCursorJournal,
    removeJournal: () => {
      journalPresent = false;
    },
    advanceClock: (millis: number) => {
      currentEpoch += millis;
    },
    clock: () => currentEpoch,
  };
}

describe("per-step R2 cursor witness attempt recovery", () => {
  it.each(["attempting", "retry_wait"] as const)(
    "does not transition a cooled %s journal after losing scan authority before recovery",
    async (phase) => {
      const state = await fixture();
      if (phase === "retry_wait") {
        expect(
          await checkSyncInventoryCursor(
            state.manifest,
            state.chunk,
            state.next,
            state.scratch,
            state.clock,
          ),
        ).toMatchObject({ kind: "progress" });
        state.advanceClock(1_100);
      }
      state.replaceCursorJournal.mockClear();
      const original = state.scratch.readManifest.bind(state.scratch);
      state.scratch.readManifest = async () => ({ kind: "unavailable" });
      expect(
        await checkSyncInventoryCursor(
          state.manifest,
          state.chunk,
          state.next,
          state.scratch,
          state.clock,
        ),
      ).toEqual({ kind: "effect_unknown" });
      expect(state.replaceCursorJournal).not.toHaveBeenCalled();
      expect(state.createCursorJournal).not.toHaveBeenCalled();
      expect(state.createCursorWitness).not.toHaveBeenCalled();
      state.scratch.readManifest = original;
      expect(
        await checkSyncInventoryCursor(
          state.manifest,
          state.chunk,
          state.next,
          state.scratch,
          state.clock,
        ),
      ).toMatchObject({ kind: "progress" });
      expect(state.replaceCursorJournal).toHaveBeenCalledOnce();
      if (phase === "retry_wait")
        expect(state.createCursorWitness).toHaveBeenCalledOnce();
    },
  );
  it.each(["invalid", "unavailable"] as const)(
    "withholds cursor proof when the initial journal is %s",
    async (kind) => {
      const state = await fixture();
      state.scratch.readCursorJournal = async () => ({ kind });
      expect(
        await checkSyncInventoryCursor(
          state.manifest,
          state.chunk,
          state.next,
          state.scratch,
          state.clock,
        ),
      ).toEqual({ kind: kind === "invalid" ? "incomplete" : "effect_unknown" });
      expect(state.createCursorJournal).not.toHaveBeenCalled();
      expect(state.replaceCursorJournal).not.toHaveBeenCalled();
      expect(state.createCursorWitness).not.toHaveBeenCalled();
    },
  );

  it.each(["attempting", "retry_wait"] as const)(
    "preserves a throttled %s journal CAS floor without issuing a witness PUT",
    async (phase) => {
      const state = await fixture();
      if (phase === "retry_wait") {
        expect(
          await checkSyncInventoryCursor(
            state.manifest,
            state.chunk,
            state.next,
            state.scratch,
            state.clock,
          ),
        ).toMatchObject({ kind: "progress" });
        state.advanceClock(1_100);
      }
      const floor = state.clock() + 4_000;
      state.replaceCursorJournal.mockResolvedValueOnce({
        kind: "throttled",
        retryAfterEpochMs: floor,
      });
      expect(
        await checkSyncInventoryCursor(
          state.manifest,
          state.chunk,
          state.next,
          state.scratch,
          state.clock,
        ),
      ).toEqual({ kind: "progress", retryAfterEpochMs: floor });
      expect(state.createCursorWitness).not.toHaveBeenCalled();
      const call = state.replaceCursorJournal.mock.calls.at(-1);
      expect(call?.[0].value.state).toBe(phase);
      expect(call?.[1].state).toBe(
        phase === "attempting" ? "retry_wait" : "attempting",
      );
    },
  );

  it.each([
    "claim_throttled",
    "claim_unreadable",
    "witness_throttled",
    "scan_lost",
    "confirmed",
  ] as const)(
    "fences the first cursor claim at the %s boundary",
    async (boundary) => {
      const state = await fixture();
      state.removeJournal();
      const floor = epoch + 4_000;
      const create = state.createCursorJournal.getMockImplementation();
      if (!create) throw new Error("Expected stateful claim create");
      state.createCursorJournal.mockImplementationOnce(
        async (record, context) => {
          if (boundary === "claim_throttled")
            return { kind: "throttled", retryAfterEpochMs: floor };
          const written = await create(record, context);
          if (boundary === "claim_unreadable")
            state.scratch.readCursorJournal = async () => ({
              kind: "unavailable",
            });
          if (boundary === "scan_lost")
            state.scratch.readActive = async () => ({ kind: "absent" });
          return written;
        },
      );
      if (boundary === "witness_throttled") {
        state.createCursorWitness.mockResolvedValueOnce({
          kind: "throttled",
          retryAfterEpochMs: floor,
        });
      }
      expect(
        await checkSyncInventoryCursor(
          state.manifest,
          state.chunk,
          state.next,
          state.scratch,
          state.clock,
        ),
      ).toEqual(
        boundary === "claim_unreadable" || boundary === "scan_lost"
          ? { kind: "effect_unknown" }
          : boundary === "confirmed"
            ? { kind: "progress" }
            : { kind: "progress", retryAfterEpochMs: floor },
      );
      expect(state.createCursorJournal).toHaveBeenCalledOnce();
      expect(state.replaceCursorJournal).not.toHaveBeenCalled();
      expect(state.createCursorWitness).toHaveBeenCalledTimes(
        boundary === "confirmed" || boundary === "witness_throttled" ? 1 : 0,
      );
    },
  );

  it.each(["clock", "upload"] as const)(
    "refuses a retry observation with an invalid %s time before journal CAS",
    async (invalidTime) => {
      const state = await fixture();
      const read = await state.scratch.readCursorJournal(
        vaultId,
        inventoryId,
        0,
      );
      if (read.kind !== "observed") throw new Error("Expected persisted claim");
      if (invalidTime === "clock") state.advanceClock(Number.NaN);
      else
        state.scratch.readCursorJournal = async () => ({
          kind: "observed",
          observation: {
            ...read.observation,
            observed: {
              ...read.observation.observed,
              uploaded: new Date(Number.NaN),
            },
          },
        });
      expect(
        await checkSyncInventoryCursor(
          state.manifest,
          state.chunk,
          state.next,
          state.scratch,
          state.clock,
        ),
      ).toEqual({ kind: "effect_unknown" });
      expect(state.replaceCursorJournal).not.toHaveBeenCalled();
      expect(state.createCursorWitness).not.toHaveBeenCalled();
    },
  );
  it.each([
    "absent_journal",
    "divergent_journal",
    "changed_manifest",
    "matched",
  ] as const)(
    "requires exact scan and journal authority for an existing witness: %s",
    async (evidence) => {
      const state = await fixture();
      const read = await state.scratch.readCursorJournal(
        vaultId,
        inventoryId,
        0,
      );
      if (read.kind !== "observed") throw new Error("Expected cursor claim");
      const claim = read.observation.value;
      const value = {
        schemaVersion: 1 as const,
        protocolMajor: 1 as const,
        vaultId,
        inventoryId,
        step: claim.step,
        chunkHash: claim.chunkHash,
        cursorDigest: claim.cursorDigest,
      };
      const key = createSyncR2Key(
        syncInventoryCursorWitnessKey(vaultId, inventoryId, value.cursorDigest),
        vaultId,
      );
      if (!key) throw new Error("Expected witness key");
      state.scratch.readCursorWitness = async () => ({
        kind: "observed",
        observation: {
          value,
          observed: {
            key,
            etag: "witness-etag",
            uploaded: new Date(epoch),
            bytes: await encodeSyncRecord({
              kind: "cursorWitness",
              record: value,
            }),
          },
        },
      });
      if (evidence === "absent_journal") state.removeJournal();
      if (evidence === "divergent_journal") {
        const divergent = {
          ...claim,
          cursorDigest: state.chunk.value.inputCursorDigest,
        };
        state.scratch.readCursorJournal = async () => ({
          kind: "observed",
          observation: {
            value: divergent,
            observed: {
              ...read.observation.observed,
              bytes: await encodeSyncRecord({
                kind: "cursorJournal",
                record: divergent,
              }),
            },
          },
        });
      }
      if (evidence === "changed_manifest") {
        state.scratch.readManifest = async () => ({
          kind: "observed",
          observation: {
            ...state.manifest,
            observed: {
              ...state.manifest.observed,
              etag: "new-manifest-generation",
            },
          },
        });
      }
      expect(
        await checkSyncInventoryCursor(
          state.manifest,
          state.chunk,
          state.next,
          state.scratch,
          state.clock,
        ),
      ).toEqual({
        kind:
          evidence === "matched"
            ? "proved"
            : evidence === "changed_manifest"
              ? "effect_unknown"
              : "incomplete",
      });
      expect(state.createCursorJournal).not.toHaveBeenCalled();
      expect(state.replaceCursorJournal).not.toHaveBeenCalled();
      expect(state.createCursorWitness).not.toHaveBeenCalled();
    },
  );

  it("waits for the observed journal cooldown without touching its generation", async () => {
    const state = await fixture();
    state.advanceClock(-1_500);
    expect(
      await checkSyncInventoryCursor(
        state.manifest,
        state.chunk,
        state.next,
        state.scratch,
        state.clock,
      ),
    ).toEqual({
      kind: "progress",
      retryAfterEpochMs: epoch - 900,
    });
    expect(state.replaceCursorJournal).not.toHaveBeenCalled();
    expect(state.createCursorWitness).not.toHaveBeenCalled();
  });

  it("fails closed on malformed witness or a different journal root", async () => {
    const state = await fixture();
    state.scratch.readCursorWitness = async () => ({ kind: "invalid" });
    expect(
      await checkSyncInventoryCursor(
        state.manifest,
        state.chunk,
        state.next,
        state.scratch,
        state.clock,
      ),
    ).toEqual({ kind: "incomplete" });
    state.scratch.readCursorWitness = async () => ({ kind: "absent" });
    const divergent = syncInventoryCursorJournalSchema.parse({
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      inventoryId,
      step: 0,
      chunkHash: emptyDigest,
      cursorDigest: digest,
      state: "attempting",
      claimId: "33333333-3333-4333-8333-333333333333",
    });
    const original = await state.scratch.readCursorJournal(
      vaultId,
      inventoryId,
      0,
    );
    if (original.kind !== "observed")
      throw new Error("Expected strict journal fixture");
    state.scratch.readCursorJournal = async () => ({
      kind: "observed",
      observation: {
        value: divergent,
        observed: {
          ...original.observation.observed,
          bytes: await encodeSyncRecord({
            kind: "cursorJournal",
            record: divergent,
          }),
        },
      },
    });
    expect(
      await checkSyncInventoryCursor(
        state.manifest,
        state.chunk,
        state.next,
        state.scratch,
        state.clock,
      ),
    ).toEqual({ kind: "incomplete" });
    expect(state.replaceCursorJournal).not.toHaveBeenCalled();
    expect(state.createCursorWitness).not.toHaveBeenCalled();
  });

  it("does not claim an absent journal after losing the original slot", async () => {
    const state = await fixture();
    state.scratch.readCursorJournal = async () => ({ kind: "absent" });
    state.scratch.readActive = async () => ({ kind: "absent" });
    const createCursorJournal = vi.fn<
      SyncR2InventoryScratch["createCursorJournal"]
    >(async () => ({ kind: "confirmed" }));
    state.scratch.createCursorJournal = createCursorJournal;
    expect(
      await checkSyncInventoryCursor(
        state.manifest,
        state.chunk,
        state.next,
        state.scratch,
        state.clock,
      ),
    ).toEqual({ kind: "effect_unknown" });
    expect(createCursorJournal).not.toHaveBeenCalled();
    expect(state.createCursorWitness).not.toHaveBeenCalled();
  });

  it("preserves an uncertain journal-create floor without any target dispatch", async () => {
    const state = await fixture();
    state.scratch.readCursorJournal = async () => ({ kind: "absent" });
    state.scratch.createCursorJournal = async () => ({
      kind: "effect_unknown",
      retryAfterEpochMs: epoch + 2_000,
    });
    expect(
      await checkSyncInventoryCursor(
        state.manifest,
        state.chunk,
        state.next,
        state.scratch,
        state.clock,
      ),
    ).toEqual({
      kind: "effect_unknown",
      retryAfterEpochMs: epoch + 2_000,
    });
    expect(state.createCursorWitness).not.toHaveBeenCalled();
  });
  it("persists retry_wait on absent witness before a fresh UUID claim and sole target PUT", async () => {
    const state = await fixture();
    const first = await checkSyncInventoryCursor(
      state.manifest,
      state.chunk,
      state.next,
      state.scratch,
      state.clock,
    );
    expect(first).toMatchObject({
      kind: "progress",
      retryAfterEpochMs: epoch + 1_100,
    });
    expect(state.replaceCursorJournal).toHaveBeenCalledWith(
      expect.objectContaining({
        value: expect.objectContaining({ state: "attempting" }),
      }),
      expect.objectContaining({
        state: "retry_wait",
        retryAfterEpochMs: epoch + 1_100,
      }),
    );
    expect(state.createCursorWitness).not.toHaveBeenCalled();
    expect(
      await checkSyncInventoryCursor(
        state.manifest,
        state.chunk,
        state.next,
        state.scratch,
        state.clock,
      ),
    ).toMatchObject({
      kind: "progress",
      retryAfterEpochMs: epoch + 1_100,
    });
    expect(state.replaceCursorJournal).toHaveBeenCalledTimes(1);
    state.advanceClock(2_201);
    expect(
      await checkSyncInventoryCursor(
        state.manifest,
        state.chunk,
        state.next,
        state.scratch,
        state.clock,
      ),
    ).toEqual({ kind: "progress" });
    expect(state.replaceCursorJournal).toHaveBeenCalledTimes(2);
    expect(state.replaceCursorJournal.mock.calls[1]?.[1]).toMatchObject({
      state: "attempting",
      cursorDigest: digest,
      chunkHash: root,
    });
    expect(state.replaceCursorJournal.mock.calls[1]?.[1].claimId).not.toBe(
      "33333333-3333-4333-8333-333333333333",
    );
    expect(state.createCursorWitness).toHaveBeenCalledOnce();
  });

  it("adopts an in-flight matching witness seen before retry_wait CAS without another target write", async () => {
    const state = await fixture();
    if (!digest || !root) throw new Error("Invalid cursor fixture");
    const witness = {
      schemaVersion: 1 as const,
      protocolMajor: 1 as const,
      vaultId,
      inventoryId,
      step: 0,
      chunkHash: root,
      cursorDigest: digest,
    };
    const key = createSyncR2Key(
      syncInventoryCursorWitnessKey(vaultId, inventoryId, digest),
      vaultId,
    );
    if (!key) throw new Error("Invalid witness fixture key");
    let reads = 0;
    state.scratch.readCursorWitness = async () => {
      reads += 1;
      return reads === 1
        ? { kind: "absent" }
        : {
            kind: "observed",
            observation: {
              value: witness,
              observed: {
                key,
                etag: "late-witness",
                bytes: await encodeSyncRecord({
                  kind: "cursorWitness",
                  record: witness,
                }),
                uploaded: new Date(epoch - 1_000),
              },
            },
          };
    };
    expect(
      await checkSyncInventoryCursor(
        state.manifest,
        state.chunk,
        state.next,
        state.scratch,
        state.clock,
      ),
    ).toEqual({ kind: "proved" });
    expect(reads).toBe(2);
    expect(state.replaceCursorJournal).not.toHaveBeenCalled();
    expect(state.createCursorWitness).not.toHaveBeenCalled();
  });

  it.each([
    ["attempting", "invalid", "incomplete"],
    ["attempting", "unavailable", "effect_unknown"],
    ["attempting", "divergent", "incomplete"],
    ["retry_wait", "invalid", "incomplete"],
    ["retry_wait", "unavailable", "effect_unknown"],
    ["retry_wait", "divergent", "incomplete"],
  ] as const)(
    "refuses a late %s witness %s before the next journal CAS or target PUT",
    async (phase, lateKind, expectedCode) => {
      const state = await fixture();
      if (!emptyDigest || !digest)
        throw new Error("Invalid cursor fixture digest");
      if (phase === "retry_wait") {
        expect(
          await checkSyncInventoryCursor(
            state.manifest,
            state.chunk,
            state.next,
            state.scratch,
            state.clock,
          ),
        ).toMatchObject({ kind: "progress" });
        state.advanceClock(2_201);
      }
      const replacements = state.replaceCursorJournal.mock.calls.length;
      let witnessReads = 0;
      state.scratch.readCursorWitness = async () => {
        witnessReads += 1;
        if (witnessReads === 1) return { kind: "absent" };
        if (lateKind !== "divergent") return { kind: lateKind };
        const value = {
          schemaVersion: 1 as const,
          protocolMajor: 1 as const,
          vaultId,
          inventoryId,
          step: 0,
          chunkHash: emptyDigest,
          cursorDigest: digest,
        };
        const key = createSyncR2Key(
          syncInventoryCursorWitnessKey(vaultId, inventoryId, digest),
          vaultId,
        );
        if (!key) throw new Error("Invalid witness fixture key");
        return {
          kind: "observed",
          observation: {
            value,
            observed: {
              key,
              etag: "late-divergent-witness",
              uploaded: new Date(epoch),
              bytes: await encodeSyncRecord({
                kind: "cursorWitness",
                record: value,
              }),
            },
          },
        };
      };
      expect(
        await checkSyncInventoryCursor(
          state.manifest,
          state.chunk,
          state.next,
          state.scratch,
          state.clock,
        ),
      ).toEqual({ kind: expectedCode });
      expect(witnessReads).toBe(2);
      expect(state.replaceCursorJournal).toHaveBeenCalledTimes(replacements);
      expect(state.createCursorWitness).not.toHaveBeenCalled();
    },
  );

  it("does not promote a matching witness after the original scan loses its slot", async () => {
    const state = await fixture();
    if (!digest || !root) throw new Error("Invalid cursor fixture");
    const witness = {
      schemaVersion: 1 as const,
      protocolMajor: 1 as const,
      vaultId,
      inventoryId,
      step: 0,
      chunkHash: root,
      cursorDigest: digest,
    };
    const key = createSyncR2Key(
      syncInventoryCursorWitnessKey(vaultId, inventoryId, digest),
      vaultId,
    );
    if (!key) throw new Error("Invalid witness key");
    state.scratch.readCursorWitness = async () => ({
      kind: "observed",
      observation: {
        value: witness,
        observed: {
          key,
          etag: "witness-etag",
          bytes: await encodeSyncRecord({
            kind: "cursorWitness",
            record: witness,
          }),
          uploaded: new Date(epoch - 2_000),
        },
      },
    });
    state.scratch.readActive = async () => ({ kind: "absent" });
    expect(
      await checkSyncInventoryCursor(
        state.manifest,
        state.chunk,
        state.next,
        state.scratch,
        state.clock,
      ),
    ).toEqual({ kind: "effect_unknown" });
    expect(state.replaceCursorJournal).not.toHaveBeenCalled();
    expect(state.createCursorWitness).not.toHaveBeenCalled();
  });

  it.each(["attempting", "retry_wait"] as const)(
    "does not adopt a late matching witness after a %s scan loses its active slot",
    async (phase) => {
      const state = await fixture();
      if (!root || !digest) throw new Error("Invalid cursor fixture digest");
      if (phase === "retry_wait") {
        expect(
          await checkSyncInventoryCursor(
            state.manifest,
            state.chunk,
            state.next,
            state.scratch,
            state.clock,
          ),
        ).toMatchObject({ kind: "progress" });
        state.advanceClock(2_201);
      }
      const replacements = state.replaceCursorJournal.mock.calls.length;
      const originalReadActive = state.scratch.readActive.bind(state.scratch);
      let lostSlot = false;
      let witnessReads = 0;
      state.scratch.readActive = async (vault) =>
        lostSlot ? { kind: "absent" } : originalReadActive(vault);
      state.scratch.readCursorWitness = async () => {
        witnessReads += 1;
        if (witnessReads === 1) return { kind: "absent" };
        lostSlot = true;
        const value = {
          schemaVersion: 1 as const,
          protocolMajor: 1 as const,
          vaultId,
          inventoryId,
          step: 0,
          chunkHash: root,
          cursorDigest: digest,
        };
        const key = createSyncR2Key(
          syncInventoryCursorWitnessKey(vaultId, inventoryId, digest),
          vaultId,
        );
        if (!key) throw new Error("Invalid witness fixture key");
        return {
          kind: "observed",
          observation: {
            value,
            observed: {
              key,
              etag: "late-witness",
              bytes: await encodeSyncRecord({
                kind: "cursorWitness",
                record: value,
              }),
              uploaded: new Date(epoch),
            },
          },
        };
      };
      expect(
        await checkSyncInventoryCursor(
          state.manifest,
          state.chunk,
          state.next,
          state.scratch,
          state.clock,
        ),
      ).toEqual({ kind: "effect_unknown" });
      expect(witnessReads).toBe(2);
      expect(state.replaceCursorJournal).toHaveBeenCalledTimes(replacements);
      expect(state.createCursorWitness).not.toHaveBeenCalled();
    },
  );

  it.each(["attempting", "retry_wait"] as const)(
    "does not CAS a %s journal after the scan expires during witness recheck",
    async (phase) => {
      const state = await fixture();
      if (phase === "retry_wait") {
        expect(
          await checkSyncInventoryCursor(
            state.manifest,
            state.chunk,
            state.next,
            state.scratch,
            state.clock,
          ),
        ).toMatchObject({ kind: "progress" });
        state.advanceClock(2_201);
      }
      const previousReplacements = state.replaceCursorJournal.mock.calls.length;
      let witnessReads = 0;
      state.scratch.readCursorWitness = async () => {
        witnessReads += 1;
        if (witnessReads === 2) state.advanceClock(86_400_000);
        return { kind: "absent" };
      };
      expect(
        await checkSyncInventoryCursor(
          state.manifest,
          state.chunk,
          state.next,
          state.scratch,
          state.clock,
        ),
      ).toEqual({ kind: "effect_unknown" });
      expect(witnessReads).toBe(2);
      expect(state.replaceCursorJournal).toHaveBeenCalledTimes(
        previousReplacements,
      );
      expect(state.createCursorWitness).not.toHaveBeenCalled();
    },
  );

  it("returns the target's known uncertainty floor to the same-ID caller", async () => {
    const state = await fixture();
    expect(
      await checkSyncInventoryCursor(
        state.manifest,
        state.chunk,
        state.next,
        state.scratch,
        state.clock,
      ),
    ).toMatchObject({ kind: "progress" });
    state.advanceClock(2_201);
    const floor = state.clock() + 2_000;
    state.createCursorWitness.mockResolvedValueOnce({
      kind: "effect_unknown",
      retryAfterEpochMs: floor,
    });
    expect(
      await checkSyncInventoryCursor(
        state.manifest,
        state.chunk,
        state.next,
        state.scratch,
        state.clock,
      ),
    ).toEqual({
      kind: "effect_unknown",
      retryAfterEpochMs: floor,
    });
    state.advanceClock(floor - state.clock());
    expect(
      await checkSyncInventoryCursor(
        state.manifest,
        state.chunk,
        state.next,
        state.scratch,
        state.clock,
      ),
    ).toMatchObject({ kind: "progress", retryAfterEpochMs: floor + 1_100 });
    expect(state.createCursorWitness).toHaveBeenCalledOnce();
  });

  it.each(["retry_wait", "superseded"] as const)(
    "never dispatches the witness when its newly confirmed claim becomes %s before PUT",
    async (racedState) => {
      const state = await fixture();
      let claimed: SyncInventoryCursorJournal | undefined;
      let journalReads = 0;
      const createCursorJournal = vi.fn<
        SyncR2InventoryScratch["createCursorJournal"]
      >(async (record) => {
        claimed = record;
        return { kind: "confirmed" };
      });
      state.scratch.createCursorJournal = createCursorJournal;
      state.scratch.readCursorJournal = async () => {
        journalReads += 1;
        if (journalReads === 1) return { kind: "absent" };
        if (!claimed) throw new Error("Claim must precede owner confirmation");
        const value =
          journalReads === 2
            ? claimed
            : racedState === "retry_wait"
              ? syncInventoryCursorJournalSchema.parse({
                  ...claimed,
                  state: "retry_wait",
                  retryAfterEpochMs: epoch + 1_100,
                })
              : syncInventoryCursorJournalSchema.parse({
                  ...claimed,
                  claimId: "99999999-9999-4999-8999-999999999999",
                });
        const key = createSyncR2Key(
          syncInventoryClaimKey(vaultId, inventoryId, 0),
          vaultId,
        );
        if (!key) throw new Error("Invalid journal fixture key");
        return {
          kind: "observed",
          observation: {
            value,
            observed: {
              key,
              etag: `claim-${journalReads}`,
              bytes: await encodeSyncRecord({
                kind: "cursorJournal",
                record: value,
              }),
              uploaded: new Date(epoch),
            },
          },
        };
      };
      expect(
        await checkSyncInventoryCursor(
          state.manifest,
          state.chunk,
          state.next,
          state.scratch,
          state.clock,
        ),
      ).toEqual({ kind: "effect_unknown" });
      expect(createCursorJournal).toHaveBeenCalledOnce();
      expect(journalReads).toBe(3);
      expect(state.replaceCursorJournal).not.toHaveBeenCalled();
      expect(state.createCursorWitness).not.toHaveBeenCalled();
    },
  );

  it("never dispatches a target after an uncertain journal CAS", async () => {
    const state = await fixture();
    state.replaceCursorJournal.mockResolvedValueOnce({
      kind: "effect_unknown",
      retryAfterEpochMs: epoch + 2_000,
    });
    expect(
      await checkSyncInventoryCursor(
        state.manifest,
        state.chunk,
        state.next,
        state.scratch,
        state.clock,
      ),
    ).toEqual({ kind: "effect_unknown", retryAfterEpochMs: epoch + 2_000 });
    expect(state.createCursorWitness).not.toHaveBeenCalled();
  });
});
