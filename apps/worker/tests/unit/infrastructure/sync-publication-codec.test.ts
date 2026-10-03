import type { ContentSha256 } from "@obsidian-ai-bridge/core";
import { createContentSha256, encodeBase64Url } from "@obsidian-ai-bridge/core";
import {
  syncContentKey,
  syncFeedEventKey,
  syncFeedLaneForPath,
  syncFeedLaneHeadKey,
  syncHeadKey,
  syncOperationKey,
  syncRecoveryKey,
  syncVersionKey,
} from "@protocol/sync.codec";
import {
  syncDeviceIdSchema,
  syncEventSequenceSchema,
  syncNotePathSchema,
  syncOperationIdSchema,
  syncRevisionSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import {
  decodeSyncHeadRefusalReceipt,
  decodeSyncPublication,
  encodeSyncHeadRefusalReceipt,
  encodeSyncPublication,
} from "@worker/infrastructure/sync/sync-publication.codec";
import { syncJournalRecordSchema } from "@worker/infrastructure/sync/sync-publication.schemas";
import { encodeSyncRecord } from "@worker/infrastructure/sync/sync-record.codec";
import { describe, expect, it } from "vitest";

const VAULT_ID = syncVaultIdSchema.parse(
  "11111111-1111-4111-8111-111111111111",
);
const OTHER_VAULT_ID = syncVaultIdSchema.parse(
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
);
const OPERATION_ID = syncOperationIdSchema.parse(
  "22222222-2222-4222-8222-222222222222",
);
const OTHER_OPERATION_ID = syncOperationIdSchema.parse(
  "33333333-3333-4333-8333-333333333333",
);
const REVISION = syncRevisionSchema.parse(
  "44444444-4444-4444-8444-444444444444",
);
const OTHER_REVISION = syncRevisionSchema.parse(
  "55555555-5555-4555-8555-555555555555",
);
const ORIGIN = syncDeviceIdSchema.parse("66666666-6666-4666-8666-666666666666");
const PATH = syncNotePathSchema.parse("notes/exact.md");
const CONTENT = "# Exact\r\nUnicode 🌐 and NUL \u0000";
const encoder = new TextEncoder();

/** Computes a literal fixture digest independently from the publication codec.
 * @param bytes - Exact fixture UTF-8 bytes supplied to the codec.
 * @returns Branded lowercase SHA-256 digest for the fixture.
 */
async function sha256(bytes: Uint8Array): Promise<ContentSha256> {
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", digestInput.buffer),
  );
  const value = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const contentSha256 = createContentSha256(value);
  if (contentSha256 === undefined)
    throw new Error("Expected valid fixture digest.");
  return contentSha256;
}

/** Serializes a fixture in the canonical property order used by each record schema.
 * @param value - Hand-authored record fixture.
 * @returns Exact UTF-8 JSON bytes passed to the production decoder.
 */
function json(value: object): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

/** Builds a pending journal with the exact lane reservation precondition.
 * @param content - Exact live request content, defaulting to the ordinary fixture.
 * @param operationId - Canonical operation identity bound to the journal fixture.
 * @returns Strict pending journal fixture with independently computed byte evidence.
 */
async function pendingJournal(content = CONTENT, operationId = OPERATION_ID) {
  const lane = await syncFeedLaneForPath(PATH);
  const contentBytes = encoder.encode(content);
  return {
    schemaVersion: 2,
    protocolMajor: 1,
    vaultId: VAULT_ID,
    kind: "journal",
    status: "pending",
    operationId,
    request: {
      kind: "create",
      vaultId: VAULT_ID,
      path: PATH,
      operationId,
      revision: REVISION,
      parent: { kind: "never_seen" },
      contentSha256: await sha256(contentBytes),
      content,
      mediaType: "text/markdown",
      origin: ORIGIN,
    },
    payload: { byteSize: contentBytes.byteLength },
    allocationState: "allocated",
    reservation: {
      lane,
      sequence: syncEventSequenceSchema.parse("00000000000000000001"),
      previousCommittedAtEpochMs: 0,
    },
    stepEvidence: {
      step: "immutable_create",
      key: syncVersionKey(VAULT_ID, REVISION),
      precondition: { kind: "absent" },
      retryAfterEpochMs: null,
      attempt: { state: "ready", generation: 0 },
    },
  } as const;
}

/** Builds a pending journal whose next change is a phase-checked journal CAS.
 * @param retryAfterEpochMs - Known cooldown floor, or null when recovery must derive one.
 * @returns Strict pending journal fixture for a journal-only transition.
 */
async function journalCommitPending(retryAfterEpochMs: number | null) {
  const pending = await pendingJournal();
  return {
    ...pending,
    stepEvidence: {
      step: "commit_journal",
      key: syncOperationKey(VAULT_ID, OPERATION_ID),
      precondition: { kind: "journal_phase", status: "pending" },
      retryAfterEpochMs,
    },
  } as const;
}

/** Builds an update journal with its original current-head ETag and exact prior bytes.
 * @param retryAfterEpochMs - Known cooldown floor, or null when a response floor was lost.
 * @returns Strict pending update fixture bound to one exact old head generation.
 */
async function updateJournal(retryAfterEpochMs: number | null) {
  const lane = await syncFeedLaneForPath(PATH);
  const contentBytes = encoder.encode(CONTENT);
  const priorHead = {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId: VAULT_ID,
    path: PATH,
    revision: OTHER_REVISION,
    contentSha256: "a".repeat(64),
    byteSize: 3,
    mediaType: "text/markdown",
    operationId: OTHER_OPERATION_ID,
    origin: ORIGIN,
    kind: "live",
    parent: { kind: "never_seen" },
  };
  return {
    schemaVersion: 2,
    protocolMajor: 1,
    vaultId: VAULT_ID,
    kind: "journal",
    status: "pending",
    operationId: OPERATION_ID,
    request: {
      kind: "update",
      vaultId: VAULT_ID,
      path: PATH,
      operationId: OPERATION_ID,
      revision: REVISION,
      parent: { kind: "revision", revision: OTHER_REVISION },
      contentSha256: await sha256(contentBytes),
      content: CONTENT,
      mediaType: "text/markdown",
      origin: ORIGIN,
    },
    payload: { byteSize: contentBytes.byteLength },
    allocationState: "allocated",
    reservation: {
      lane,
      sequence: syncEventSequenceSchema.parse("00000000000000000002"),
      previousCommittedAtEpochMs: 100,
    },
    stepEvidence: {
      step: "write_head",
      key: syncHeadKey(VAULT_ID, PATH),
      precondition: {
        kind: "observed",
        etag: '"original-r2-etag"',
        bytes: encodeBase64Url(json(priorHead)),
        uploadedAtEpochMs: 700,
      },
      retryAfterEpochMs,
      attempt: { state: "ready", generation: 0 },
    },
  } as const;
}

/** Builds a tombstone write journal observed against one exact versioned prior head.
 * @param priorKind - Whether the prior revision is live or already a tombstone.
 * @param priorDigest - Exact prior metadata digest to compare with the mutation request.
 * @returns Pending tombstone write fixture with encoded original head bytes.
 */
async function tombstoneWriteJournal(
  priorKind: "live" | "tombstone",
  priorDigest: string,
) {
  const journal = await tombstoneJournal();
  const priorHead = {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId: VAULT_ID,
    path: PATH,
    revision: OTHER_REVISION,
    contentSha256: priorDigest,
    byteSize: encoder.encode(CONTENT).byteLength,
    mediaType: "text/markdown",
    operationId: OTHER_OPERATION_ID,
    origin: ORIGIN,
    kind: priorKind,
    parent:
      priorKind === "live"
        ? { kind: "never_seen" }
        : { kind: "revision", revision: REVISION },
  };
  return {
    ...journal,
    stepEvidence: {
      step: "write_head",
      key: syncHeadKey(VAULT_ID, PATH),
      precondition: {
        kind: "observed",
        etag: "original-tombstone-parent-etag",
        bytes: encodeBase64Url(json(priorHead)),
        uploadedAtEpochMs: 700,
      },
      retryAfterEpochMs: 1_800,
      attempt: { state: "ready", generation: 0 },
    },
  } as const;
}

