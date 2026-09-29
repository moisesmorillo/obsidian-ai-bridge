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
 * @returns Strict pending journal fixture with independently computed byte evidence.
 */
async function pendingJournal(content = CONTENT) {
  const lane = await syncFeedLaneForPath(PATH);
  const contentBytes = encoder.encode(content);
  return {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId: VAULT_ID,
    kind: "journal",
    status: "pending",
    operationId: OPERATION_ID,
    request: {
      kind: "create",
      vaultId: VAULT_ID,
      path: PATH,
      operationId: OPERATION_ID,
      revision: REVISION,
      parent: { kind: "never_seen" },
      contentSha256: await sha256(contentBytes),
      content,
      mediaType: "text/markdown",
      origin: ORIGIN,
    },
    payload: { byteSize: contentBytes.byteLength },
    reservation: {
      lane,
      sequence: syncEventSequenceSchema.parse("00000000000000000001"),
      previousCommittedAtEpochMs: 0,
    },
    stepEvidence: {
      step: "reserve_lane",
      key: syncFeedLaneHeadKey(VAULT_ID, lane),
      precondition: { kind: "absent" },
      retryAfterEpochMs: null,
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
    schemaVersion: 1,
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
    },
  } as const;
}

/** Builds a tombstone journal retaining its exact parent digest and no request body.
 * @returns Strict pending tombstone fixture for immutable recovery metadata creation.
 */
async function tombstoneJournal() {
  const lane = await syncFeedLaneForPath(PATH);
  return {
    schemaVersion: 1,
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
    if (priorRead.kind !== "journal") throw new Error("Expected a journal.");
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
    if (recovered.kind !== "journal") throw new Error("Expected a journal.");
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
    const known = await decodeSyncPublication(
      "journal",
      key,
      knownBytes,
      VAULT_ID,
    );
    expect(known.kind).toBe("journal");
    if (known.kind !== "journal") throw new Error("Expected a journal.");
    expect(known.stepEvidence.retryAfterEpochMs).toBe(1_800);
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
          precondition: { kind: "absent" },
          retryAfterEpochMs: null,
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
          },
        }),
      ).resolves.toBeInstanceOf(Uint8Array);
    }
    const pendingLane = await pendingLaneHead();
    await expect(encodeSyncPublication(pendingLane)).resolves.toBeInstanceOf(
      Uint8Array,
    );
    const initialLane = { ...pendingLane, pending: undefined };
    await expect(
      encodeSyncPublication({
        ...live,
        stepEvidence: {
          step: "reserve_lane",
          key: syncFeedLaneHeadKey(VAULT_ID, pendingLane.lane),
          precondition: {
            kind: "observed",
            etag: "initial-lane-etag",
            bytes: encodeBase64Url(json(initialLane)),
            uploadedAtEpochMs: 800,
          },
          retryAfterEpochMs: null,
        },
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
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
