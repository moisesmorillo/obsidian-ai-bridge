import { createContentSha256, encodeNotePath } from "@obsidian-ai-bridge/core";
import { syncHeadKey, syncInventoryChunkKey } from "@protocol/sync.codec";
import {
  syncInventoryIdSchema,
  syncNotePathSchema,
  syncRevisionSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type { SyncRecordObservation } from "@worker/infrastructure/sync/sync-r2.types";
import {
  type SyncInventoryChunkPosition,
  verifySyncInventoryChunk,
} from "@worker/infrastructure/sync/sync-r2-inventory-evidence";
import { createSyncR2Key } from "@worker/infrastructure/sync/sync-r2-key";
import { encodeSyncRecord } from "@worker/infrastructure/sync/sync-record.codec";
import type { SyncInventoryChunk } from "@worker/infrastructure/sync/sync-record.types";
import { sha256Content } from "@worker/storage/storage-crypto";
import { describe, expect, it } from "vitest";

const vaultId = syncVaultIdSchema.parse("11111111-1111-4111-8111-111111111111");
const inventoryId = syncInventoryIdSchema.parse(
  "22222222-2222-4222-8222-222222222222",
);
const revision = syncRevisionSchema.parse(
  "33333333-3333-4333-8333-333333333333",
);
/** Validates each literal evidence digest rather than propagating a nullable fixture.
 * @param value Literal lowercase SHA-256 fixture.
 * @returns Branded SHA-256 digest used in strict inventory records.
 */
function fixtureDigest(value: string) {
  const digest = createContentSha256(value);
  if (!digest) throw new Error("Invalid cursor fixture digest");
  return digest;
}
const digestA = fixtureDigest(
  "559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd",
);
const digestEmpty = fixtureDigest(
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
);

/** Forms a canonical page record without trusting an R2 list result or head body.
 * @returns Empty terminal evidence, with optional controlled forgery fields.
 */
function emptyChunk(
  overrides: Partial<SyncInventoryChunk> = {},
): SyncInventoryChunk {
  return {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    inventoryId,
    step: 0,
    previousChunkHash: null,
    inputCursorDigest: digestEmpty,
    outputCursorDigest: digestEmpty,
    outputCursor: null,
    truncated: false,
    transcript: JSON.stringify({
      objectCount: 0,
      keySha256: null,
      headBodyBytes: 0,
      truncated: false,
    }),
    headSummary: null,
    ...overrides,
  };
}

/** Simulates one exact R2 generation containing a strict immutable chunk.
 * @returns Typed observation whose body is canonical unless overridden for tampering.
 */
async function observedChunk(
  value: SyncInventoryChunk,
  bytes?: Uint8Array,
): Promise<SyncRecordObservation<SyncInventoryChunk>> {
  const key = createSyncR2Key(
    syncInventoryChunkKey(vaultId, inventoryId, 0),
    vaultId,
  );
  if (!key) throw new Error("Invalid chunk key");
  const body =
    bytes ?? (await encodeSyncRecord({ kind: "chunk", record: value }));
  return {
    value,
    observed: { key, etag: "etag", bytes: body, uploaded: new Date(1_000) },
  };
}

/** Initial unvisited input cursor, before any truncated page output. */
const initial: SyncInventoryChunkPosition = {
  vaultId,
  inventoryId,
  nextStep: 0,
  chunkHash: null,
  cursor: null,
  lastKey: null,
};
/** Digest-only evidence paging starts at the same unvisited input position. */
const digestPosition: SyncInventoryChunkPosition = {
  vaultId,
  inventoryId,
  nextStep: 0,
  chunkHash: null,
  inputCursorDigest: digestEmpty,
  lastKey: null,
};

describe("strict immutable inventory page evidence", () => {
  it("accepts a canonical terminal empty page only with its exact bytes and chain root", async () => {
    const chunk = await observedChunk(emptyChunk());
    const verified = await verifySyncInventoryChunk(initial, chunk);
    expect(verified).toMatchObject({
      byteSize: chunk.observed.bytes.byteLength,
      listedKey: null,
      transcript: { objectCount: 0, truncated: false },
    });
    expect(verified?.hash).toBe(
      await sha256Content(new TextDecoder().decode(chunk.observed.bytes)),
    );
    expect(await verifySyncInventoryChunk(digestPosition, chunk)).toBeDefined();
    const { inputCursorDigest: _digest, ...withoutInput } = digestPosition;
    expect(await verifySyncInventoryChunk(withoutInput, chunk)).toBeUndefined();
  });

  it("accepts a first truncated output despite null initial input, but rejects adjacent replay", async () => {
    const value = emptyChunk({
      outputCursor: "QQ",
      outputCursorDigest: digestA,
      truncated: true,
      transcript: JSON.stringify({
        objectCount: 0,
        keySha256: null,
        headBodyBytes: 0,
        truncated: true,
      }),
    });
    const chunk = await observedChunk(value);
    expect(await verifySyncInventoryChunk(initial, chunk)).toBeDefined();
    expect(
      await verifySyncInventoryChunk(
        { ...initial, cursor: "QQ", inputCursorDigest: digestA },
        await observedChunk({ ...value, inputCursorDigest: digestA }),
      ),
    ).toBeUndefined();
  });

  it("rejects changed bytes, wrong step key and incorrectly linked chunk root", async () => {
    const chunk = await observedChunk(emptyChunk());
    const changed = chunk.observed.bytes.slice();
    changed[0] = changed[0] === 0 ? 1 : 0;
    expect(
      await verifySyncInventoryChunk(initial, {
        ...chunk,
        observed: { ...chunk.observed, bytes: changed },
      }),
    ).toBeUndefined();
    expect(
      await verifySyncInventoryChunk({ ...initial, nextStep: 1 }, chunk),
    ).toBeUndefined();
    expect(
      await verifySyncInventoryChunk({ ...initial, chunkHash: digestA }, chunk),
    ).toBeUndefined();
  });

  it("rejects forged cursor digests, transcript counts and terminal markers", async () => {
    await expect(
      observedChunk(emptyChunk({ outputCursorDigest: digestA })),
    ).rejects.toThrow("Chunk output cursor digest does not match");
    for (const record of [
      emptyChunk({ inputCursorDigest: digestA }),
      emptyChunk({
        transcript: JSON.stringify({
          objectCount: 1,
          keySha256: null,
          headBodyBytes: 0,
          truncated: false,
        }),
      }),
      emptyChunk({
        transcript: JSON.stringify({
          objectCount: 0,
          keySha256: null,
          headBodyBytes: 1,
          truncated: false,
        }),
      }),
      emptyChunk({
        transcript: JSON.stringify({
          objectCount: 0,
          keySha256: null,
          headBodyBytes: 0,
          truncated: true,
        }),
      }),
    ]) {
      expect(
        await verifySyncInventoryChunk(initial, await observedChunk(record)),
      ).toBeUndefined();
    }
  });

  it("binds a headed page's key hash, summary and lexicographic order", async () => {
    const path = syncNotePathSchema.parse("notes/item.md");
    const listedKey = syncHeadKey(vaultId, path);
    const headSummary = {
      pathKey: encodeNotePath(path),
      revision,
      kind: "live" as const,
    };
    const transcript = {
      objectCount: 1 as const,
      keySha256: await sha256Content(listedKey),
      headBodyBytes: 100,
      truncated: false,
    };
    const chunk = await observedChunk(
      emptyChunk({ headSummary, transcript: JSON.stringify(transcript) }),
    );
    expect((await verifySyncInventoryChunk(initial, chunk))?.listedKey).toBe(
      listedKey,
    );
    expect(
      await verifySyncInventoryChunk({ ...initial, lastKey: listedKey }, chunk),
    ).toBeUndefined();
    const forged = await observedChunk(
      emptyChunk({
        headSummary,
        transcript: JSON.stringify({ ...transcript, keySha256: digestA }),
      }),
    );
    expect(await verifySyncInventoryChunk(initial, forged)).toBeUndefined();
  });
});
