import type { ContentSha256 } from "@obsidian-ai-bridge/core";
import {
  createContentSha256,
  decodeBase64Url,
  decodeUtf8,
  encodeBase64Url,
} from "@obsidian-ai-bridge/core";
import {
  decodeSyncPathKey,
  syncContentKey,
  syncHeadKey,
  syncInventoryActiveKey,
  syncInventoryChunkKey,
  syncInventoryManifestKey,
  syncRecoveryKey,
  syncVaultMarkerKey,
  syncVaultPrefix,
  syncVersionKey,
} from "@protocol/sync.codec";
import {
  syncOperationIdSchema,
  syncRevisionSchema,
  syncVaultIdSchema,
  syncVaultMarkerSchema,
} from "@protocol/sync.schemas";
import type { SyncVaultIdDto } from "@protocol/sync.types";
import {
  SYNC_RECORD_LIMITS,
  syncHeadRecordSchema,
  syncInventoryChunkSchema,
  syncInventoryManifestSchema,
  syncInventorySlotSchema,
  syncRecoveryMetadataSchema,
  syncVersionMetadataSchema,
} from "@worker/infrastructure/sync/sync-record.schemas";
import type {
  SyncDecodedRecord,
  SyncInventoryChunk,
  SyncRecordKind,
} from "@worker/infrastructure/sync/sync-record.types";

const utf8Encoder = new TextEncoder();

/** Decodes one bounded R2 record only when vault, canonical key, bytes and strict private schema agree.
 *
 * @param kind - Closed record family selecting its exact key shape and size cap.
 * @param key - Untrusted R2 object key, checked against M7.1 builders for this vault.
 * @param bytes - Exact R2 payload bytes, bounded before JSON parsing or body hashing.
 * @param expectedVaultId - Validated vault scope expected by the caller.
 * @returns A strict adapter-private record; body hashes describe exact bytes only and must be compared with linked metadata by the facade.
 * @throws {TypeError} When bytes, identity, canonical encoding, or schema are invalid.
 * @throws {RangeError} When a persisted record exceeds its family limit.
 */
export async function decodeSyncRecord(
  kind: SyncRecordKind,
  key: string,
  bytes: Uint8Array,
  expectedVaultId: SyncVaultIdDto,
): Promise<SyncDecodedRecord> {
  const vaultId = syncVaultIdSchema.parse(expectedVaultId);
  if (kind === "contentBody" || kind === "recoveryBody") {
    return decodeBody(kind, key, bytes, vaultId);
  }

  const limit =
    kind === "manifest"
      ? SYNC_RECORD_LIMITS.manifestBytes
      : kind === "chunk"
        ? SYNC_RECORD_LIMITS.chunkBytes
        : kind === "head"
          ? SYNC_RECORD_LIMITS.headBytes
          : 2_048;
  if (bytes.byteLength > limit)
    throw new RangeError("Sync record exceeds its storage byte limit.");
  const text = decodeUtf8(bytes);
  if (text === undefined)
    throw new TypeError("Sync record is not valid UTF-8.");
  const parsed = parseCanonicalJson(text);

  if (kind === "vaultMarker") {
    if (key !== syncVaultMarkerKey(vaultId))
      throw new TypeError("Vault marker key does not match its vault.");
    const record = syncVaultMarkerSchema.parse(parsed);
    if (record.vaultId !== vaultId)
      throw new TypeError("Vault marker belongs to another vault.");
    assertCanonicalRecord(text, record);
    return { kind, ...record };
  }
  if (kind === "head") {
    const record = syncHeadRecordSchema.parse(parsed);
    const expectedKey = syncHeadKey(vaultId, record.path);
    if (record.vaultId !== vaultId || key !== expectedKey)
      throw new TypeError("Head identity does not match its key or vault.");
    assertCanonicalRecord(text, record);
    return { kind, record };
  }
  if (kind === "version") {
    const record = syncVersionMetadataSchema.parse(parsed);
    if (
      record.vaultId !== vaultId ||
      key !== syncVersionKey(vaultId, record.revision)
    )
      throw new TypeError("Version identity does not match its key or vault.");
    assertCanonicalRecord(text, record);
    return { kind, record };
  }
  if (kind === "recoveryMetadata") {
    const record = syncRecoveryMetadataSchema.parse(parsed);
    if (
      record.vaultId !== vaultId ||
      key !== syncRecoveryKey(vaultId, record.operationId, "metadata")
    )
      throw new TypeError(
        "Recovery metadata identity does not match its key or vault.",
      );
    assertCanonicalRecord(text, record);
    return { kind, record };
  }
  if (kind === "activeSlot") {
    const record = syncInventorySlotSchema.parse(parsed);
    if (record.vaultId !== vaultId || key !== syncInventoryActiveKey(vaultId))
      throw new TypeError(
        "Active inventory slot identity does not match its key or vault.",
      );
    assertCanonicalRecord(text, record);
    return { kind, record };
  }
  if (kind === "manifest") {
    const record = syncInventoryManifestSchema.parse(parsed);
    if (
      record.vaultId !== vaultId ||
      key !== syncInventoryManifestKey(vaultId, record.inventoryId)
    )
      throw new TypeError(
        "Inventory manifest identity does not match its key or vault.",
      );
    if (
      record.lastKey !== null &&
      !isCanonicalHeadKey(record.lastKey, vaultId)
    ) {
      throw new TypeError(
        "Inventory manifest last key is not a canonical head key in its vault.",
      );
    }
    assertCanonicalRecord(text, record);
    return { kind, record };
  }
  if (kind === "chunk") {
    const record = syncInventoryChunkSchema.parse(parsed);
    if (
      record.vaultId !== vaultId ||
      key !== syncInventoryChunkKey(vaultId, record.inventoryId, record.step)
    )
      throw new TypeError(
        "Inventory chunk identity does not match its key or vault.",
      );
    await assertChunkCursorDigest(record);
    assertCanonicalRecord(text, record);
    return { kind, record };
  }
  throw new TypeError("Unsupported sync record kind.");
}

