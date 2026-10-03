import { syncContentKey } from "@protocol/sync.codec";
import {
  syncOperationIdSchema,
  syncRevisionSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type { SyncPublicationStepEvidence } from "@worker/infrastructure/sync/sync-publication.types";
import {
  claimClockIsSafe,
  mergeKnownPendingRetryFloors,
  planPendingClaim,
  planPendingRetryWait,
} from "@worker/infrastructure/sync/sync-r2-mutation-attempt-policy";
import { describe, expect, it } from "vitest";

const vaultId = syncVaultIdSchema.parse("11111111-1111-4111-8111-111111111111");
const revision = syncRevisionSchema.parse(
  "44444444-4444-4444-8444-444444444444",
);
const claimId = syncOperationIdSchema.parse(
  "22222222-2222-4222-8222-222222222222",
);
const attempting = {
  step: "immutable_create",
  key: syncContentKey(vaultId, revision),
  precondition: { kind: "absent" },
  retryAfterEpochMs: null,
  attempt: {
    state: "attempting",
    claimId,
    generation: 1,
    claimedAtEpochMs: 1_000,
  },
} satisfies SyncPublicationStepEvidence;

describe("pending R2 attempt policy", () => {
  it("merges independently known response, planned and observed floors without confusing absence with a known zero", () => {
    expect(mergeKnownPendingRetryFloors(undefined, undefined)).toEqual({
      kind: "none",
    });
    expect(mergeKnownPendingRetryFloors(50, 100, 75)).toEqual({
      kind: "known",
      retryAfterEpochMs: 100,
    });
    expect(mergeKnownPendingRetryFloors(200, 100, 300)).toEqual({
      kind: "known",
      retryAfterEpochMs: 300,
    });
    expect(mergeKnownPendingRetryFloors(undefined, 0)).toEqual({
      kind: "known",
      retryAfterEpochMs: 0,
    });
    expect(mergeKnownPendingRetryFloors(0, undefined)).toEqual({
      kind: "known",
      retryAfterEpochMs: 0,
    });
    expect(mergeKnownPendingRetryFloors(undefined, undefined, 100)).toEqual({
      kind: "known",
      retryAfterEpochMs: 100,
    });
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    "does not hide an unsafe response floor %s behind a valid peer floor",
    (floor) => {
      expect(mergeKnownPendingRetryFloors(5_000, floor)).toEqual({
        kind: "unsafe",
      });
    },
  );
  it("claims a ready target only after the original target and journal cooldowns", () => {
    expect(planPendingClaim(attempting, 2_000, 1_000)).toEqual({
      kind: "wait",
      retryAfterEpochMs: 2_100,
    });
    const ready = {
      ...attempting,
      attempt: { state: "ready" as const, generation: 0 as const },
    } satisfies SyncPublicationStepEvidence;
    expect(planPendingClaim(ready, 2_100, 1_000)).toEqual({
      kind: "claim",
      evidence: ready,
      generation: 1,
    });
    expect(
      planPendingClaim(
        {
          ...ready,
          precondition: {
            kind: "observed",
            etag: "original",
            bytes: "YQ",
            uploadedAtEpochMs: 1_500,
          },
        },
        2_200,
        1_000,
      ),
    ).toEqual({ kind: "wait", retryAfterEpochMs: 2_600 });
    expect(
      planPendingClaim({ ...ready, retryAfterEpochMs: 3_000 }, 2_100, 1_000),
    ).toEqual({
      kind: "wait",
      retryAfterEpochMs: 3_000,
    });
  });

  it("increments only the exact retry-wait generation, never another claimant", () => {
    const retryWait = {
      ...attempting,
      attempt: {
        state: "retry_wait" as const,
        claimId,
        generation: 3,
        observedAtEpochMs: 1_500,
        retryAfterEpochMs: 2_600,
      },
      retryAfterEpochMs: 2_600,
    } satisfies SyncPublicationStepEvidence;
    expect(planPendingClaim(retryWait, 2_600, 1_000)).toEqual({
      kind: "claim",
      evidence: retryWait,
      generation: 4,
    });
    expect(planPendingClaim(attempting, 2_600, 1_000)).toEqual({
      kind: "already_claimed",
    });
    expect(
      planPendingClaim(
        {
          ...retryWait,
          attempt: {
            ...retryWait.attempt,
            generation: Number.MAX_SAFE_INTEGER,
          },
        },
        2_600,
        1_000,
      ),
    ).toEqual({ kind: "unsafe" });
  });

  it("refuses nonrepresentable clocks, floors and journal-only claim evidence", () => {
    expect(claimClockIsSafe(Number.NaN)).toBe(false);
    expect(claimClockIsSafe(Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(claimClockIsSafe(8_640_000_000_000_001)).toBe(false);
    expect(claimClockIsSafe(8_639_999_999_999_000)).toBe(false);
    expect(claimClockIsSafe(2_000)).toBe(true);
    expect(
      planPendingClaim(attempting, 2_000, Number.MAX_SAFE_INTEGER),
    ).toEqual({ kind: "unsafe" });
    expect(
      planPendingClaim(
        {
          ...attempting,
          precondition: {
            kind: "observed",
            etag: "original",
            bytes: "YQ",
            uploadedAtEpochMs: Number.MAX_SAFE_INTEGER,
          },
        },
        2_000,
        1_000,
      ),
    ).toEqual({ kind: "unsafe" });
    expect(
      planPendingClaim({ ...attempting, step: "commit_lane" }, 2_000, 1_000),
    ).toEqual({ kind: "unsafe" });
    expect(
      planPendingClaim(
        {
          step: "commit_journal",
          key: "journal",
          precondition: { kind: "journal_phase", status: "pending" },
          retryAfterEpochMs: null,
        },
        2_000,
        1_000,
      ),
    ).toEqual({ kind: "unsafe" });
  });

  it("fixes the later of observation, original-key and known response floors without changing the claim", () => {
    const evidence = {
      ...attempting,
      retryAfterEpochMs: 4_000,
      precondition: {
        kind: "observed" as const,
        etag: "original",
        bytes: "YQ",
        uploadedAtEpochMs: 2_500,
      },
    } satisfies SyncPublicationStepEvidence;
    expect(
      planPendingRetryWait(evidence, 2_000, {
        kind: "throttled",
        retryAfterEpochMs: 5_000,
      }),
    ).toEqual({
      kind: "floor",
      evidence,
      attempt: evidence.attempt,
      observedAtEpochMs: 2_000,
      retryAfterEpochMs: 5_000,
    });
    expect(planPendingRetryWait(evidence, 2_000)).toEqual({
      kind: "floor",
      evidence,
      attempt: evidence.attempt,
      observedAtEpochMs: 2_000,
      retryAfterEpochMs: 4_000,
    });
    expect(evidence.attempt).toEqual(attempting.attempt);
  });

  it.each(["throttled", "effect_unknown"] as const)(
    "does not normalize invalid %s response floors behind a later valid observation",
    (kind) => {
      for (const retryAfterEpochMs of [-1, 0.5]) {
        const response =
          kind === "throttled"
            ? { kind, retryAfterEpochMs }
            : { kind, retryAfterEpochMs };
        expect(planPendingRetryWait(attempting, 2_000, response)).toEqual({
          kind: "unsafe",
        });
      }
    },
  );

  it("refuses invalid, backwards or overflowing observation time before any retry journal CAS", () => {
    for (const now of [Number.NaN, 999, Number.MAX_SAFE_INTEGER]) {
      expect(planPendingRetryWait(attempting, now)).toEqual({ kind: "unsafe" });
    }
  });

  it("refuses an original precondition or response floor that cannot be safely persisted", () => {
    expect(
      planPendingRetryWait(
        {
          ...attempting,
          precondition: {
            kind: "observed",
            etag: "original",
            bytes: "YQ",
            uploadedAtEpochMs: Number.MAX_SAFE_INTEGER,
          },
        },
        2_000,
      ),
    ).toEqual({ kind: "unsafe" });
    expect(
      planPendingRetryWait(attempting, 2_000, {
        kind: "throttled",
        retryAfterEpochMs: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toEqual({ kind: "unsafe" });
  });

  it("never grants a retry floor to an unclaimed or journal-only step", () => {
    expect(
      planPendingRetryWait(
        {
          ...attempting,
          attempt: { state: "ready", generation: 0 },
        },
        2_000,
      ),
    ).toEqual({ kind: "unsafe" });
    expect(
      planPendingRetryWait(
        {
          ...attempting,
          step: "commit_lane",
        },
        2_000,
      ),
    ).toEqual({ kind: "unsafe" });
  });
});
