import { createContentSha256 } from "@obsidian-ai-bridge/core";
import {
  syncFeedLaneHeadKey,
  syncInventoryActiveKey,
  syncInventoryManifestKey,
} from "@protocol/sync.codec";
import { MAX_INVENTORY_SUBREQUESTS_PER_INVOCATION } from "@protocol/sync.constants";
import {
  syncEventSequenceSchema,
  syncInventoryIdSchema,
  syncOperationIdSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type { SyncR2InventoryScratch } from "@worker/infrastructure/sync/sync-r2-inventory";
import { createSyncInventoryInvocationBudget } from "@worker/infrastructure/sync/sync-r2-inventory-budget";
import type { SyncR2InventoryListing } from "@worker/infrastructure/sync/sync-r2-inventory-list";
import { syncR2InventoryRunner } from "@worker/infrastructure/sync/sync-r2-inventory-runner";
import { createSyncR2Key } from "@worker/infrastructure/sync/sync-r2-key";
import type { SyncR2Publication } from "@worker/infrastructure/sync/sync-r2-publication";
import type {
  SyncInventoryManifest,
  SyncInventorySlot,
} from "@worker/infrastructure/sync/sync-record.types";
import { describe, expect, it, vi } from "vitest";

const vaultId = syncVaultIdSchema.parse("11111111-1111-4111-8111-111111111111");
const inventoryId = syncInventoryIdSchema.parse(
  "22222222-2222-4222-8222-222222222222",
);
const otherInventoryId = syncInventoryIdSchema.parse(
  "66666666-6666-4666-8666-666666666666",
);
const now = 2_000_000_000_000;

/** Creates a strict minimal scan fixture without access to any network or vault.
 * @returns Typed scratch and publication fakes whose unused methods fail explicitly.
 */
function fixture() {
  const createManifest = vi.fn<SyncR2InventoryScratch["createManifest"]>(
    async () => ({ kind: "confirmed" }),
  );
  const readManifest = vi.fn<SyncR2InventoryScratch["readManifest"]>(
    async () => ({ kind: "absent" }),
  );
  const fail = () => {
    throw new Error("Unplanned inventory storage call");
  };
  const scratch: SyncR2InventoryScratch = {
    readManifest,
    createManifest,
    readActive: fail,
    createActive: fail,
    replaceActive: fail,
    replaceManifest: fail,
    readChunk: fail,
    createChunk: fail,
    readCursorJournal: fail,
    createCursorJournal: fail,
    replaceCursorJournal: fail,
    readCursorWitness: fail,
    createCursorWitness: fail,
  };
  const publication: SyncR2Publication = {
    readJournal: fail,
    createJournal: fail,
    replaceJournal: fail,
    replaceJournalFromReadyHeadCasAbort: fail,
    readLaneHead: fail,
    createLaneHead: fail,
    replaceLaneHead: fail,
    readEvent: fail,
    createEvent: fail,
    readHeadRefusalReceipt: fail,
    createHeadRefusalReceipt: fail,
    replaceJournalFromHeadRefusalReceipt: fail,
  };
  return { scratch, publication, createManifest, readManifest };
}

/** Builds typed exact observation evidence for one private inventory record.
 * @param value Previously persisted manifest or active-slot value.
 * @param keyValue Canonical key matching that value.
 * @returns Same-generation typed observation for the runner's CAS path.
 */
function observed<T>(value: T, keyValue: string) {
  const key = createSyncR2Key(keyValue, vaultId);
  if (key === undefined) throw new Error("Invalid fixture key");
  return {
    kind: "observed" as const,
    observation: {
      value,
      observed: {
        key,
        etag: "etag",
        bytes: new Uint8Array(),
        uploaded: new Date(now - 2_000),
      },
    },
  };
}

describe("inventory runner admission", () => {
  it.each([
    ["start_admission", 5],
    ["continue_admission", 1],
    ["start_competitor", 6],
    ["start_vector", 6],
    ["continue_slot", 2],
    ["continue_finalize", 3],
    ["continue_release", 3],
    ["failed_release", 2],
  ] as const)(
    "defers at %s without dispatching the next unreserved storage operation",
    async (boundary, availableCalls) => {
      const state = fixture();
      await syncR2InventoryRunner(
        state.scratch,
        state.publication,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ).startInventory({ vaultId, inventoryId });
      const initial = state.createManifest.mock.calls[0]?.[0];
      if (!initial) throw new Error("Expected strict initial manifest");
      const root = createContentSha256("b".repeat(64));
      if (!root) throw new Error("Expected inventory root");
      const terminal: SyncInventoryManifest = {
        ...initial,
        phase: boundary === "continue_release" ? "complete" : "scanning",
        nextStep: 1,
        listPageCount: 1,
        chunkCount: 1,
        chunkHash: root,
        listAttemptCount: 1,
      };
      const value =
        boundary === "continue_release" || boundary === "continue_finalize"
          ? terminal
          : boundary === "failed_release"
            ? { ...initial, phase: "failed" as const }
            : boundary === "continue_slot"
              ? { ...initial, phase: "scanning" as const }
              : initial;
      state.createManifest.mockClear();
      state.readManifest.mockClear();
      state.readManifest.mockResolvedValue(
        observed(value, syncInventoryManifestKey(vaultId, inventoryId)),
      );
      const readActive = vi.fn<SyncR2InventoryScratch["readActive"]>(async () =>
        observed(
          {
            schemaVersion: 1 as const,
            protocolMajor: 1 as const,
            vaultId,
            state: "active" as const,
            inventoryId:
              boundary === "start_competitor" ? otherInventoryId : inventoryId,
          },
          syncInventoryActiveKey(vaultId),
        ),
      );
      const replaceActive = vi.fn<SyncR2InventoryScratch["replaceActive"]>();
      const replaceManifest =
        vi.fn<SyncR2InventoryScratch["replaceManifest"]>();
      const readLaneHead = vi.fn<SyncR2Publication["readLaneHead"]>();
      state.scratch.readActive = readActive;
      state.scratch.replaceActive = replaceActive;
      state.scratch.replaceManifest = replaceManifest;
      state.publication.readLaneHead = readLaneHead;
      const budget = createSyncInventoryInvocationBudget(() => 20);
      expect(
        budget.reserve(
          MAX_INVENTORY_SUBREQUESTS_PER_INVOCATION - availableCalls,
          0,
        ),
      ).toBe(true);
      const runner = syncR2InventoryRunner(
        state.scratch,
        state.publication,
        budget,
        () => now,
      );
      const result = boundary.startsWith("start")
        ? await runner.startInventory({ vaultId, inventoryId })
        : await runner.continueInventory({ vaultId, inventoryId });
      expect(result).toEqual({
        kind: "inventory_in_progress",
        vaultId,
        inventoryId,
      });
      expect(state.createManifest).not.toHaveBeenCalled();
      expect(replaceActive).not.toHaveBeenCalled();
      expect(replaceManifest).not.toHaveBeenCalled();
      expect(readLaneHead).not.toHaveBeenCalled();
      expect(state.readManifest).toHaveBeenCalledTimes(
        boundary.endsWith("admission") ? 0 : 1,
      );
      expect(readActive).toHaveBeenCalledTimes(
        [
          "start_competitor",
          "start_vector",
          "continue_finalize",
          "continue_release",
        ].includes(boundary)
          ? 1
          : 0,
      );
    },
  );

  it("rejects unvalidated inventory identities before any read or write on both entry points", async () => {
    const state = fixture();
    const runner = syncR2InventoryRunner(
      state.scratch,
      state.publication,
      createSyncInventoryInvocationBudget(() => 20),
      () => now,
    );
    expect(
      // @ts-expect-error External malformed UUIDs must not bypass entry validation.
      await runner.startInventory({ vaultId, inventoryId: "invalid-id" }),
    ).toEqual({ kind: "error", code: "invalid_input" });
    expect(
      // @ts-expect-error External malformed UUIDs must not bypass entry validation.
      await runner.continueInventory({ vaultId: "invalid-vault", inventoryId }),
    ).toEqual({ kind: "error", code: "invalid_input" });
    expect(state.readManifest).not.toHaveBeenCalled();
    expect(state.createManifest).not.toHaveBeenCalled();
  });
  it("persists the exact starting manifest before any active-slot or lane access", async () => {
    const { scratch, publication, createManifest, readManifest } = fixture();
    const runner = syncR2InventoryRunner(
      scratch,
      publication,
      createSyncInventoryInvocationBudget(() => 20),
      () => now,
    );
    const result = await runner.startInventory({ vaultId, inventoryId });
    expect(result).toEqual({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
    });
    expect(readManifest).toHaveBeenCalledWith(vaultId, inventoryId);
    expect(createManifest).toHaveBeenCalledTimes(1);
    const record = createManifest.mock.calls[0]?.[0];
    expect(record).toMatchObject({
      schemaVersion: 2,
      cursorWitnessMode: 1,
      protocolMajor: 1,
      vaultId,
      inventoryId,
      phase: "starting",
      startVector: Array(64).fill("00000000000000000000"),
      expiresAtEpochMs: now + 24 * 60 * 60 * 1000,
      reservedAttempt: 0,
    });
    expect(syncInventoryManifestKey(vaultId, inventoryId)).toContain(
      inventoryId,
    );
  });

  it("rejects unsafe server time and unavailable manifest before any active-slot claim", async () => {
    const { scratch, publication, readManifest, createManifest } = fixture();
    for (const timestamp of [Number.NaN, Number.MAX_SAFE_INTEGER]) {
      expect(
        await syncR2InventoryRunner(
          scratch,
          publication,
          createSyncInventoryInvocationBudget(() => 20),
          () => timestamp,
        ).startInventory({ vaultId, inventoryId }),
      ).toEqual({
        kind: "error",
        code: "storage_unavailable",
        inventoryId,
      });
    }
    expect(readManifest).not.toHaveBeenCalled();
    expect(createManifest).not.toHaveBeenCalled();
    readManifest.mockResolvedValueOnce({ kind: "unavailable" });
    expect(
      await syncR2InventoryRunner(
        scratch,
        publication,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ).startInventory({ vaultId, inventoryId }),
    ).toEqual({
      kind: "error",
      code: "storage_unavailable",
      inventoryId,
    });
    expect(createManifest).not.toHaveBeenCalled();
  });

  it("rejects historical v1 scans before slot access or continuation", async () => {
    const { scratch, publication, readManifest } = fixture();
    const historical: SyncInventoryManifest = {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      inventoryId,
      phase: "scanning",
      startVector: Array(64).fill(
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
      reservedAttempt: 0,
      expiresAtEpochMs: now + 86_400_000,
    };
    readManifest.mockResolvedValue(
      observed(historical, syncInventoryManifestKey(vaultId, inventoryId)),
    );
    const runner = syncR2InventoryRunner(
      scratch,
      publication,
      createSyncInventoryInvocationBudget(() => 20),
      () => now,
    );
    expect(await runner.continueInventory({ vaultId, inventoryId })).toEqual({
      kind: "error",
      code: "inventory_incomplete",
    });
    expect(await runner.startInventory({ vaultId, inventoryId })).toEqual({
      kind: "error",
      code: "inventory_incomplete",
    });
  });

  it("returns same-ID progress and a retry floor on a definite manifest cooldown", async () => {
    const { scratch, publication, createManifest } = fixture();
    createManifest.mockResolvedValue({
      kind: "throttled",
      retryAfterEpochMs: now + 1_100,
    });
    const runner = syncR2InventoryRunner(
      scratch,
      publication,
      createSyncInventoryInvocationBudget(() => 20),
      () => now,
    );
    expect(await runner.startInventory({ vaultId, inventoryId })).toEqual({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
      retryAfterEpochMs: now + 1_100,
    });
  });

  it("preflights enough physical calls for an exact write's preflight GET, PUT and read-back", async () => {
    const { scratch, publication, createManifest } = fixture();
    const budget = createSyncInventoryInvocationBudget(() => 20);
    const reserve = vi.spyOn(budget, "reserve");
    const runner = syncR2InventoryRunner(
      scratch,
      publication,
      budget,
      () => now,
    );
    await runner.startInventory({ vaultId, inventoryId });
    expect(reserve).toHaveBeenCalledWith(6, 1);
    expect(createManifest).toHaveBeenCalledTimes(1);
  });

  it("claims an absent slot for the same durable starting manifest before reading lanes", async () => {
    const { scratch, publication, createManifest, readManifest } = fixture();
    const first = syncR2InventoryRunner(
      scratch,
      publication,
      createSyncInventoryInvocationBudget(() => 20),
      () => now,
    );
    await first.startInventory({ vaultId, inventoryId });
    const manifest = createManifest.mock.calls[0]?.[0];
    if (!manifest) throw new Error("Missing created manifest");
    readManifest.mockResolvedValue(
      observed(manifest, syncInventoryManifestKey(vaultId, inventoryId)),
    );
    const readActive = vi.fn<SyncR2InventoryScratch["readActive"]>(
      async () => ({ kind: "absent" }),
    );
    const createActive = vi.fn<SyncR2InventoryScratch["createActive"]>(
      async () => ({ kind: "confirmed" }),
    );
    scratch.readActive = readActive;
    scratch.createActive = createActive;
    readActive.mockResolvedValueOnce({ kind: "unavailable" });
    expect(
      await syncR2InventoryRunner(
        scratch,
        publication,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ).startInventory({ vaultId, inventoryId }),
    ).toEqual({
      kind: "error",
      code: "storage_unavailable",
      inventoryId,
    });
    expect(createActive).not.toHaveBeenCalled();
    const second = syncR2InventoryRunner(
      scratch,
      publication,
      createSyncInventoryInvocationBudget(() => 20),
      () => now,
    );
    expect(await second.startInventory({ vaultId, inventoryId })).toEqual({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
    });
    expect(createActive).toHaveBeenCalledWith({
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      state: "active",
      inventoryId,
    });
    readActive.mockResolvedValue(
      observed(
        {
          schemaVersion: 1 as const,
          protocolMajor: 1 as const,
          vaultId,
          state: "empty" as const,
        },
        syncInventoryActiveKey(vaultId),
      ),
    );
    const replaceActive = vi.fn<SyncR2InventoryScratch["replaceActive"]>(
      async () => ({ kind: "confirmed" }),
    );
    scratch.replaceActive = replaceActive;
    expect(
      await syncR2InventoryRunner(
        scratch,
        publication,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ).startInventory({ vaultId, inventoryId }),
    ).toMatchObject({ kind: "inventory_in_progress" });
    expect(replaceActive).toHaveBeenCalledWith(expect.anything(), {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      state: "active",
      inventoryId,
    });
    expect(createActive).toHaveBeenCalledTimes(1);
    const active: SyncInventorySlot = {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      state: "active",
      inventoryId,
    };
    readActive.mockResolvedValue(
      observed(active, syncInventoryActiveKey(vaultId)),
    );
    const readLaneHead = vi.fn<SyncR2Publication["readLaneHead"]>(async () => ({
      kind: "absent",
    }));
    publication.readLaneHead = readLaneHead;
    const replaceManifest = vi.fn<SyncR2InventoryScratch["replaceManifest"]>(
      async () => ({ kind: "confirmed" }),
    );
    scratch.replaceManifest = replaceManifest;
    const third = syncR2InventoryRunner(
      scratch,
      publication,
      createSyncInventoryInvocationBudget(() => 20),
      () => now,
    );
    expect(await third.startInventory({ vaultId, inventoryId })).toEqual({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
    });
    expect(readLaneHead).toHaveBeenCalledTimes(64);
    expect(replaceManifest).toHaveBeenCalledWith(
      expect.objectContaining({ value: manifest }),
      expect.objectContaining({
        phase: "scanning",
        startVector: Array(64).fill("00000000000000000000"),
      }),
    );
    readManifest.mockResolvedValue(
      observed(
        { ...manifest, phase: "scanning" },
        syncInventoryManifestKey(vaultId, inventoryId),
      ),
    );
    readActive.mockClear();
    expect(
      await syncR2InventoryRunner(
        scratch,
        publication,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ).startInventory({ vaultId, inventoryId }),
    ).toMatchObject({ kind: "inventory_in_progress" });
    expect(readActive).not.toHaveBeenCalled();
  });

  it("does not replace another active scan without exact proof its manifest expired", async () => {
    const { scratch, publication, createManifest, readManifest } = fixture();
    await syncR2InventoryRunner(
      scratch,
      publication,
      createSyncInventoryInvocationBudget(() => 20),
      () => now,
    ).startInventory({ vaultId, inventoryId });
    const own = createManifest.mock.calls[0]?.[0];
    if (!own) throw new Error("Missing own manifest");
    const competing = {
      ...own,
      inventoryId: otherInventoryId,
      expiresAtEpochMs: now - 1,
    };
    readManifest.mockImplementation(async (_vault, id) =>
      id === inventoryId
        ? observed(own, syncInventoryManifestKey(vaultId, inventoryId))
        : { kind: "absent" },
    );
    scratch.readActive = vi.fn(async () =>
      observed(
        {
          schemaVersion: 1 as const,
          protocolMajor: 1 as const,
          vaultId,
          state: "active" as const,
          inventoryId: otherInventoryId,
        },
        syncInventoryActiveKey(vaultId),
      ),
    );
    const replaceActive = vi.fn<SyncR2InventoryScratch["replaceActive"]>(
      async () => ({ kind: "confirmed" }),
    );
    scratch.replaceActive = replaceActive;
    const start = () =>
      syncR2InventoryRunner(
        scratch,
        publication,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ).startInventory({ vaultId, inventoryId });
    expect(await start()).toEqual({
      kind: "error",
      code: "storage_unavailable",
      inventoryId,
    });
    expect(replaceActive).not.toHaveBeenCalled();
    readManifest.mockImplementation(async (_vault, id) =>
      id === inventoryId
        ? observed(own, syncInventoryManifestKey(vaultId, inventoryId))
        : observed(
            { ...competing, expiresAtEpochMs: now + 10_000 },
            syncInventoryManifestKey(vaultId, otherInventoryId),
          ),
    );
    expect(await start()).toEqual({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId: otherInventoryId,
    });
    expect(replaceActive).not.toHaveBeenCalled();
    readManifest.mockImplementation(async (_vault, id) =>
      id === inventoryId
        ? observed(own, syncInventoryManifestKey(vaultId, inventoryId))
        : observed(
            competing,
            syncInventoryManifestKey(vaultId, otherInventoryId),
          ),
    );
    expect(await start()).toEqual({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
    });
    expect(replaceActive).toHaveBeenCalledWith(expect.anything(), {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      state: "active",
      inventoryId,
    });
  });

  it("continues only its own active scan with a persisted attempt before LIST", async () => {
    const { scratch, publication, readManifest } = fixture();
    const base: SyncInventoryManifest = {
      schemaVersion: 2,
      cursorWitnessMode: 1,
      protocolMajor: 1,
      vaultId,
      inventoryId,
      phase: "scanning",
      startVector: Array(64).fill(
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
      reservedAttempt: 0,
      expiresAtEpochMs: now + 86_400_000,
    };
    readManifest.mockResolvedValue(
      observed(base, syncInventoryManifestKey(vaultId, inventoryId)),
    );
    scratch.readActive = vi.fn(async () =>
      observed(
        {
          schemaVersion: 1 as const,
          protocolMajor: 1 as const,
          vaultId,
          state: "active" as const,
          inventoryId,
        },
        syncInventoryActiveKey(vaultId),
      ),
    );
    const replaceManifest = vi.fn<SyncR2InventoryScratch["replaceManifest"]>(
      async () => ({ kind: "confirmed" }),
    );
    const createChunk = vi.fn<SyncR2InventoryScratch["createChunk"]>(
      async () => ({ kind: "confirmed" }),
    );
    scratch.replaceManifest = replaceManifest;
    scratch.createChunk = createChunk;
    const listHeads = vi.fn<SyncR2InventoryListing["listHeads"]>(async () => ({
      kind: "page",
      page: { objects: [], truncated: false },
    }));
    const listing: SyncR2InventoryListing = {
      listHeads,
      async readHead() {
        throw new Error("Unexpected head GET");
      },
    };
    const ownSlot = scratch.readActive.bind(scratch);
    scratch.readActive = vi.fn(async () =>
      observed(
        {
          schemaVersion: 1 as const,
          protocolMajor: 1 as const,
          vaultId,
          state: "active" as const,
          inventoryId: otherInventoryId,
        },
        syncInventoryActiveKey(vaultId),
      ),
    );
    expect(
      await syncR2InventoryRunner(
        scratch,
        publication,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
        listing,
      ).continueInventory({ vaultId, inventoryId }),
    ).toEqual({
      kind: "error",
      code: "effect_unknown",
      inventoryId,
    });
    expect(listHeads).not.toHaveBeenCalled();
    expect(replaceManifest).not.toHaveBeenCalled();
    scratch.readActive = ownSlot;
    const runner = syncR2InventoryRunner(
      scratch,
      publication,
      createSyncInventoryInvocationBudget(() => 20),
      () => now,
      listing,
    );
    expect(await runner.continueInventory({ vaultId, inventoryId })).toEqual({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
    });
    expect(replaceManifest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reservedAttempt: 1 }),
    );
    expect(listHeads).toHaveBeenCalledExactlyOnceWith(vaultId, null);
    expect(createChunk).toHaveBeenCalledTimes(1);
    readManifest.mockResolvedValue(
      observed(
        { ...base, cursor: "QQ" },
        syncInventoryManifestKey(vaultId, inventoryId),
      ),
    );
    replaceManifest.mockClear();
    expect(
      await syncR2InventoryRunner(
        scratch,
        publication,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ).continueInventory({ vaultId, inventoryId }),
    ).toEqual({
      kind: "error",
      code: "storage_unavailable",
      inventoryId,
    });
    expect(replaceManifest).not.toHaveBeenCalled();
    expect(createChunk).toHaveBeenCalledTimes(1);
  });

  it("finalizes only an unchanged 64-lane vector and releases the same active slot before exposing a handle", async () => {
    const { scratch, publication, readManifest } = fixture();
    const root = createContentSha256(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    if (!root) throw new Error("Invalid root fixture");
    const manifest: SyncInventoryManifest = {
      schemaVersion: 2,
      cursorWitnessMode: 1,
      protocolMajor: 1,
      vaultId,
      inventoryId,
      phase: "scanning",
      startVector: Array(64).fill(
        syncSequenceSchema.parse("00000000000000000000"),
      ),
      cursor: null,
      lastKey: null,
      emptyPageCount: 0,
      nextStep: 1,
      listPageCount: 1,
      headCount: 0,
      listAttemptCount: 1,
      headGetAttemptCount: 0,
      uniqueHeadBodyBytes: 0,
      actualHeadBodyBytes: 0,
      evidenceBytes: 150,
      chunkCount: 1,
      chunkHash: root,
      reservedAttempt: 0,
      expiresAtEpochMs: now + 86_400_000,
    };
    readManifest.mockResolvedValue(
      observed(manifest, syncInventoryManifestKey(vaultId, inventoryId)),
    );
    const activeSlot = vi.fn<SyncR2InventoryScratch["readActive"]>(async () =>
      observed(
        {
          schemaVersion: 1 as const,
          protocolMajor: 1 as const,
          vaultId,
          state: "active" as const,
          inventoryId,
        },
        syncInventoryActiveKey(vaultId),
      ),
    );
    scratch.readActive = activeSlot;
    const readLaneHead = vi.fn<SyncR2Publication["readLaneHead"]>(async () => ({
      kind: "absent",
    }));
    publication.readLaneHead = readLaneHead;
    const replaceManifest = vi.fn<SyncR2InventoryScratch["replaceManifest"]>(
      async () => ({ kind: "confirmed" }),
    );
    const replaceActive = vi.fn<SyncR2InventoryScratch["replaceActive"]>(
      async () => ({ kind: "confirmed" }),
    );
    scratch.replaceManifest = replaceManifest;
    scratch.replaceActive = replaceActive;
    const attempt = () =>
      syncR2InventoryRunner(
        scratch,
        publication,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ).continueInventory({ vaultId, inventoryId });
    activeSlot.mockResolvedValueOnce({ kind: "absent" });
    expect(await attempt()).toEqual({
      kind: "error",
      code: "storage_unavailable",
      inventoryId,
    });
    readLaneHead.mockResolvedValueOnce({ kind: "unavailable" });
    expect(await attempt()).toEqual({
      kind: "error",
      code: "storage_unavailable",
      inventoryId,
    });
    const pendingLane = {
      kind: "laneHead" as const,
      schemaVersion: 1 as const,
      protocolMajor: 1 as const,
      vaultId,
      lane: 0,
      committedSequence: syncSequenceSchema.parse("00000000000000000000"),
      committedAtEpochMs: 0,
      pending: {
        operationId: syncOperationIdSchema.parse(
          "33333333-3333-4333-8333-333333333333",
        ),
        nextSequence: syncEventSequenceSchema.parse("00000000000000000001"),
      },
    };
    readLaneHead.mockResolvedValueOnce(
      observed(pendingLane, syncFeedLaneHeadKey(vaultId, 0)),
    );
    expect(await attempt()).toEqual({
      kind: "error",
      code: "effect_unknown",
      inventoryId,
    });
    readLaneHead.mockResolvedValueOnce(
      observed(
        {
          ...pendingLane,
          pending: undefined,
          committedSequence: syncSequenceSchema.parse("00000000000000000001"),
        },
        syncFeedLaneHeadKey(vaultId, 0),
      ),
    );
    expect(await attempt()).toEqual({
      kind: "error",
      code: "effect_unknown",
      inventoryId,
    });
    expect(replaceManifest).not.toHaveBeenCalled();
    readLaneHead.mockClear();
    expect(await attempt()).toEqual({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
    });
    expect(readLaneHead).toHaveBeenCalledTimes(64);
    expect(replaceManifest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ phase: "complete" }),
    );
    expect(replaceActive).not.toHaveBeenCalled();
    readManifest.mockResolvedValue(
      observed(
        { ...manifest, phase: "complete" },
        syncInventoryManifestKey(vaultId, inventoryId),
      ),
    );
    const resume = () =>
      syncR2InventoryRunner(
        scratch,
        publication,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ).continueInventory({ vaultId, inventoryId });
    replaceActive.mockResolvedValueOnce({
      kind: "throttled",
      retryAfterEpochMs: now + 1_100,
    });
    expect(await resume()).toEqual({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
      retryAfterEpochMs: now + 1_100,
    });
    replaceActive.mockResolvedValueOnce({ kind: "effect_unknown" });
    expect(await resume()).toEqual({
      kind: "error",
      code: "effect_unknown",
      inventoryId,
    });
    expect(await resume()).toEqual({
      kind: "complete",
      vaultId,
      inventoryId,
      vector: manifest.startVector,
      entryCount: 0,
      chunkCount: 1,
      root,
    });
    expect(replaceActive).toHaveBeenCalledWith(expect.anything(), {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      state: "empty",
    });
    const releases = replaceActive.mock.calls.length;
    scratch.readActive = vi.fn(async () =>
      observed(
        {
          schemaVersion: 1 as const,
          protocolMajor: 1 as const,
          vaultId,
          state: "empty" as const,
        },
        syncInventoryActiveKey(vaultId),
      ),
    );
    expect(await resume()).toMatchObject({
      kind: "complete",
      vaultId,
      inventoryId,
      root,
    });
    expect(replaceActive).toHaveBeenCalledTimes(releases);
    scratch.readActive = vi.fn(async () =>
      observed(
        {
          schemaVersion: 1 as const,
          protocolMajor: 1 as const,
          vaultId,
          state: "active" as const,
          inventoryId: otherInventoryId,
        },
        syncInventoryActiveKey(vaultId),
      ),
    );
    expect(await resume()).toEqual({
      kind: "error",
      code: "effect_unknown",
      inventoryId,
    });
    readManifest.mockResolvedValue(
      observed(
        {
          ...manifest,
          phase: "complete",
          chunkHash: null,
          nextStep: 0,
          listPageCount: 0,
          chunkCount: 0,
        },
        syncInventoryManifestKey(vaultId, inventoryId),
      ),
    );
    expect(await resume()).toEqual({
      kind: "error",
      code: "effect_unknown",
      inventoryId,
    });
    expect(replaceActive).toHaveBeenCalledTimes(releases);
  });

  it("marks the same scan failed rather than capturing a pending lane as a complete start vector", async () => {
    const { scratch, publication, readManifest } = fixture();
    const manifest: SyncInventoryManifest = {
      schemaVersion: 2,
      cursorWitnessMode: 1,
      protocolMajor: 1,
      vaultId,
      inventoryId,
      phase: "starting",
      startVector: Array(64).fill(
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
      reservedAttempt: 0,
      expiresAtEpochMs: now + 86_400_000,
    };
    readManifest.mockResolvedValue(
      observed(manifest, syncInventoryManifestKey(vaultId, inventoryId)),
    );
    const active: SyncInventorySlot = {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      state: "active",
      inventoryId,
    };
    const readActive = vi.fn<SyncR2InventoryScratch["readActive"]>(async () =>
      observed(active, syncInventoryActiveKey(vaultId)),
    );
    scratch.readActive = readActive;
    publication.readLaneHead = vi.fn(async (_vault, lane) =>
      lane === 4
        ? observed(
            {
              kind: "laneHead" as const,
              schemaVersion: 1 as const,
              protocolMajor: 1 as const,
              vaultId,
              lane,
              committedSequence: syncSequenceSchema.parse(
                "00000000000000000000",
              ),
              committedAtEpochMs: 0,
              pending: {
                operationId: syncOperationIdSchema.parse(
                  "33333333-3333-4333-8333-333333333333",
                ),
                nextSequence: syncEventSequenceSchema.parse(
                  "00000000000000000001",
                ),
              },
            },
            syncFeedLaneHeadKey(vaultId, lane),
          )
        : { kind: "absent" as const },
    );
    const replaceManifest = vi.fn<SyncR2InventoryScratch["replaceManifest"]>(
      async () => ({ kind: "confirmed" }),
    );
    scratch.replaceManifest = replaceManifest;
    const runner = syncR2InventoryRunner(
      scratch,
      publication,
      createSyncInventoryInvocationBudget(() => 20),
      () => now,
    );
    expect(await runner.startInventory({ vaultId, inventoryId })).toEqual({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
    });
    expect(replaceManifest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ phase: "failed" }),
    );
    const failed = replaceManifest.mock.calls[0]?.[1];
    if (!failed) throw new Error("Failed manifest not persisted");
    readManifest.mockResolvedValue(
      observed(failed, syncInventoryManifestKey(vaultId, inventoryId)),
    );
    const replaceActive = vi.fn<SyncR2InventoryScratch["replaceActive"]>(
      async () => ({ kind: "confirmed" }),
    );
    scratch.replaceActive = replaceActive;
    const resume = (method: "startInventory" | "continueInventory") =>
      syncR2InventoryRunner(
        scratch,
        publication,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      )[method]({ vaultId, inventoryId });
    readActive.mockResolvedValueOnce({ kind: "unavailable" });
    expect(await resume("continueInventory")).toEqual({
      kind: "error",
      code: "storage_unavailable",
      inventoryId,
    });
    readActive.mockResolvedValueOnce(
      observed(
        {
          schemaVersion: 1 as const,
          protocolMajor: 1 as const,
          vaultId,
          state: "empty" as const,
        },
        syncInventoryActiveKey(vaultId),
      ),
    );
    expect(await resume("startInventory")).toEqual({
      kind: "error",
      code: "inventory_incomplete",
    });
    readActive.mockResolvedValueOnce(
      observed(
        {
          ...active,
          inventoryId: otherInventoryId,
        },
        syncInventoryActiveKey(vaultId),
      ),
    );
    expect(await resume("continueInventory")).toEqual({
      kind: "error",
      code: "inventory_incomplete",
    });
    expect(replaceActive).not.toHaveBeenCalled();
    replaceActive.mockResolvedValueOnce({
      kind: "throttled",
      retryAfterEpochMs: now + 1_100,
    });
    expect(await resume("continueInventory")).toEqual({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
      retryAfterEpochMs: now + 1_100,
    });
    replaceActive.mockResolvedValueOnce({ kind: "effect_unknown" });
    expect(await resume("startInventory")).toEqual({
      kind: "error",
      code: "effect_unknown",
      inventoryId,
    });
    expect(await resume("continueInventory")).toEqual({
      kind: "error",
      code: "inventory_incomplete",
    });
    expect(replaceActive).toHaveBeenCalledWith(expect.anything(), {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      state: "empty",
    });
    replaceActive.mockClear();
    expect(await resume("startInventory")).toEqual({
      kind: "error",
      code: "inventory_incomplete",
    });
    expect(replaceActive).toHaveBeenCalledWith(expect.anything(), {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      state: "empty",
    });
    const slotReads = readActive.mock.calls.length;
    const slotWrites = replaceActive.mock.calls.length;
    readManifest.mockResolvedValue(
      observed(
        {
          ...failed,
          expiresAtEpochMs: now,
        },
        syncInventoryManifestKey(vaultId, inventoryId),
      ),
    );
    for (const method of ["startInventory", "continueInventory"] as const) {
      expect(await resume(method)).toEqual({
        kind: "error",
        code: "inventory_expired",
      });
    }
    expect(readActive).toHaveBeenCalledTimes(slotReads);
    expect(replaceActive).toHaveBeenCalledTimes(slotWrites);
  });
});
