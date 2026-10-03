import { syncVaultIdSchema } from "@protocol/sync.schemas";
import type {
  R2ConditionalBucketPort,
  R2ConditionalPutOptions,
} from "@worker/infrastructure/r2.types";
import {
  R2_ABSENCE_WILDCARD,
  R2_IF_NONE_MATCH_HEADER,
} from "@worker/infrastructure/storage-object.constants";
import { SYNC_PUBLICATION_LIMITS } from "@worker/infrastructure/sync/sync-publication.constants";
import {
  SYNC_R2_INVOCATION_CALL_LIMIT,
  SYNC_R2_WRITE_COOLDOWN_MS,
} from "@worker/infrastructure/sync/sync-r2.constants";
import type {
  SyncR2CallBudget,
  SyncR2Key,
  SyncR2ObjectStore,
  SyncR2Observed,
  SyncR2ReadResult,
  SyncR2RetryContext,
  SyncR2WriteResult,
} from "@worker/infrastructure/sync/sync-r2.types";
import { isCanonicalSyncR2Key } from "@worker/infrastructure/sync/sync-r2-key";
import { SYNC_RECORD_LIMITS } from "@worker/infrastructure/sync/sync-record.schemas";

/** Mutable accounting state held privately for one invocation's call budget. */
interface SyncR2CallBudgetState {
  /** GET and PUT calls already dispatched through this state. */
  actualCalls: number;
  /** Capacity held for pending PUT/read-back pairs. */
  reservedCalls: number;
}

/** Unforgeable reservation for one conditional PUT and its exact read-back. */
interface SyncR2WriteReservation {
  /** Invocation state from which both calls were atomically reserved. */
  readonly state: SyncR2CallBudgetState;
  /** Reserved calls that have not yet been dispatched or released. */
  remainingCalls: number;
}

/** Keeps invocation counters private while allowing a capability to be shared across stores. */
const callBudgetStates = new WeakMap<SyncR2CallBudget, SyncR2CallBudgetState>();

/** Creates an independent 64-call accounting capability for one invocation.
 * @returns A live actual-call count shared by every object store passed this capability.
 */
export function createSyncR2CallBudget(): SyncR2CallBudget {
  const state: SyncR2CallBudgetState = { actualCalls: 0, reservedCalls: 0 };
  const budget: SyncR2CallBudget = {
    get actualCalls() {
      return state.actualCalls;
    },
  };
  callBudgetStates.set(budget, state);
  return budget;
}

/** Builds a private one-key conditional adapter with deterministic time and safe effect certainty.
 * @param bucket Conditional-only R2 capability; no delete or unconditional write is accepted.
 * @param epochNow Unix epoch millisecond clock for repeat-write cooldowns.
 * @param callBudget Optional invocation budget shared by every object store in that invocation.
 * Omitting the budget preserves the uncounted M7.3 boundary and its R2 call behavior.
 * @returns Key-scoped read/create/CAS operations with typed evidence certainty.
 */
