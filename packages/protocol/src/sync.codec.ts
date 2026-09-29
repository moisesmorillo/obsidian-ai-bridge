import {
  decodeBase64Url,
  decodeNotePath,
  decodeUtf8,
  encodeBase64Url,
  encodeNotePath,
} from "@obsidian-ai-bridge/core";
import {
  MAX_SYNC_NOTE_PATH_BYTES,
  SYNC_FEED_LANE_COUNT,
  SYNC_NAMESPACE_PREFIX,
  SYNC_OBJECT_SEGMENT,
} from "@protocol/sync.constants";
import {
  syncCheckpointSchema,
  syncEventSequenceSchema,
  syncIdentifierSchema,
  syncNotePathSchema,
  syncOpaqueCursorSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type {
  SyncCheckpointDto,
  SyncEventSequenceDto,
  SyncInventoryIdDto,
  SyncNotePathDto,
  SyncOperationIdDto,
  SyncRevisionDto,
  SyncVaultIdDto,
} from "@protocol/sync.types";

/** Builds the isolated protocol-v1 prefix for a validated vault UUID.
 * @returns A trailing-slash prefix that cannot overlap the legacy v2 namespace.
 */
export function syncVaultPrefix(vaultId: SyncVaultIdDto): string {
  return `${SYNC_NAMESPACE_PREFIX}/${syncIdentifierSchema.parse(vaultId)}/`;
}

/** Builds a vault marker key without sharing or probing any legacy namespace.
 * @returns The create-only vault marker key within protocol-major-one storage.
 */
export function syncVaultMarkerKey(vaultId: SyncVaultIdDto): string {
  return `${syncVaultPrefix(vaultId)}${SYNC_OBJECT_SEGMENT.vault}`;
}

/** Builds the current-head key from the canonical UTF-8 path's base64url encoding.
 * @returns A path-derived key with no raw path characters in its object name.
 */
export function syncHeadKey(
  vaultId: SyncVaultIdDto,
  path: SyncNotePathDto,
): string {
  const validatedPath = syncNotePathSchema.parse(path);
  return `${syncVaultPrefix(vaultId)}${SYNC_OBJECT_SEGMENT.heads}/${encodeNotePath(validatedPath)}.json`;
}

/** Builds an immutable version metadata key for one validated revision UUID.
 * @returns The JSON object key for the specified revision.
 */
export function syncVersionKey(
  vaultId: SyncVaultIdDto,
  revision: SyncRevisionDto,
): string {
  return `${syncVaultPrefix(vaultId)}${SYNC_OBJECT_SEGMENT.versions}/${syncIdentifierSchema.parse(revision)}.json`;
}

/** Builds an immutable Markdown payload key for one validated revision UUID.
 * @returns The content object key for the specified revision.
 */
export function syncContentKey(
  vaultId: SyncVaultIdDto,
  revision: SyncRevisionDto,
): string {
  return `${syncVaultPrefix(vaultId)}${SYNC_OBJECT_SEGMENT.content}/${syncIdentifierSchema.parse(revision)}.md`;
}

/** Builds the metadata or body key for an operation's immutable recovery evidence.
 * @returns The JSON metadata key or Markdown recovery-body key.
 */
export function syncRecoveryKey(
  vaultId: SyncVaultIdDto,
  operationId: SyncOperationIdDto,
  kind: "metadata" | "content",
): string {
  const suffix = kind === "metadata" ? ".json" : ".md";
  return `${syncVaultPrefix(vaultId)}${SYNC_OBJECT_SEGMENT.recovery}/${syncIdentifierSchema.parse(operationId)}${suffix}`;
}

/** Builds a durable operation-journal key for one validated operation UUID.
 * @returns The operation journal key within the vault namespace.
 */
export function syncOperationKey(
  vaultId: SyncVaultIdDto,
  operationId: SyncOperationIdDto,
): string {
  return `${syncVaultPrefix(vaultId)}${SYNC_OBJECT_SEGMENT.operations}/${syncIdentifierSchema.parse(operationId)}.json`;
}

/** Builds a fixed lane-head key after validating the closed 0–63 lane range.
 * @returns The JSON key holding the lane's committed high-water mark.
 */
export function syncFeedLaneHeadKey(
  vaultId: SyncVaultIdDto,
  lane: number,
): string {
  return `${syncVaultPrefix(vaultId)}${SYNC_OBJECT_SEGMENT.feed}/${formatLane(lane)}/${SYNC_OBJECT_SEGMENT.head}`;
}

/** Builds a fixed-width immutable event key for a lane and non-zero sequence.
 * @returns The immutable event key for the validated lane and sequence.
 */
export function syncFeedEventKey(
  vaultId: SyncVaultIdDto,
  lane: number,
  sequence: SyncEventSequenceDto,
): string {
  if (!syncEventSequenceSchema.safeParse(sequence).success) {
    throw new TypeError("Expected a non-zero 20-digit feed sequence.");
  }
  return `${syncVaultPrefix(vaultId)}${SYNC_OBJECT_SEGMENT.feed}/${formatLane(lane)}/${SYNC_OBJECT_SEGMENT.events}/${sequence}.json`;
}

/** Builds the mutable inventory active-slot key in the isolated sync namespace.
 * @returns The vault-wide active inventory slot key.
 */
export function syncInventoryActiveKey(vaultId: SyncVaultIdDto): string {
  return `${syncVaultPrefix(vaultId)}${SYNC_OBJECT_SEGMENT.inventories}/${SYNC_OBJECT_SEGMENT.active}`;
}

/** Builds the durable manifest key for one immutable inventory scan identity.
 * @returns The scan's durable manifest key.
 */
export function syncInventoryManifestKey(
  vaultId: SyncVaultIdDto,
  inventoryId: SyncInventoryIdDto,
): string {
  return `${syncVaultPrefix(vaultId)}${SYNC_OBJECT_SEGMENT.inventories}/${SYNC_OBJECT_SEGMENT.scans}/${syncIdentifierSchema.parse(inventoryId)}/${SYNC_OBJECT_SEGMENT.manifest}`;
}

/** Builds one immutable evidence chunk key using its non-negative step number.
 * @returns The scan's durable key for the requested chunk step.
 */
export function syncInventoryChunkKey(
  vaultId: SyncVaultIdDto,
  inventoryId: SyncInventoryIdDto,
  step: number,
): string {
  if (!Number.isSafeInteger(step) || step < 0) {
    throw new TypeError("Expected a non-negative safe inventory step.");
  }
  return `${syncVaultPrefix(vaultId)}${SYNC_OBJECT_SEGMENT.inventories}/${SYNC_OBJECT_SEGMENT.scans}/${syncIdentifierSchema.parse(inventoryId)}/${SYNC_OBJECT_SEGMENT.chunks}/${step}.json`;
}

/** Assigns a canonical path to its protocol-stable SHA-256 feed lane.
 * @returns The lane number selected from the first digest byte.
 */
export async function syncFeedLaneForPath(
  path: SyncNotePathDto,
): Promise<number> {
  const validatedPath = syncNotePathSchema.parse(path);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(validatedPath),
  );
  const firstDigestByte = new Uint8Array(digest)[0];
  if (firstDigestByte === undefined) {
    throw new Error("SHA-256 returned an empty digest.");
  }
  return firstDigestByte & (SYNC_FEED_LANE_COUNT - 1);
}

