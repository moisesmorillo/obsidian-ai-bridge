import { syncVaultIdSchema } from "@protocol/sync.schemas";
import type {
  R2ConditionalBucketPort,
  R2ConditionalPutOptions,
} from "@worker/infrastructure/r2.types";
import {
  R2_ABSENCE_WILDCARD,
  R2_IF_NONE_MATCH_HEADER,
} from "@worker/infrastructure/storage-object.constants";
import type {
  SyncR2Key,
  SyncR2ObjectStore,
  SyncR2Observed,
  SyncR2ReadResult,
  SyncR2RetryContext,
  SyncR2WriteResult,
} from "@worker/infrastructure/sync/sync-r2.types";
import { isCanonicalSyncR2Key } from "@worker/infrastructure/sync/sync-r2-key";
import { SYNC_RECORD_LIMITS } from "@worker/infrastructure/sync/sync-record.schemas";

/** Minimum same-key retry spacing required by the M7 R2 contract. */
const SYNC_R2_WRITE_COOLDOWN_MS = 1_100;

/** Builds a private one-key conditional adapter with deterministic time and safe effect certainty.
 * @param bucket Conditional-only R2 capability; no delete or unconditional write is accepted.
 * @param epochNow Unix epoch millisecond clock for repeat-write cooldowns.
 * @returns Key-scoped read/create/CAS operations with typed evidence certainty.
 */
