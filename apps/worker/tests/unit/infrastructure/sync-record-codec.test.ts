import { encodeBase64Url } from "@obsidian-ai-bridge/core";
import {
  syncHeadKey,
  syncInventoryActiveKey,
  syncInventoryChunkKey,
  syncInventoryManifestKey,
  syncRecoveryKey,
  syncVaultMarkerKey,
  syncVersionKey,
} from "@protocol/sync.codec";
import {
  syncDeviceIdSchema,
  syncInventoryIdSchema,
  syncNotePathSchema,
  syncOperationIdSchema,
  syncRevisionSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import {
  decodeSyncRecord,
  encodeSyncRecord,
} from "@worker/infrastructure/sync/sync-record.codec";
import { describe, expect, it } from "vitest";

const VAULT_ID = syncVaultIdSchema.parse(
  "8f14e45f-ea6b-4a0f-a4d0-7c2f9e9a0001",
);
const OTHER_VAULT_ID = syncVaultIdSchema.parse(
  "8f14e45f-ea6b-4a0f-a4d0-7c2f9e9a0002",
);
const REVISION = syncRevisionSchema.parse(
  "8f14e45f-ea6b-4a0f-a4d0-7c2f9e9a0003",
);
const OPERATION = syncOperationIdSchema.parse(
  "8f14e45f-ea6b-4a0f-a4d0-7c2f9e9a0004",
);
const OTHER_REVISION = syncRevisionSchema.parse(
  "8f14e45f-ea6b-4a0f-a4d0-7c2f9e9a0007",
);
const INVENTORY = syncInventoryIdSchema.parse(
  "8f14e45f-ea6b-4a0f-a4d0-7c2f9e9a0005",
);
const ORIGIN = syncDeviceIdSchema.parse("8f14e45f-ea6b-4a0f-a4d0-7c2f9e9a0006");
const PATH = syncNotePathSchema.parse("folder/note.md");
const encoder = new TextEncoder();

/** Encodes one test envelope using the persisted canonical JSON representation.
 *
 * @param value - Test envelope in its strict serialized property order.
 * @returns Exact UTF-8 bytes supplied to the production decoder.
 */
function json(value: object): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

/** Creates strict head bytes with configurable fields for hostile-storage tests.
 *
 * @param overrides - Candidate fields that deliberately alter the valid test record.
 * @returns Exact canonical JSON bytes before applying hostile test changes.
 */
function head(overrides: Record<string, unknown> = {}): Uint8Array {
  return json({
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId: VAULT_ID,
    path: PATH,
    revision: REVISION,
    contentSha256: "a".repeat(64),
    byteSize: 1,
    mediaType: "text/markdown",
    operationId: OPERATION,
    origin: ORIGIN,
    kind: "live",
    parent: { kind: "never_seen" },
    ...overrides,
  });
}

/** Creates a minimal bounded manifest for serialized-size boundary checks.
 *
 * @param extra - Additional fields or malformed replacements used by limit tests.
 * @returns Exact JSON bytes sized before strict schema parsing.
 */
function manifest(extra: object = {}): Uint8Array {
  return json({
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId: VAULT_ID,
    inventoryId: INVENTORY,
    phase: "scanning",
    startVector: Array.from({ length: 64 }, () => "0".repeat(20)),
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
    expiresAtEpochMs: 1_800_000_000_000,
    ...extra,
  });
}

describe("strict private sync persistence records", () => {
  it("rejects malformed JSON, unknown fields, and unsupported protocol majors", async () => {
    const key = syncHeadKey(VAULT_ID, PATH);
    await expect(
      decodeSyncRecord("head", key, encoder.encode("{"), VAULT_ID),
    ).rejects.toThrow();
    await expect(
      decodeSyncRecord("head", key, head({ injected: true }), VAULT_ID),
    ).rejects.toThrow();
    await expect(
      decodeSyncRecord("head", key, head({ protocolMajor: 2 }), VAULT_ID),
    ).rejects.toThrow();
    await expect(
      decodeSyncRecord(
        "head",
        key,
        encoder.encode(` ${new TextDecoder().decode(head())}`),
        VAULT_ID,
      ),
    ).rejects.toThrow();
  });

  it("validates marker, version, recovery metadata, and active-slot keys", async () => {
    const marker = json({
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId: VAULT_ID,
    });
    await expect(
      decodeSyncRecord(
        "vaultMarker",
        syncVaultMarkerKey(VAULT_ID),
        marker,
        VAULT_ID,
      ),
    ).resolves.toMatchObject({ kind: "vaultMarker" });
    const headBytes = head();
    const decodedHead = await decodeSyncRecord(
      "head",
      syncHeadKey(VAULT_ID, PATH),
      headBytes,
      VAULT_ID,
    );
    expect(decodedHead.kind).toBe("head");
    expect(await encodeSyncRecord(decodedHead)).toEqual(headBytes);
    const version = {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId: VAULT_ID,
      path: PATH,
      revision: REVISION,
      contentSha256: "a".repeat(64),
      byteSize: 1,
      mediaType: "text/markdown",
      operationId: OPERATION,
      origin: ORIGIN,
      kind: "live",
      parent: { kind: "never_seen" },
    };
    await expect(
      decodeSyncRecord(
        "version",
        syncVersionKey(VAULT_ID, REVISION),
        json(version),
        VAULT_ID,
      ),
    ).resolves.toMatchObject({ kind: "version" });
    await expect(
      decodeSyncRecord(
        "version",
        syncVersionKey(VAULT_ID, OTHER_REVISION),
        json(version),
        VAULT_ID,
      ),
    ).rejects.toThrow();
    const recovery = {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId: VAULT_ID,
      path: PATH,
      operationId: OPERATION,
      sourceRevision: REVISION,
      contentSha256: "a".repeat(64),
      byteSize: 1,
      mediaType: "text/markdown",
      origin: ORIGIN,
    };
    await expect(
      decodeSyncRecord(
        "recoveryMetadata",
        syncRecoveryKey(VAULT_ID, OPERATION, "metadata"),
        json(recovery),
        VAULT_ID,
      ),
    ).resolves.toMatchObject({ kind: "recoveryMetadata" });
    const slot = json({
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId: VAULT_ID,
      state: "active",
      inventoryId: INVENTORY,
    });
    await expect(
      decodeSyncRecord(
        "activeSlot",
        syncInventoryActiveKey(VAULT_ID),
        slot,
        VAULT_ID,
      ),
    ).resolves.toMatchObject({ kind: "activeSlot" });
    const manifestBytes = manifest();
    const manifestKey = syncInventoryManifestKey(VAULT_ID, INVENTORY);
    await expect(
      decodeSyncRecord("manifest", manifestKey, manifestBytes, VAULT_ID),
    ).resolves.toMatchObject({ kind: "manifest" });
    await expect(
      decodeSyncRecord(
        "manifest",
        manifestKey,
        manifest({ lastKey: "vault/wrong.md" }),
        VAULT_ID,
      ),
    ).rejects.toThrow();
  });

  it("rejects invalid UTF-8 in envelopes and exact Markdown body records", async () => {
    const key = syncHeadKey(VAULT_ID, PATH);
    await expect(
      decodeSyncRecord("head", key, new Uint8Array([0xc3, 0x28]), VAULT_ID),
    ).rejects.toThrow();
    await expect(
      decodeSyncRecord(
        "contentBody",
        `sync/v1/vaults/${VAULT_ID}/content/${REVISION}.md`,
        new Uint8Array([0xc3, 0x28]),
        VAULT_ID,
      ),
    ).rejects.toThrow();
  });

  it("rejects keys, vault IDs, and canonical paths that disagree with the persisted record", async () => {
    await expect(
      decodeSyncRecord(
        "head",
        syncHeadKey(OTHER_VAULT_ID, PATH),
        head(),
        VAULT_ID,
      ),
    ).rejects.toThrow();
    await expect(
      decodeSyncRecord(
        "head",
        syncHeadKey(VAULT_ID, PATH),
        head({ vaultId: OTHER_VAULT_ID }),
        VAULT_ID,
      ),
    ).rejects.toThrow();
    await expect(
      decodeSyncRecord(
        "head",
        syncHeadKey(VAULT_ID, PATH),
        head({ path: "folder/other.md" }),
        VAULT_ID,
      ),
    ).rejects.toThrow();
  });

  it("accepts a 720-byte path and rejects a 721-byte path before key construction", () => {
    const allowed = syncNotePathSchema.parse(`${"a".repeat(717)}.md`);
    const rejected = syncNotePathSchema.safeParse(`${"a".repeat(718)}.md`);
    expect(encoder.encode(allowed).byteLength).toBe(720);
    expect(rejected.success).toBe(false);
  });

  it("enforces the 2,048-byte head, 8,192-byte manifest, and 1,536-byte summary bounds", async () => {
    const key = syncHeadKey(VAULT_ID, PATH);
    await expect(
      decodeSyncRecord(
        "head",
        key,
        head({ padding: "x".repeat(2_048) }),
        VAULT_ID,
      ),
    ).rejects.toThrow();
    await expect(
      decodeSyncRecord(
        "manifest",
        `sync/v1/vaults/${VAULT_ID}/inventories/scans/${INVENTORY}/manifest.json`,
        manifest({ padding: "x".repeat(8_192) }),
        VAULT_ID,
      ),
    ).rejects.toThrow();
  });

  it("bounds encoded raw R2 cursors and the complete inventory chunk", async () => {
    const chunkKey = syncInventoryChunkKey(VAULT_ID, INVENTORY, 0);
    const emptyCursorDigest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array())),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const baseChunk = {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId: VAULT_ID,
      inventoryId: INVENTORY,
      step: 0,
      previousChunkHash: null,
      inputCursorDigest: "0".repeat(64),
      outputCursorDigest: emptyCursorDigest,
      outputCursor: null,
      truncated: false,
      transcript: "{}",
      headSummary: null,
    };
    const oversizedCursorBytes = new Uint8Array(4_097);
    const oversizedCursor = encodeBase64Url(oversizedCursorBytes);
    const oversizedCursorDigest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", oversizedCursorBytes),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    await expect(
      decodeSyncRecord(
        "chunk",
        chunkKey,
        json({
          ...baseChunk,
          outputCursor: oversizedCursor,
          outputCursorDigest: oversizedCursorDigest,
          truncated: true,
        }),
        VAULT_ID,
      ),
    ).rejects.toThrow();
    const maximumCursorBytes = new Uint8Array(4_096);
    const maximumCursor = encodeBase64Url(maximumCursorBytes);
    const maximumCursorDigest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", maximumCursorBytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    await expect(
      decodeSyncRecord(
        "chunk",
        chunkKey,
        json({
          ...baseChunk,
          outputCursor: maximumCursor,
          outputCursorDigest: maximumCursorDigest,
          truncated: true,
        }),
        VAULT_ID,
      ),
    ).resolves.toMatchObject({ kind: "chunk" });
    await expect(
      decodeSyncRecord(
        "chunk",
        chunkKey,
        json({ ...baseChunk, transcript: "x".repeat(12 * 1024) }),
        VAULT_ID,
      ),
    ).rejects.toThrow();
    await expect(
      decodeSyncRecord(
        "chunk",
        chunkKey,
        json({ ...baseChunk, transcript: JSON.stringify("😀".repeat(70)) }),
        VAULT_ID,
      ),
    ).rejects.toThrow();
  });

  it("rejects chunk step disagreement with its key and validates its own cursor digest", async () => {
    const key = syncInventoryChunkKey(VAULT_ID, INVENTORY, 0);
    const chunk = {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId: VAULT_ID,
      inventoryId: INVENTORY,
      step: 1,
      previousChunkHash: null,
      inputCursorDigest: "0".repeat(64),
      outputCursorDigest: "0".repeat(64),
      outputCursor: "",
      truncated: false,
      transcript: "{}",
      headSummary: null,
    };
    await expect(
      decodeSyncRecord("chunk", key, json(chunk), VAULT_ID),
    ).rejects.toThrow();
    const terminalChunk = {
      ...chunk,
      step: 0,
      previousChunkHash: null,
      outputCursor: null,
      truncated: false,
      outputCursorDigest: "0".repeat(64),
    };
    await expect(
      decodeSyncRecord("chunk", key, json(terminalChunk), VAULT_ID),
    ).rejects.toThrow();
  });

  it("rejects Markdown bodies over 1 MiB before decoding or hashing", async () => {
    const oversized = new Uint8Array(1_048_577);
    await expect(
      decodeSyncRecord(
        "contentBody",
        `sync/v1/vaults/${VAULT_ID}/content/${REVISION}.md`,
        oversized,
        VAULT_ID,
      ),
    ).rejects.toThrow();
  });

  it("preserves exact content bytes and reports their computed digest and byte size", async () => {
    const text = "# exact\r\n“Unicode” stays exact ";
    const bytes = encoder.encode(text);
    const decoded = await decodeSyncRecord(
      "contentBody",
      `sync/v1/vaults/${VAULT_ID}/content/${REVISION}.md`,
      bytes,
      VAULT_ID,
    );
    expect(decoded.kind).toBe("contentBody");
    if (decoded.kind !== "contentBody")
      throw new Error("Expected content body record.");
    expect(decoded.record.bytes).toEqual(bytes);
    expect(decoded.record.byteSize).toBe(bytes.byteLength);
    expect(decoded.record.contentSha256).toBe(
      Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join(""),
    );
    expect(await encodeSyncRecord(decoded)).toEqual(bytes);
  });

  it("rejects mutated computed body digest or byte-size evidence before encoding", async () => {
    const bytes = encoder.encode("exact body");
    const body = await decodeSyncRecord(
      "contentBody",
      `sync/v1/vaults/${VAULT_ID}/content/${REVISION}.md`,
      bytes,
      VAULT_ID,
    );
    if (body.kind !== "contentBody")
      throw new Error("Expected content body record.");
    const other = await decodeSyncRecord(
      "contentBody",
      `sync/v1/vaults/${VAULT_ID}/content/${REVISION}.md`,
      encoder.encode("different body"),
      VAULT_ID,
    );
    if (other.kind !== "contentBody")
      throw new Error("Expected content body record.");
    await expect(
      encodeSyncRecord({
        ...body,
        record: { ...body.record, contentSha256: other.record.contentSha256 },
      }),
    ).rejects.toThrow();
    await expect(
      encodeSyncRecord({ ...body, record: { ...body.record, byteSize: 99 } }),
    ).rejects.toThrow();
  });
});