/** Encodes a strict adapter-private record without normalizing body bytes or JSON field order.
 *
 * @param record - Previously validated record to persist under its corresponding M7.1 key.
 * @returns Exact raw body bytes or canonical bounded UTF-8 JSON envelope bytes.
 * @throws {TypeError} When body evidence or metadata does not match its typed record.
 * @throws {RangeError} When serialized output exceeds its family limit.
 */
export async function encodeSyncRecord(
  record: SyncDecodedRecord,
): Promise<Uint8Array> {
  switch (record.kind) {
    case "contentBody":
    case "recoveryBody": {
      const body = record.record;
      if (
        body.kind !== record.kind ||
        syncVaultIdSchema.parse(body.vaultId) !== body.vaultId ||
        body.bytes.byteLength > SYNC_RECORD_LIMITS.contentBodyBytes ||
        body.bytes.byteLength !== body.byteSize ||
        decodeUtf8(body.bytes) === undefined ||
        (await sha256Hex(body.bytes)) !== body.contentSha256
      ) {
        throw new TypeError("Body evidence does not match its exact bytes.");
      }
      return body.bytes.slice();
    }
    case "chunk":
      await assertChunkCursorDigest(record.record);
      return encodeJson(record.record, SYNC_RECORD_LIMITS.chunkBytes);
    case "head":
      return encodeJson(
        syncHeadRecordSchema.parse(record.record),
        SYNC_RECORD_LIMITS.headBytes,
      );
    case "version":
      return encodeJson(syncVersionMetadataSchema.parse(record.record), 2_048);
    case "recoveryMetadata":
      return encodeJson(syncRecoveryMetadataSchema.parse(record.record), 2_048);
    case "activeSlot":
      return encodeJson(syncInventorySlotSchema.parse(record.record), 2_048);
    case "manifest":
      return encodeJson(
        syncInventoryManifestSchema.parse(record.record),
        SYNC_RECORD_LIMITS.manifestBytes,
      );
    case "vaultMarker":
      return encodeJson(
        syncVaultMarkerSchema.parse({
          schemaVersion: 1,
          protocolMajor: 1,
          vaultId: record.vaultId,
        }),
        2_048,
      );
  }
}

/** Parses a bounded UTF-8 JSON value before strict schema validation.
 *
 * @param text - Already byte-bounded text decoded with fatal UTF-8 semantics.
 * @returns Parsed value awaiting its closed family-specific schema.
 * @throws {TypeError} When JSON syntax is malformed.
 */
function parseCanonicalJson(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError("Sync record JSON is malformed.");
  }
  return parsed;
}

/** Requires compact JSON serialization to exactly match the validated field order and values.
 *
 * @param text - Exact persisted JSON string supplied by R2.
 * @param record - Strict schema output whose serialization is canonical for this record.
 * @throws {TypeError} When key order, whitespace, duplicate fields, or spelling differs.
 */
function assertCanonicalRecord(text: string, record: object): void {
  if (JSON.stringify(record) !== text)
    throw new TypeError("Sync record JSON is not canonical.");
}

/** Validates one manifest's last listed object against the exact canonical heads-key codec.
 *
 * @param key - Last listed R2 key persisted by the inventory scan.
 * @param vaultId - Expected vault prefix for the saved key.
 * @returns Whether the key decodes to one canonical NotePath and reconstructs exactly.
 */
function isCanonicalHeadKey(key: string, vaultId: SyncVaultIdDto): boolean {
  const prefix = `${syncVaultPrefix(vaultId)}heads/`;
  if (!key.startsWith(prefix) || !key.endsWith(".json")) return false;
  const pathKey = key.slice(prefix.length, -".json".length);
  const path = decodeSyncPathKey(pathKey);
  return path !== undefined && syncHeadKey(vaultId, path) === key;
}

/** Serializes schema-validated JSON before returning bytes, rejecting over-limit allocation.
 *
 * @param value - Strict parsed record whose schema order defines the canonical encoding.
 * @param maxBytes - Hard UTF-8 allocation limit for this persisted record family.
 * @returns Canonical UTF-8 JSON envelope bytes.
 * @throws {RangeError} When the serialized UTF-8 output exceeds its storage limit.
 */