/** Builds a tombstone journal retaining its exact parent digest and no request body.
 * @returns Strict pending tombstone fixture for immutable recovery metadata creation.
 */
async function tombstoneJournal() {
  const lane = await syncFeedLaneForPath(PATH);
  return {
    schemaVersion: 2,
    protocolMajor: 1,
    vaultId: VAULT_ID,
    kind: "journal",
    status: "pending",
    operationId: OPERATION_ID,
    request: {
      kind: "tombstone",
      vaultId: VAULT_ID,
      path: PATH,
      operationId: OPERATION_ID,
      revision: REVISION,
      parent: { kind: "revision", revision: OTHER_REVISION },
      contentSha256: await sha256(encoder.encode(CONTENT)),
      origin: ORIGIN,
    },
    payload: null,
    allocationState: "allocated",
    reservation: {
      lane,
      sequence: syncEventSequenceSchema.parse("00000000000000000002"),
      previousCommittedAtEpochMs: 100,
    },
    stepEvidence: {
      step: "immutable_create",
      key: syncRecoveryKey(VAULT_ID, OPERATION_ID, "metadata"),
      precondition: { kind: "absent" },
      retryAfterEpochMs: null,
      attempt: { state: "ready", generation: 0 },
    },
  } as const;
}

/** Builds a lane head with one exact pending operation reservation.
 * @returns Canonical lane-head fixture containing the operation's next sequence.
 */
async function pendingLaneHead() {
  const lane = await syncFeedLaneForPath(PATH);
  return {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId: VAULT_ID,
    kind: "laneHead",
    lane,
    committedSequence: syncSequenceSchema.parse("00000000000000000000"),
    committedAtEpochMs: 0,
    pending: {
      operationId: OPERATION_ID,
      nextSequence: syncEventSequenceSchema.parse("00000000000000000001"),
    },
  } as const;
}

/** Builds an unreserved lane head for an observed allocation precondition.
 * @param committedSequence - Exact fixed-width high-water mark, including zero.
 * @param committedAtEpochMs - Time bound to that high-water mark.
 * @returns Canonical lane head without a pending owner.
 */
async function unreservedLaneHead(
  committedSequence = syncSequenceSchema.parse("00000000000000000000"),
  committedAtEpochMs = 0,
) {
  return {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId: VAULT_ID,
    kind: "laneHead",
    lane: await syncFeedLaneForPath(PATH),
    committedSequence,
    committedAtEpochMs,
  } as const;
}

/** Builds a journal with no sequence authority and one exact lane observation.
 * @param observation - Verified lane-head absence or its exact canonical prior generation.
 * @param operationId - Immutable operation identity for this private request.
 * @returns Strict unallocated journal candidate for codec and facade tests.
 */
async function unallocatedJournal(
  observation:
    | { readonly kind: "absent" }
    | {
        readonly kind: "observed";
        readonly head: Awaited<ReturnType<typeof unreservedLaneHead>>;
        readonly etag: string;
        readonly uploadedAtEpochMs: number;
      },
  operationId = OPERATION_ID,
) {
  const allocated = await pendingJournal(CONTENT, operationId);
  const lane = allocated.reservation.lane;
  const precondition =
    observation.kind === "absent"
      ? ({ kind: "absent" } as const)
      : ({
          kind: "observed",
          etag: observation.etag,
          bytes: encodeBase64Url(json(observation.head)),
          uploadedAtEpochMs: observation.uploadedAtEpochMs,
        } as const);
  return {
    schemaVersion: 2,
    protocolMajor: 1,
    vaultId: VAULT_ID,
    kind: "journal",
    status: "pending",
    operationId,
    request: allocated.request,
    payload: allocated.payload,
    allocationState: "unallocated",
    lane,
    laneObservation: {
      key: syncFeedLaneHeadKey(VAULT_ID, lane),
      precondition,
      retryAfterEpochMs: null,
    },
  } as const;
}

/** Builds a fully linked changed event for one exact lane and sequence key.
 * @returns Canonical content-free event fixture bound to its path-derived lane.
 */
async function changedEvent() {
  const lane = await syncFeedLaneForPath(PATH);
  return {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId: VAULT_ID,
    kind: "changed",
    lane,
    sequence: syncEventSequenceSchema.parse("00000000000000000001"),
    path: PATH,
    result: { kind: "live", revision: REVISION },
    operationId: OPERATION_ID,
    origin: ORIGIN,
    committedAtEpochMs: 101,
  } as const;
}

