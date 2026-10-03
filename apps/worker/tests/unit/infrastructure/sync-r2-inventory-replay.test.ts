import { createContentSha256 } from "@obsidian-ai-bridge/core";
import {
  syncHeadKey,
  syncInventoryActiveKey,
  syncInventoryChunkKey,
  syncInventoryClaimKey,
  syncInventoryCursorWitnessKey,
  syncInventoryManifestKey,
} from "@protocol/sync.codec";
import {
  syncDeviceIdSchema,
  syncInventoryIdSchema,
  syncNotePathSchema,
  syncOperationIdSchema,
  syncRevisionSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type { SyncR2InventoryScratch } from "@worker/infrastructure/sync/sync-r2-inventory";
import { createSyncInventoryInvocationBudget } from "@worker/infrastructure/sync/sync-r2-inventory-budget";
import type { SyncR2InventoryListing } from "@worker/infrastructure/sync/sync-r2-inventory-list";
import { runSyncInventoryStep } from "@worker/infrastructure/sync/sync-r2-inventory-replay";
import { createSyncR2Key } from "@worker/infrastructure/sync/sync-r2-key";
import { encodeSyncRecord } from "@worker/infrastructure/sync/sync-record.codec";
import {
  SYNC_RECORD_LIMITS,
  syncInventoryManifestSchema,
} from "@worker/infrastructure/sync/sync-record.schemas";
import type {
  SyncHeadRecord,
  SyncInventoryManifest,
} from "@worker/infrastructure/sync/sync-record.types";
import { describe, expect, it, vi } from "vitest";

const vaultId = syncVaultIdSchema.parse("11111111-1111-4111-8111-111111111111");
const inventoryId = syncInventoryIdSchema.parse(
  "22222222-2222-4222-8222-222222222222",
);
const now = 2_000_000_000_000;
const startingVector = Array(64).fill(
  syncSequenceSchema.parse("00000000000000000000"),
);

/** Supplies one persisted scanning phase with exact source generation and no pages.
 * @returns Typed scan observation whose saved cursor and step remain unchanged on failure.
 */
function scanningManifest() {
  const key = createSyncR2Key(
    syncInventoryManifestKey(vaultId, inventoryId),
    vaultId,
  );
  if (!key) throw new Error("Invalid manifest fixture key");
  const value: SyncInventoryManifest = {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    inventoryId,
    phase: "scanning",
    startVector: startingVector,
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
  return {
    value,
    observed: {
      key,
      etag: "etag",
      bytes: new Uint8Array(),
      uploaded: new Date(now - 2_000),
    },
  };
}

/** Makes fail-closed fake persistence and listing boundaries for attempt-admission tests.
 * @returns Typed collaborators and spies for durable attempt writes and LIST.
 */
function fixture() {
  const fail = () => {
    throw new Error("Unexpected inventory operation");
  };
  const replaceManifest = vi.fn<SyncR2InventoryScratch["replaceManifest"]>(
    async () => ({ kind: "effect_unknown" }),
  );
  const createChunk = vi.fn<SyncR2InventoryScratch["createChunk"]>(
    async () => ({ kind: "confirmed" }),
  );
  const scratch: SyncR2InventoryScratch = {
    readActive: fail,
    createActive: fail,
    replaceActive: fail,
    readManifest: fail,
    createManifest: fail,
    replaceManifest,
    readChunk: fail,
    createChunk,
    readCursorJournal: fail,
    createCursorJournal: fail,
    replaceCursorJournal: fail,
    readCursorWitness: fail,
    createCursorWitness: fail,
  };
  const listHeads = vi.fn<SyncR2InventoryListing["listHeads"]>(async () => ({
    kind: "page",
    page: { objects: [], truncated: false },
  }));
  const readHead = vi.fn<SyncR2InventoryListing["readHead"]>(async () => ({
    kind: "unavailable",
  }));
  const listing: SyncR2InventoryListing = { listHeads, readHead };
  return {
    scratch,
    listing,
    replaceManifest,
    createChunk,
    listHeads,
    readHead,
  };
}

describe("one inventory listing step", () => {
  it.each([
    "unavailable",
    "foreign_key",
    "invalid_path",
    "duplicate_key",
    "missing_head",
    "oversized_cursor",
    "chunk_throttled",
  ] as const)(
    "withholds evidence from a reserved LIST at the %s boundary",
    async (fault) => {
      const state = fixture();
      const manifest = scanningManifest();
      const path = syncNotePathSchema.parse("notes/listed.md");
      const key = syncHeadKey(vaultId, path);
      state.replaceManifest.mockResolvedValue({ kind: "confirmed" });
      if (fault === "unavailable")
        state.listHeads.mockResolvedValue({ kind: "unavailable" });
      else if (fault === "oversized_cursor")
        state.listHeads.mockResolvedValue({
          kind: "page",
          page: {
            objects: [],
            truncated: true,
            cursor: "x".repeat(SYNC_RECORD_LIMITS.cursorBytes + 1),
          },
        });
      else if (fault !== "chunk_throttled") {
        const listedKey =
          fault === "foreign_key"
            ? "legacy/notes/listed.md"
            : fault === "invalid_path"
              ? `sync/v1/vaults/${vaultId}/heads/!.json`
              : key;
        state.listHeads.mockResolvedValue({
          kind: "page",
          page: {
            objects: [
              {
                key: listedKey,
                size: 100,
              },
            ],
            truncated: false,
          },
        });
        if (fault === "duplicate_key") {
          const hash = createContentSha256("b".repeat(64));
          if (!hash) throw new Error("Expected prior chunk root");
          manifest.value = {
            ...manifest.value,
            cursor: "QQ",
            lastKey: key,
            nextStep: 1,
            listPageCount: 1,
            chunkCount: 1,
            chunkHash: hash,
            headCount: 1,
            listAttemptCount: 1,
            headGetAttemptCount: 1,
          };
        }
        if (fault === "missing_head")
          state.readHead.mockResolvedValue({ kind: "absent" });
      }
      if (fault === "chunk_throttled")
        state.createChunk.mockResolvedValue({
          kind: "throttled",
          retryAfterEpochMs: now + 1_100,
        });
      expect(
        syncInventoryManifestSchema.safeParse(manifest.value).success,
      ).toBe(true);
      expect(
        await runSyncInventoryStep(
          manifest,
          state.scratch,
          state.listing,
          createSyncInventoryInvocationBudget(() => 20),
          () => now,
        ),
      ).toEqual(
        fault === "chunk_throttled"
          ? {
              kind: "inventory_in_progress",
              vaultId,
              inventoryId,
              retryAfterEpochMs: now + 1_100,
            }
          : fault === "unavailable"
            ? { kind: "error", code: "storage_unavailable", inventoryId }
            : { kind: "error", code: "inventory_incomplete" },
      );
      expect(state.replaceManifest).toHaveBeenCalledExactlyOnceWith(manifest, {
        ...manifest.value,
        reservedAttempt: 1,
      });
      expect(state.listHeads).toHaveBeenCalledOnce();
      expect(state.createChunk).toHaveBeenCalledTimes(
        fault === "chunk_throttled" ? 1 : 0,
      );
    },
  );

  it.each(["failed", "expired", "terminal_page"] as const)(
    "does not reserve another attempt or LIST for a %s scan",
    async (stateKind) => {
      const state = fixture();
      const manifest = scanningManifest();
      if (stateKind === "failed")
        manifest.value = { ...manifest.value, phase: "failed" };
      if (stateKind === "expired")
        manifest.value = { ...manifest.value, expiresAtEpochMs: now };
      if (stateKind === "terminal_page") {
        const hash = createContentSha256("b".repeat(64));
        if (!hash) throw new Error("Expected terminal root");
        manifest.value = {
          ...manifest.value,
          listPageCount: 1,
          nextStep: 1,
          chunkCount: 1,
          chunkHash: hash,
          listAttemptCount: 1,
        };
      }
      expect(
        syncInventoryManifestSchema.safeParse(manifest.value).success,
      ).toBe(true);
      expect(
        await runSyncInventoryStep(
          manifest,
          state.scratch,
          state.listing,
          createSyncInventoryInvocationBudget(() => 20),
          () => now,
        ),
      ).toEqual(
        stateKind === "terminal_page"
          ? { kind: "inventory_in_progress", vaultId, inventoryId }
          : {
              kind: "error",
              code:
                stateKind === "expired"
                  ? "inventory_expired"
                  : "inventory_incomplete",
            },
      );
      expect(state.replaceManifest).not.toHaveBeenCalled();
      expect(state.listHeads).not.toHaveBeenCalled();
      expect(state.createChunk).not.toHaveBeenCalled();
    },
  );
  it("does not LIST after an uncertain exact attempt-reservation CAS", async () => {
    const { scratch, listing, replaceManifest, listHeads } = fixture();
    const manifest = scanningManifest();
    const result = await runSyncInventoryStep(
      manifest,
      scratch,
      listing,
      createSyncInventoryInvocationBudget(() => 20),
      () => now,
    );
    expect(result).toEqual({
      kind: "error",
      code: "effect_unknown",
      inventoryId,
    });
    expect(replaceManifest).toHaveBeenCalledWith(manifest, {
      ...manifest.value,
      reservedAttempt: 1,
    });
    expect(listHeads).not.toHaveBeenCalled();
  });

  it("does not LIST when a definite attempt-reservation cooldown supplies a same-ID floor", async () => {
    const { scratch, listing, replaceManifest, listHeads } = fixture();
    replaceManifest.mockResolvedValue({
      kind: "throttled",
      retryAfterEpochMs: now + 1_100,
    });
    expect(
      await runSyncInventoryStep(
        scanningManifest(),
        scratch,
        listing,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ),
    ).toEqual({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
      retryAfterEpochMs: now + 1_100,
    });
    expect(listHeads).not.toHaveBeenCalled();
  });

  it("persists an empty terminal page chunk after reservation without a same-key manifest CAS inside its cooldown", async () => {
    const { scratch, listing, replaceManifest, createChunk, listHeads } =
      fixture();
    replaceManifest.mockResolvedValue({ kind: "confirmed" });
    const result = await runSyncInventoryStep(
      scanningManifest(),
      scratch,
      listing,
      createSyncInventoryInvocationBudget(() => 20),
      () => now,
    );
    expect(result).toEqual({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
    });
    expect(listHeads).toHaveBeenCalledExactlyOnceWith(vaultId, null);
    expect(createChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        step: 0,
        vaultId,
        inventoryId,
        truncated: false,
        outputCursor: null,
        headSummary: null,
        previousChunkHash: null,
      }),
    );
    expect(replaceManifest).toHaveBeenCalledTimes(1);
  });

  it("persists one canonical linked head summary for a single complete LIST page", async () => {
    const {
      scratch,
      listing,
      replaceManifest,
      createChunk,
      listHeads,
      readHead,
    } = fixture();
    replaceManifest.mockResolvedValue({ kind: "confirmed" });
    const path = syncNotePathSchema.parse("notes/item.md");
    const key = syncHeadKey(vaultId, path);
    const digest = createContentSha256(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    const observedKey = createSyncR2Key(key, vaultId);
    if (!digest || !observedKey)
      throw new Error("Invalid head evidence fixture");
    const record: SyncHeadRecord = {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId,
      path,
      kind: "live",
      parent: { kind: "never_seen" },
      revision: syncRevisionSchema.parse(
        "33333333-3333-4333-8333-333333333333",
      ),
      operationId: syncOperationIdSchema.parse(
        "44444444-4444-4444-8444-444444444444",
      ),
      origin: syncDeviceIdSchema.parse("55555555-5555-4555-8555-555555555555"),
      contentSha256: digest,
      byteSize: 4,
      mediaType: "text/markdown",
    };
    listHeads.mockResolvedValue({
      kind: "page",
      page: { objects: [{ key, size: 100 }], truncated: false },
    });
    readHead.mockResolvedValue({
      kind: "observed",
      observation: {
        value: record,
        observed: {
          key: observedKey,
          etag: "etag",
          bytes: new Uint8Array(100),
          uploaded: new Date(now),
        },
      },
    });
    expect(
      await runSyncInventoryStep(
        scanningManifest(),
        scratch,
        listing,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ),
    ).toEqual({ kind: "inventory_in_progress", vaultId, inventoryId });
    expect(readHead).toHaveBeenCalledExactlyOnceWith(vaultId, key, 2048);
    expect(createChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        headSummary: expect.objectContaining({
          revision: record.revision,
          kind: "live",
        }),
      }),
    );
  });

  it("validates a durable chunk and advances the manifest without repeating LIST", async () => {
    const { scratch, listing, replaceManifest, createChunk, listHeads } =
      fixture();
    replaceManifest.mockResolvedValue({ kind: "confirmed" });
    const initial = scanningManifest();
    await runSyncInventoryStep(
      initial,
      scratch,
      listing,
      createSyncInventoryInvocationBudget(() => 20),
      () => now,
    );
    const chunk = createChunk.mock.calls[0]?.[0];
    if (!chunk) throw new Error("Missing page chunk fixture");
    const bytes = await encodeSyncRecord({ kind: "chunk", record: chunk });
    const key = createSyncR2Key(
      syncInventoryChunkKey(vaultId, inventoryId, 0),
      vaultId,
    );
    if (!key) throw new Error("Invalid chunk key fixture");
    scratch.readChunk = vi.fn<SyncR2InventoryScratch["readChunk"]>(
      async () => ({
        kind: "observed",
        observation: {
          value: chunk,
          observed: { key, etag: "chunk-etag", bytes, uploaded: new Date(now) },
        },
      }),
    );
    const reserved = {
      ...initial,
      value: { ...initial.value, reservedAttempt: 1 as const },
    };
    listHeads.mockClear();
    replaceManifest.mockClear();
    replaceManifest.mockResolvedValueOnce({
      kind: "throttled",
      retryAfterEpochMs: now + 1_100,
    });
    expect(
      await runSyncInventoryStep(
        reserved,
        scratch,
        listing,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ),
    ).toEqual({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
      retryAfterEpochMs: now + 1_100,
    });
    expect(listHeads).not.toHaveBeenCalled();
    replaceManifest.mockClear();
    expect(
      await runSyncInventoryStep(
        reserved,
        scratch,
        listing,
        createSyncInventoryInvocationBudget(() => 20),
        () => now + 1_100,
      ),
    ).toEqual({ kind: "inventory_in_progress", vaultId, inventoryId });
    expect(listHeads).not.toHaveBeenCalled();
    expect(replaceManifest).toHaveBeenCalledExactlyOnceWith(
      reserved,
      expect.objectContaining({
        nextStep: 1,
        chunkCount: 1,
        listPageCount: 1,
        reservedAttempt: 0,
      }),
    );
  });

  it("persists failed phase for a divergent present chunk without another LIST", async () => {
    const { scratch, listing, replaceManifest, createChunk, listHeads } =
      fixture();
    replaceManifest.mockResolvedValue({ kind: "confirmed" });
    const initial = scanningManifest();
    await runSyncInventoryStep(
      initial,
      scratch,
      listing,
      createSyncInventoryInvocationBudget(() => 20),
      () => now,
    );
    const original = createChunk.mock.calls[0]?.[0];
    const wrongDigest = createContentSha256(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    const key = createSyncR2Key(
      syncInventoryChunkKey(vaultId, inventoryId, 0),
      vaultId,
    );
    if (!original || !wrongDigest || !key)
      throw new Error("Invalid replay fixture");
    const tampered = { ...original, inputCursorDigest: wrongDigest };
    const bytes = await encodeSyncRecord({ kind: "chunk", record: tampered });
    scratch.readChunk = vi.fn<SyncR2InventoryScratch["readChunk"]>(
      async () => ({
        kind: "observed",
        observation: {
          value: tampered,
          observed: { key, etag: "etag", bytes, uploaded: new Date(now) },
        },
      }),
    );
    const reserved = {
      ...initial,
      value: { ...initial.value, reservedAttempt: 1 as const },
    };
    replaceManifest.mockClear();
    listHeads.mockClear();
    expect(
      await runSyncInventoryStep(
        reserved,
        scratch,
        listing,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ),
    ).toEqual({ kind: "error", code: "inventory_incomplete" });
    expect(replaceManifest).toHaveBeenCalledExactlyOnceWith(reserved, {
      ...reserved.value,
      phase: "failed",
    });
    expect(listHeads).not.toHaveBeenCalled();
  });

  it("returns a known target floor without advancing the reserved manifest or relisting", async () => {
    const { scratch, listing, replaceManifest, listHeads } = fixture();
    const digestA = createContentSha256(
      "559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd",
    );
    const emptyDigest = createContentSha256(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    if (!digestA || !emptyDigest)
      throw new Error("Invalid cursor fixture digest");
    const initial = scanningManifest();
    const manifest = {
      ...initial,
      value: {
        ...initial.value,
        schemaVersion: 2 as const,
        cursorWitnessMode: 1 as const,
        reservedAttempt: 1 as const,
      },
    };
    const chunk = {
      schemaVersion: 1 as const,
      protocolMajor: 1 as const,
      vaultId,
      inventoryId,
      step: 0,
      previousChunkHash: null,
      inputCursorDigest: emptyDigest,
      outputCursorDigest: digestA,
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
    const key = createSyncR2Key(
      syncInventoryChunkKey(vaultId, inventoryId, 0),
      vaultId,
    );
    const activeKey = createSyncR2Key(syncInventoryActiveKey(vaultId), vaultId);
    const journalKey = createSyncR2Key(
      syncInventoryClaimKey(vaultId, inventoryId, 0),
      vaultId,
    );
    if (!key || !activeKey || !journalKey)
      throw new Error("Invalid scratch fixture keys");
    scratch.readChunk = vi.fn<SyncR2InventoryScratch["readChunk"]>(
      async () => ({
        kind: "observed",
        observation: {
          value: chunk,
          observed: {
            key,
            etag: "chunk-etag",
            bytes: await encodeSyncRecord({ kind: "chunk", record: chunk }),
            uploaded: new Date(now - 2_000),
          },
        },
      }),
    );
    scratch.readManifest = vi.fn<SyncR2InventoryScratch["readManifest"]>(
      async () => ({
        kind: "observed",
        observation: manifest,
      }),
    );
    scratch.readActive = vi.fn<SyncR2InventoryScratch["readActive"]>(
      async () => ({
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
            etag: "active-etag",
            bytes: new Uint8Array(),
            uploaded: new Date(now - 2_000),
          },
        },
      }),
    );
    scratch.readCursorWitness = vi.fn<
      SyncR2InventoryScratch["readCursorWitness"]
    >(async () => ({ kind: "absent" }));
    let claimed:
      | Parameters<SyncR2InventoryScratch["createCursorJournal"]>[0]
      | undefined;
    const createCursorJournal = vi.fn<
      SyncR2InventoryScratch["createCursorJournal"]
    >(async (record) => {
      claimed = record;
      return { kind: "confirmed" };
    });
    scratch.createCursorJournal = createCursorJournal;
    scratch.readCursorJournal = vi.fn<
      SyncR2InventoryScratch["readCursorJournal"]
    >(async () =>
      claimed === undefined
        ? { kind: "absent" }
        : {
            kind: "observed",
            observation: {
              value: claimed,
              observed: {
                key: journalKey,
                etag: "claim-etag",
                bytes: await encodeSyncRecord({
                  kind: "cursorJournal",
                  record: claimed,
                }),
                uploaded: new Date(now - 2_000),
              },
            },
          },
    );
    const createCursorWitness = vi.fn<
      SyncR2InventoryScratch["createCursorWitness"]
    >(async () => ({ kind: "effect_unknown", retryAfterEpochMs: now + 2_000 }));
    scratch.createCursorWitness = createCursorWitness;
    expect(
      await runSyncInventoryStep(
        manifest,
        scratch,
        listing,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ),
    ).toEqual({
      kind: "error",
      code: "effect_unknown",
      inventoryId,
      retryAfterEpochMs: now + 2_000,
    });
    expect(createCursorJournal).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "attempting",
        step: 0,
        cursorDigest: digestA,
      }),
    );
    expect(createCursorWitness).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        step: 0,
        cursorDigest: digestA,
      }),
    );
    expect(replaceManifest).not.toHaveBeenCalled();
    expect(listHeads).not.toHaveBeenCalled();
  });

  it("fails a witnessed scan when a non-adjacent empty-page output repeats an earlier cursor", async () => {
    const { scratch, listing, replaceManifest, listHeads } = fixture();
    replaceManifest.mockResolvedValue({ kind: "confirmed" });
    const priorHash = createContentSha256("a".repeat(64));
    const oldHash = createContentSha256("c".repeat(64));
    const digestA = createContentSha256(
      "559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd",
    );
    const digestB = createContentSha256(
      "df7e70e5021544f4834bbee64a9e3789febc4be81470df629cad6ddb03320a5c",
    );
    if (!priorHash || !oldHash || !digestA || !digestB)
      throw new Error("Invalid cursor digest fixture");
    const initial = scanningManifest();
    const manifest = {
      ...initial,
      value: {
        ...initial.value,
        schemaVersion: 2 as const,
        cursorWitnessMode: 1 as const,
        cursor: "Qg",
        nextStep: 2,
        listPageCount: 2,
        chunkCount: 2,
        chunkHash: priorHash,
        emptyPageCount: 2,
        listAttemptCount: 2,
        reservedAttempt: 1 as const,
      },
    };
    const chunk = {
      schemaVersion: 1 as const,
      protocolMajor: 1 as const,
      vaultId,
      inventoryId,
      step: 2,
      previousChunkHash: priorHash,
      inputCursorDigest: digestB,
      outputCursorDigest: digestA,
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
    const chunkKey = createSyncR2Key(
      syncInventoryChunkKey(vaultId, inventoryId, 2),
      vaultId,
    );
    if (!chunkKey) throw new Error("Invalid chunk fixture key");
    scratch.readChunk = vi.fn<SyncR2InventoryScratch["readChunk"]>(
      async () => ({
        kind: "observed",
        observation: {
          value: chunk,
          observed: {
            key: chunkKey,
            etag: "chunk-etag",
            bytes: await encodeSyncRecord({ kind: "chunk", record: chunk }),
            uploaded: new Date(now - 2_000),
          },
        },
      }),
    );
    const witness = {
      schemaVersion: 1 as const,
      protocolMajor: 1 as const,
      vaultId,
      inventoryId,
      step: 0,
      chunkHash: oldHash,
      cursorDigest: digestA,
    };
    const witnessKey = createSyncR2Key(
      syncInventoryCursorWitnessKey(vaultId, inventoryId, digestA),
      vaultId,
    );
    if (!witnessKey) throw new Error("Invalid witness fixture key");
    scratch.readCursorWitness = vi.fn<
      SyncR2InventoryScratch["readCursorWitness"]
    >(async () => ({
      kind: "observed",
      observation: {
        value: witness,
        observed: {
          key: witnessKey,
          etag: "witness-etag",
          bytes: await encodeSyncRecord({
            kind: "cursorWitness",
            record: witness,
          }),
          uploaded: new Date(now - 2_000),
        },
      },
    }));
    scratch.readCursorJournal = vi.fn<
      SyncR2InventoryScratch["readCursorJournal"]
    >(async () => ({ kind: "absent" }));
    expect(
      await runSyncInventoryStep(
        manifest,
        scratch,
        listing,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ),
    ).toEqual({
      kind: "error",
      code: "inventory_incomplete",
    });
    expect(replaceManifest).toHaveBeenCalledExactlyOnceWith(manifest, {
      ...manifest.value,
      phase: "failed",
    });
    expect(listHeads).not.toHaveBeenCalled();
  });

  it("persists a short empty truncated page and resumes from its opaque output cursor", async () => {
    const { scratch, listing, replaceManifest, createChunk, listHeads } =
      fixture();
    replaceManifest.mockResolvedValue({ kind: "confirmed" });
    listHeads.mockResolvedValue({
      kind: "page",
      page: { objects: [], truncated: true, cursor: "opaque-next" },
    });
    const initial = scanningManifest();
    expect(
      await runSyncInventoryStep(
        initial,
        scratch,
        listing,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ),
    ).toEqual({ kind: "inventory_in_progress", vaultId, inventoryId });
    const record = createChunk.mock.calls[0]?.[0];
    const key = createSyncR2Key(
      syncInventoryChunkKey(vaultId, inventoryId, 0),
      vaultId,
    );
    if (!record || !key) throw new Error("Missing truncated chunk");
    const bytes = await encodeSyncRecord({ kind: "chunk", record });
    scratch.readChunk = vi.fn<SyncR2InventoryScratch["readChunk"]>(
      async () => ({
        kind: "observed",
        observation: {
          value: record,
          observed: { key, etag: "etag", bytes, uploaded: new Date(now) },
        },
      }),
    );
    replaceManifest.mockClear();
    listHeads.mockClear();
    const reserved = {
      ...initial,
      value: { ...initial.value, reservedAttempt: 1 as const },
    };
    await runSyncInventoryStep(
      reserved,
      scratch,
      listing,
      createSyncInventoryInvocationBudget(() => 20),
      () => now,
    );
    const advanced = replaceManifest.mock.calls[0]?.[1];
    expect(advanced).toMatchObject({ nextStep: 1, emptyPageCount: 1 });
    if (!advanced) throw new Error("Missing advanced cursor");
    replaceManifest.mockClear();
    listHeads.mockClear();
    await runSyncInventoryStep(
      { ...initial, value: advanced },
      scratch,
      listing,
      createSyncInventoryInvocationBudget(() => 20),
      () => now,
    );
    expect(listHeads).toHaveBeenCalledExactlyOnceWith(vaultId, "opaque-next");
  });

  it("allows one same-cursor replay only after a verified absent first-attempt chunk", async () => {
    const { scratch, listing, replaceManifest, createChunk, listHeads } =
      fixture();
    scratch.readChunk = vi.fn<SyncR2InventoryScratch["readChunk"]>(
      async () => ({ kind: "absent" }),
    );
    replaceManifest.mockResolvedValue({ kind: "confirmed" });
    const original = scanningManifest();
    const reserved = {
      ...original,
      value: { ...original.value, reservedAttempt: 1 as const },
    };
    expect(
      await runSyncInventoryStep(
        reserved,
        scratch,
        listing,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ),
    ).toEqual({ kind: "inventory_in_progress", vaultId, inventoryId });
    expect(replaceManifest).toHaveBeenCalledExactlyOnceWith(reserved, {
      ...reserved.value,
      reservedAttempt: 2,
    });
    expect(listHeads).toHaveBeenCalledExactlyOnceWith(vaultId, null);
    expect(createChunk).toHaveBeenCalledTimes(1);
  });

  it("does not relist a reserved attempt while its deterministic chunk read is unavailable", async () => {
    const { scratch, listing, replaceManifest, listHeads } = fixture();
    scratch.readChunk = vi.fn<SyncR2InventoryScratch["readChunk"]>(
      async () => ({ kind: "unavailable" }),
    );
    const initial = scanningManifest();
    const reserved = {
      ...initial,
      value: { ...initial.value, reservedAttempt: 1 as const },
    };
    expect(
      await runSyncInventoryStep(
        reserved,
        scratch,
        listing,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ),
    ).toEqual({ kind: "error", code: "effect_unknown", inventoryId });
    expect(replaceManifest).not.toHaveBeenCalled();
    expect(listHeads).not.toHaveBeenCalled();
  });

  it("persists failed phase for a present invalid chunk so continuation can release its slot", async () => {
    const { scratch, listing, replaceManifest, listHeads } = fixture();
    scratch.readChunk = vi.fn<SyncR2InventoryScratch["readChunk"]>(
      async () => ({ kind: "invalid" }),
    );
    replaceManifest.mockResolvedValue({ kind: "confirmed" });
    const initial = scanningManifest();
    const reserved = {
      ...initial,
      value: { ...initial.value, reservedAttempt: 1 as const },
    };
    expect(
      await runSyncInventoryStep(
        reserved,
        scratch,
        listing,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ),
    ).toEqual({ kind: "error", code: "inventory_incomplete" });
    expect(replaceManifest).toHaveBeenCalledExactlyOnceWith(reserved, {
      ...reserved.value,
      phase: "failed",
    });
    expect(listHeads).not.toHaveBeenCalled();
  });

  it("fails a second absent attempt without issuing a third LIST", async () => {
    const { scratch, listing, replaceManifest, listHeads } = fixture();
    scratch.readChunk = vi.fn<SyncR2InventoryScratch["readChunk"]>(
      async () => ({ kind: "absent" }),
    );
    replaceManifest.mockResolvedValue({ kind: "confirmed" });
    const original = scanningManifest();
    const exhausted = {
      ...original,
      value: { ...original.value, reservedAttempt: 2 as const },
    };
    replaceManifest.mockResolvedValueOnce({
      kind: "throttled",
      retryAfterEpochMs: now + 1_100,
    });
    expect(
      await runSyncInventoryStep(
        exhausted,
        scratch,
        listing,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ),
    ).toEqual({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
      retryAfterEpochMs: now + 1_100,
    });
    expect(listHeads).not.toHaveBeenCalled();
    replaceManifest.mockClear();
    expect(
      await runSyncInventoryStep(
        exhausted,
        scratch,
        listing,
        createSyncInventoryInvocationBudget(() => 20),
        () => now + 1_100,
      ),
    ).toEqual({ kind: "error", code: "inventory_limit_exceeded" });
    expect(replaceManifest).toHaveBeenCalledExactlyOnceWith(exhausted, {
      ...exhausted.value,
      phase: "failed",
    });
    expect(listHeads).not.toHaveBeenCalled();
  });

  it("fences the exhausted step limit without another LIST and confirms failure only after durable CAS", async () => {
    const { scratch, listing, replaceManifest, listHeads } = fixture();
    const root = createContentSha256(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    if (!root) throw new Error("Invalid digest fixture");
    const original = scanningManifest();
    const exhausted = {
      ...original,
      value: {
        ...original.value,
        nextStep: SYNC_RECORD_LIMITS.inventorySteps,
        listPageCount: SYNC_RECORD_LIMITS.inventorySteps,
        chunkCount: SYNC_RECORD_LIMITS.inventorySteps,
        chunkHash: root,
        cursor: "QQ",
      },
    };
    expect(syncInventoryManifestSchema.safeParse(exhausted.value).success).toBe(
      true,
    );
    expect(
      await runSyncInventoryStep(
        exhausted,
        scratch,
        listing,
        createSyncInventoryInvocationBudget(() => 0),
        () => now,
      ),
    ).toEqual({ kind: "inventory_in_progress", vaultId, inventoryId });
    expect(replaceManifest).not.toHaveBeenCalled();
    replaceManifest.mockResolvedValueOnce({
      kind: "throttled",
      retryAfterEpochMs: now + 1_100,
    });
    expect(
      await runSyncInventoryStep(
        exhausted,
        scratch,
        listing,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ),
    ).toEqual({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
      retryAfterEpochMs: now + 1_100,
    });
    replaceManifest.mockResolvedValueOnce({ kind: "confirmed" });
    expect(
      await runSyncInventoryStep(
        exhausted,
        scratch,
        listing,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ),
    ).toEqual({ kind: "error", code: "inventory_limit_exceeded" });
    expect(
      await runSyncInventoryStep(
        exhausted,
        scratch,
        listing,
        createSyncInventoryInvocationBudget(() => 20),
        () => now,
      ),
    ).toEqual({ kind: "error", code: "effect_unknown", inventoryId });
    expect(replaceManifest).toHaveBeenCalledTimes(3);
    expect(replaceManifest).toHaveBeenLastCalledWith(exhausted, {
      ...exhausted.value,
      phase: "failed",
    });
    expect(listHeads).not.toHaveBeenCalled();
  });

  it("defers before persisting an attempt when CPU preflight cannot cover the complete page", async () => {
    const { scratch, listing, replaceManifest, listHeads } = fixture();
    const result = await runSyncInventoryStep(
      scanningManifest(),
      scratch,
      listing,
      createSyncInventoryInvocationBudget(() => 0),
      () => now,
    );
    expect(result).toEqual({
      kind: "inventory_in_progress",
      vaultId,
      inventoryId,
    });
    expect(replaceManifest).not.toHaveBeenCalled();
    expect(listHeads).not.toHaveBeenCalled();
  });
});
