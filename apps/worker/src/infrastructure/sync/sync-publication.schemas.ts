import type {
  SyncAbortedChangeReason,
  SyncMutationRequest,
} from "@core/sync/sync-store.types";
import {
  createContentSha256,
  decodeBase64Url,
  decodeUtf8,
  encodeBase64Url,
} from "@obsidian-ai-bridge/core";
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
  SYNC_FEED_LANE_COUNT,
  SYNC_MAX_SEQUENCE,
  SYNC_SEQUENCE_WIDTH,
} from "@protocol/sync.constants";
import {
  syncDeviceIdSchema,
  syncEventSequenceSchema,
  syncNotePathSchema,
  syncOperationIdSchema,
  syncRevisionSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type {
  SyncEventSequenceDto,
  SyncSequenceDto,
  SyncVaultIdDto,
} from "@protocol/sync.types";
import type {
  SyncJournalRecord,
  SyncPublicationRecord,
  SyncPublicationStepEvidence,
} from "@worker/infrastructure/sync/sync-publication.types";
import { isCanonicalSyncR2Key } from "@worker/infrastructure/sync/sync-r2-key";
import { syncHeadRecordSchema } from "@worker/infrastructure/sync/sync-record.schemas";
import { z } from "zod";

/** Single source of bounds for durable M7.4 publication records and their private payload evidence. */
export const SYNC_PUBLICATION_LIMITS = {
  payloadBytes: 1_048_576,
  journalBytes: 8 * 1_048_576,
  metadataBytes: 2_048,
  preconditionBytes: 2_048,
  etagBytes: 1_024,
} as const;

/** Lower-case SHA-256 digest type accepted for exact immutable request bytes. */
const sha256Schema = z.custom<SyncMutationRequest["contentSha256"]>(
  (value) =>
    typeof value === "string" && createContentSha256(value) !== undefined,
);
/** Safe Unix epoch-millisecond timestamps persisted as R2 evidence. */
const epochMillisecondsSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
/** Validates a lane index under the fixed protocol-v1 feed partition count. */
const laneSchema = z
  .number()
  .int()
  .min(0)
  .max(SYNC_FEED_LANE_COUNT - 1);
/** Largest canonical base64url character count for one bounded prior record body. */
const MAX_PRECONDITION_BASE64URL_CHARACTERS = Math.ceil(
  (SYNC_PUBLICATION_LIMITS.preconditionBytes * 4) / 3,
);
/** First event sequence assigned to an empty M7.4 feed lane. */
const FIRST_SYNC_EVENT_SEQUENCE: SyncEventSequenceDto =
  syncEventSequenceSchema.parse("00000000000000000001");
/** Exact common envelope for every private journal, lane-head, and feed event. */
const envelopeShape = {
  schemaVersion: z.literal(1),
  protocolMajor: z.literal(1),
  vaultId: syncVaultIdSchema,
};
/** Exact normalized request accepted by the storage-independent SyncStore port. */
const mutationRequestSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("create"),
        vaultId: syncVaultIdSchema,
        path: syncNotePathSchema,
        operationId: syncOperationIdSchema,
        revision: syncRevisionSchema,
        parent: z.object({ kind: z.literal("never_seen") }).strict(),
        contentSha256: sha256Schema,
        content: z.string().max(SYNC_PUBLICATION_LIMITS.payloadBytes),
        mediaType: z.literal("text/markdown"),
        origin: syncDeviceIdSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("update"),
        vaultId: syncVaultIdSchema,
        path: syncNotePathSchema,
        operationId: syncOperationIdSchema,
        revision: syncRevisionSchema,
        parent: z
          .object({ kind: z.literal("revision"), revision: syncRevisionSchema })
          .strict(),
        contentSha256: sha256Schema,
        content: z.string().max(SYNC_PUBLICATION_LIMITS.payloadBytes),
        mediaType: z.literal("text/markdown"),
        origin: syncDeviceIdSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("tombstone"),
        vaultId: syncVaultIdSchema,
        path: syncNotePathSchema,
        operationId: syncOperationIdSchema,
        revision: syncRevisionSchema,
        parent: z
          .object({ kind: z.literal("revision"), revision: syncRevisionSchema })
          .strict(),
        contentSha256: sha256Schema,
        origin: syncDeviceIdSchema,
      })
      .strict(),
  ])
  .superRefine((request, context) => {
    if (
      request.kind !== "create" &&
      request.revision === request.parent.revision
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A mutation target revision must differ from its exact parent.",
      });
    }
  });
