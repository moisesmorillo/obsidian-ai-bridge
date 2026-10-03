import { decodeUtf8 } from "@obsidian-ai-bridge/core";
import {
  syncFeedEventKey,
  syncFeedLaneHeadKey,
  syncOperationKey,
} from "@protocol/sync.codec";
import { syncVaultIdSchema } from "@protocol/sync.schemas";
import type { SyncVaultIdDto } from "@protocol/sync.types";
import {
  assertSyncHeadRefusalReceipt,
  assertSyncPublicationRecord,
  SYNC_PUBLICATION_LIMITS,
  syncFeedEventRecordSchema,
  syncHeadRefusalReceiptSchema,
  syncJournalRecordSchema,
  syncLaneHeadRecordSchema,
} from "@worker/infrastructure/sync/sync-publication.schemas";
import type {
  SyncHeadRefusalReceiptRecord,
  SyncPublicationKind,
  SyncPublicationRecord,
} from "@worker/infrastructure/sync/sync-publication.types";
import { syncHeadRefusalReceiptKey } from "@worker/infrastructure/sync/sync-r2-key";

const utf8Encoder = new TextEncoder();

/** Strictly decodes one private M7 publication only when bytes, key, vault and authority evidence agree.
 *
 * @param kind - Closed publication record family selecting its key shape and storage bound.
 * @param key - Untrusted full R2 key, reconstructed from the protocol-v1 builders for this vault.
 * @param bytes - Exact persisted UTF-8 JSON bytes, bounded before parsing or hashing.
 * @param expectedVaultId - Validated vault identity expected by the caller.
 * @returns A strict Worker-private journal, lane head, or immutable feed event.
 * @throws {ZodError} When the expected vault ID or strict record schema is invalid.
 * @throws {TypeError} When UTF-8, JSON, identity, key linkage, or payload evidence is invalid.
 * @throws {RangeError} When the record exceeds its persisted byte ceiling.
 */
export async function decodeSyncPublication(
  kind: SyncPublicationKind,
  key: string,
  bytes: Uint8Array,
  expectedVaultId: SyncVaultIdDto,
): Promise<SyncPublicationRecord> {
  const vaultId = syncVaultIdSchema.parse(expectedVaultId);
  if (bytes.byteLength > maxBytes(kind)) {
    throw new RangeError("Sync publication exceeds its persisted byte limit.");
  }
  const text = decodeUtf8(bytes);
  if (text === undefined) {
    throw new TypeError("Sync publication bytes are not valid UTF-8.");
  }
  const parsed = parseJson(text);
  const record = decodeByKind(kind, parsed);
  await assertSyncPublicationRecord(record, vaultId);
  if (record.vaultId !== vaultId || key !== recordKey(record)) {
    throw new TypeError(
      "Sync publication identity does not match its key or vault.",
    );
  }
  if (JSON.stringify(record) !== text) {
    throw new TypeError("Sync publication JSON is not canonical.");
  }
  return record;
}

/** Encodes a strict private receipt after checking its exact no-effect evidence and byte ceiling.
 * @param record Validated generation-one refusal record retained only by Worker storage.
 * @returns Canonical immutable UTF-8 JSON bytes under the receipt limit.
 * @throws {TypeError} When receipt schema, identity, path, or lane evidence is invalid.
 * @throws {RangeError} When canonical UTF-8 bytes exceed 8,192 bytes.
 */
export async function encodeSyncHeadRefusalReceipt(
  record: SyncHeadRefusalReceiptRecord,
): Promise<Uint8Array> {
  const validated = syncHeadRefusalReceiptSchema.parse(record);
  await assertSyncHeadRefusalReceipt(validated, validated.vaultId);
  const text = JSON.stringify(validated);
  if (utf8ByteLength(text) > SYNC_PUBLICATION_LIMITS.headRefusalReceiptBytes) {
    throw new RangeError("Head-refusal receipt exceeds its 8,192-byte limit.");
  }
  return utf8Encoder.encode(text);
}

/** Strictly decodes one private receipt only when its canonical key, vault and bounded bytes agree.
 * @param key Untrusted full Worker-private receipt key.
 * @param bytes Exact persisted UTF-8 JSON bytes; the ceiling is checked before decoding.
 * @param expectedVaultId Validated immutable vault identity expected by the caller.
 * @returns A strict typed generation-one no-effect receipt.
 * @throws {TypeError} When UTF-8, JSON, key, path, lane, or identity evidence is invalid.
 * @throws {RangeError} When the raw receipt exceeds its persisted byte ceiling.
 */
