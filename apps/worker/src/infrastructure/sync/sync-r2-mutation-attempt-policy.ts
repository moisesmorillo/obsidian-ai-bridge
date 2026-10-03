import type {
  SyncPublicationAttemptState,
  SyncPublicationStepEvidence,
} from "@worker/infrastructure/sync/sync-publication.types";
import {
  SYNC_R2_MAX_DATE_EPOCH_MS,
  SYNC_R2_WRITE_COOLDOWN_MS,
} from "@worker/infrastructure/sync/sync-r2.constants";
import type { SyncR2WriteResult } from "@worker/infrastructure/sync/sync-r2.types";

/** Classified combination of independent epoch-millisecond floors; unsafe evidence cannot be replaced by a lower valid floor. */
export type SyncPendingRetryFloorMerge =
  | { readonly kind: "none" }
  | { readonly kind: "unsafe" }
  | {
      readonly kind: "known";
      /** Greatest known nonnegative safe-integer lower bound, including a known zero. */
      readonly retryAfterEpochMs: number;
    };

/** Retains every known lower bound when a concurrent journal generation supplies different retry evidence.
 * @param observedFloor Floor retained by the newly observed journal, or absent for a floorless phase.
 * @param responseFloor Locally known response or planned floor that must never be weakened by the journal.
 * @param additionalFloor Independent response floor learned while persisting the planned retry wait.
 * @returns Maximum valid floor, no known floor, or unsafe evidence; never target-PUT authority.
 */
export function mergeKnownPendingRetryFloors(
  observedFloor: number | undefined,
  responseFloor: number | undefined,
  additionalFloor?: number,
): SyncPendingRetryFloorMerge {
  const floors = [observedFloor, responseFloor, additionalFloor].filter(
    (floor) => floor !== undefined,
  );
  if (floors.some((floor) => !Number.isSafeInteger(floor) || floor < 0)) {
    return { kind: "unsafe" };
  }
  if (floors.length === 0) return { kind: "none" };
  return { kind: "known", retryAfterEpochMs: Math.max(...floors) };
}

/** One current-journal claim decision without granting authority to dispatch a target PUT. */
export type SyncPendingClaimPlan =
  | {
      readonly kind: "claim";
      readonly evidence: Exclude<
        SyncPublicationStepEvidence,
        { readonly step: "commit_journal" }
      >;
      readonly generation: number;
    }
  | { readonly kind: "wait"; readonly retryAfterEpochMs: number }
  | { readonly kind: "already_claimed" }
  | { readonly kind: "unsafe" };

/** Checks that a fresh claim time and its mandatory observation floor fit epoch milliseconds.
 * @param now Server epoch milliseconds before any journal read or CAS.
 * @returns Whether a new claim can retain a safely representable cooldown.
 */
export function claimClockIsSafe(now: number): boolean {
  return (
    Number.isSafeInteger(now) &&
    now >= 0 &&
    Number.isSafeInteger(now + SYNC_R2_WRITE_COOLDOWN_MS) &&
    now + SYNC_R2_WRITE_COOLDOWN_MS <= SYNC_R2_MAX_DATE_EPOCH_MS
  );
}

/** Selects the exact generation allowed by original target and journal cooldowns.
 * @param evidence Persisted step tuple; never refresh its target precondition or prior retry floor.
 * @param now Server epoch milliseconds already checked before the journal read.
 * @param journalUploadedAtEpochMs Original upload time of the exact current journal generation.
 * @returns A fresh generation, fixed wait floor, or no-claim outcome; never an external dispatch.
 */