describe("private sync publication codec", () => {
  it.each([
    "terminal_prior_phase",
    "phase_on_immutable",
    "nonmonotonic_event",
    "undecodable_lane_observation",
  ] as const)(
    "refuses persisted publication evidence with %s instead of repairing its authority",
    async (damage) => {
      const pending = await pendingJournal();
      const journal = await journalCommitPending(null);
      const candidate =
        damage === "terminal_prior_phase"
          ? {
              ...journal,
              stepEvidence: {
                ...journal.stepEvidence,
                precondition: { kind: "journal_phase", status: "committed" },
              },
            }
          : damage === "phase_on_immutable"
            ? {
                ...pending,
                stepEvidence: {
                  ...pending.stepEvidence,
                  precondition: { kind: "journal_phase", status: "pending" },
                },
              }
            : damage === "nonmonotonic_event"
              ? {
                  ...pending,
                  reservation: {
                    ...pending.reservation,
                    sequence: syncEventSequenceSchema.parse(
                      "00000000000000000002",
                    ),
                    previousCommittedAtEpochMs: 100,
                  },
                  stepEvidence: {
                    step: "create_event",
                    key: syncFeedEventKey(
                      VAULT_ID,
                      pending.reservation.lane,
                      syncEventSequenceSchema.parse("00000000000000000002"),
                    ),
                    precondition: { kind: "absent" },
                    retryAfterEpochMs: null,
                    attempt: { state: "ready", generation: 0 },
                    committedAtEpochMs: 100,
                    outcomeIntent: "changed",
                  },
                }
              : {
                  ...pending,
                  status: "committed",
                  revision: REVISION,
                  position: {
                    lane: pending.reservation.lane,
                    sequence: pending.reservation.sequence,
                  },
                  committedAtEpochMs: 200,
                  stepEvidence: {
                    step: "commit_lane",
                    key: syncFeedLaneHeadKey(
                      VAULT_ID,
                      pending.reservation.lane,
                    ),
                    precondition: {
                      kind: "observed",
                      etag: "original",
                      uploadedAtEpochMs: 100,
                      bytes: encodeBase64Url(new Uint8Array([255])),
                    },
                    retryAfterEpochMs: null,
                    attempt: { state: "ready", generation: 0 },
                  },
                };
      const message =
        damage === "terminal_prior_phase"
          ? JSON.stringify('Invalid input: expected "pending"').slice(1, -1)
          : damage === "phase_on_immutable"
            ? "Invalid discriminator value. Expected 'absent' | 'observed'"
            : damage === "nonmonotonic_event"
              ? "Event-step time must be strictly later than its predecessor lane clock"
              : "Journal precondition bytes are not exact bounded UTF-8 evidence";
      await expect(
        decodeSyncPublication(
          "journal",
          syncOperationKey(VAULT_ID, OPERATION_ID),
          json(candidate),
          VAULT_ID,
        ),
      ).rejects.toThrow(message);
    },
  );
  it("does not rehydrate a settled journal that has lost its final lane-commit evidence", async () => {
    const pending = await pendingJournal();
    const damaged = {
      ...pending,
      status: "committed",
      revision: pending.request.revision,
      position: {
        lane: pending.reservation.lane,
        sequence: pending.reservation.sequence,
      },
      committedAtEpochMs: 200,
    };
    expect(syncJournalRecordSchema.safeParse(damaged).success).toBe(false);
    await expect(
      decodeSyncPublication(
        "journal",
        syncOperationKey(VAULT_ID, OPERATION_ID),
        json(damaged),
        VAULT_ID,
      ),
    ).rejects.toThrow();
  });
  it.each(["observation_floor", "original_target_floor"] as const)(
    "rejects retry-wait authority below its %s even when its own floor fields agree",
    async (floor) => {
      const journal =
        floor === "observation_floor"
          ? await pendingJournal()
          : await updateJournal(null);
      const candidate = {
        ...journal,
        stepEvidence: {
          ...journal.stepEvidence,
          retryAfterEpochMs: 1_500,
          attempt: {
            state: "retry_wait",
            claimId: OTHER_OPERATION_ID,
            generation: 1,
            observedAtEpochMs: floor === "observation_floor" ? 1_000 : 0,
            retryAfterEpochMs: 1_500,
          },
        },
      } as const;
      await expect(encodeSyncPublication(candidate)).rejects.toThrow();
      await expect(
        decodeSyncPublication(
          "journal",
          syncOperationKey(VAULT_ID, OPERATION_ID),
          json(candidate),
          VAULT_ID,
        ),
      ).rejects.toThrow();
    },
  );

  it("does not let a saved generation authorize replacement of a create-only immutable target", async () => {
    const journal = await pendingJournal();
    const candidate = {
      ...journal,
      stepEvidence: {
        ...journal.stepEvidence,
        precondition: {
          kind: "observed",
          etag: "immutable-generation",
          bytes: encodeBase64Url(json(await pendingLaneHead())),
          uploadedAtEpochMs: 0,
        },
        retryAfterEpochMs: 1_100,
      },
    } as const;
    await expect(encodeSyncPublication(candidate)).rejects.toThrow(TypeError);
    await expect(
      decodeSyncPublication(
        "journal",
        syncOperationKey(VAULT_ID, OPERATION_ID),
        json(candidate),
        VAULT_ID,
      ),
    ).rejects.toThrow(TypeError);
  });

  it("does not let an absent lane observation authorize releasing a committed operation's reserved lane", async () => {
    const pending = await pendingJournal();
    const candidate = {
      ...pending,
      status: "committed",
      revision: REVISION,
      position: {
        lane: pending.reservation.lane,
        sequence: pending.reservation.sequence,
      },
      committedAtEpochMs: 200,
      stepEvidence: {
        step: "commit_lane",
        key: syncFeedLaneHeadKey(VAULT_ID, pending.reservation.lane),
        precondition: { kind: "absent" },
        retryAfterEpochMs: null,
        attempt: { state: "ready", generation: 0 },
      },
    } as const;
    await expect(encodeSyncPublication(candidate)).rejects.toThrow(TypeError);
    await expect(
      decodeSyncPublication(
        "journal",
        syncOperationKey(VAULT_ID, OPERATION_ID),
        json(candidate),
        VAULT_ID,
      ),
    ).rejects.toThrow(TypeError);
  });
  it("round-trips strict bounded generation-one head-refusal receipts", async () => {
    const competitorBytes = await encodeSyncRecord({
      kind: "head",
      record: {
        schemaVersion: 1,
        protocolMajor: 1,
        vaultId: VAULT_ID,
        kind: "live",
        path: PATH,
        revision: OTHER_REVISION,
        parent: { kind: "never_seen" },
        contentSha256: await sha256(encoder.encode("competitor")),
        byteSize: 10,
        mediaType: "text/markdown",
        operationId: OTHER_OPERATION_ID,
        origin: ORIGIN,
      },
    });
    const targetBytes = await encodeSyncRecord({
      kind: "head",
      record: {
        schemaVersion: 1,
        protocolMajor: 1,
        vaultId: VAULT_ID,
        kind: "live",
        path: PATH,
        revision: REVISION,
        parent: { kind: "never_seen" },
        contentSha256: await sha256(encoder.encode(CONTENT)),
        byteSize: encoder.encode(CONTENT).byteLength,
        mediaType: "text/markdown",
        operationId: OPERATION_ID,
        origin: ORIGIN,
      },
    });
    const receipt = {
      schemaVersion: 1 as const,
      protocolMajor: 1 as const,
      vaultId: VAULT_ID,
      operationId: OPERATION_ID,
      claimId: OTHER_OPERATION_ID,
      generation: 1 as const,
      headKey: syncHeadKey(VAULT_ID, PATH),
      headTargetSha256: await sha256(targetBytes),
      headPrecondition: { kind: "absent" as const },
      lane: await syncFeedLaneForPath(PATH),
      sequence: syncEventSequenceSchema.parse("00000000000000000001"),
      refusalSource: "preflight_no_dispatch" as const,
      competingHead: {
        etag: "etag-competitor",
        bytes: encodeBase64Url(competitorBytes),
        uploadedAtEpochMs: 1_000,
      },
    };
    const key = `sync/v1/vaults/${VAULT_ID}/operations/${OPERATION_ID}.head-refusal.json`;
    const bytes = await encodeSyncHeadRefusalReceipt(receipt);
    expect(bytes.byteLength).toBeLessThanOrEqual(8_192);
    const escapedEtag = "\u0000".repeat(1_024);
    expect(encoder.encode(escapedEtag)).toHaveLength(1_024);
    await expect(
      encodeSyncHeadRefusalReceipt({
        ...receipt,
        competingHead: { ...receipt.competingHead, etag: escapedEtag },
        headPrecondition: {
          kind: "observed",
          etag: escapedEtag,
          uploadedAtEpochMs: 1_000,
          bytes: encodeBase64Url(targetBytes),
        },
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      decodeSyncHeadRefusalReceipt(key, bytes, VAULT_ID),
    ).resolves.toEqual(receipt);
    await expect(
      decodeSyncHeadRefusalReceipt(key, bytes, OTHER_VAULT_ID),
    ).rejects.toThrow(TypeError);
    await expect(
      decodeSyncHeadRefusalReceipt(
        key,
        json({ ...receipt, lane: (receipt.lane + 1) % 64 }),
        VAULT_ID,
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      decodeSyncHeadRefusalReceipt(`${key}.other`, bytes, VAULT_ID),
    ).rejects.toThrow();
    await expect(
      decodeSyncHeadRefusalReceipt(key, new Uint8Array(8_193), VAULT_ID),
    ).rejects.toThrow(RangeError);
    await expect(
      decodeSyncHeadRefusalReceipt(
        key,
        json({ ...receipt, unexpectedAuthority: true }),
        VAULT_ID,
      ),
    ).rejects.toThrow();
    await expect(
      encodeSyncHeadRefusalReceipt({
        ...receipt,
        headKey: syncOperationKey(VAULT_ID, OPERATION_ID),
      }),
    ).rejects.toThrow();
    await expect(
      encodeSyncHeadRefusalReceipt({
        ...receipt,
        competingHead: {
          ...receipt.competingHead,
          bytes: encodeBase64Url(encoder.encode("{}")),
        },
      }),
    ).rejects.toThrow();
    for (const malformed of [
      "!",
      encodeBase64Url(new Uint8Array([0xff])),
      encodeBase64Url(encoder.encode("{")),
      encodeBase64Url(
        encoder.encode(`${new TextDecoder().decode(competitorBytes)} `),
      ),
    ]) {
      await expect(
        encodeSyncHeadRefusalReceipt({
          ...receipt,
          competingHead: { ...receipt.competingHead, bytes: malformed },
        }),
      ).rejects.toThrow();
    }
    const otherPath = syncNotePathSchema.parse("notes/foreign.md");
    const foreignHeadBytes = await encodeSyncRecord({
      kind: "head",
      record: {
        schemaVersion: 1,
        protocolMajor: 1,
        vaultId: VAULT_ID,
        kind: "live",
        path: otherPath,
        revision: OTHER_REVISION,
        parent: { kind: "never_seen" },
        contentSha256: await sha256(encoder.encode("competitor")),
        byteSize: 10,
        mediaType: "text/markdown",
        operationId: OTHER_OPERATION_ID,
        origin: ORIGIN,
      },
    });
    await expect(
      encodeSyncHeadRefusalReceipt({
        ...receipt,
        competingHead: {
          ...receipt.competingHead,
          bytes: encodeBase64Url(foreignHeadBytes),
        },
      }),
    ).rejects.toThrow();
    const observedPrecondition = {
      ...receipt,
      headPrecondition: {
        kind: "observed" as const,
        etag: "etag-prior",
        bytes: encodeBase64Url(competitorBytes),
        uploadedAtEpochMs: 1_000,
      },
    };
    await expect(
      encodeSyncHeadRefusalReceipt(observedPrecondition),
    ).resolves.toBeInstanceOf(Uint8Array);
    await expect(
      encodeSyncHeadRefusalReceipt({
        ...observedPrecondition,
        headPrecondition: {
          ...observedPrecondition.headPrecondition,
          bytes: "!",
        },
      }),
    ).rejects.toThrow();
  });

  it("accepts strict journal-v2 attempt states without changing lane/event v1", async () => {
    const { decodeSyncPublication, encodeSyncPublication } = await import(
      "@worker/infrastructure/sync/sync-publication.codec"
    );
    const journal = await pendingJournal();
    const versionTwoReady = {
      ...journal,
      schemaVersion: 2 as const,
      stepEvidence: {
        ...journal.stepEvidence,
        attempt: { state: "ready" as const, generation: 0 as const },
      },
    };
    await expect(
      decodeSyncPublication(
        "journal",
        syncOperationKey(VAULT_ID, OPERATION_ID),
        await encodeSyncPublication(versionTwoReady),
        VAULT_ID,
      ),
    ).resolves.toMatchObject({
      schemaVersion: 2,
      stepEvidence: { attempt: { state: "ready", generation: 0 } },
    });

    await expect(
      decodeSyncPublication(
        "journal",
        syncOperationKey(VAULT_ID, OPERATION_ID),
        json({ ...versionTwoReady, schemaVersion: 1 }),
        VAULT_ID,
      ),
    ).rejects.toThrow();

    const malformed = [
      {
        ...versionTwoReady,
        stepEvidence: { ...versionTwoReady.stepEvidence, attempt: undefined },
      },
      {
        ...versionTwoReady,
        stepEvidence: {
          ...versionTwoReady.stepEvidence,
          attempt: { state: "ready", generation: 1 },
        },
      },
      {
        ...versionTwoReady,
        stepEvidence: {
          ...versionTwoReady.stepEvidence,
          attempt: {
            state: "attempting",
            claimId: OPERATION_ID,
            generation: Number.MAX_SAFE_INTEGER + 1,
            claimedAtEpochMs: 1,
          },
        },
      },
      {
        ...versionTwoReady,
        stepEvidence: {
          ...versionTwoReady.stepEvidence,
          retryAfterEpochMs: 2_000,
          attempt: {
            state: "retry_wait",
            claimId: OPERATION_ID,
            generation: 1,
            observedAtEpochMs: 100,
            retryAfterEpochMs: 1_200,
          },
        },
      },
    ];
    for (const record of malformed) {
      await expect(
        decodeSyncPublication(
          "journal",
          syncOperationKey(VAULT_ID, OPERATION_ID),
          json(record),
          VAULT_ID,
        ),
      ).rejects.toThrow();
    }
  });

  it("round-trips an unallocated journal without sequence or publication authority", async () => {
    const { decodeSyncPublication, encodeSyncPublication } = await import(
      "@worker/infrastructure/sync/sync-publication.codec"
    );
    const head = await unreservedLaneHead();
    const unallocated = await unallocatedJournal({
      kind: "observed",
      head,
      etag: '"zero-head-generation"',
      uploadedAtEpochMs: 800,
    });
    const key = syncOperationKey(VAULT_ID, OPERATION_ID);
    const bytes = await encodeSyncPublication(unallocated);

    await expect(
      decodeSyncPublication("journal", key, bytes, VAULT_ID),
    ).resolves.toEqual(unallocated);
    await expect(
      decodeSyncPublication(
        "journal",
        key,
        json({
          ...unallocated,
          reservation: {
            lane: unallocated.lane,
            sequence: "00000000000000000001",
            previousCommittedAtEpochMs: 0,
          },
        }),
        VAULT_ID,
      ),
    ).rejects.toThrow();
    await expect(
      decodeSyncPublication(
        "journal",
        key,
        json({
          ...unallocated,
          stepEvidence: { step: "reserve_lane" },
        }),
        VAULT_ID,
      ),
    ).rejects.toThrow();
  });

  it("accepts verified absence for zero-head initialization but rejects malformed lane observations", async () => {
    const { decodeSyncPublication, encodeSyncPublication } = await import(
      "@worker/infrastructure/sync/sync-publication.codec"
    );
    const key = syncOperationKey(VAULT_ID, OPERATION_ID);
    const absent = await unallocatedJournal({ kind: "absent" });
    await expect(
      decodeSyncPublication(
        "journal",
        key,
        await encodeSyncPublication(absent),
        VAULT_ID,
      ),
    ).resolves.toMatchObject({ allocationState: "unallocated" });

    const head = await unreservedLaneHead();
    const observed = await unallocatedJournal({
      kind: "observed",
      head,
      etag: '"zero-head-generation"',
      uploadedAtEpochMs: 800,
    });
    for (const malformed of [
      {
        ...observed,
        lane: (observed.lane + 1) % 64,
      },
      {
        ...observed,
        laneObservation: {
          ...observed.laneObservation,
          key: "sync/v1/unrelated",
        },
      },
      {
        ...observed,
        laneObservation: {
          ...observed.laneObservation,
          precondition: {
            ...observed.laneObservation.precondition,
            uploadedAtEpochMs: 1_000,
          },
        },
      },
    ]) {
      await expect(
        decodeSyncPublication("journal", key, json(malformed), VAULT_ID),
      ).rejects.toThrow();
    }
  });

  it("rejects malformed exact lane bytes, retry floors, and reserved snapshots", async () => {
    const { decodeSyncPublication } = await import(
      "@worker/infrastructure/sync/sync-publication.codec"
    );
    const key = syncOperationKey(VAULT_ID, OPERATION_ID);
    const head = await unreservedLaneHead();
    const observed = await unallocatedJournal({
      kind: "observed",
      head,
      etag: '"zero-head-generation"',
      uploadedAtEpochMs: 800,
    });
    const { laneObservation } = observed;
    if (laneObservation.precondition.kind !== "observed") {
      throw new Error("Expected an exact observed lane fixture.");
    }
    const precondition = laneObservation.precondition;
    const reservedHead = {
      ...head,
      pending: {
        operationId: OPERATION_ID,
        nextSequence: syncEventSequenceSchema.parse("00000000000000000001"),
      },
    };
    const malformed = [
      {
        ...observed,
        laneObservation: { ...laneObservation, retryAfterEpochMs: 1_899 },
      },
      {
        ...observed,
        laneObservation: {
          ...laneObservation,
          precondition: { ...precondition, bytes: "!" },
        },
      },
      {
        ...observed,
        laneObservation: {
          ...laneObservation,
          precondition: {
            ...precondition,
            bytes: encodeBase64Url(new Uint8Array([0xff])),
          },
        },
      },
      {
        ...observed,
        laneObservation: {
          ...laneObservation,
          precondition: {
            ...precondition,
            bytes: encodeBase64Url(encoder.encode("{")),
          },
        },
      },
      {
        ...observed,
        laneObservation: {
          ...laneObservation,
          precondition: {
            ...precondition,
            bytes: encodeBase64Url(json(reservedHead)),
          },
        },
      },
    ];
    for (const record of malformed) {
      await expect(
        decodeSyncPublication("journal", key, json(record), VAULT_ID),
      ).rejects.toThrow();
    }

    const tombstone = await tombstoneJournal();
    await expect(
      decodeSyncPublication(
        "journal",
        key,
        json({ ...tombstone, payload: { byteSize: 1 } }),
        VAULT_ID,
      ),
    ).rejects.toThrow("Only live requests carry exact payload size evidence.");
  });

  it("round-trips exact request bytes and produces idempotent canonical journal bytes", async () => {
    const { decodeSyncPublication, encodeSyncPublication } = await import(
      "@worker/infrastructure/sync/sync-publication.codec"
    );
    const record = await pendingJournal();
    const first = await encodeSyncPublication(record);
    const second = await encodeSyncPublication(record);
    expect(second).toEqual(first);
    await expect(
      decodeSyncPublication(
        "journal",
        syncOperationKey(VAULT_ID, OPERATION_ID),
        first,
        VAULT_ID,
      ),
    ).resolves.toEqual(record);
    await expect(
      encodeSyncPublication(
        await decodeSyncPublication(
          "journal",
          syncOperationKey(VAULT_ID, OPERATION_ID),
          first,
          VAULT_ID,
        ),
      ),
    ).resolves.toEqual(first);
  });

  it("rejects oversized, invalid UTF-8, malformed, and non-canonical stored bytes", async () => {
    const { decodeSyncPublication } = await import(
      "@worker/infrastructure/sync/sync-publication.codec"
    );
    const key = syncOperationKey(VAULT_ID, OPERATION_ID);
    await expect(
      decodeSyncPublication(
        "journal",
        key,
        new Uint8Array(8 * 1_048_576 + 1),
        VAULT_ID,
      ),
    ).rejects.toThrow("byte limit");
    await expect(
      decodeSyncPublication("journal", key, new Uint8Array([0xff]), VAULT_ID),
    ).rejects.toThrow("UTF-8");
    await expect(
      decodeSyncPublication("journal", key, encoder.encode("{"), VAULT_ID),
    ).rejects.toThrow("malformed");

    const record = await pendingJournal();
    await expect(
      decodeSyncPublication(
        "journal",
        key,
        encoder.encode(`${JSON.stringify(record)} `),
        VAULT_ID,
      ),
    ).rejects.toThrow("canonical");
  });

  it("re-resolves journal CAS outcomes from exact prior or target phase after isolate loss", async () => {
    const { decodeSyncPublication, encodeSyncPublication } = await import(
      "@worker/infrastructure/sync/sync-publication.codec"
    );
    const pending = await journalCommitPending(1_800);
    const key = syncOperationKey(VAULT_ID, OPERATION_ID);
    const priorBytes = await encodeSyncPublication(pending);
    const priorRead = await decodeSyncPublication(
      "journal",
      key,
      priorBytes,
      VAULT_ID,
    );
    expect(priorRead).toEqual(pending);
    if (
      priorRead.kind !== "journal" ||
      priorRead.status !== "pending" ||
      priorRead.allocationState !== "allocated"
    ) {
      throw new Error("Expected an allocated pending journal.");
    }
    expect(priorRead.stepEvidence.retryAfterEpochMs).toBe(1_800);

    const lane = pending.reservation.lane;
    const committed = {
      ...pending,
      status: "committed",
      stepEvidence: {
        step: "commit_lane",
        key: syncFeedLaneHeadKey(VAULT_ID, lane),
        precondition: {
          kind: "observed",
          etag: "reserved-lane-etag",
          bytes: encodeBase64Url(json(await pendingLaneHead())),
          uploadedAtEpochMs: 1_700,
        },
        retryAfterEpochMs: null,
        attempt: { state: "ready", generation: 0 },
      },
      position: {
        lane,
        sequence: pending.reservation.sequence,
      },
      revision: REVISION,
      committedAtEpochMs: 1_801,
    } as const;
    const committedBytes = await encodeSyncPublication(committed);
    await expect(
      decodeSyncPublication("journal", key, committedBytes, VAULT_ID),
    ).resolves.toMatchObject({ status: "committed" });

    const reservedHead = await pendingLaneHead();
    const invalidCommitPreconditions = [
      {
        ...committed,
        stepEvidence: {
          ...committed.stepEvidence,
          precondition: {
            ...committed.stepEvidence.precondition,
            bytes: encodeBase64Url(
              json({
                ...reservedHead,
                lane: (reservedHead.lane + 1) % 64,
              }),
            ),
          },
        },
      },
      {
        ...committed,
        stepEvidence: {
          ...committed.stepEvidence,
          precondition: {
            ...committed.stepEvidence.precondition,
            bytes: encodeBase64Url(
              json({
                ...reservedHead,
                pending: {
                  ...reservedHead.pending,
                  operationId: OTHER_OPERATION_ID,
                },
              }),
            ),
          },
        },
      },
      {
        ...committed,
        stepEvidence: {
          ...committed.stepEvidence,
          precondition: {
            ...committed.stepEvidence.precondition,
            bytes: encodeBase64Url(
              encoder.encode(`${JSON.stringify(reservedHead)} `),
            ),
          },
        },
      },
    ];
    for (const malformed of invalidCommitPreconditions) {
      await expect(
        decodeSyncPublication("journal", key, json(malformed), VAULT_ID),
      ).rejects.toThrow();
    }

    await expect(
      decodeSyncPublication(
        "journal",
        key,
        json({
          ...pending,
          stepEvidence: {
            ...pending.stepEvidence,
            precondition: { kind: "journal_phase", status: "committed" },
          },
        }),
        VAULT_ID,
      ),
    ).rejects.toThrow();
  });

  it("retains original ETag and exact prior bytes when an uncertain retry floor is absent", async () => {
    const { decodeSyncPublication, encodeSyncPublication } = await import(
      "@worker/infrastructure/sync/sync-publication.codec"
    );
    const journal = await updateJournal(null);
    const key = syncOperationKey(VAULT_ID, OPERATION_ID);
    const bytes = await encodeSyncPublication(journal);
    const recovered = await decodeSyncPublication(
      "journal",
      key,
      bytes,
      VAULT_ID,
    );
    expect(recovered.kind).toBe("journal");
    if (
      recovered.kind !== "journal" ||
      recovered.status !== "pending" ||
      recovered.allocationState !== "allocated"
    ) {
      throw new Error("Expected an allocated pending journal.");
    }
    expect(recovered.stepEvidence).toEqual(journal.stepEvidence);
    expect(recovered.stepEvidence.precondition).toMatchObject({
      kind: "observed",
      etag: '"original-r2-etag"',
      bytes: journal.stepEvidence.precondition.bytes,
      uploadedAtEpochMs: 700,
    });
    expect(recovered.stepEvidence.retryAfterEpochMs).toBeNull();

    const knownFloor = await updateJournal(1_800);
    const knownBytes = await encodeSyncPublication(knownFloor);
    const tooSoonBytes = encoder.encode(
      new TextDecoder()
        .decode(knownBytes)
        .replace('"retryAfterEpochMs":1800', '"retryAfterEpochMs":701'),
    );
    await expect(
      decodeSyncPublication("journal", key, tooSoonBytes, VAULT_ID),
    ).rejects.toThrow();
    const known = await decodeSyncPublication(
      "journal",
      key,
      knownBytes,
      VAULT_ID,
    );
    expect(known.kind).toBe("journal");
    if (
      known.kind !== "journal" ||
      known.status !== "pending" ||
      known.allocationState !== "allocated"
    ) {
      throw new Error("Expected an allocated pending journal.");
    }
    expect(known.stepEvidence.retryAfterEpochMs).toBe(1_800);
  });

  it("accepts tombstoning the exact live parent with a matching content digest", async () => {
    const { decodeSyncPublication, encodeSyncPublication } = await import(
      "@worker/infrastructure/sync/sync-publication.codec"
    );
    const tombstone = await tombstoneJournal();
    const journal = await tombstoneWriteJournal(
      "live",
      tombstone.request.contentSha256,
    );
    const bytes = await encodeSyncPublication(journal);
    await expect(
      decodeSyncPublication(
        "journal",
        syncOperationKey(VAULT_ID, OPERATION_ID),
        bytes,
        VAULT_ID,
      ),
    ).resolves.toMatchObject({ status: "pending" });
  });

  it("rejects tombstoning a live parent with a mismatched content digest", async () => {
    const { decodeSyncPublication, encodeSyncPublication } = await import(
      "@worker/infrastructure/sync/sync-publication.codec"
    );
    const tombstone = await tombstoneJournal();
    const matching = await tombstoneWriteJournal(
      "live",
      tombstone.request.contentSha256,
    );
    const mismatched = await tombstoneWriteJournal("live", "a".repeat(64));
    expect(tombstone.request.contentSha256).not.toBe("a".repeat(64));
    const validBytes = await encodeSyncPublication(matching);
    const invalidBytes = encoder.encode(
      new TextDecoder()
        .decode(validBytes)
        .replace(
          matching.stepEvidence.precondition.bytes,
          mismatched.stepEvidence.precondition.bytes,
        ),
    );
    await expect(
      decodeSyncPublication(
        "journal",
        syncOperationKey(VAULT_ID, OPERATION_ID),
        invalidBytes,
        VAULT_ID,
      ),
    ).rejects.toThrow();
  });

  it("rejects tombstoning a parent that is already a tombstone", async () => {
    const { decodeSyncPublication, encodeSyncPublication } = await import(
      "@worker/infrastructure/sync/sync-publication.codec"
    );
    const tombstone = await tombstoneJournal();
    const matching = await tombstoneWriteJournal(
      "live",
      tombstone.request.contentSha256,
    );
    const tombstoneParent = await tombstoneWriteJournal(
      "tombstone",
      tombstone.request.contentSha256,
    );
    const validBytes = await encodeSyncPublication(matching);
    const invalidBytes = encoder.encode(
      new TextDecoder()
        .decode(validBytes)
        .replace(
          matching.stepEvidence.precondition.bytes,
          tombstoneParent.stepEvidence.precondition.bytes,
        ),
    );
    await expect(
      decodeSyncPublication(
        "journal",
        syncOperationKey(VAULT_ID, OPERATION_ID),
        invalidBytes,
        VAULT_ID,
      ),
    ).rejects.toThrow();
  });

  it("rejects wrong major, vault, key, operation, and result-revision linkages", async () => {
    const { decodeSyncPublication } = await import(
      "@worker/infrastructure/sync/sync-publication.codec"
    );
    const record = await pendingJournal();
    const key = syncOperationKey(VAULT_ID, OPERATION_ID);
    for (const malformed of [
      { ...record, protocolMajor: 2 },
      { ...record, vaultId: OTHER_VAULT_ID },
      {
        ...record,
        request: { ...record.request, vaultId: OTHER_VAULT_ID },
      },
      {
        ...record,
        request: { ...record.request, operationId: OTHER_OPERATION_ID },
      },
    ]) {
      await expect(
        decodeSyncPublication("journal", key, json(malformed), VAULT_ID),
      ).rejects.toThrow();
    }
    await expect(
      decodeSyncPublication(
        "journal",
        syncOperationKey(VAULT_ID, OTHER_OPERATION_ID),
        json(record),
        VAULT_ID,
      ),
    ).rejects.toThrow();
    const reusedRevision = await updateJournal(null);
    await expect(
      decodeSyncPublication(
        "journal",
        syncOperationKey(VAULT_ID, OPERATION_ID),
        json({
          ...reusedRevision,
          request: { ...reusedRevision.request, revision: OTHER_REVISION },
        }),
        VAULT_ID,
      ),
    ).rejects.toThrow();

    const committed = await pendingJournal();
    const committedRecord = {
      ...committed,
      status: "committed",
      stepEvidence: {
        step: "commit_lane",
        key: syncFeedLaneHeadKey(VAULT_ID, committed.reservation.lane),
        precondition: {
          kind: "observed",
          etag: "original-lane-etag",
          bytes: encodeBase64Url(json(await pendingLaneHead())),
          uploadedAtEpochMs: 100,
        },
        retryAfterEpochMs: null,
        attempt: { state: "ready", generation: 0 },
      },
      position: {
        lane: committed.reservation.lane,
        sequence: committed.reservation.sequence,
      },
      revision: REVISION,
      committedAtEpochMs: 101,
    };
    await expect(
      decodeSyncPublication(
        "journal",
        key,
        json({ ...committedRecord, revision: OTHER_REVISION }),
        VAULT_ID,
      ),
    ).rejects.toThrow();
  });

  it("rejects inconsistent journal identity, payload, step, and saved observation evidence", async () => {
    const { decodeSyncPublication } = await import(
      "@worker/infrastructure/sync/sync-publication.codec"
    );
    const key = syncOperationKey(VAULT_ID, OPERATION_ID);
    const pending = await pendingJournal();
    for (const malformed of [
      { ...pending, operationId: OTHER_OPERATION_ID },
      { ...pending, payload: null },
      {
        ...pending,
        reservation: {
          ...pending.reservation,
          lane: (pending.reservation.lane + 1) % 32,
        },
      },
      {
        ...pending,
        stepEvidence: {
          ...pending.stepEvidence,
          step: "commit_lane",
          key: syncFeedLaneHeadKey(VAULT_ID, pending.reservation.lane),
        },
      },
      {
        ...pending,
        reservation: {
          ...pending.reservation,
          sequence: syncEventSequenceSchema.parse("00000000000000000002"),
        },
      },
      {
        ...pending,
        stepEvidence: { ...pending.stepEvidence, key: "vault/unrelated" },
      },
      {
        ...pending,
        stepEvidence: {
          step: "commit_journal",
          key,
          precondition: { kind: "absent" },
          retryAfterEpochMs: null,
        },
      },
      {
        ...pending,
        stepEvidence: {
          ...pending.stepEvidence,
          precondition: { kind: "journal_phase", status: "pending" },
        },
      },
    ]) {
      await expect(
        decodeSyncPublication("journal", key, json(malformed), VAULT_ID),
      ).rejects.toThrow();
    }

    const update = await updateJournal(null);
    for (const malformed of [
      {
        ...update,
        request: {
          ...update.request,
          parent: { kind: "revision", revision: REVISION },
        },
      },
      {
        ...update,
        stepEvidence: {
          ...update.stepEvidence,
          precondition: { kind: "journal_phase", status: "pending" },
        },
      },
      {
        ...update,
        stepEvidence: {
          ...update.stepEvidence,
          precondition: {
            ...update.stepEvidence.precondition,
            bytes: "not-base64url!",
          },
        },
      },
      {
        ...update,
        stepEvidence: {
          ...update.stepEvidence,
          precondition: {
            ...update.stepEvidence.precondition,
            bytes: encodeBase64Url(new Uint8Array([0xff])),
          },
        },
      },
      {
        ...update,
        stepEvidence: {
          ...update.stepEvidence,
          precondition: {
            ...update.stepEvidence.precondition,
            bytes: encodeBase64Url(encoder.encode("{")),
          },
        },
      },
      {
        ...update,
        stepEvidence: {
          ...update.stepEvidence,
          precondition: {
            ...update.stepEvidence.precondition,
            etag: "é".repeat(600),
          },
        },
      },
      {
        ...update,
        stepEvidence: {
          ...update.stepEvidence,
          retryAfterEpochMs: 699,
        },
      },
    ]) {
      await expect(
        decodeSyncPublication("journal", key, json(malformed), VAULT_ID),
      ).rejects.toThrow();
    }

    await expect(
      decodeSyncPublication(
        "journal",
        key,
        json({
          ...update,
          stepEvidence: {
            ...update.stepEvidence,
            step: "create_event",
            key: syncFeedEventKey(
              VAULT_ID,
              update.reservation.lane,
              update.reservation.sequence,
            ),
          },
        }),
        VAULT_ID,
      ),
    ).rejects.toThrow();
    await expect(
      decodeSyncPublication(
        "journal",
        key,
        json({
          ...update,
          stepEvidence: {
            ...update.stepEvidence,
            precondition: { kind: "absent" },
            retryAfterEpochMs: null,
          },
        }),
        VAULT_ID,
      ),
    ).rejects.toThrow();

    const settledSource = await pendingJournal();
    const committedWithoutEvidence = {
      ...settledSource,
      status: "committed",
      stepEvidence: {
        step: "commit_lane",
        key: syncFeedLaneHeadKey(VAULT_ID, settledSource.reservation.lane),
        precondition: { kind: "absent" },
        retryAfterEpochMs: null,
      },
      position: {
        lane: settledSource.reservation.lane,
        sequence: settledSource.reservation.sequence,
      },
      revision: REVISION,
      committedAtEpochMs: 1,
    } as const;
    await expect(
      decodeSyncPublication(
        "journal",
        key,
        json(committedWithoutEvidence),
        VAULT_ID,
      ),
    ).rejects.toThrow();
  });

  it("rejects unknown journal and nested request authority fields", async () => {
    const { decodeSyncPublication } = await import(
      "@worker/infrastructure/sync/sync-publication.codec"
    );
    const record = await pendingJournal();
    for (const malformed of [
      { ...record, injected: true },
      { ...record, request: { ...record.request, injected: true } },
      {
        ...record,
        stepEvidence: { ...record.stepEvidence, refreshedEtag: "unsafe" },
      },
    ]) {
      await expect(
        decodeSyncPublication(
          "journal",
          syncOperationKey(VAULT_ID, OPERATION_ID),
          json(malformed),
          VAULT_ID,
        ),
      ).rejects.toThrow();
    }
  });

  it("checks exact payload hash, UTF-8 byte size, and the one-megabyte limit", async () => {
    const { decodeSyncPublication, encodeSyncPublication } = await import(
      "@worker/infrastructure/sync/sync-publication.codec"
    );
    const record = await pendingJournal();
    const key = syncOperationKey(VAULT_ID, OPERATION_ID);
    await expect(
      decodeSyncPublication(
        "journal",
        key,
        json({ ...record, payload: { byteSize: 1 } }),
        VAULT_ID,
      ),
    ).rejects.toThrow();
    await expect(
      decodeSyncPublication(
        "journal",
        key,
        json({
          ...record,
          request: { ...record.request, contentSha256: "0".repeat(64) },
        }),
        VAULT_ID,
      ),
    ).rejects.toThrow();
    await expect(
      encodeSyncPublication({
        ...record,
        request: {
          ...record.request,
          content: "x".repeat(1_048_577),
        },
      }),
    ).rejects.toThrow();

    const maximumPayload = await pendingJournal("\u0000".repeat(1_048_576));
    const maximumBytes = await encodeSyncPublication(maximumPayload);
    expect(maximumBytes.byteLength).toBeLessThan(8 * 1_048_576);
    await expect(
      decodeSyncPublication("journal", key, maximumBytes, VAULT_ID),
    ).resolves.toMatchObject({ payload: { byteSize: 1_048_576 } });
  });

  it("requires a closed outcome intent and fixed time for each event step", async () => {
    const journal = await pendingJournal();
    const event = await changedEvent();
    const eventStep = {
      ...journal,
      stepEvidence: {
        step: "create_event",
        key: syncFeedEventKey(VAULT_ID, event.lane, event.sequence),
        committedAtEpochMs: event.committedAtEpochMs,
        outcomeIntent: "changed",
        precondition: { kind: "absent" },
        retryAfterEpochMs: null,
        attempt: { state: "ready", generation: 0 },
      },
    };
    expect(syncJournalRecordSchema.safeParse(eventStep).success).toBe(true);
    expect(
      syncJournalRecordSchema.safeParse({
        ...eventStep,
        stepEvidence: {
          ...eventStep.stepEvidence,
          outcomeIntent: "not-an-event-kind",
        },
      }).success,
    ).toBe(false);
    const { outcomeIntent: _outcomeIntent, ...missingIntentEvidence } =
      eventStep.stepEvidence;
    expect(
      syncJournalRecordSchema.safeParse({
        ...eventStep,
        stepEvidence: missingIntentEvidence,
      }).success,
    ).toBe(false);
  });

  it("encodes live and tombstone immutable targets plus each publication family", async () => {
    const { encodeSyncPublication } = await import(
      "@worker/infrastructure/sync/sync-publication.codec"
    );
    const live = await pendingJournal();
    for (const key of [
      syncVersionKey(VAULT_ID, REVISION),
      syncContentKey(VAULT_ID, REVISION),
    ]) {
      await expect(
        encodeSyncPublication({
          ...live,
          stepEvidence: {
            step: "immutable_create",
            key,
            precondition: { kind: "absent" },
            retryAfterEpochMs: null,
            attempt: { state: "ready", generation: 0 },
          },
        }),
      ).resolves.toBeInstanceOf(Uint8Array);
    }
    await expect(
      encodeSyncPublication({
        ...live,
        stepEvidence: {
          step: "write_head",
          key: syncHeadKey(VAULT_ID, PATH),
          precondition: { kind: "absent" },
          retryAfterEpochMs: null,
          attempt: { state: "ready", generation: 0 },
        },
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
    const event = await changedEvent();
    await expect(
      encodeSyncPublication({
        ...live,
        stepEvidence: {
          step: "create_event",
          key: syncFeedEventKey(VAULT_ID, event.lane, event.sequence),
          committedAtEpochMs: event.committedAtEpochMs,
          outcomeIntent: "changed",
          precondition: { kind: "absent" },
          retryAfterEpochMs: null,
          attempt: { state: "ready", generation: 0 },
        },
      }),
    ).resolves.toBeInstanceOf(Uint8Array);

    const tombstone = await tombstoneJournal();
    for (const key of [
      syncVersionKey(VAULT_ID, REVISION),
      syncRecoveryKey(VAULT_ID, OPERATION_ID, "metadata"),
      syncRecoveryKey(VAULT_ID, OPERATION_ID, "content"),
    ]) {
      await expect(
        encodeSyncPublication({
          ...tombstone,
          stepEvidence: {
            step: "immutable_create",
            key,
            precondition: { kind: "absent" },
            retryAfterEpochMs: null,
            attempt: { state: "ready", generation: 0 },
          },
        }),
      ).resolves.toBeInstanceOf(Uint8Array);
    }
    const pendingLane = await pendingLaneHead();
    await expect(encodeSyncPublication(pendingLane)).resolves.toBeInstanceOf(
      Uint8Array,
    );
    const initialLane = await unreservedLaneHead();
    const unallocated = await unallocatedJournal({
      kind: "observed",
      head: initialLane,
      etag: "initial-lane-etag",
      uploadedAtEpochMs: 800,
    });
    await expect(encodeSyncPublication(unallocated)).resolves.toBeInstanceOf(
      Uint8Array,
    );
    await expect(encodeSyncPublication(event)).resolves.toBeInstanceOf(
      Uint8Array,
    );
  });

  it("requires a lane reservation to be exactly the next non-overflowing sequence", async () => {
    const { decodeSyncPublication } = await import(
      "@worker/infrastructure/sync/sync-publication.codec"
    );
    const head = await pendingLaneHead();
    const lane = head.lane;
    await expect(
      decodeSyncPublication(
        "laneHead",
        syncFeedLaneHeadKey(VAULT_ID, lane),
        json(head),
        VAULT_ID,
      ),
    ).resolves.toEqual(head);
    await expect(
      decodeSyncPublication(
        "laneHead",
        syncFeedLaneHeadKey(VAULT_ID, lane),
        json({ ...head, committedAtEpochMs: 1 }),
        VAULT_ID,
      ),
    ).rejects.toThrow();
    await expect(
      decodeSyncPublication(
        "laneHead",
        syncFeedLaneHeadKey(VAULT_ID, lane),
        json({
          ...head,
          pending: {
            operationId: OPERATION_ID,
            nextSequence: "00000000000000000002",
          },
        }),
        VAULT_ID,
      ),
    ).rejects.toThrow();

    const maxSequence = "99999999999999999999";
    const exhausted = {
      ...head,
      committedSequence: maxSequence,
      committedAtEpochMs: 100,
      pending: {
        operationId: OPERATION_ID,
        nextSequence: "00000000000000000001",
      },
    };
    await expect(
      decodeSyncPublication(
        "laneHead",
        syncFeedLaneHeadKey(VAULT_ID, lane),
        json(exhausted),
        VAULT_ID,
      ),
    ).rejects.toThrow();
    const terminal = {
      ...head,
      committedSequence: maxSequence,
      committedAtEpochMs: 100,
      pending: undefined,
    };
    await expect(
      decodeSyncPublication(
        "laneHead",
        syncFeedLaneHeadKey(VAULT_ID, lane),
        json(terminal),
        VAULT_ID,
      ),
    ).resolves.toMatchObject({ committedSequence: maxSequence });
  });

  it("round-trips tombstone and aborted journals with exact non-payload evidence", async () => {
    const { decodeSyncPublication, encodeSyncPublication } = await import(
      "@worker/infrastructure/sync/sync-publication.codec"
    );
    const key = syncOperationKey(VAULT_ID, OPERATION_ID);
    const tombstone = await tombstoneJournal();
    const tombstoneBytes = await encodeSyncPublication(tombstone);
    await expect(
      decodeSyncPublication("journal", key, tombstoneBytes, VAULT_ID),
    ).resolves.toEqual(tombstone);
    await expect(
      decodeSyncPublication(
        "journal",
        key,
        json({ ...tombstone, payload: { byteSize: 0 } }),
        VAULT_ID,
      ),
    ).rejects.toThrow();

    const pending = await pendingJournal();
    const lane = await pendingLaneHead();
    const aborted = {
      ...pending,
      status: "aborted",
      stepEvidence: {
        step: "commit_lane",
        key: syncFeedLaneHeadKey(VAULT_ID, lane.lane),
        precondition: {
          kind: "observed",
          etag: "reserved-lane-etag",
          bytes: encodeBase64Url(json(lane)),
          uploadedAtEpochMs: 800,
        },
        retryAfterEpochMs: null,
        attempt: { state: "ready", generation: 0 },
      },
      position: {
        lane: pending.reservation.lane,
        sequence: pending.reservation.sequence,
      },
      reason: "stale_revision",
      committedAtEpochMs: 101,
    } as const;
    await expect(
      decodeSyncPublication(
        "journal",
        key,
        await encodeSyncPublication(aborted),
        VAULT_ID,
      ),
    ).resolves.toEqual(aborted);
    await expect(
      decodeSyncPublication(
        "journal",
        key,
        json({ ...aborted, committedAtEpochMs: 0 }),
        VAULT_ID,
      ),
    ).rejects.toThrow();
    await expect(
      decodeSyncPublication(
        "journal",
        key,
        json({
          ...aborted,
          position: { ...aborted.position, sequence: "00000000000000000002" },
        }),
        VAULT_ID,
      ),
    ).rejects.toThrow();
    await expect(
      decodeSyncPublication(
        "journal",
        key,
        json({
          ...aborted,
          stepEvidence: { ...aborted.stepEvidence, step: "reserve_lane" },
        }),
        VAULT_ID,
      ),
    ).rejects.toThrow();
  });

  it("rejects committed journal timestamps that do not advance their lane clock", async () => {
    const { decodeSyncPublication } = await import(
      "@worker/infrastructure/sync/sync-publication.codec"
    );
    const pending = await pendingJournal();
    const previousTime = 900;
    const record = {
      ...pending,
      reservation: {
        ...pending.reservation,
        previousCommittedAtEpochMs: previousTime,
      },
      status: "committed",
      stepEvidence: {
        step: "commit_lane",
        key: syncFeedLaneHeadKey(VAULT_ID, pending.reservation.lane),
        precondition: {
          kind: "observed",
          etag: "original-lane-etag",
          bytes: encodeBase64Url(json(await pendingLaneHead())),
          uploadedAtEpochMs: 950,
        },
        retryAfterEpochMs: null,
        attempt: { state: "ready", generation: 0 },
      },
      position: {
        lane: pending.reservation.lane,
        sequence: pending.reservation.sequence,
      },
      revision: REVISION,
      committedAtEpochMs: previousTime,
    };
    await expect(
      decodeSyncPublication(
        "journal",
        syncOperationKey(VAULT_ID, OPERATION_ID),
        json(record),
        VAULT_ID,
      ),
    ).rejects.toThrow();
  });

  it("decodes changed and aborted events as disjoint immutable unions", async () => {
    const { decodeSyncPublication } = await import(
      "@worker/infrastructure/sync/sync-publication.codec"
    );
    const changed = await changedEvent();
    const changedKey = syncFeedEventKey(
      VAULT_ID,
      changed.lane,
      changed.sequence,
    );
    await expect(
      decodeSyncPublication("feedEvent", changedKey, json(changed), VAULT_ID),
    ).resolves.toEqual(changed);
    await expect(
      decodeSyncPublication(
        "feedEvent",
        changedKey,
        json({
          ...changed,
          result: { kind: "live", revision: "not-a-revision" },
        }),
        VAULT_ID,
      ),
    ).rejects.toThrow();
    await expect(
      decodeSyncPublication(
        "feedEvent",
        changedKey,
        json({ ...changed, lane: (changed.lane + 1) % 32 }),
        VAULT_ID,
      ),
    ).rejects.toThrow();

    const aborted = {
      schemaVersion: 1,
      protocolMajor: 1,
      vaultId: VAULT_ID,
      kind: "aborted",
      lane: changed.lane,
      sequence: syncEventSequenceSchema.parse("00000000000000000002"),
      operationId: OTHER_OPERATION_ID,
      reason: "stale_revision",
      committedAtEpochMs: 102,
    };
    await expect(
      decodeSyncPublication(
        "feedEvent",
        syncFeedEventKey(VAULT_ID, aborted.lane, aborted.sequence),
        json(aborted),
        VAULT_ID,
      ),
    ).resolves.toEqual(aborted);
    await expect(
      decodeSyncPublication(
        "feedEvent",
        syncFeedEventKey(VAULT_ID, aborted.lane, aborted.sequence),
        json({ ...aborted, revision: REVISION }),
        VAULT_ID,
      ),
    ).rejects.toThrow();
  });

  it("never decodes publication records or head/list keys from a v2 prefix", async () => {
    const { decodeSyncPublication } = await import(
      "@worker/infrastructure/sync/sync-publication.codec"
    );
    const record = await pendingJournal();
    const event = await changedEvent();
    const v2Keys = [`vault/${PATH}`, `recovery/${OPERATION_ID}`, "vault/"];
    for (const key of v2Keys) {
      await expect(
        decodeSyncPublication("journal", key, json(record), VAULT_ID),
      ).rejects.toThrow();
      await expect(
        decodeSyncPublication(
          "laneHead",
          key,
          json(await pendingLaneHead()),
          VAULT_ID,
        ),
      ).rejects.toThrow();
      await expect(
        decodeSyncPublication("feedEvent", key, json(event), VAULT_ID),
      ).rejects.toThrow();
    }
    await expect(
      decodeSyncPublication(
        "feedEvent",
        syncFeedEventKey(VAULT_ID, event.lane, event.sequence),
        json(event),
        OTHER_VAULT_ID,
      ),
    ).rejects.toThrow();
  });
});