export async function decodeSyncHeadRefusalReceipt(
  key: string,
  bytes: Uint8Array,
  expectedVaultId: SyncVaultIdDto,
): Promise<SyncHeadRefusalReceiptRecord> {
  const vaultId = syncVaultIdSchema.parse(expectedVaultId);
  if (bytes.byteLength > SYNC_PUBLICATION_LIMITS.headRefusalReceiptBytes) {
    throw new RangeError("Head-refusal receipt exceeds its 8,192-byte limit.");
  }
  const text = decodeUtf8(bytes);
  if (text === undefined) {
    throw new TypeError("Head-refusal receipt bytes are not valid UTF-8.");
  }
  const record = syncHeadRefusalReceiptSchema.parse(parseJson(text));
  await assertSyncHeadRefusalReceipt(record, vaultId);
  if (
    record.vaultId !== vaultId ||
    key !== syncHeadRefusalReceiptKey(vaultId, record.operationId)
  ) {
    throw new TypeError(
      "Head-refusal receipt identity does not match its key.",
    );
  }
  if (JSON.stringify(record) !== text) {
    throw new TypeError("Head-refusal receipt JSON is not canonical.");
  }
  return record;
}

/** Encodes one private M7 publication as deterministic canonical UTF-8 JSON bytes.
 * @param record Validated protocol-v1 journal, lane head, or feed event retained by Worker storage.
 * @returns Canonical bytes suitable for create-only storage or exact-CAS replacement.
 * @throws {TypeError} When fields, request bytes, or precondition evidence disagree.
 * @throws {RangeError} When the serialized publication exceeds its family byte ceiling.
 */
export async function encodeSyncPublication(
  record: SyncPublicationRecord,
): Promise<Uint8Array> {
  const validated = decodeByKind(kindForRecord(record), record);
  await assertSyncPublicationRecord(validated, validated.vaultId);
  const bytes = utf8Encoder.encode(JSON.stringify(validated));
  if (bytes.byteLength > maxBytes(kindForRecord(validated))) {
    throw new RangeError(
      "Encoded sync publication exceeds its persisted byte limit.",
    );
  }
  return bytes;
}

/** Measures exact UTF-8 output length without allocating the encoded receipt body.
 * @param value Canonical JSON text whose byte ceiling must be proven before encoding.
 * @returns Exact UTF-8 byte length, including multibyte ETag characters.
 */
function utf8ByteLength(value: string): number {
  let byteLength = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) return Number.POSITIVE_INFINITY;
    byteLength +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return byteLength;
}

/** Parses strict UTF-8 text as JSON without allowing parser errors to escape untyped.
 * @param text - Bounded UTF-8 JSON source.
 * @returns Parsed value for the selected strict record schema.
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new TypeError("Sync publication JSON is malformed.");
  }
}

/** Applies the family-specific strict schema before any identity or evidence checks.
 * @param kind - Closed persisted record family.
 * @param value - Untrusted parsed JSON awaiting schema validation.
 * @returns Strictly parsed publication record for that family.
 */
function decodeByKind(
  kind: SyncPublicationKind,
  value: unknown,
): SyncPublicationRecord {
  switch (kind) {
    case "journal":
      return syncJournalRecordSchema.parse(value);
    case "laneHead":
      return syncLaneHeadRecordSchema.parse(value);
    case "feedEvent":
      return syncFeedEventRecordSchema.parse(value);
  }
}

/** Rebuilds the exact canonical R2 key from the validated record's complete identity.
 * @param record - Strict publication record whose identity names exactly one private key.
 * @returns Canonical protocol-v1 R2 key.
 */
function recordKey(record: SyncPublicationRecord): string {
  switch (record.kind) {
    case "journal":
      return syncOperationKey(record.vaultId, record.operationId);
    case "laneHead":
      return syncFeedLaneHeadKey(record.vaultId, record.lane);
    case "changed":
    case "aborted":
      return syncFeedEventKey(record.vaultId, record.lane, record.sequence);
  }
}

/** Returns the bounded serialized byte ceiling for the closed publication family.
 * @param kind - Publication family whose R2 body is bounded before parsing.
 * @returns Maximum stored byte count for that family.
 */
function maxBytes(kind: SyncPublicationKind): number {
  return kind === "journal"
    ? SYNC_PUBLICATION_LIMITS.journalBytes
    : SYNC_PUBLICATION_LIMITS.metadataBytes;
}

/** Selects the strict family used to re-validate a typed record at the encoding boundary.
 * @param record - Private publication record to validate.
 * @returns Its closed decoder family.
 */
function kindForRecord(record: SyncPublicationRecord): SyncPublicationKind {
  if (record.kind === "journal") return "journal";
  if (record.kind === "laneHead") return "laneHead";
  return "feedEvent";
}