/** Captured R2 absence or exact prior mutable generation for one pending write. */
const publicationPreconditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict(),
  z
    .object({
      kind: z.literal("observed"),
      etag: z.string().min(1).max(SYNC_PUBLICATION_LIMITS.etagBytes),
      bytes: z.string().min(1).max(MAX_PRECONDITION_BASE64URL_CHARACTERS),
      uploadedAtEpochMs: epochMillisecondsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("journal_phase"),
      status: z.literal("pending"),
    })
    .strict(),
]);
/** Closed step name selecting one deterministic key and its persisted exact precondition. */
const publicationStepSchema = z.enum([
  "reserve_lane",
  "immutable_create",
  "write_head",
  "create_event",
  "commit_journal",
  "commit_lane",
]);
/** Durable, single-step precondition and known cooldown evidence. */
const publicationStepEvidenceSchema = z
  .object({
    step: publicationStepSchema,
    key: z.string().min(1),
    precondition: publicationPreconditionSchema,
    retryAfterEpochMs: epochMillisecondsSchema.nullable(),
  })
  .strict();
/** Exact lane allocation, retaining the predecessor clock for monotonic publication. */
const laneReservationSchema = z
  .object({
    lane: laneSchema,
    sequence: syncEventSequenceSchema,
    previousCommittedAtEpochMs: epochMillisecondsSchema,
  })
  .strict();
/** Stored byte count for a live request payload, absent for tombstone requests. */
const payloadEvidenceSchema = z
  .object({
    byteSize: z.number().int().min(0).max(SYNC_PUBLICATION_LIMITS.payloadBytes),
  })
  .strict();
/** Feed position shared by committed and safely aborted operation journals. */
const positionSchema = z
  .object({
    lane: laneSchema,
    sequence: syncEventSequenceSchema,
  })
  .strict();
/** Identity and immutable request shared by all operation journal states. */
const journalBaseShape = {
  ...envelopeShape,
  kind: z.literal("journal"),
  operationId: syncOperationIdSchema,
  request: mutationRequestSchema,
  payload: payloadEvidenceSchema.nullable(),
  reservation: laneReservationSchema,
  stepEvidence: publicationStepEvidenceSchema,
};
/** Strict pending, committed, or aborted journal with request, sequence and time linkage checks. */
export const syncJournalRecordSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        ...journalBaseShape,
        status: z.literal("pending"),
      })
      .strict(),
    z
      .object({
        ...journalBaseShape,
        status: z.literal("committed"),
        position: positionSchema,
        revision: syncRevisionSchema,
        committedAtEpochMs: epochMillisecondsSchema,
      })
      .strict(),
    z
      .object({
        ...journalBaseShape,
        status: z.literal("aborted"),
        position: positionSchema,
        reason: z.literal("stale_revision" satisfies SyncAbortedChangeReason),
        committedAtEpochMs: epochMillisecondsSchema,
      })
      .strict(),
  ])
  .superRefine((journal, context) => {
    if (
      journal.vaultId !== journal.request.vaultId ||
      journal.operationId !== journal.request.operationId
    ) {
      context.addIssue({
        code: "custom",
        message: "Journal identity must exactly match its immutable request.",
      });
    }
    const liveRequest =
      journal.request.kind === "create" || journal.request.kind === "update";
    if (liveRequest !== (journal.payload !== null)) {
      context.addIssue({
        code: "custom",
        message: "Only live requests carry exact payload size evidence.",
      });
    }
    if (
      journal.status !== "pending" &&
      (journal.position.lane !== journal.reservation.lane ||
        journal.position.sequence !== journal.reservation.sequence)
    ) {
      context.addIssue({
        code: "custom",
        message: "Settled journal position must equal its lane reservation.",
      });
    }
    if (
      journal.status === "committed" &&
      (journal.revision !== journal.request.revision ||
        journal.committedAtEpochMs <=
          journal.reservation.previousCommittedAtEpochMs)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Committed revision must match its request and advance the lane clock.",
      });
    }
    if (
      journal.status === "aborted" &&
      journal.committedAtEpochMs <=
        journal.reservation.previousCommittedAtEpochMs
    ) {
      context.addIssue({
        code: "custom",
        message: "Aborted event time must advance the lane clock.",
      });
    }
    if (
      journal.status === "pending" &&
      journal.stepEvidence.step === "commit_lane"
    ) {
      context.addIssue({
        code: "custom",
        message: "Lane commit can start only after journal settlement.",
      });
    }
    if (
      journal.status !== "pending" &&
      journal.stepEvidence.step !== "commit_lane"
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A settled journal must retain its final lane-commit evidence.",
      });
    }
  });