function encodeJson(value: object, maxBytes: number): Uint8Array {
  const bytes = utf8Encoder.encode(JSON.stringify(value));
  if (bytes.byteLength > maxBytes)
    throw new RangeError("Encoded sync record exceeds its storage byte limit.");
  return bytes;
}

/** Validates one Markdown body key, then retains its exact bytes and computed digest as evidence.
 *
 * @param kind - Content revision body or operation-scoped recovery body family.
 * @param key - Exact R2 key parsed and reconstructed through the matching M7.1 builder.
 * @param bytes - Raw UTF-8 body bounded before decoding and SHA-256 work.
 * @param vaultId - Validated expected namespace identity.
 * @returns Exact body bytes with computed digest and byte size, not linked-metadata proof.
 * @throws {TypeError} When body UTF-8 or storage-key identity is invalid.
 * @throws {RangeError} When the body exceeds the supported Markdown limit.
 */
async function decodeBody(
  kind: "contentBody" | "recoveryBody",
  key: string,
  bytes: Uint8Array,
  vaultId: ReturnType<typeof syncVaultIdSchema.parse>,
): Promise<SyncDecodedRecord> {
  if (bytes.byteLength > SYNC_RECORD_LIMITS.contentBodyBytes) {
    throw new RangeError("Sync body exceeds the Markdown byte limit.");
  }
  if (decodeUtf8(bytes) === undefined)
    throw new TypeError("Sync body is not valid UTF-8.");
  if (kind === "contentBody") {
    const match = new RegExp(
      `^sync/v1/vaults/${vaultId}/content/([^/]+)\\.md$`,
    ).exec(key);
    const revision = match?.[1];
    if (
      revision === undefined ||
      !syncRevisionSchema.safeParse(revision).success ||
      key !== syncContentKey(vaultId, syncRevisionSchema.parse(revision))
    ) {
      throw new TypeError(
        "Content body key is invalid or belongs to another vault.",
      );
    }
    return {
      kind,
      record: {
        kind,
        vaultId,
        revision: syncRevisionSchema.parse(revision),
        bytes: bytes.slice(),
        byteSize: bytes.byteLength,
        contentSha256: await sha256Hex(bytes),
      },
    };
  }
  const match = new RegExp(
    `^sync/v1/vaults/${vaultId}/recovery/([^/]+)\\.md$`,
  ).exec(key);
  const operationId = match?.[1];
  if (
    operationId === undefined ||
    !syncOperationIdSchema.safeParse(operationId).success ||
    key !==
      syncRecoveryKey(
        vaultId,
        syncOperationIdSchema.parse(operationId),
        "content",
      )
  ) {
    throw new TypeError(
      "Recovery body key is invalid or belongs to another vault.",
    );
  }
  return {
    kind,
    record: {
      kind,
      vaultId,
      operationId: syncOperationIdSchema.parse(operationId),
      bytes: bytes.slice(),
      byteSize: bytes.byteLength,
      contentSha256: await sha256Hex(bytes),
    },
  };
}

/** Computes canonical SHA-256 evidence over an exact byte copy for Web Crypto.
 *
 * @param bytes - Validated source bytes whose exact digest is required.
 * @returns Lowercase hexadecimal SHA-256 branded as a content digest.
 */
async function sha256Hex(bytes: Uint8Array): Promise<ContentSha256> {
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", digestInput.buffer),
  );
  const hexadecimal = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const contentSha256 = createContentSha256(hexadecimal);
  if (contentSha256 === undefined)
    throw new Error("Web Crypto returned an invalid SHA-256 digest.");
  return contentSha256;
}

/** Verifies the chunk's saved output-cursor evidence without asserting external chain authority.
 *
 * @param chunk - Strict chunk whose key step was already checked by the caller.
 * @throws {TypeError} When cursor encoding is noncanonical, oversize, or digest-mismatched.
 * Prior-root comparison with the authoritative manifest or preceding chunk belongs to M7.4 replay policy.
 */
async function assertChunkCursorDigest(
  chunk: SyncInventoryChunk,
): Promise<void> {
  const cursorBytes =
    chunk.outputCursor === null
      ? new Uint8Array()
      : decodeBase64Url(chunk.outputCursor);
  if (
    chunk.outputCursor !== null &&
    (cursorBytes === undefined ||
      encodeBase64Url(cursorBytes) !== chunk.outputCursor)
  ) {
    throw new TypeError(
      "Chunk output cursor is not canonical unpadded base64url.",
    );
  }
  const bytes = cursorBytes ?? new Uint8Array();
  if (
    bytes.byteLength > SYNC_RECORD_LIMITS.cursorBytes ||
    (await sha256Hex(bytes)) !== chunk.outputCursorDigest
  ) {
    throw new TypeError(
      "Chunk output cursor digest does not match its exact encoded cursor.",
    );
  }
}

/** Reuses the completed protocol marker schema without widening the public protocol package. */
