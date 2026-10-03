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
  decodeSyncPathKey,
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
import { SYNC_PUBLICATION_LIMITS } from "@worker/infrastructure/sync/sync-publication.constants";
import type {
  SyncHeadRefusalReceiptRecord,
  SyncJournalRecord,
  SyncPublicationRecord,
  SyncPublicationStepEvidence,
  SyncUnallocatedPendingJournalRecord,
} from "@worker/infrastructure/sync/sync-publication.types";
import { SYNC_R2_WRITE_COOLDOWN_MS } from "@worker/infrastructure/sync/sync-r2.constants";
import { isCanonicalSyncR2Key } from "@worker/infrastructure/sync/sync-r2-key";
import {
  SYNC_RECORD_LIMITS,
  syncHeadRecordSchema,
} from "@worker/infrastructure/sync/sync-record.schemas";
import { z } from "zod";

export { SYNC_PUBLICATION_LIMITS } from "@worker/infrastructure/sync/sync-publication.constants";

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
/** Exact common envelope for every private journal, lane-head, and feed event. */
const envelopeShape = {
  schemaVersion: z.literal(1),
  protocolMajor: z.literal(1),
  vaultId: syncVaultIdSchema,
};
/** Journal-only schema-v2 envelope; lane and event records remain schema-v1. */
const journalEnvelopeShape = {
  schemaVersion: z.literal(2),
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
/** Exact observed R2 generation captured as an original mutable-write precondition. */
const observedPreconditionSchema = z
  .object({
    kind: z.literal("observed"),
    etag: z.string().min(1).max(SYNC_PUBLICATION_LIMITS.etagBytes),
    bytes: z.string().min(1).max(MAX_PRECONDITION_BASE64URL_CHARACTERS),
    uploadedAtEpochMs: epochMillisecondsSchema,
  })
  .strict();
/** Proven absence or exact prior generation for a publication precondition. */
const absenceOrObservedPreconditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict(),
  observedPreconditionSchema,
]);
/** Exact lane-head snapshot retained while a request still lacks allocation authority. */
const journalLaneObservationSchema = z
  .object({
    key: z.string().min(1),
    precondition: absenceOrObservedPreconditionSchema,
    retryAfterEpochMs: epochMillisecondsSchema.nullable(),
  })
  .strict();
/** Closed journal-only step whose CAS has no external attempt claim. */
const journalStepSchema = z.literal("commit_journal");
/** Closed external target steps that require a persisted attempt claim. */
const externalStepSchema = z.enum([
  "immutable_create",
  "write_head",
  "commit_lane",
]);
/** Strict generation-zero authority for a target tuple not yet dispatched. */
const readyAttemptSchema = z
  .object({ state: z.literal("ready"), generation: z.literal(0) })
  .strict();
/** Strict unique invocation claim that authorizes at most its own target PUT. */
const attemptingAttemptSchema = z
  .object({
    state: z.literal("attempting"),
    claimId: syncOperationIdSchema,
    generation: epochMillisecondsSchema.min(1),
    claimedAtEpochMs: epochMillisecondsSchema,
  })
  .strict();
/** Strict recovered prior-target observation with its fixed, non-early retry floor. */
const retryWaitAttemptSchema = z
  .object({
    state: z.literal("retry_wait"),
    claimId: syncOperationIdSchema,
    generation: epochMillisecondsSchema.min(1),
    observedAtEpochMs: epochMillisecondsSchema,
    retryAfterEpochMs: epochMillisecondsSchema,
  })
  .strict();
/** Closed attempt-state tag accepted by every external publication step. */
const publicationAttemptSchema = z.discriminatedUnion("state", [
  readyAttemptSchema,
  attemptingAttemptSchema,
  retryWaitAttemptSchema,
]);
/** External target evidence that always carries attempt state and fixed target condition. */
const externalStepEvidenceSchema = z
  .object({
    step: externalStepSchema,
    key: z.string().min(1),
    precondition: absenceOrObservedPreconditionSchema,
    retryAfterEpochMs: epochMillisecondsSchema.nullable(),
    attempt: publicationAttemptSchema,
  })
  .strict();
/** Event-step evidence fixes the intended event kind and lane time before any create-only claim. */
const eventStepEvidenceSchema = z
  .object({
    step: z.literal("create_event"),
    key: z.string().min(1),
    committedAtEpochMs: epochMillisecondsSchema,
    outcomeIntent: z.enum(["changed", "aborted"]),
    precondition: absenceOrObservedPreconditionSchema,
    retryAfterEpochMs: epochMillisecondsSchema.nullable(),
    attempt: publicationAttemptSchema,
  })
  .strict();