/** Exact 20-digit sequence increment, refusing to wrap the protocol maximum.
 * @param current - Current fixed-width committed lane sequence.
 * @returns Its exact non-zero successor, or undefined at protocol exhaustion.
 */
function nextEventSequence(
  current: SyncSequenceDto,
): SyncEventSequenceDto | undefined {
  if (current === SYNC_MAX_SEQUENCE) return undefined;
  const next = (BigInt(current) + 1n)
    .toString()
    .padStart(SYNC_SEQUENCE_WIDTH, "0");
  const parsed = syncEventSequenceSchema.safeParse(next);
  return parsed.success ? parsed.data : undefined;
}
/** Strict lane clock whose pending reservation is exactly one non-overflowing next position. */
export const syncLaneHeadRecordSchema = z
  .object({
    ...envelopeShape,
    kind: z.literal("laneHead"),
    lane: laneSchema,
    committedSequence: syncSequenceSchema,
    committedAtEpochMs: epochMillisecondsSchema,
    pending: z
      .object({
        operationId: syncOperationIdSchema,
        nextSequence: syncEventSequenceSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((head, context) => {
    const isInitial =
      head.committedSequence === "0".repeat(SYNC_SEQUENCE_WIDTH);
    if (isInitial !== (head.committedAtEpochMs === 0)) {
      context.addIssue({
        code: "custom",
        message:
          "Only an initial zero-sequence lane head has a zero commit time.",
      });
    }
    if (head.pending !== undefined) {
      const next = nextEventSequence(head.committedSequence);
      if (next === undefined || head.pending.nextSequence !== next) {
        context.addIssue({
          code: "custom",
          message:
            "Pending reservation must be the exact next non-overflowing sequence.",
        });
      }
    }
  });
/** Strict metadata-only changed/aborted event union with bounded server time. */
export const syncFeedEventRecordSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...envelopeShape,
      kind: z.literal("changed"),
      lane: laneSchema,
      sequence: syncEventSequenceSchema,
      path: syncNotePathSchema,
      result: z.discriminatedUnion("kind", [
        z
          .object({ kind: z.literal("live"), revision: syncRevisionSchema })
          .strict(),
        z
          .object({
            kind: z.literal("tombstone"),
            revision: syncRevisionSchema,
          })
          .strict(),
      ]),
      operationId: syncOperationIdSchema,
      origin: syncDeviceIdSchema,
      committedAtEpochMs: epochMillisecondsSchema.min(1),
    })
    .strict(),
  z
    .object({
      ...envelopeShape,
      kind: z.literal("aborted"),
      lane: laneSchema,
      sequence: syncEventSequenceSchema,
      operationId: syncOperationIdSchema,
      reason: z.literal("stale_revision" satisfies SyncAbortedChangeReason),
      committedAtEpochMs: epochMillisecondsSchema.min(1),
    })
    .strict(),
]);

/** Confirms private publication identity, payload, feed-lane and in-flight precondition evidence.
 * @param record - Strictly schema-parsed publication record to recheck.
 * @param expectedVaultId - Vault namespace expected by the caller.
 * @returns Resolves only when payload and authority evidence remain consistent.
 */
export async function assertSyncPublicationRecord(
  record: SyncPublicationRecord,
  expectedVaultId: SyncVaultIdDto,
): Promise<void> {
  if (record.vaultId !== expectedVaultId) {
    throw new TypeError("Publication record belongs to another vault.");
  }
  if (record.kind === "journal") {
    await assertJournalRecord(record);
    return;
  }
  if (record.kind === "laneHead") {
    return;
  }
  if (record.kind === "changed") {
    const lane = await syncFeedLaneForPath(record.path);
    if (record.lane !== lane) {
      throw new TypeError(
        "Changed event lane does not match its canonical path.",
      );
    }
  }
}

/** Validates request payload bytes and exact canonical key/precondition evidence in one journal.
 * @param journal - Strictly parsed durable request and current-step evidence.
 * @returns Resolves only when path lane, exact payload, and saved precondition agree.
 */
async function assertJournalRecord(journal: SyncJournalRecord): Promise<void> {
  const request = journal.request;
  const lane = await syncFeedLaneForPath(request.path);
  if (journal.reservation.lane !== lane) {
    throw new TypeError(
      "Journal lane does not match its normalized request path.",
    );
  }
  if (request.kind === "create" || request.kind === "update") {
    const bytes = new TextEncoder().encode(request.content);
    if (
      bytes.byteLength > SYNC_PUBLICATION_LIMITS.payloadBytes ||
      journal.payload?.byteSize !== bytes.byteLength ||
      (await sha256Hex(bytes)) !== request.contentSha256
    ) {
      throw new TypeError(
        "Journal payload size or digest does not match exact request bytes.",
      );
    }
  } else if (journal.payload !== null) {
    throw new TypeError(
      "Tombstone journals cannot contain a mutation payload.",
    );
  }
  assertStepEvidence(journal);
}