/** Encodes a strict checkpoint as canonical UTF-8 JSON in unpadded base64url.
 * @returns An opaque, canonical unpadded base64url cursor.
 */
export function encodeSyncCursor(checkpoint: SyncCheckpointDto): string {
  const validated = syncCheckpointSchema.parse(checkpoint);
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(validated)));
}

/** Decodes a canonical cursor only when it belongs to the vault whose feed is read.
 * @param cursor The untrusted cursor string supplied by a protocol caller.
 * @param expectedVaultId The vault whose committed feed the cursor must address.
 * @returns The validated checkpoint, or `undefined` when invalid or vault-mismatched.
 */
export function decodeSyncCursor(
  cursor: string,
  expectedVaultId: SyncVaultIdDto,
): SyncCheckpointDto | undefined {
  if (
    !syncOpaqueCursorSchema.safeParse(cursor).success ||
    !syncVaultIdSchema.safeParse(expectedVaultId).success
  ) {
    return undefined;
  }
  const bytes = decodeBase64Url(cursor);
  if (bytes === undefined) {
    return undefined;
  }
  const text = decodeUtf8(bytes);
  if (text === undefined) {
    return undefined;
  }
  let parsed: ReturnType<typeof syncCheckpointSchema.safeParse>;
  try {
    parsed = syncCheckpointSchema.safeParse(JSON.parse(text));
  } catch {
    return undefined;
  }
  if (
    !parsed.success ||
    parsed.data.vaultId !== expectedVaultId ||
    encodeSyncCursor(parsed.data) !== cursor
  ) {
    return undefined;
  }
  return parsed.data;
}

/** Re-encodes a decoded path key only when it is the unique canonical representation.
 * @param pathKey The untrusted base64url path component from an object key.
 * @returns Its validated NotePath, or `undefined` if decoding is invalid/non-canonical.
 */
export function decodeSyncPathKey(
  pathKey: string,
): SyncNotePathDto | undefined {
  const decoded = decodeNotePath(pathKey);
  if (
    decoded === undefined ||
    new TextEncoder().encode(decoded).byteLength > MAX_SYNC_NOTE_PATH_BYTES
  ) {
    return undefined;
  }
  const validated = syncNotePathSchema.safeParse(decoded);
  return validated.success ? validated.data : undefined;
}

/** Validates and formats a feed lane as its fixed two-digit lowercase hex component.
 * @param lane The lane number, constrained to the protocol's 0–63 range.
 * @returns The lowercase hexadecimal key component.
 */
function formatLane(lane: number): string {
  if (!Number.isInteger(lane) || lane < 0 || lane >= SYNC_FEED_LANE_COUNT) {
    throw new RangeError("Feed lane must be an integer from 0 through 63.");
  }
  return lane.toString(16).padStart(2, "0");
}
