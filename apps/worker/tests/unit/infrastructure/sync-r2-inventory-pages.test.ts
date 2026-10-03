import type { SyncCompleteInventory } from "@core/sync/sync-store.types";
import {
  decodeBase64Url,
  decodeUtf8,
  encodeBase64Url,
} from "@obsidian-ai-bridge/core";
import {
  syncHeadKey,
  syncInventoryActiveKey,
  syncInventoryChunkKey,
  syncInventoryManifestKey,
} from "@protocol/sync.codec";
import {
  syncInventoryIdSchema,
  syncNotePathSchema,
  syncRevisionSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type { SyncR2InventoryScratch } from "@worker/infrastructure/sync/sync-r2-inventory";
import { createSyncInventoryInvocationBudget } from "@worker/infrastructure/sync/sync-r2-inventory-budget";
import { syncR2InventoryPages } from "@worker/infrastructure/sync/sync-r2-inventory-pages";
import { createSyncR2Key } from "@worker/infrastructure/sync/sync-r2-key";
import { encodeSyncRecord } from "@worker/infrastructure/sync/sync-record.codec";
import type {
  SyncInventoryChunk,
  SyncInventoryManifest,
} from "@worker/infrastructure/sync/sync-record.types";
import { sha256Content } from "@worker/storage/storage-crypto";
import { describe, expect, it, vi } from "vitest";

const vaultId = syncVaultIdSchema.parse("11111111-1111-4111-8111-111111111111");
const inventoryId = syncInventoryIdSchema.parse(
  "22222222-2222-4222-8222-222222222222",
);

/** Assembles one fully committed empty terminal page and exact slot-release evidence.
 * @returns Typed complete handle, scratch reader and immutable chunk read spy.
 */
async function fixture() {
  const digest = await sha256Content("");
  const chunk: SyncInventoryChunk = {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    inventoryId,
    step: 0,
    previousChunkHash: null,
    inputCursorDigest: digest,
    outputCursorDigest: digest,
    outputCursor: null,
    truncated: false,
    transcript: JSON.stringify({
      objectCount: 0,
      keySha256: null,
      headBodyBytes: 0,
      truncated: false,
    }),
    headSummary: null,
  };
  const bytes = await encodeSyncRecord({ kind: "chunk", record: chunk });
  const root = await sha256Content(new TextDecoder().decode(bytes));
  const vector = Array(64).fill(
    syncSequenceSchema.parse("00000000000000000000"),
  );
  const handle: SyncCompleteInventory = {
    kind: "complete",
    vaultId,
    inventoryId,
    vector,
    entryCount: 0,
    chunkCount: 1,
    root,
  };
  const manifest: SyncInventoryManifest = {
    schemaVersion: 2,
    cursorWitnessMode: 1,
    protocolMajor: 1,
    vaultId,
    inventoryId,
    phase: "complete",
    startVector: vector,
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
    evidenceBytes: bytes.byteLength,
    chunkCount: 1,
    chunkHash: root,
    reservedAttempt: 0,
    expiresAtEpochMs: 2_000_000_000_000,
  };
  const key = (value: string) => {
    const validated = createSyncR2Key(value, vaultId);
    if (!validated) throw new Error("Invalid fixture key");
    return validated;
  };
  const observed = <T>(
    value: T,
    keyValue: string,
    body: Uint8Array = new Uint8Array(),
  ) => ({
    kind: "observed" as const,
    observation: {
      value,
      observed: {
        key: key(keyValue),
        etag: "etag",
        bytes: body,
        uploaded: new Date(1_000),
      },
    },
  });
  const readChunk = vi.fn<SyncR2InventoryScratch["readChunk"]>(async () =>
    observed(chunk, syncInventoryChunkKey(vaultId, inventoryId, 0), bytes),
  );
  const fail = () => {
    throw new Error("Unexpected inventory write");
  };
  const readManifest = vi.fn(async () =>
    observed(manifest, syncInventoryManifestKey(vaultId, inventoryId)),
  );
  const scratch: SyncR2InventoryScratch = {
    readManifest,
    readActive: vi.fn(async () =>
      observed(
        {
          schemaVersion: 1 as const,
          protocolMajor: 1 as const,
          vaultId,
          state: "empty" as const,
        },
        syncInventoryActiveKey(vaultId),
      ),
    ),
    readChunk,
    createManifest: fail,
    replaceManifest: fail,
    createActive: fail,
    replaceActive: fail,
    createChunk: fail,
    readCursorJournal: fail,
    createCursorJournal: fail,
    replaceCursorJournal: fail,
    readCursorWitness: fail,
    createCursorWitness: fail,
  };
  return {
    handle,
    scratch,
    readManifest,
    readChunk,
    manifest,
    chunk,
    observed,
  };
}

describe("verified inventory evidence pages", () => {
  it.each([
    "malformed_json",
    "oversized",
    "noncanonical",
    "foreign_scan",
    "past_end",
  ] as const)(
    "rejects a %s evidence continuation before reading scan authority or chunks",
    async (fault) => {
      const state = await fixture();
      const checkpoint = {
        version: 1,
        vaultId,
        inventoryId,
        root: state.handle.root,
        vectorDigest: await sha256Content(JSON.stringify(state.handle.vector)),
        step: 0,
        count: 0,
        evidenceBytes: 0,
        priorHash: null,
        inputDigest: await sha256Content(""),
        lastKey: null,
      };
      const changed =
        fault === "foreign_scan"
          ? {
              ...checkpoint,
              inventoryId: "99999999-9999-4999-8999-999999999999",
            }
          : fault === "past_end"
            ? { ...checkpoint, step: 1 }
            : checkpoint;
      const text =
        fault === "malformed_json"
          ? "{"
          : `${JSON.stringify(changed)}${fault === "noncanonical" ? " " : ""}`;
      const cursor =
        fault === "oversized"
          ? "A".repeat(8_193)
          : encodeBase64Url(new TextEncoder().encode(text));
      expect(
        await syncR2InventoryPages(
          state.scratch,
          createSyncInventoryInvocationBudget(() => 20),
          () => 1_000,
        ).readInventoryPage({ vaultId, handle: state.handle, cursor }),
      ).toEqual({ kind: "error", code: "inventory_incomplete" });
      expect(state.readManifest).not.toHaveBeenCalled();
      expect(state.readChunk).not.toHaveBeenCalled();
    },
  );

  it("does not read any inventory evidence without the complete-page CPU reservation", async () => {
    const state = await fixture();
    expect(
      await syncR2InventoryPages(
        state.scratch,
        createSyncInventoryInvocationBudget(() => 0),
        () => 1_000,
      ).readInventoryPage({ vaultId, handle: state.handle, cursor: "" }),
    ).toEqual({ kind: "error", code: "storage_unavailable", inventoryId });
    expect(state.readManifest).not.toHaveBeenCalled();
    expect(state.readChunk).not.toHaveBeenCalled();
  });

  it.each(["vector", "count", "chunk_count"] as const)(
    "rejects an invalid complete handle %s before storage access",
    async (field) => {
      const state = await fixture();
      const handle = {
        ...state.handle,
        vector: field === "vector" ? [] : state.handle.vector,
        entryCount: field === "count" ? -1 : state.handle.entryCount,
        chunkCount: field === "chunk_count" ? 0 : state.handle.chunkCount,
      };
      expect(
        await syncR2InventoryPages(
          state.scratch,
          createSyncInventoryInvocationBudget(() => 20),
          () => 1_000,
        ).readInventoryPage({ vaultId, handle, cursor: "" }),
      ).toEqual({ kind: "error", code: "invalid_input" });
      expect(state.readManifest).not.toHaveBeenCalled();
      expect(state.readChunk).not.toHaveBeenCalled();
    },
  );

  it("does not accept a canonical chunk whose input digest breaks the complete chain", async () => {
    const state = await fixture();
    const value = {
      ...state.chunk,
      inputCursorDigest: await sha256Content("foreign cursor"),
    };
    const bytes = await encodeSyncRecord({ kind: "chunk", record: value });
    state.readChunk.mockResolvedValue(
      state.observed(
        value,
        syncInventoryChunkKey(vaultId, inventoryId, 0),
        bytes,
      ),
    );
    expect(
      await syncR2InventoryPages(
        state.scratch,
        createSyncInventoryInvocationBudget(() => 20),
        () => 1_000,
      ).readInventoryPage({ vaultId, handle: state.handle, cursor: "" }),
    ).toEqual({ kind: "error", code: "inventory_incomplete" });
    expect(state.readChunk).toHaveBeenCalledOnce();
  });

  it("rejects a terminal chunk before the manifest's declared chain end without fabricating a next page", async () => {
    const state = await fixture();
    state.scratch.readManifest = vi.fn(async () =>
      state.observed(
        {
          ...state.manifest,
          chunkCount: 2,
          listPageCount: 2,
          nextStep: 2,
          listAttemptCount: 2,
          evidenceBytes: state.manifest.evidenceBytes * 2,
        },
        syncInventoryManifestKey(vaultId, inventoryId),
      ),
    );
    expect(
      await syncR2InventoryPages(
        state.scratch,
        createSyncInventoryInvocationBudget(() => 20),
        () => 1_000,
      ).readInventoryPage({
        vaultId,
        handle: { ...state.handle, chunkCount: 2 },
        cursor: "",
      }),
    ).toEqual({ kind: "error", code: "inventory_incomplete" });
    expect(state.readChunk).toHaveBeenCalledExactlyOnceWith(
      vaultId,
      inventoryId,
      0,
    );
  });
  it("returns a validated content-free live head summary from a complete linked page", async () => {
    const { handle, scratch, manifest, chunk, observed } = await fixture();
    const path = syncNotePathSchema.parse("notes/item.md");
    const revision = syncRevisionSchema.parse(
      "33333333-3333-4333-8333-333333333333",
    );
    const key = syncHeadKey(vaultId, path);
    const pathKey = key.slice(`sync/v1/vaults/${vaultId}/heads/`.length, -5);
    const evidence: SyncInventoryChunk = {
      ...chunk,
      transcript: JSON.stringify({
        objectCount: 1,
        keySha256: await sha256Content(key),
        headBodyBytes: 100,
        truncated: false,
      }),
      headSummary: { pathKey, kind: "live", revision },
    };
    const bytes = await encodeSyncRecord({ kind: "chunk", record: evidence });
    const root = await sha256Content(new TextDecoder().decode(bytes));
    scratch.readManifest = vi.fn(async () =>
      observed(
        {
          ...manifest,
          headCount: 1,
          evidenceBytes: bytes.byteLength,
          chunkHash: root,
          lastKey: key,
        },
        syncInventoryManifestKey(vaultId, inventoryId),
      ),
    );
    scratch.readChunk = vi.fn(async () =>
      observed(evidence, syncInventoryChunkKey(vaultId, inventoryId, 0), bytes),
    );
    const pages = syncR2InventoryPages(
      scratch,
      createSyncInventoryInvocationBudget(() => 20),
      () => 1_000_000,
    );
    expect(
      await pages.readInventoryPage({
        vaultId,
        handle: { ...handle, root, entryCount: 1 },
        cursor: "",
      }),
    ).toEqual({
      kind: "complete",
      summaries: [{ path, kind: "live", revision }],
      nextCursor: null,
      final: true,
    });
  });

  it("refuses historical v1 complete handles before reading any chunk", async () => {
    const { handle, scratch, readChunk, manifest, observed } = await fixture();
    if (manifest.schemaVersion !== 2) throw new Error("Expected v2 fixture");
    const { cursorWitnessMode: _mode, ...fields } = manifest;
    const historical: SyncInventoryManifest = { ...fields, schemaVersion: 1 };
    scratch.readManifest = vi.fn(async () =>
      observed(historical, syncInventoryManifestKey(vaultId, inventoryId)),
    );
    const pages = syncR2InventoryPages(
      scratch,
      createSyncInventoryInvocationBudget(() => 20),
      () => 1_000,
    );
    expect(
      await pages.readInventoryPage({ vaultId, handle, cursor: "" }),
    ).toEqual({
      kind: "error",
      code: "inventory_incomplete",
    });
    expect(readChunk).not.toHaveBeenCalled();
  });

  it("returns a final marker only after the exact complete manifest, released slot and terminal chunk root match", async () => {
    const { handle, scratch, readChunk } = await fixture();
    const pages = syncR2InventoryPages(
      scratch,
      createSyncInventoryInvocationBudget(() => 20),
      () => 1_000,
    );
    expect(
      await pages.readInventoryPage({ vaultId, handle, cursor: "" }),
    ).toEqual({
      kind: "complete",
      summaries: [],
      nextCursor: null,
      final: true,
    });
    expect(readChunk).toHaveBeenCalledExactlyOnceWith(vaultId, inventoryId, 0);
  });

  it("limits one call to 16 chunks and carries only digests, not an R2 cursor, into the next page", async () => {
    const { scratch, readChunk, manifest, observed } = await fixture();
    const chunks: SyncInventoryChunk[] = [];
    const bodies: Uint8Array[] = [];
    let priorHash: SyncInventoryChunk["previousChunkHash"] = null;
    let inputCursor = "";
    for (let step = 0; step < 17; step += 1) {
      const outputCursor = step === 16 ? null : `opaque-${step + 1}`;
      const chunk: SyncInventoryChunk = {
        schemaVersion: 1,
        protocolMajor: 1,
        vaultId,
        inventoryId,
        step,
        previousChunkHash: priorHash,
        inputCursorDigest: await sha256Content(inputCursor),
        outputCursorDigest: await sha256Content(outputCursor ?? ""),
        outputCursor:
          outputCursor === null
            ? null
            : encodeBase64Url(new TextEncoder().encode(outputCursor)),
        truncated: outputCursor !== null,
        transcript: JSON.stringify({
          objectCount: 0,
          keySha256: null,
          headBodyBytes: 0,
          truncated: outputCursor !== null,
        }),
        headSummary: null,
      };
      const body = await encodeSyncRecord({ kind: "chunk", record: chunk });
      priorHash = await sha256Content(new TextDecoder().decode(body));
      inputCursor = outputCursor ?? "";
      chunks.push(chunk);
      bodies.push(body);
    }
    if (priorHash === null) throw new Error("Missing chain root");
    const complete = {
      ...manifest,
      nextStep: 17,
      listPageCount: 17,
      chunkCount: 17,
      emptyPageCount: 16,
      chunkHash: priorHash,
      evidenceBytes: bodies.reduce((total, body) => total + body.byteLength, 0),
    };
    const handle: SyncCompleteInventory = {
      kind: "complete",
      vaultId,
      inventoryId,
      vector: complete.startVector,
      entryCount: 0,
      chunkCount: 17,
      root: priorHash,
    };
    scratch.readManifest = vi.fn(async () =>
      observed(complete, syncInventoryManifestKey(vaultId, inventoryId)),
    );
    readChunk.mockImplementation(async (_vault, _id, step) => {
      const chunk = chunks[step];
      const bytes = bodies[step];
      if (!chunk || !bytes) return { kind: "absent" };
      return observed(
        chunk,
        syncInventoryChunkKey(vaultId, inventoryId, step),
        bytes,
      );
    });
    const first = await syncR2InventoryPages(
      scratch,
      createSyncInventoryInvocationBudget(() => 20),
      () => 1_000,
    ).readInventoryPage({ vaultId, handle, cursor: "" });
    expect(first.kind).toBe("page");
    if (first.kind !== "page") return;
    expect(readChunk).toHaveBeenCalledTimes(16);
    const decoded = decodeBase64Url(first.nextCursor);
    expect(decoded ? decodeUtf8(decoded) : "").not.toContain("opaque-16");
    const second = await syncR2InventoryPages(
      scratch,
      createSyncInventoryInvocationBudget(() => 20),
      () => 1_000,
    ).readInventoryPage({ vaultId, handle, cursor: first.nextCursor });
    expect(second).toEqual({
      kind: "complete",
      summaries: [],
      nextCursor: null,
      final: true,
    });
    expect(readChunk).toHaveBeenCalledTimes(17);
  });

  it("rejects a complete label that retains an unfinished R2 listing cursor", async () => {
    const { handle, scratch, manifest, observed, readChunk } = await fixture();
    scratch.readManifest = vi.fn(async () =>
      observed(
        {
          ...manifest,
          cursor: encodeBase64Url(
            new TextEncoder().encode("unfinished-r2-cursor"),
          ),
        },
        syncInventoryManifestKey(vaultId, inventoryId),
      ),
    );
    const pages = syncR2InventoryPages(
      scratch,
      createSyncInventoryInvocationBudget(() => 20),
      () => 1_000,
    );
    expect(
      await pages.readInventoryPage({ vaultId, handle, cursor: "" }),
    ).toEqual({ kind: "error", code: "inventory_incomplete" });
    expect(readChunk).not.toHaveBeenCalled();
  });

  it("rejects a final chain whose persisted evidence-byte count does not match its chunks", async () => {
    const { handle, scratch, manifest, observed } = await fixture();
    scratch.readManifest = vi.fn(async () =>
      observed(
        { ...manifest, evidenceBytes: manifest.evidenceBytes + 1 },
        syncInventoryManifestKey(vaultId, inventoryId),
      ),
    );
    const pages = syncR2InventoryPages(
      scratch,
      createSyncInventoryInvocationBudget(() => 20),
      () => 1_000,
    );
    expect(
      await pages.readInventoryPage({ vaultId, handle, cursor: "" }),
    ).toEqual({ kind: "error", code: "inventory_incomplete" });
  });

  it("never returns an absence witness from an expired complete manifest", async () => {
    const { handle, scratch, manifest, readChunk } = await fixture();
    const pages = syncR2InventoryPages(
      scratch,
      createSyncInventoryInvocationBudget(() => 20),
      () => manifest.expiresAtEpochMs + 1,
    );
    expect(
      await pages.readInventoryPage({ vaultId, handle, cursor: "" }),
    ).toEqual({ kind: "error", code: "inventory_expired" });
    expect(readChunk).not.toHaveBeenCalled();
  });

  it("rejects a malformed or foreign continuation without reading any chunk", async () => {
    const { handle, scratch, readChunk } = await fixture();
    const pages = syncR2InventoryPages(
      scratch,
      createSyncInventoryInvocationBudget(() => 20),
      () => 1_000,
    );
    expect(
      await pages.readInventoryPage({ vaultId, handle, cursor: "!" }),
    ).toEqual({ kind: "error", code: "inventory_incomplete" });
    expect(readChunk).not.toHaveBeenCalled();
  });

  it.each(["manifest", "slot", "busy_slot", "chunk"] as const)(
    "withholds complete evidence when the %s authority is unavailable or still active",
    async (failure) => {
      const { handle, scratch, readChunk, observed } = await fixture();
      const readManifest = scratch.readManifest.bind(scratch);
      const readActive = scratch.readActive.bind(scratch);
      if (failure === "manifest") {
        scratch.readManifest = async () => ({ kind: "unavailable" });
      }
      if (failure === "slot") {
        scratch.readActive = async () => ({ kind: "unavailable" });
      }
      if (failure === "busy_slot") {
        scratch.readActive = async () =>
          observed(
            {
              schemaVersion: 1 as const,
              protocolMajor: 1 as const,
              vaultId,
              state: "active" as const,
              inventoryId,
            },
            syncInventoryActiveKey(vaultId),
          );
      }
      if (failure === "chunk") {
        readChunk.mockResolvedValueOnce({ kind: "unavailable" });
      }
      const pages = syncR2InventoryPages(
        scratch,
        createSyncInventoryInvocationBudget(() => 20),
        () => 1_000,
      );
      expect(
        await pages.readInventoryPage({ vaultId, handle, cursor: "" }),
      ).toEqual({
        kind: "error",
        code:
          failure === "busy_slot"
            ? "inventory_incomplete"
            : "storage_unavailable",
        ...(failure === "busy_slot" ? {} : { inventoryId }),
      });
      expect(readChunk).toHaveBeenCalledTimes(failure === "chunk" ? 1 : 0);
      scratch.readManifest = readManifest;
      scratch.readActive = readActive;
      expect(
        await pages.readInventoryPage({ vaultId, handle, cursor: "" }),
      ).toEqual({
        kind: "complete",
        summaries: [],
        nextCursor: null,
        final: true,
      });
    },
  );

  it("rejects a missing chunk instead of fabricating an empty terminal page", async () => {
    const { handle, scratch, readChunk } = await fixture();
    readChunk.mockResolvedValue({ kind: "absent" });
    const pages = syncR2InventoryPages(
      scratch,
      createSyncInventoryInvocationBudget(() => 20),
      () => 1_000,
    );
    expect(
      await pages.readInventoryPage({ vaultId, handle, cursor: "" }),
    ).toEqual({ kind: "error", code: "inventory_incomplete" });
  });
});