/** Checks a journal step's canonical target and its immutable original precondition.
 * @param journal - Pending or settled journal carrying the exact current step evidence.
 * @returns No value; throws when the key, step, or precondition is inconsistent.
 */
function assertStepEvidence(journal: SyncJournalRecord): void {
  const evidence = journal.stepEvidence;
  const key = expectedStepKey(journal, evidence.step, evidence.key);
  if (key === undefined || key !== evidence.key) {
    throw new TypeError(
      "Journal step key is not its exact canonical protocol-v1 target.",
    );
  }
  const precondition = evidence.precondition;
  if (evidence.step === "commit_journal") {
    if (
      precondition.kind !== "journal_phase" ||
      precondition.status !== "pending"
    ) {
      throw new TypeError(
        "Journal CAS requires the exact typed pending phase, not an embedded ETag.",
      );
    }
    return;
  }
  if (precondition.kind === "journal_phase") {
    throw new TypeError(
      "Only a journal transition may use its typed prior phase.",
    );
  }
  if (precondition.kind === "observed") {
    assertBoundedEtag(precondition.etag);
    if (
      evidence.retryAfterEpochMs !== null &&
      evidence.retryAfterEpochMs < precondition.uploadedAtEpochMs
    ) {
      throw new TypeError(
        "Persisted retry floor cannot precede the observed R2 cooldown.",
      );
    }
    const bytes = decodeBase64Url(precondition.bytes);
    if (
      bytes === undefined ||
      encodeBase64Url(bytes) !== precondition.bytes ||
      bytes.byteLength > SYNC_PUBLICATION_LIMITS.preconditionBytes ||
      decodeUtf8(bytes) === undefined
    ) {
      throw new TypeError(
        "Journal precondition bytes are not exact bounded UTF-8 evidence.",
      );
    }
    assertObservedPrecondition(journal, evidence.step, evidence.key, bytes);
    return;
  }
  if (
    evidence.step === "reserve_lane" ||
    evidence.step === "commit_lane" ||
    evidence.step === "write_head"
  ) {
    assertAbsentPreconditionAllowed(journal, evidence.step);
    if (
      evidence.step === "reserve_lane" &&
      (journal.reservation.sequence !== FIRST_SYNC_EVENT_SEQUENCE ||
        journal.reservation.previousCommittedAtEpochMs !== 0)
    ) {
      throw new TypeError(
        "An absent lane starts at sequence one and commit time zero.",
      );
    }
    return;
  }
  if (precondition.kind !== "absent") {
    throw new TypeError(
      "Create-only publication steps require proven absence evidence.",
    );
  }
}

/** Validates the body linked to a prior R2 observation without refreshing its ETag.
 * @param journal - Immutable request and reservation that authorized this target.
 * @param step - Exact publication transition expecting the observation.
 * @param key - Canonical key whose exact prior bytes were retained.
 * @param bytes - Original observed JSON bytes, before any attempted write.
 * @returns No value; throws when the observation cannot prove its exact precondition.
 */
function assertObservedPrecondition(
  journal: SyncJournalRecord,
  step: SyncPublicationStepEvidence["step"],
  key: string,
  bytes: Uint8Array,
): void {
  const text = decodeUtf8(bytes);
  if (text === undefined)
    throw new TypeError("Observed precondition is not valid UTF-8.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError("Observed precondition is not valid JSON evidence.");
  }
  if (step === "reserve_lane" || step === "commit_lane") {
    const prior = syncLaneHeadRecordSchema.parse(parsed);
    if (
      prior.vaultId !== journal.vaultId ||
      prior.lane !== journal.reservation.lane ||
      prior.committedSequence !==
        previousSequence(journal.reservation.sequence) ||
      prior.committedAtEpochMs !==
        journal.reservation.previousCommittedAtEpochMs
    ) {
      throw new TypeError(
        "Lane-head precondition disagrees with its reserved successor.",
      );
    }
    if (step === "reserve_lane" && prior.pending !== undefined) {
      throw new TypeError(
        "A new lane reservation cannot replace an existing pending operation.",
      );
    }
    if (
      step === "commit_lane" &&
      (prior.pending === undefined ||
        prior.pending.operationId !== journal.operationId ||
        prior.pending.nextSequence !== journal.reservation.sequence)
    ) {
      throw new TypeError(
        "Lane commit precondition is not this operation's reservation.",
      );
    }
    if (JSON.stringify(prior) !== text) {
      throw new TypeError("Lane-head precondition bytes are not canonical.");
    }
    return;
  }
  if (step === "write_head") {
    const prior = syncHeadRecordSchema.parse(parsed);
    if (
      prior.vaultId !== journal.vaultId ||
      prior.path !== journal.request.path ||
      journal.request.parent.kind !== "revision" ||
      prior.revision !== journal.request.parent.revision ||
      key !== syncHeadKey(journal.vaultId, journal.request.path) ||
      JSON.stringify(prior) !== text
    ) {
      throw new TypeError(
        "Head precondition does not match the request's exact parent.",
      );
    }
    return;
  }
  throw new TypeError(
    "This publication step cannot use an observed precondition.",
  );
}

