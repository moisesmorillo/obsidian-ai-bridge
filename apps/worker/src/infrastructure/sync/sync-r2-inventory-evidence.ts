import {
  type ContentSha256,
  decodeBase64Url,
  decodeUtf8,
} from "@obsidian-ai-bridge/core";
import {
  decodeSyncPathKey,
  syncHeadKey,
  syncInventoryChunkKey,
} from "@protocol/sync.codec";
import type { SyncInventoryIdDto, SyncVaultIdDto } from "@protocol/sync.types";
import type { SyncRecordObservation } from "@worker/infrastructure/sync/sync-r2.types";
import { encodeSyncRecord } from "@worker/infrastructure/sync/sync-record.codec";
import { SYNC_RECORD_LIMITS } from "@worker/infrastructure/sync/sync-record.schemas";
import type { SyncInventoryChunk } from "@worker/infrastructure/sync/sync-record.types";
import { sha256Content } from "@worker/storage/storage-crypto";
import { z } from "zod";

/** Closed, compact R2 page transcript whose key hash binds the linked head summary. */
const syncInventoryTranscriptSchema = z
  .object({
    objectCount: z.union([z.literal(0), z.literal(1)]),
    keySha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    headBodyBytes: z.number().int().min(0).max(SYNC_RECORD_LIMITS.headBytes),
    truncated: z.boolean(),
  })
  .strict();

/** Exact preceding evidence that a chunk must extend, independent of transport ETags. */
export interface SyncInventoryChunkPosition {
  /** Vault namespace containing both manifest and immutable chunk. */
  readonly vaultId: SyncVaultIdDto;
  /** Stable scan whose chunk key encodes its next step. */
  readonly inventoryId: SyncInventoryIdDto;
  /** Next unconsumed chunk index in the contiguous chain. */
  readonly nextStep: number;
  /** Prior validated rolling root, or null before the first chunk. */
  readonly chunkHash: SyncInventoryChunk["previousChunkHash"];
  /** Exact encoded input cursor for replay; absent only for digest-bound evidence paging. */
  readonly cursor?: string | null;
  /** Persisted input cursor digest for evidence pages that never expose the raw R2 cursor. */
  readonly inputCursorDigest?: ContentSha256;
  /** Last canonical listed key, retained to detect out-of-order pages. */
  readonly lastKey: string | null;
}

/** Validated immutable page evidence, shared by same-step replay and public evidence paging. */
export interface SyncVerifiedInventoryChunk {
  /** Strict canonical chunk whose exact bytes matched the object observation. */
  readonly record: SyncInventoryChunk;
  /** Exact persisted canonical body byte count for aggregate evidence limits. */
  readonly byteSize: number;
  /** Rolling root over the exact chunk bytes including its prior root. */
  readonly hash: ContentSha256;
  /** Canonical listed key when this page held a validated head. */
  readonly listedKey: string | null;
  /** Strict bounded transcript fields authoritative for this one page. */
  readonly transcript: z.infer<typeof syncInventoryTranscriptSchema>;
}

/** Checks key, bytes, cursor digests, transcript, summary and chain linkage without advancing policy.
 * @param prior Exact preceding cursor, step, key ordering and chain root.
 * @param chunk Observed immutable chunk with its exact R2 body bytes.
 * @returns Verified evidence or undefined; never repairs or normalizes persisted content.
 */
export async function verifySyncInventoryChunk(
  prior: SyncInventoryChunkPosition,
  chunk: SyncRecordObservation<SyncInventoryChunk>,
): Promise<SyncVerifiedInventoryChunk | undefined> {
  const record = chunk.value;
  if (
    record.vaultId !== prior.vaultId ||
    record.inventoryId !== prior.inventoryId ||
    record.step !== prior.nextStep ||
    record.previousChunkHash !== prior.chunkHash ||
    chunk.observed.key !==
      syncInventoryChunkKey(prior.vaultId, prior.inventoryId, prior.nextStep)
  )
    return undefined;
  let bytes: Uint8Array;
  try {
    bytes = await encodeSyncRecord({ kind: "chunk", record });
  } catch {
    return undefined;
  }
  if (
    bytes.byteLength !== chunk.observed.bytes.byteLength ||
    !bytes.every((byte, index) => byte === chunk.observed.bytes[index])
  )
    return undefined;
  const inputBytes =
    prior.cursor === undefined
      ? undefined
      : prior.cursor === null
        ? new Uint8Array()
        : decodeBase64Url(prior.cursor);
  const outputBytes =
    record.outputCursor === null
      ? new Uint8Array()
      : decodeBase64Url(record.outputCursor);
  const input = inputBytes === undefined ? undefined : decodeUtf8(inputBytes);
  const output =
    outputBytes === undefined ? undefined : decodeUtf8(outputBytes);
  const expectedInputDigest =
    prior.cursor === undefined
      ? prior.inputCursorDigest
      : input === undefined
        ? undefined
        : await sha256Content(input);
  if (
    expectedInputDigest === undefined ||
    output === undefined ||
    record.inputCursorDigest !== expectedInputDigest ||
    record.outputCursorDigest !== (await sha256Content(output)) ||
    record.truncated !== (record.outputCursor !== null) ||
    (record.truncated &&
      (output.length === 0 ||
        record.outputCursorDigest === expectedInputDigest))
  )
    return undefined;
  let parsed: ReturnType<typeof syncInventoryTranscriptSchema.safeParse>;
  try {
    parsed = syncInventoryTranscriptSchema.safeParse(
      JSON.parse(record.transcript),
    );
  } catch {
    return undefined;
  }
  if (
    !parsed.success ||
    parsed.data.truncated !== record.truncated ||
    new TextEncoder().encode(record.transcript).byteLength >
      SYNC_RECORD_LIMITS.chunkTranscriptBytes
  )
    return undefined;
  const transcript = parsed.data;
  let listedKey: string | null = null;
  if (transcript.objectCount === 0) {
    if (
      record.headSummary !== null ||
      transcript.keySha256 !== null ||
      transcript.headBodyBytes !== 0
    )
      return undefined;
  } else {
    if (
      record.headSummary === null ||
      transcript.keySha256 === null ||
      transcript.headBodyBytes <= 0
    )
      return undefined;
    const path = decodeSyncPathKey(record.headSummary.pathKey);
    if (path === undefined) return undefined;
    listedKey = syncHeadKey(prior.vaultId, path);
    if (
      (await sha256Content(listedKey)) !== transcript.keySha256 ||
      (prior.lastKey !== null && listedKey <= prior.lastKey)
    )
      return undefined;
  }
  return {
    record,
    byteSize: bytes.byteLength,
    hash: await sha256Content(new TextDecoder().decode(bytes)),
    listedKey,
    transcript,
  };
}