export function syncR2ObjectStore(
  bucket: R2ConditionalBucketPort,
  epochNow: () => number = Date.now,
  callBudget?: SyncR2CallBudget,
): SyncR2ObjectStore {
  const retryNotBefore = new Map<string, number>();
  const budgetState =
    callBudget === undefined ? undefined : callBudgetStates.get(callBudget);

  /** Reads exact key bytes and metadata without allowing untrusted size or key input to reach R2.
   * @param key Canonical sync-v1 key admitted by the M7.1 key codec.
   * @param maxBytes Caller-selected tighter bound; the family ceiling still applies.
   * @returns Verified absence, bounded exact generation evidence, or unavailable.
   */
  async function read(
    key: SyncR2Key,
    maxBytes: number,
    reservation?: SyncR2WriteReservation,
  ): Promise<SyncR2ReadResult> {
    if (!isValidSyncKey(key)) return { kind: "unavailable" };
    const familyLimit = maxBytesForKey(key);
    if (
      familyLimit === undefined ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0 ||
      maxBytes > SYNC_PUBLICATION_LIMITS.journalBytes
    ) {
      return { kind: "unavailable" };
    }
    const readLimit = Math.min(maxBytes, familyLimit);
    if (
      callBudget !== undefined &&
      !recordBudgetedCall(budgetState, reservation)
    ) {
      return { kind: "unavailable" };
    }
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
   * @returns Confirmed state, precise no-effect provenance, throttle, or uncertainty.
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
   * @returns Confirmed state, precise no-effect provenance, throttle, or uncertainty.
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
   * @returns One effect-certainty result; it never retries after refusal or uncertainty.
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
    const current = await read(key, SYNC_PUBLICATION_LIMITS.journalBytes);
    if (current.kind === "unavailable") return { kind: "effect_unknown" };
    if (condition.kind === "create" && current.kind === "observed") {
      return equalBytes(current.observation.bytes, bytes)
        ? { kind: "confirmed" }
        : {
            kind: "refused",
            noEffectProvenance: "preflight_no_dispatch",
          };
    }
    if (condition.kind === "replace") {
      if (
        current.kind !== "observed" ||
        current.observation.etag !== condition.observed.etag ||
        current.observation.uploaded.getTime() !==
          condition.observed.uploaded.getTime() ||
        !equalBytes(current.observation.bytes, condition.observed.bytes)
      ) {
        return {
          kind: "refused",
          noEffectProvenance: "preflight_no_dispatch",
        };
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

    const reservation =
      callBudget === undefined
        ? undefined
        : reserveWriteAndReadback(budgetState);
    if (callBudget !== undefined && reservation === undefined) {
      return effectUnknown(undefined);
    }
    if (
      callBudget !== undefined &&
      !recordBudgetedCall(budgetState, reservation)
    ) {
      releaseReservation(reservation);
      return effectUnknown(undefined);
    }

    try {
      const result = await bucket.put(key, bytes, options);
      if (result === null) {
        const readback = await read(
          key,
          SYNC_PUBLICATION_LIMITS.journalBytes,
          reservation,
        );
        if (
          readback.kind === "observed" &&
          equalBytes(readback.observation.bytes, bytes)
        ) {
          return { kind: "confirmed" };
        }
        if (readback.kind === "unavailable") {
          const retryAfterEpochMs = epochNow() + SYNC_R2_WRITE_COOLDOWN_MS;
          retryNotBefore.set(key, retryAfterEpochMs);
          return {
            kind: "effect_unknown",
            noEffectProvenance: "conditional_null",
            retryAfterEpochMs,
          };
        }
        return {
          kind: "refused",
          noEffectProvenance: "conditional_null",
        };
      }
      const successfulUploadTime = result.uploaded.getTime();
      const resultRetryAt = Number.isFinite(successfulUploadTime)
        ? successfulUploadTime + SYNC_R2_WRITE_COOLDOWN_MS
        : epochNow() + SYNC_R2_WRITE_COOLDOWN_MS;
      retryNotBefore.set(key, resultRetryAt);
      const readback = await read(
        key,
        SYNC_PUBLICATION_LIMITS.journalBytes,
        reservation,
      );
      return readback.kind === "observed" &&
        equalBytes(readback.observation.bytes, bytes)
        ? { kind: "confirmed" }
        : effectUnknown(resultRetryAt);
    } catch (error) {
      const retryAfterEpochMs = epochNow() + SYNC_R2_WRITE_COOLDOWN_MS;
      retryNotBefore.set(key, retryAfterEpochMs);
      if (isRateLimitError(error)) {
        releaseReservation(reservation);
        return { kind: "throttled", retryAfterEpochMs };
      }
      const readback = await read(
        key,
        SYNC_PUBLICATION_LIMITS.journalBytes,
        reservation,
      );
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

/** Reserves the indivisible conditional PUT/read-back pair within the invocation ceiling.
 * @param state Budget state owned by the caller's invocation capability.
 * @returns A reservation for both actual calls, or undefined when both cannot be guaranteed.
 */
function reserveWriteAndReadback(
  state: SyncR2CallBudgetState | undefined,
): SyncR2WriteReservation | undefined {
  if (
    state === undefined ||
    state.actualCalls + state.reservedCalls + 2 > SYNC_R2_INVOCATION_CALL_LIMIT
  ) {
    return undefined;
  }
  state.reservedCalls += 2;
  return { state, remainingCalls: 2 };
}

/** Counts one dispatched R2 call, consuming a reservation or free invocation capacity.
 * @param state Budget state attached to an invocation capability.
 * @param reservation Pair reservation when this call is a write or its mandatory read-back.
 * @returns Whether the call may reach the bucket without exceeding the cap.
 */
function recordBudgetedCall(
  state: SyncR2CallBudgetState | undefined,
  reservation?: SyncR2WriteReservation,
): boolean {
  if (state === undefined) return false;
  if (reservation !== undefined) {
    if (reservation.state !== state || reservation.remainingCalls === 0) {
      return false;
    }
    reservation.remainingCalls -= 1;
    state.reservedCalls -= 1;
  } else if (
    state.actualCalls + state.reservedCalls >=
    SYNC_R2_INVOCATION_CALL_LIMIT
  ) {
    return false;
  }
  state.actualCalls += 1;
  return true;
}

/** Releases still-unused reserved read-back capacity after a direct rate-limit response.
 * @param reservation Reservation whose conditional PUT was dispatched but read-back was not used.
 */
function releaseReservation(
  reservation: SyncR2WriteReservation | undefined,
): void {
  if (reservation === undefined) return;
  reservation.state.reservedCalls -= reservation.remainingCalls;
  reservation.remainingCalls = 0;
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
  if (/\/operations\/[^/]+\.head-refusal\.json$/.test(key)) {
    return SYNC_PUBLICATION_LIMITS.headRefusalReceiptBytes;
  }
  if (/\/operations\/[^/]+\.json$/.test(key)) {
    return SYNC_PUBLICATION_LIMITS.journalBytes;
  }
  if (/\/inventories\/scans\/[^/]+\/manifest\.json$/.test(key)) {
    return SYNC_RECORD_LIMITS.witnessedManifestBytes;
  }
  if (/\/inventories\/scans\/[^/]+\/chunks\/[0-9]+\.json$/.test(key)) {
    return SYNC_RECORD_LIMITS.chunkBytes;
  }
  if (/\/inventories\/scans\/[^/]+\/chunks\/claims\/[0-9]+\.json$/.test(key)) {
    return SYNC_RECORD_LIMITS.cursorJournalBytes;
  }
  if (
    /\/inventories\/scans\/[^/]+\/chunks\/cursors\/[0-9a-f]{64}\.json$/.test(
      key,
    )
  ) {
    return SYNC_RECORD_LIMITS.cursorWitnessBytes;
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