export function planPendingClaim(
  evidence: SyncPublicationStepEvidence,
  now: number,
  journalUploadedAtEpochMs: number,
): SyncPendingClaimPlan {
  if (
    evidence.step !== "immutable_create" &&
    evidence.step !== "write_head" &&
    evidence.step !== "create_event"
  ) {
    return { kind: "unsafe" };
  }
  const targetFloor = Math.max(
    evidence.retryAfterEpochMs ?? 0,
    evidence.precondition.kind === "observed"
      ? evidence.precondition.uploadedAtEpochMs + SYNC_R2_WRITE_COOLDOWN_MS
      : 0,
  );
  const journalFloor = journalUploadedAtEpochMs + SYNC_R2_WRITE_COOLDOWN_MS;
  if (
    !Number.isSafeInteger(targetFloor) ||
    !Number.isSafeInteger(journalFloor)
  ) {
    return { kind: "unsafe" };
  }
  const retryAfterEpochMs = Math.max(targetFloor, journalFloor);
  if (now < retryAfterEpochMs) {
    return { kind: "wait", retryAfterEpochMs };
  }
  switch (evidence.attempt.state) {
    case "ready":
      return { kind: "claim", evidence, generation: 1 };
    case "retry_wait": {
      const generation = evidence.attempt.generation + 1;
      return Number.isSafeInteger(generation)
        ? { kind: "claim", evidence, generation }
        : { kind: "unsafe" };
    }
    case "attempting":
      return { kind: "already_claimed" };
  }
}

/** Whether an exact attempting claim has a safely representable, immutable retry observation floor. */
export type SyncPendingRetryPlan =
  | {
      readonly kind: "floor";
      readonly evidence: Exclude<
        SyncPublicationStepEvidence,
        { readonly step: "commit_journal" }
      >;
      readonly attempt: Extract<
        SyncPublicationAttemptState,
        { readonly state: "attempting" }
      >;
      readonly observedAtEpochMs: number;
      readonly retryAfterEpochMs: number;
    }
  | { readonly kind: "unsafe" };

/** Selects a conservative retry floor without performing a journal read, CAS, or target dispatch.
 * @param evidence Durable external-step tuple and its original target precondition.
 * @param observedAtEpochMs Server time of the exact target observation, never the claim time.
 * @param result Target-write response whose optional floor must independently be a nonnegative safe integer, if that write has returned.
 * @returns A safely representable fixed floor, or an unsafe result that cannot authorize a transition.
 */
export function planPendingRetryWait(
  evidence: SyncPublicationStepEvidence,
  observedAtEpochMs: number,
  result?: SyncR2WriteResult,
): SyncPendingRetryPlan {
  if (
    (evidence.step !== "immutable_create" &&
      evidence.step !== "write_head" &&
      evidence.step !== "create_event") ||
    evidence.attempt.state !== "attempting"
  ) {
    return { kind: "unsafe" };
  }
  const observationFloor = observedAtEpochMs + SYNC_R2_WRITE_COOLDOWN_MS;
  if (
    !Number.isSafeInteger(observedAtEpochMs) ||
    observedAtEpochMs < evidence.attempt.claimedAtEpochMs ||
    !Number.isSafeInteger(observationFloor)
  ) {
    return { kind: "unsafe" };
  }
  const resultFloor =
    result?.kind === "throttled" || result?.kind === "effect_unknown"
      ? result.retryAfterEpochMs
      : undefined;
  const checkedResponse = mergeKnownPendingRetryFloors(undefined, resultFloor);
  if (checkedResponse.kind === "unsafe") return { kind: "unsafe" };
  const originalUploadFloor =
    evidence.precondition.kind === "observed"
      ? evidence.precondition.uploadedAtEpochMs + SYNC_R2_WRITE_COOLDOWN_MS
      : 0;
  const retryAfterEpochMs = Math.max(
    evidence.retryAfterEpochMs ?? 0,
    resultFloor ?? 0,
    originalUploadFloor,
    observationFloor,
  );
  if (!Number.isSafeInteger(retryAfterEpochMs)) {
    return { kind: "unsafe" };
  }
  return {
    kind: "floor",
    evidence,
    attempt: evidence.attempt,
    observedAtEpochMs,
    retryAfterEpochMs,
  };
}