/** Restricts an absent observation to create-only or first lane-reservation steps.
 * @param journal - Immutable request whose mutation kind constrains create versus CAS.
 * @param step - Publication step whose target was exactly observed absent.
 * @returns No value; throws when absence cannot authorize this step.
 */
function assertAbsentPreconditionAllowed(
  journal: SyncJournalRecord,
  step: SyncPublicationStepEvidence["step"],
): void {
  if (step === "write_head" && journal.request.kind !== "create") {
    throw new TypeError(
      "Conditional head replacement requires its original observed ETag.",
    );
  }
  if (
    step !== "reserve_lane" &&
    step !== "write_head" &&
    step !== "immutable_create" &&
    step !== "create_event"
  ) {
    throw new TypeError(
      "This publication step cannot use an absent precondition.",
    );
  }
}

/** Reconstructs one step's expected M7 key and refuses every legacy or unrelated namespace.
 * @param journal - Operation identity and path used to rebuild the key.
 * @param step - Closed target operation selecting one protocol key family.
 * @param candidate - Persisted key that must match the canonical builder exactly.
 * @returns Exact protocol-v1 target key, or undefined for any mismatch.
 */
function expectedStepKey(
  journal: SyncJournalRecord,
  step: SyncPublicationStepEvidence["step"],
  candidate: string,
): string | undefined {
  const { vaultId, operationId, request, reservation } = journal;
  let expected: string | undefined;
  switch (step) {
    case "reserve_lane":
    case "commit_lane":
      expected = syncFeedLaneHeadKey(vaultId, reservation.lane);
      break;
    case "write_head":
      expected = syncHeadKey(vaultId, request.path);
      break;
    case "create_event":
      expected = syncFeedEventKey(
        vaultId,
        reservation.lane,
        reservation.sequence,
      );
      break;
    case "commit_journal":
      expected = syncOperationKey(vaultId, operationId);
      break;
    case "immutable_create":
      if (candidate === syncVersionKey(vaultId, request.revision)) {
        expected = candidate;
      }
      if (
        (request.kind === "create" || request.kind === "update") &&
        candidate === syncContentKey(vaultId, request.revision)
      ) {
        expected = candidate;
      }
      if (
        request.kind === "tombstone" &&
        [
          syncRecoveryKey(vaultId, operationId, "metadata"),
          syncRecoveryKey(vaultId, operationId, "content"),
        ].includes(candidate)
      ) {
        expected = candidate;
      }
      break;
  }
  return expected !== undefined && isCanonicalSyncR2Key(expected, vaultId)
    ? expected
    : undefined;
}

/** Enforces bounded R2 ETag persistence without interpreting or normalizing its opaque value.
 * @param etag - Opaque original R2 generation token.
 * @returns No value; throws when the persisted token exceeds its evidence limit.
 */
function assertBoundedEtag(etag: string): void {
  if (
    new TextEncoder().encode(etag).byteLength >
    SYNC_PUBLICATION_LIMITS.etagBytes
  ) {
    throw new RangeError(
      "Persisted R2 ETag exceeds its private evidence limit.",
    );
  }
}

/** Derives the prior event sequence from a non-zero reservation without number coercion.
 * @param sequence - Reserved non-zero event position.
 * @returns Exact preceding 20-digit sequence.
 */
function previousSequence(sequence: SyncEventSequenceDto): SyncSequenceDto {
  return syncSequenceSchema.parse(
    (BigInt(sequence) - 1n).toString().padStart(SYNC_SEQUENCE_WIDTH, "0"),
  );
}

/** Computes lowercase SHA-256 over a private request's exact UTF-8 bytes.
 * @param bytes - Exact bounded payload bytes retained by the private journal.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", digestInput.buffer),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