/** Journal-only evidence has a typed pending phase and no external attempt substate. */
const journalStepEvidenceSchema = z
  .object({
    step: journalStepSchema,
    key: z.string().min(1),
    precondition: z
      .object({
        kind: z.literal("journal_phase"),
        status: z.literal("pending"),
      })
      .strict(),
    retryAfterEpochMs: epochMillisecondsSchema.nullable(),
  })
  .strict();
/** Durable step union; retry-wait floor duplicates must equal the key's sole safe floor. */
const publicationStepEvidenceSchema = z
  .union([
    externalStepEvidenceSchema,
    eventStepEvidenceSchema,
    journalStepEvidenceSchema,
  ])
  .superRefine((evidence, context) => {
    if (evidence.step === "commit_journal") return;
    if (
      evidence.attempt.state === "retry_wait" &&
      evidence.retryAfterEpochMs !== evidence.attempt.retryAfterEpochMs
    ) {
      context.addIssue({
        code: "custom",
        path: ["attempt", "retryAfterEpochMs"],
        message: "Retry-wait and step retry floors must be identical.",
      });
    }
    if (evidence.attempt.state === "retry_wait") {
      const minimumFloor =
        evidence.attempt.observedAtEpochMs + SYNC_R2_WRITE_COOLDOWN_MS;
      if (
        !Number.isSafeInteger(minimumFloor) ||
        evidence.attempt.retryAfterEpochMs < minimumFloor
      ) {
        context.addIssue({
          code: "custom",
          path: ["attempt", "retryAfterEpochMs"],
          message: "Retry floor must follow the exact observation cooldown.",
        });
      }
      if (
        evidence.precondition.kind === "observed" &&
        evidence.attempt.retryAfterEpochMs <
          evidence.precondition.uploadedAtEpochMs + SYNC_R2_WRITE_COOLDOWN_MS
      ) {
        context.addIssue({
          code: "custom",
          path: ["attempt", "retryAfterEpochMs"],
          message: "Retry floor cannot precede the target-key cooldown.",
        });
      }
    }
  });
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
/** Immutable request identity shared by every private journal authority phase. */
const journalIdentityShape = {
  ...journalEnvelopeShape,
  kind: z.literal("journal"),
  operationId: syncOperationIdSchema,
  request: mutationRequestSchema,
  payload: payloadEvidenceSchema.nullable(),
};
/** Reservation and in-flight evidence present only after the lane marker is won. */
const allocatedJournalShape = {
  ...journalIdentityShape,
  allocationState: z.literal("allocated"),
  reservation: laneReservationSchema,
  stepEvidence: publicationStepEvidenceSchema,
};
/** Strict pending, committed, aborted, or unallocated journal with closed authority phases. */
export const syncJournalRecordSchema = z
  .union([
    z
      .object({
        ...journalIdentityShape,
        status: z.literal("pending"),
        allocationState: z.literal("unallocated"),
        lane: laneSchema,
        laneObservation: journalLaneObservationSchema,
      })
      .strict(),
    z
      .object({
        ...allocatedJournalShape,
        status: z.literal("pending"),
      })
      .strict(),
    z
      .object({
        ...allocatedJournalShape,
        status: z.literal("committed"),
        position: positionSchema,
        revision: syncRevisionSchema,
        committedAtEpochMs: epochMillisecondsSchema,
      })
      .strict(),
    z
      .object({
        ...allocatedJournalShape,
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
      journal.status === "pending" &&
      journal.allocationState === "unallocated"
    ) {
      return;
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
/** Journal variants that carry immutable allocation and publication-step authority. */
type SyncAllocatedPublicationJournal = Exclude<
  SyncJournalRecord,
  SyncUnallocatedPendingJournalRecord
>;
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

/** Strict exact R2 observation retained for the stale head competing with one claim. */
const competingHeadObservationSchema = z
  .object({
    etag: z.string().min(1).max(SYNC_PUBLICATION_LIMITS.etagBytes),
    bytes: z.string().min(1).max(MAX_PRECONDITION_BASE64URL_CHARACTERS),
    uploadedAtEpochMs: epochMillisecondsSchema,
  })
  .strict();

/** Closed schema-v1 Worker-private receipt for a definite generation-one head refusal. */
export const syncHeadRefusalReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolMajor: z.literal(1),
    vaultId: syncVaultIdSchema,
    operationId: syncOperationIdSchema,
    claimId: syncOperationIdSchema,
    generation: z.literal(1),
    headKey: z.string().min(1).max(1_023),
    headTargetSha256: sha256Schema,
    headPrecondition: absenceOrObservedPreconditionSchema,
    lane: laneSchema,
    sequence: syncEventSequenceSchema,
    refusalSource: z.enum(["preflight_no_dispatch", "conditional_null"]),
    competingHead: competingHeadObservationSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    const prefix = `sync/v1/vaults/${receipt.vaultId}/heads/`;
    const encodedPath = receipt.headKey.startsWith(prefix)
      ? /^([^/]+)\.json$/.exec(receipt.headKey.slice(prefix.length))?.[1]
      : undefined;
    const path =
      encodedPath === undefined ? undefined : decodeSyncPathKey(encodedPath);
    if (
      path === undefined ||
      syncHeadKey(receipt.vaultId, path) !== receipt.headKey
    ) {
      context.addIssue({
        code: "custom",
        path: ["headKey"],
        message: "Receipt target must be one canonical head key in its vault.",
      });
    }
  });

/** Revalidates receipt path, lane, opaque generations, and canonical bounded bytes. */
export async function assertSyncHeadRefusalReceipt(
  receipt: SyncHeadRefusalReceiptRecord,
  expectedVaultId: SyncVaultIdDto,
): Promise<void> {
  if (receipt.vaultId !== expectedVaultId) {
    throw new TypeError("Head-refusal receipt belongs to another vault.");
  }
  const encodedPath = /^sync\/v1\/vaults\/[^/]+\/heads\/([^/]+)\.json$/.exec(
    receipt.headKey,
  )?.[1];
  const path =
    encodedPath === undefined ? undefined : decodeSyncPathKey(encodedPath);
  if (
    path === undefined ||
    (await syncFeedLaneForPath(path)) !== receipt.lane
  ) {
    throw new TypeError("Head-refusal receipt lane or path is invalid.");
  }
  assertBoundedEtag(receipt.competingHead.etag);
  assertCanonicalReceiptHeadBytes(
    receipt.competingHead.bytes,
    expectedVaultId,
    path,
  );
  if (receipt.headPrecondition.kind === "observed") {
    assertBoundedEtag(receipt.headPrecondition.etag);
    assertCanonicalReceiptHeadBytes(
      receipt.headPrecondition.bytes,
      expectedVaultId,
      path,
    );
  }
}

/** Validates bounded canonical head bytes against their immutable vault and path identity.
 * @param encoded Unpadded-base64url head evidence retained in the receipt.
 * @param vaultId Receipt vault whose strict head record must match.
 * @param path Canonical note path encoded by the exact head key.
 * @throws TypeError When bytes, JSON, schema, vault, path, or canonical representation diverges.
 */
function assertCanonicalReceiptHeadBytes(
  encoded: string,
  vaultId: SyncVaultIdDto,
  path: string,
): void {
  const bytes = decodeBase64Url(encoded);
  if (
    bytes === undefined ||
    bytes.byteLength > SYNC_RECORD_LIMITS.headBytes ||
    encodeBase64Url(bytes) !== encoded
  ) {
    throw new TypeError(
      "Head-refusal receipt bytes are not canonical or bounded.",
    );
  }
  const text = decodeUtf8(bytes);
  if (text === undefined) {
    throw new TypeError("Head-refusal receipt head bytes are not valid UTF-8.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TypeError("Head-refusal receipt head JSON is malformed.");
  }
  const head = syncHeadRecordSchema.parse(value);
  if (
    head.vaultId !== vaultId ||
    head.path !== path ||
    JSON.stringify(head) !== text
  ) {
    throw new TypeError(
      "Head-refusal receipt head bytes diverge from their key.",
    );
  }
}

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
  if (
    journal.status === "pending" &&
    journal.allocationState === "unallocated"
  ) {
    if (journal.lane !== lane) {
      throw new TypeError(
        "Unallocated journal lane does not match its normalized request path.",
      );
    }
    assertUnallocatedLaneObservation(journal);
    return;
  }
  if (journal.reservation.lane !== lane) {
    throw new TypeError(
      "Journal lane does not match its normalized request path.",
    );
  }
  assertStepEvidence(journal);
}

/** Validates the exact unreserved lane generation or absence retained before allocation.
 * @param journal - Unallocated request whose lane observation is its authority boundary.
 * @returns No value; throws when the key, canonical bytes, upload evidence, or retry floor disagrees.
 */
function assertUnallocatedLaneObservation(
  journal: SyncUnallocatedPendingJournalRecord,
): void {
  const observation = journal.laneObservation;
  if (observation.key !== syncFeedLaneHeadKey(journal.vaultId, journal.lane)) {
    throw new TypeError(
      "Unallocated lane observation has a non-canonical key.",
    );
  }
  const precondition = observation.precondition;
  if (precondition.kind === "absent") return;

  assertBoundedEtag(precondition.etag);
  const cooldownFloor =
    precondition.uploadedAtEpochMs + SYNC_R2_WRITE_COOLDOWN_MS;
  if (
    observation.retryAfterEpochMs !== null &&
    (!Number.isSafeInteger(cooldownFloor) ||
      observation.retryAfterEpochMs < cooldownFloor)
  ) {
    throw new TypeError(
      "Lane retry floor cannot precede the observed R2 cooldown.",
    );
  }
  const bytes = decodeBase64Url(precondition.bytes);
  if (
    bytes === undefined ||
    encodeBase64Url(bytes) !== precondition.bytes ||
    bytes.byteLength > SYNC_PUBLICATION_LIMITS.preconditionBytes
  ) {
    throw new TypeError("Lane observation is not exact bounded byte evidence.");
  }
  const text = decodeUtf8(bytes);
  if (text === undefined) {
    throw new TypeError("Lane observation is not valid UTF-8.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError("Lane observation is not valid JSON.");
  }
  const head = syncLaneHeadRecordSchema.parse(parsed);
  if (
    head.vaultId !== journal.vaultId ||
    head.lane !== journal.lane ||
    head.pending !== undefined ||
    JSON.stringify(head) !== text
  ) {
    throw new TypeError(
      "Unallocated lane observation must be its exact canonical unreserved head.",
    );
  }
}

/** Checks a journal step's canonical target and its immutable original precondition.
 * @param journal - Allocated journal carrying the exact current step evidence.
 * @returns No value; throws when the key, step, or precondition is inconsistent.
 */
function assertStepEvidence(journal: SyncAllocatedPublicationJournal): void {
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
  if (
    evidence.step === "create_event" &&
    evidence.committedAtEpochMs <=
      journal.reservation.previousCommittedAtEpochMs
  ) {
    throw new TypeError(
      "Event-step time must be strictly later than its predecessor lane clock.",
    );
  }
  if (precondition.kind === "observed") {
    assertBoundedEtag(precondition.etag);
    const observedCooldownFloor =
      precondition.uploadedAtEpochMs + SYNC_R2_WRITE_COOLDOWN_MS;
    if (
      evidence.retryAfterEpochMs !== null &&
      (!Number.isSafeInteger(observedCooldownFloor) ||
        evidence.retryAfterEpochMs < observedCooldownFloor)
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
  if (evidence.step === "commit_lane" || evidence.step === "write_head") {
    assertAbsentPreconditionAllowed(journal, evidence.step);
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
  journal: SyncAllocatedPublicationJournal,
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
  if (step === "commit_lane") {
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
    if (
      prior.pending === undefined ||
      prior.pending.operationId !== journal.operationId ||
      prior.pending.nextSequence !== journal.reservation.sequence
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
      (journal.request.kind === "tombstone" &&
        (prior.kind !== "live" ||
          prior.contentSha256 !== journal.request.contentSha256)) ||
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

/** Restricts absent observations to create-only objects and never to reserved lane heads.
 * @param journal - Allocated request whose mutation kind constrains create versus CAS.
 * @param step - Publication step whose target was exactly observed absent.
 * @returns No value; throws when absence cannot authorize this step.
 */
function assertAbsentPreconditionAllowed(
  journal: SyncAllocatedPublicationJournal,
  step: SyncPublicationStepEvidence["step"],
): void {
  if (step === "write_head" && journal.request.kind !== "create") {
    throw new TypeError(
      "Conditional head replacement requires its original observed ETag.",
    );
  }
  if (
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
  journal: SyncAllocatedPublicationJournal,
  step: SyncPublicationStepEvidence["step"],
  candidate: string,
): string | undefined {
  const { vaultId, operationId, request, reservation } = journal;
  let expected: string | undefined;
  switch (step) {
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