export function syncR2ObjectStore(
  bucket: R2ConditionalBucketPort,
  epochNow: () => number = Date.now,
): SyncR2ObjectStore {
  const retryNotBefore = new Map<string, number>();

  /** Reads exact key bytes and metadata without allowing untrusted size or key input to reach R2.
   * @param key Canonical sync-v1 key admitted by the M7.1 key codec.
   * @param maxBytes Caller-selected tighter bound; the family ceiling still applies.
   * @returns Verified absence, bounded exact generation evidence, or unavailable.
   */
  async function read(
    key: SyncR2Key,
    maxBytes: number,
  ): Promise<SyncR2ReadResult> {
    if (!isValidSyncKey(key)) return { kind: "unavailable" };
    const familyLimit = maxBytesForKey(key);
    if (
      familyLimit === undefined ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0 ||
      maxBytes > SYNC_RECORD_LIMITS.contentBodyBytes
    ) {
      return { kind: "unavailable" };
    }
    const readLimit = Math.min(maxBytes, familyLimit);
    try {
      const stored = await bucket.get(key);
      if (stored === null) return { kind: "absent" };
      const uploadedTime = stored.uploaded.getTime();
      if (
        !Number.isSafeInteger(stored.size) ||
        stored.size < 0 ||
        stored.size > readLimit ||
        stored.key !== key ||
        stored.etag.length === 0 ||
        !Number.isFinite(uploadedTime)
      ) {
        return { kind: "unavailable" };
      }
      const bytes = new Uint8Array(await stored.arrayBuffer());
      if (bytes.byteLength !== stored.size) return { kind: "unavailable" };
      return {
        kind: "observed",
        observation: {
          key,
          etag: stored.etag,
          bytes,
          uploaded: new Date(uploadedTime),
        },
      };
    } catch {
      return { kind: "unavailable" };
    }
  }

  /** Attempts one create-only PUT and establishes success only from exact byte read-back.
   * @param key Canonical key that must be absent or already contain the exact requested bytes.
   * @param bytes Exact candidate body retained without text normalization.
   * @param retryContext Previously returned cooldown floor that must survive isolate changes.
   * @returns Confirmed, refused, throttled, or effect-unknown result.
   */
  async function create(
    key: SyncR2Key,
    bytes: Uint8Array,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult> {
    return write(key, bytes, { kind: "create" }, retryContext);
  }

  /** Attempts one CAS with the exact previously observed ETag and never refreshes after refusal.
   * @param observed Exact key, bytes, ETag, and upload timestamp from an earlier read.
   * @param bytes Exact candidate replacement body.
   * @param retryContext Previously returned cooldown floor that must survive isolate changes.
   * @returns Confirmed, refused, throttled, or effect-unknown result.
   */
  async function replace(
    observed: SyncR2Observed,
    bytes: Uint8Array,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult> {
    if (!isValidObservation(observed)) return { kind: "effect_unknown" };
    return write(
      observed.key,
      bytes,
      { kind: "replace", observed },
      retryContext,
    );
  }

  /** Preflights one key, enforces cooldown, sends one conditional write and classifies exact evidence.
   * @param key Canonical M7.1 key to create or conditionally replace.
   * @param bytes Exact candidate body.
   * @param condition Create-only absence or exact previously observed ETag predicate.
   * @param retryContext Prior safe retry floor supplied by the caller across isolate changes.
   * @returns The single-attempt result; it never retries after refusal or uncertainty.
   */
  async function write(
    key: SyncR2Key,
    bytes: Uint8Array,
    condition:
      | { readonly kind: "create" }
      | { readonly kind: "replace"; readonly observed: SyncR2Observed },
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult> {
    if (
      retryContext !== undefined &&
      (!Number.isSafeInteger(retryContext.retryAfterEpochMs) ||
        retryContext.retryAfterEpochMs < 0)
    ) {
      return { kind: "effect_unknown" };
    }
    if (!isValidSyncKey(key)) return { kind: "effect_unknown" };
    const familyLimit = maxBytesForKey(key);
    if (familyLimit === undefined) return { kind: "effect_unknown" };
    if (bytes.byteLength > familyLimit) {
      throw new RangeError("Sync R2 object exceeds its key-family byte limit.");
    }
    const current = await read(key, SYNC_RECORD_LIMITS.contentBodyBytes);
    if (current.kind === "unavailable") return { kind: "effect_unknown" };
    if (condition.kind === "create" && current.kind === "observed") {
      return equalBytes(current.observation.bytes, bytes)
        ? { kind: "confirmed" }
        : { kind: "refused" };
    }
    if (condition.kind === "replace") {
      if (
        current.kind !== "observed" ||
        current.observation.etag !== condition.observed.etag ||
        current.observation.uploaded.getTime() !==
          condition.observed.uploaded.getTime() ||
        !equalBytes(current.observation.bytes, condition.observed.bytes)
      ) {
        return { kind: "refused" };
      }
    }

    const uploadedCooldown =
      current.kind === "observed"
        ? current.observation.uploaded.getTime() + SYNC_R2_WRITE_COOLDOWN_MS
        : 0;
    const retryAt = Math.max(
      uploadedCooldown,
      retryNotBefore.get(key) ?? 0,
      retryContext?.retryAfterEpochMs ?? 0,
    );
    if (epochNow() < retryAt) {
      return { kind: "throttled", retryAfterEpochMs: retryAt };
    }

    let options: R2ConditionalPutOptions;
    if (condition.kind === "create") {
      const onlyIf = new Headers();
      onlyIf.set(R2_IF_NONE_MATCH_HEADER, R2_ABSENCE_WILDCARD);
      options = {
        onlyIf,
        customMetadata: { format: "sync-v1" },
        httpMetadata: { contentType: "application/octet-stream" },
      };
    } else {
      options = {
        onlyIf: { etagMatches: condition.observed.etag },
        customMetadata: { format: "sync-v1" },
        httpMetadata: { contentType: "application/octet-stream" },
      };
    }

    try {
      const result = await bucket.put(key, bytes, options);
      if (result === null) {
        const readback = await read(key, SYNC_RECORD_LIMITS.contentBodyBytes);
        if (
          readback.kind === "observed" &&
          equalBytes(readback.observation.bytes, bytes)
        ) {
          return { kind: "confirmed" };
        }
        if (
          readback.kind === "observed" ||
          (readback.kind === "absent" && condition.kind === "replace")
        ) {
          return { kind: "refused" };
        }
        const retryAfterEpochMs = epochNow() + SYNC_R2_WRITE_COOLDOWN_MS;
        retryNotBefore.set(key, retryAfterEpochMs);
        return effectUnknown(retryAfterEpochMs);
      }
      const successfulUploadTime = result.uploaded.getTime();
      const resultRetryAt = Number.isFinite(successfulUploadTime)
        ? successfulUploadTime + SYNC_R2_WRITE_COOLDOWN_MS
        : epochNow() + SYNC_R2_WRITE_COOLDOWN_MS;
      retryNotBefore.set(key, resultRetryAt);
      const readback = await read(key, SYNC_RECORD_LIMITS.contentBodyBytes);
      return readback.kind === "observed" &&
        equalBytes(readback.observation.bytes, bytes)
        ? { kind: "confirmed" }
        : effectUnknown(resultRetryAt);
    } catch (error) {
      const retryAfterEpochMs = epochNow() + SYNC_R2_WRITE_COOLDOWN_MS;
      retryNotBefore.set(key, retryAfterEpochMs);
      if (isRateLimitError(error)) {
        return { kind: "throttled", retryAfterEpochMs };
      }
      const readback = await read(key, SYNC_RECORD_LIMITS.contentBodyBytes);
      if (
        readback.kind === "observed" &&
        equalBytes(readback.observation.bytes, bytes)
      ) {
        return { kind: "confirmed" };
      }
      return effectUnknown(retryAfterEpochMs);
    }
  }

  return { read, create, replace };
}

/** Confirms an observation retains complete generation evidence before replacement.
 * @param observed Candidate observation to validate before using its ETag.
 * @returns Whether its exact validator and upload timestamp are usable.
 */
function isValidObservation(observed: SyncR2Observed): boolean {
  return (
    observed.etag.length > 0 && Number.isFinite(observed.uploaded.getTime())
  );
}

/** Compares exact byte sequences without text decoding or normalization.
 * @param left First exact body.
 * @param right Second exact body.
 * @returns Whether both arrays have identical length and byte values.
 */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

/** Produces uncertainty with a safe retry lower bound when known.
 * @param retryAfterEpochMs Earliest safe retry time, or omitted when no lower bound is known.
 * @returns A typed unknown-effect result with the available cooldown evidence.
 */
function effectUnknown(
  retryAfterEpochMs: number | undefined,
): SyncR2WriteResult {
  return retryAfterEpochMs === undefined
    ? { kind: "effect_unknown" }
    : { kind: "effect_unknown", retryAfterEpochMs };
}

/** Identifies explicit R2 rate-limit responses without treating generic failures as refusals.
 * @param error Failure thrown by the R2 binding.
 * @returns Whether R2 explicitly reported rate limiting.
 */
function isRateLimitError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const status = "status" in error ? error.status : undefined;
  if (status === 429) return true;
  const message =
    "message" in error && typeof error.message === "string"
      ? error.message
      : "";
  return /(?:\b429\b|rate.?limit|too many requests)/i.test(message);
}

/** Applies the strict family-specific byte ceiling to one already reconstructed M7.1 key.
 * @param key Candidate canonical M7.1 storage key.
 * @returns Its family cap, or undefined when the key is not canonical.
 */
function maxBytesForKey(key: SyncR2Key): number | undefined {
  if (!isValidSyncKey(key)) return undefined;
  if (/\/(?:content\/[^/]+\.md|recovery\/[^/]+\.md)$/.test(key)) {
    return SYNC_RECORD_LIMITS.contentBodyBytes;
  }
  if (/\/heads\/[^/]+\.json$/.test(key)) return SYNC_RECORD_LIMITS.headBytes;
  if (/\/inventories\/scans\/[^/]+\/manifest\.json$/.test(key)) {
    return SYNC_RECORD_LIMITS.manifestBytes;
  }
  if (/\/inventories\/scans\/[^/]+\/chunks\/[0-9]+\.json$/.test(key)) {
    return SYNC_RECORD_LIMITS.chunkBytes;
  }
  return 2_048;
}

/** Validates a store key's embedded vault UUID and exact M7.1 key-builder shape.
 * @param key Candidate branded key supplied at the adapter boundary.
 * @returns Whether the key rebuilds exactly under its parsed vault identity.
 */
function isValidSyncKey(key: SyncR2Key): boolean {
  const vaultId = /^sync\/v1\/vaults\/([^/]+)\//.exec(key)?.[1];
  if (vaultId === undefined || !syncVaultIdSchema.safeParse(vaultId).success)
    return false;
  return isCanonicalSyncR2Key(key, syncVaultIdSchema.parse(vaultId));
}
