import type { SyncMutationRequest } from "@core/sync/sync-store.types";
import { decodeBase64Url } from "@obsidian-ai-bridge/core";
import {
  syncFeedEventKey,
  syncFeedLaneHeadKey,
  syncHeadKey,
  syncOperationKey,
  syncVaultMarkerKey,
} from "@protocol/sync.codec";
import {
  SYNC_MAX_SEQUENCE,
  SYNC_SEQUENCE_WIDTH,
} from "@protocol/sync.constants";
import {
  syncEventSequenceSchema,
  syncSequenceSchema,
} from "@protocol/sync.schemas";
import type {
  SyncEventSequenceDto,
  SyncOperationIdDto,
  SyncSequenceDto,
  SyncVaultIdDto,
} from "@protocol/sync.types";
import {
  decodeSyncHeadRefusalReceipt,
  decodeSyncPublication,
  encodeSyncHeadRefusalReceipt,
  encodeSyncPublication,
} from "@worker/infrastructure/sync/sync-publication.codec";
import { SYNC_PUBLICATION_LIMITS } from "@worker/infrastructure/sync/sync-publication.constants";
import type {
  SyncFeedEventRecord,
  SyncHeadRefusalReceiptRecord,
  SyncJournalRecord,
  SyncLaneHeadRecord,
  SyncPendingJournalRecord,
  SyncPublicationKind,
  SyncPublicationRecord,
  SyncPublicationStepEvidence,
  SyncUnallocatedPendingJournalRecord,
} from "@worker/infrastructure/sync/sync-publication.types";
import { SYNC_R2_WRITE_COOLDOWN_MS } from "@worker/infrastructure/sync/sync-r2.constants";
import type {
  SyncR2Key,
  SyncR2NoEffectOutcome,
  SyncR2ObjectStore,
  SyncR2Observed,
  SyncR2ReadResult,
  SyncR2RetryContext,
  SyncR2WriteResult,
  SyncRecordObservation,
  SyncRecordRead,
} from "@worker/infrastructure/sync/sync-r2.types";
import {
  createSyncR2Key,
  syncHeadRefusalReceiptKey,
} from "@worker/infrastructure/sync/sync-r2-key";
import {
  decodeSyncRecord,
  encodeSyncRecord,
} from "@worker/infrastructure/sync/sync-record.codec";
import { SYNC_RECORD_LIMITS } from "@worker/infrastructure/sync/sync-record.schemas";
import type { SyncHeadRecord } from "@worker/infrastructure/sync/sync-record.types";

/** Marker validation distinguishes a definite unprovisioned vault from unavailable evidence. */
type SyncMarkerEvidence =
  | { readonly kind: "valid" }
  | { readonly kind: "refused" }
  | { readonly kind: "unavailable" };

/** Protocol-v1 lane sequence before any feed event has committed. */
const INITIAL_LANE_SEQUENCE = syncSequenceSchema.parse(
  "0".repeat(SYNC_SEQUENCE_WIDTH),
);

/** One-key persistence boundary for private operation journals and feed records. */
export interface SyncR2Publication {
  /** Reads the exact operation journal only after the matching vault marker validates.
   * @param vaultId Validated immutable sync-v1 namespace.
   * @param operationId Canonical operation UUID identifying one journal key.
   * @returns Typed absence, unavailability, or decoded journal with exact R2 observation.
   */
  readJournal(
    vaultId: SyncVaultIdDto,
    operationId: SyncOperationIdDto,
  ): Promise<SyncRecordRead<SyncJournalRecord>>;
  /** Creates only an unallocated request journal after verifying its saved lane observation.
   * @param record Immutable request with no sequence or publication-step authority.
   * @param retryContext Persisted cooldown floor from an earlier uncertain or throttled attempt.
   * @returns Create certainty after the one-key adapter's exact read-back.
   */
  createJournal(
    record: SyncUnallocatedPendingJournalRecord,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult>;
  /** Advances one journal through exact allocation proof, loser re-observation, or terminal settlement.
   * @param observed Exact decoded journal and R2 generation supplied by the caller.
   * @param record Strict monotonic replacement for the same operation; allocation requires its exact lane marker.
   * @param retryContext Persisted cooldown floor from an earlier uncertain or throttled attempt.
   * @returns Exact-CAS certainty; divergent or unavailable evidence is never treated as absence.
   */
  replaceJournal(
    observed: SyncRecordObservation<SyncJournalRecord>,
    record: SyncJournalRecord,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult>;
  /** Replaces only an unclaimed ready head step after revalidating its exact stale competitor and lane reservation.
   * @param observed Exact ready generation-zero write-head journal being replaced.
   * @param competingHead Exact linked current-head observation proving the request parent is stale.
   * @param record Fixed aborted event step for the same reserved sequence.
   * @returns Exact journal CAS certainty; changed or unavailable proof leaves the lane blocked.
   */
  replaceJournalFromReadyHeadCasAbort(
    observed: SyncRecordObservation<SyncJournalRecord>,
    competingHead: SyncRecordObservation<SyncHeadRecord>,
    record: SyncJournalRecord,
  ): Promise<SyncR2WriteResult>;
  /** Reads one lane head only after its vault marker validates.
   * @param vaultId Validated immutable sync-v1 namespace.
   * @param lane Fixed protocol feed partition selected from a path.
   * @returns Typed absence, unavailability, or decoded head with exact R2 observation.
   */
  readLaneHead(
    vaultId: SyncVaultIdDto,
    lane: SyncLaneHeadRecord["lane"],
  ): Promise<SyncRecordRead<SyncLaneHeadRecord>>;
  /** Creates the empty initial lane clock using create-only semantics.
   * @param record Zero-sequence lane head with no pending operation.
   * @param retryContext Persisted cooldown floor from an earlier uncertain or throttled attempt.
   * @returns Create certainty after the one-key adapter's exact read-back.
   */
  createLaneHead(
    record: SyncLaneHeadRecord,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult>;
  /** Replaces a lane head only with the original caller-observed ETag; it never refreshes CAS.
   * @param observed Exact decoded head and R2 generation used as the conditional precondition.
   * @param record Strict replacement head for the same vault and lane.
   * @param retryContext Persisted cooldown floor from an earlier uncertain or throttled attempt.
   * @returns Exact-CAS certainty; a stale observation is refused without a newer predicate.
   */
  replaceLaneHead(
    observed: SyncRecordObservation<SyncLaneHeadRecord>,
    record: SyncLaneHeadRecord,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult>;
  /** Reads one event key without interpreting absence as proof that its sequence committed.
   * @param vaultId Validated immutable sync-v1 namespace.
   * @param lane Fixed protocol feed partition containing the event.
   * @param sequence Non-zero fixed-width sequence encoded into the immutable event key.
   * @returns Typed absence, unavailability, or decoded event with exact R2 observation.
   */
  readEvent(
    vaultId: SyncVaultIdDto,
    lane: SyncLaneHeadRecord["lane"],
    sequence: SyncEventSequenceDto,
  ): Promise<SyncRecordRead<SyncFeedEventRecord>>;
  /** Creates one immutable changed or aborted event using exact-byte create-only semantics.
   * @param record Event whose vault, lane and sequence rebuild its sole permitted key.
   * @param retryContext Persisted cooldown floor from an earlier uncertain or throttled attempt.
   * @returns Create certainty after the one-key adapter's exact read-back.
   */
  createEvent(
    record: SyncFeedEventRecord,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult>;
  /** Settles a matching generation-one head refusal to its abort event step using the exact observed journal ETag.
   * @param observed Current journal generation whose original claim remains authority-bound.
   * @param receipt Canonical persisted receipt for this exact write-head claim.
   * @param target Intended strict head record covered by the refusal receipt.
   * @param record Fixed abort-only event step proposed from that claim.
   * @returns Exact journal CAS certainty; this never refreshes a changed claim or ETag.
   */
  replaceJournalFromHeadRefusalReceipt(
    observed: SyncRecordObservation<SyncJournalRecord>,
    receipt: SyncHeadRefusalReceiptRecord,
    target: SyncHeadRecord,
    record: SyncJournalRecord,
  ): Promise<SyncR2WriteResult>;
  /** Reads one exact Worker-private refusal receipt after matching marker validation.
   * @param vaultId Immutable vault identity encoded in the receipt key.
   * @param operationId Operation identity selecting its sole private receipt key.
   * @returns Exact decoded receipt evidence, absence, or fail-closed unavailability.
   */
  readHeadRefusalReceipt(
    vaultId: SyncVaultIdDto,
    operationId: SyncOperationIdDto,
  ): Promise<SyncRecordRead<SyncHeadRefusalReceiptRecord>>;
  /** Creates an immutable receipt only while its exact generation-one write-head claim and stale competitor remain current.
   * @param receipt Closed receipt binding the claim, original condition, target digest, and exact competitor.
   * @param target Intended strict head record whose canonical bytes must match the receipt digest.
   * @param noEffect Direct typed no-effect evidence from this exact head attempt.
   * @param retryContext Caller-carried cooldown floor for the receipt key.
   * @returns Create-only exact-byte certainty, preserving unknown on divergent or unavailable evidence.
   * Unproven uncertainty carries no no-effect provenance and is rejected. The journal preflight cannot atomically fence this cross-key create; recovery must revalidate the current claim.
   */
  createHeadRefusalReceipt(
    receipt: SyncHeadRefusalReceiptRecord,
    target: SyncHeadRecord,
    noEffect: SyncR2NoEffectOutcome,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult>;
}

/** Composes strict publication codecs, vault-marker gating, and one-key conditional storage.
 * @param objects Isolated conditional R2 capability; it exposes no delete or unconditional write.
 * @returns Journal, lane-head, and immutable event operations without mutation sequencing.
 */
export function syncR2Publication(
  objects: SyncR2ObjectStore,
): SyncR2Publication {
  /** Rebuilds a branded key only when the protocol builder and vault prefix are canonical.
   * @param keyValue Key generated from the record identity.
   * @param vaultId Validated namespace that must own the key.
   * @returns Canonical private R2 key or undefined for invalid caller data.
   */
  function keyFor(
    keyValue: string,
    vaultId: SyncVaultIdDto,
  ): SyncR2Key | undefined {
    return createSyncR2Key(keyValue, vaultId);
  }

  /** Builds one canonical publication key while containing invalid runtime DTOs.
   * @param build Protocol key-builder call for one publication identity.
   * @param vaultId Vault namespace to which the resulting key must belong.
   * @returns Branded key after exact reconstruction, or undefined for invalid input.
   */
  function buildKey(
    build: () => string,
    vaultId: SyncVaultIdDto,
  ): SyncR2Key | undefined {
    try {
      return keyFor(build(), vaultId);
    } catch {
      return undefined;
    }
  }

  /** Confirms the marker is the strict matching protocol-v1 vault record.
   * @param vaultId Namespace prerequisite for every publication read or write.
   * @returns Valid, definitely refused, or unavailable marker evidence.
   */
  async function validateMarker(
    vaultId: SyncVaultIdDto,
  ): Promise<SyncMarkerEvidence> {
    const key = buildKey(() => syncVaultMarkerKey(vaultId), vaultId);
    if (key === undefined) return { kind: "refused" };
    let raw: SyncR2ReadResult;
    try {
      raw = await objects.read(key, SYNC_PUBLICATION_LIMITS.metadataBytes);
    } catch {
      return { kind: "unavailable" };
    }
    if (raw.kind === "absent") return { kind: "refused" };
    if (raw.kind === "unavailable") return { kind: "unavailable" };
    try {
      const marker = await decodeSyncRecord(
        "vaultMarker",
        key,
        raw.observation.bytes,
        vaultId,
      );
      return marker.kind === "vaultMarker" && marker.vaultId === vaultId
        ? { kind: "valid" }
        : { kind: "refused" };
    } catch {
      return { kind: "refused" };
    }
  }

  /** Reads and strictly decodes a single marker-gated publication key.
   * @param kind Closed publication family selecting its decoder and byte ceiling.
   * @param key Canonical key derived from a typed operation, lane, and sequence.
   * @param vaultId Validated namespace identity for the marker and record decoder.
   * @param project Narrows the closed publication union to this operation's record type.
   * @returns Missing, unavailable, or typed record with the exact source generation.
   */
  async function readRecord<T extends SyncPublicationRecord>(
    kind: SyncPublicationKind,
    key: SyncR2Key | undefined,
    vaultId: SyncVaultIdDto,
    project: (record: SyncPublicationRecord) => T | undefined,
  ): Promise<SyncRecordRead<T>> {
    if (key === undefined) return { kind: "unavailable" };
    if ((await validateMarker(vaultId)).kind !== "valid") {
      return { kind: "unavailable" };
    }
    const maxBytes =
      kind === "journal"
        ? SYNC_PUBLICATION_LIMITS.journalBytes
        : SYNC_PUBLICATION_LIMITS.metadataBytes;
    let raw: SyncR2ReadResult;
    try {
      raw = await objects.read(key, maxBytes);
    } catch {
      return { kind: "unavailable" };
    }
    if (raw.kind !== "observed") return raw;
    try {
      const decoded = await decodeSyncPublication(
        kind,
        key,
        raw.observation.bytes,
        vaultId,
      );
      const value = project(decoded);
      return value === undefined
        ? { kind: "unavailable" }
        : {
            kind: "observed",
            observation: { value, observed: raw.observation },
          };
    } catch {
      return { kind: "unavailable" };
    }
  }

  /** Validates and encodes a publication record before one create-only R2 write.
   * @param kind Closed record family expected by this specific creation method.
   * @param record Strict immutable or initial mutable publication record.
   * @param key Canonical R2 key derived from the record's identity.
   * @param retryContext Caller-carried lower bound from a previous write result.
   * @returns Create certainty from the conditional R2 primitive.
   */
  async function createRecord(
    kind: SyncPublicationKind,
    record: SyncPublicationRecord,
    key: SyncR2Key | undefined,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult> {
    if (
      key === undefined ||
      (record.kind === "journal" &&
        (record.status !== "pending" ||
          record.allocationState !== "unallocated"))
    ) {
      return { kind: "refused" };
    }
    const marker = await validateMarker(record.vaultId);
    if (marker.kind === "refused") return { kind: "refused" };
    if (marker.kind === "unavailable") return { kind: "effect_unknown" };
    let bytes: Uint8Array;
    try {
      if (
        publicationKind(record) !== kind ||
        keyFor(recordKey(record), record.vaultId) !== key
      ) {
        return { kind: "refused" };
      }
      bytes = await encodeSyncPublication(record);
    } catch {
      return { kind: "refused" };
    }
    try {
      return await objects.create(key, bytes, retryContext);
    } catch {
      return { kind: "effect_unknown" };
    }
  }

  /** Replaces one strict record using its caller-owned ETag, except for an exact journal phase.
   * @param kind Closed record family selecting the expected key and decoder.
   * @param observed Typed exact generation supplied by the state-machine caller.
   * @param record Strict replacement value for the same publication identity.
   * @param key Canonical R2 key derived from that identity.
   * @param retryContext Caller-carried lower bound from a previous write result.
   * @param refreshJournalPhase Whether this exact source phase and terminal target qualify for the journal-only refresh.
   * @returns Exact CAS result, an idempotent exact target confirmation, or conservative uncertainty/refusal.
   */
  async function replaceRecord<
    PreviousRecord extends SyncPublicationRecord,
    NextRecord extends SyncPublicationRecord,
  >(
    kind: SyncPublicationKind,
    observed: SyncRecordObservation<PreviousRecord>,
    record: NextRecord,
    key: SyncR2Key | undefined,
    retryContext: SyncR2RetryContext | undefined,
    refreshJournalPhase?: () => Promise<SyncRecordRead<SyncPublicationRecord>>,
  ): Promise<SyncR2WriteResult> {
    if (
      key === undefined ||
      observed.observed.key !== key ||
      observed.value.vaultId !== record.vaultId ||
      publicationKind(observed.value) !== kind ||
      publicationKind(record) !== kind
    ) {
      return { kind: "refused" };
    }
    let observedRecordKey: SyncR2Key | undefined;
    let replacementRecordKey: SyncR2Key | undefined;
    try {
      observedRecordKey = keyFor(
        recordKey(observed.value),
        observed.value.vaultId,
      );
      replacementRecordKey = keyFor(recordKey(record), record.vaultId);
    } catch {
      return { kind: "refused" };
    }
    if (observedRecordKey !== key || replacementRecordKey !== key) {
      return { kind: "refused" };
    }
    let priorBytes: Uint8Array;
    let replacementBytes: Uint8Array;
    try {
      priorBytes = await encodeSyncPublication(observed.value);
      replacementBytes = await encodeSyncPublication(record);
    } catch {
      return { kind: "refused" };
    }
    if (!equalBytes(priorBytes, observed.observed.bytes)) {
      return { kind: "refused" };
    }

    const marker = await validateMarker(record.vaultId);
    if (marker.kind === "refused") return { kind: "refused" };
    if (marker.kind === "unavailable") return { kind: "effect_unknown" };

    let writeObservation = observed.observed;
    if (refreshJournalPhase !== undefined) {
      const fresh = await refreshJournalPhase();
      if (fresh.kind === "unavailable") return { kind: "effect_unknown" };
      if (fresh.kind === "absent") return { kind: "refused" };
      if (equalBytes(fresh.observation.observed.bytes, replacementBytes)) {
        return { kind: "confirmed" };
      }
      if (!equalBytes(fresh.observation.observed.bytes, priorBytes)) {
        return { kind: "refused" };
      }
      writeObservation = fresh.observation.observed;
    }

    try {
      return await objects.replace(
        writeObservation,
        replacementBytes,
        retryContext,
      );
    } catch {
      return { kind: "effect_unknown" };
    }
  }

  /** One validation result that distinguishes safe evidence from refusal and uncertainty. */
  type SyncLaneValidation =
    | { readonly kind: "valid" }
    | { readonly kind: "refused" }
    | { readonly kind: "effect_unknown" };

  /** Reads the exact lane-head key through the marker-gated strict publication decoder.
   * @param vaultId Validated protocol-v1 namespace.
   * @param lane Path-derived lane whose exact generation is being inspected.
   * @returns Absent, unavailable, or decoded head with original R2 evidence.
   */
  async function readLaneHeadRecord(
    vaultId: SyncVaultIdDto,
    lane: SyncLaneHeadRecord["lane"],
  ): Promise<SyncRecordRead<SyncLaneHeadRecord>> {
    const key = buildKey(() => syncFeedLaneHeadKey(vaultId, lane), vaultId);
    return readRecord("laneHead", key, vaultId, (record) =>
      record.kind === "laneHead" &&
      record.vaultId === vaultId &&
      record.lane === lane
        ? record
        : undefined,
    );
  }

  /** Verifies that an unallocated record's exact source generation is still current.
   * @param journal Unallocated request and persisted exact lane condition.
   * @returns Valid only for identical absence or ETag/bytes/uploaded metadata.
   */
  async function validateLaneObservation(
    journal: SyncUnallocatedPendingJournalRecord,
  ): Promise<SyncLaneValidation> {
    const current = await readLaneHeadRecord(journal.vaultId, journal.lane);
    if (current.kind === "unavailable") return { kind: "effect_unknown" };
    if (journal.laneObservation.precondition.kind === "absent") {
      return current.kind === "absent"
        ? { kind: "valid" }
        : { kind: "refused" };
    }
    if (
      current.kind !== "observed" ||
      !matchesLaneObservation(
        journal.laneObservation.precondition,
        current.observation,
      )
    ) {
      return { kind: "refused" };
    }
    return { kind: "valid" };
  }

  /** Checks a monotonic unallocated journal update or its exact own-marker allocation.
   * @param previous Persisted unallocated journal generation being replaced.
   * @param next Candidate unallocated observation or allocated journal state.
   * @returns Valid only when current lane evidence authorizes the exact transition.
   */
  async function validateUnallocatedTransition(
    previous: SyncUnallocatedPendingJournalRecord,
    next: SyncPendingJournalRecord,
  ): Promise<SyncLaneValidation> {
    if (next.allocationState === "allocated") {
      return validateOwnLaneReservation(previous, next);
    }
    if (next.lane !== previous.lane) return { kind: "refused" };
    if (
      sameLanePrecondition(
        previous.laneObservation.precondition,
        next.laneObservation.precondition,
      )
    ) {
      if (
        !isMonotonicRetryFloor(
          previous.laneObservation.retryAfterEpochMs,
          next.laneObservation.retryAfterEpochMs,
        )
      ) {
        return { kind: "refused" };
      }
      return validateLaneObservation(previous);
    }
    if (next.laneObservation.precondition.kind !== "observed") {
      return { kind: "refused" };
    }
    const current = await readLaneHeadRecord(previous.vaultId, previous.lane);
    if (current.kind === "unavailable") return { kind: "effect_unknown" };
    if (
      current.kind !== "observed" ||
      current.observation.value.pending !== undefined ||
      !matchesLaneObservation(
        next.laneObservation.precondition,
        current.observation,
      )
    ) {
      return { kind: "refused" };
    }
    const nextHead = current.observation.value;
    if (previous.laneObservation.precondition.kind === "absent") {
      return nextHead.committedSequence === INITIAL_LANE_SEQUENCE &&
        nextHead.committedAtEpochMs === 0
        ? { kind: "valid" }
        : { kind: "refused" };
    }
    const priorHead = await decodePriorLaneHead(previous);
    if (
      priorHead === undefined ||
      BigInt(nextHead.committedSequence) <=
        BigInt(priorHead.committedSequence) ||
      nextHead.committedAtEpochMs <= priorHead.committedAtEpochMs
    ) {
      return { kind: "refused" };
    }
    return { kind: "valid" };
  }

  /** Requires an unreserved prior observation and exact read-back of its own lane marker.
   * @param journal Original unallocated journal with the sequence predecessor snapshot.
   * @param allocated Candidate whose reservation must be the exact successor of that snapshot.
   * @returns Valid only for the exact operation/lane/sequence/clock pending marker.
   */
  async function validateOwnLaneReservation(
    journal: SyncUnallocatedPendingJournalRecord,
    allocated: Extract<
      SyncPendingJournalRecord,
      { allocationState: "allocated" }
    >,
  ): Promise<SyncLaneValidation> {
    if (journal.laneObservation.precondition.kind !== "observed") {
      return { kind: "refused" };
    }
    const priorHead = await decodePriorLaneHead(journal);
    if (priorHead === undefined) return { kind: "refused" };
    const nextSequence = nextEventSequence(priorHead.committedSequence);
    if (
      nextSequence === undefined ||
      allocated.reservation.lane !== journal.lane ||
      allocated.reservation.sequence !== nextSequence ||
      allocated.reservation.previousCommittedAtEpochMs !==
        priorHead.committedAtEpochMs
    ) {
      return { kind: "refused" };
    }
    const current = await readLaneHeadRecord(journal.vaultId, journal.lane);
    if (current.kind === "unavailable") return { kind: "effect_unknown" };
    if (
      current.kind !== "observed" ||
      current.observation.value.committedSequence !==
        priorHead.committedSequence ||
      current.observation.value.committedAtEpochMs !==
        priorHead.committedAtEpochMs ||
      current.observation.value.pending?.operationId !== journal.operationId ||
      current.observation.value.pending.nextSequence !== nextSequence
    ) {
      return { kind: "refused" };
    }
    return { kind: "valid" };
  }

  /** Decodes only the exact persisted unreserved lane precondition.
   * @param journal Unallocated journal carrying canonical base64url bytes and ETag.
   * @returns Strict lane head or undefined for absence or any invalid evidence.
   */
  async function decodePriorLaneHead(
    journal: SyncUnallocatedPendingJournalRecord,
  ): Promise<SyncLaneHeadRecord | undefined> {
    const precondition = journal.laneObservation.precondition;
    if (precondition.kind !== "observed") return undefined;
    const bytes = decodeBase64Url(precondition.bytes);
    if (bytes === undefined) return undefined;
    try {
      const decoded = await decodeSyncPublication(
        "laneHead",
        journal.laneObservation.key,
        bytes,
        journal.vaultId,
      );
      return decoded.kind === "laneHead" ? decoded : undefined;
    } catch {
      return undefined;
    }
  }

  /** Matches a saved lane observation against its current complete R2 generation.
   * @param precondition Persisted canonical prior bytes, ETag, and server upload time.
   * @param current Strict lane-head observation freshly read from R2.
   * @returns Whether every original generation field is byte-for-byte unchanged.
   */
  function matchesLaneObservation(
    precondition: Extract<
      SyncUnallocatedPendingJournalRecord["laneObservation"]["precondition"],
      { kind: "observed" }
    >,
    current: SyncRecordObservation<SyncLaneHeadRecord>,
  ): boolean {
    const bytes = decodeBase64Url(precondition.bytes);
    return (
      bytes !== undefined &&
      current.observed.etag === precondition.etag &&
      current.observed.uploaded.getTime() === precondition.uploadedAtEpochMs &&
      equalBytes(current.observed.bytes, bytes)
    );
  }

  /** Compares retained lane conditions without inferring a refreshed observation.
   * @param previous Exact lane condition already durable in the unallocated journal.
   * @param next Candidate lane condition whose same-generation change may only be a retry floor.
   * @returns Whether absence remains absence or every observed generation field is identical.
   */
  function sameLanePrecondition(
    previous: SyncUnallocatedPendingJournalRecord["laneObservation"]["precondition"],
    next: SyncUnallocatedPendingJournalRecord["laneObservation"]["precondition"],
  ): boolean {
    if (previous.kind !== next.kind) return false;
    if (previous.kind === "absent" && next.kind === "absent") return true;
    if (previous.kind !== "observed" || next.kind !== "observed") {
      return false;
    }
    return (
      previous.etag === next.etag &&
      previous.bytes === next.bytes &&
      previous.uploadedAtEpochMs === next.uploadedAtEpochMs
    );
  }

  /** Accepts only a durable nondecreasing lane retry floor.
   * @param previous Floor already retained for the lane-head key, if any.
   * @param next Candidate floor that must not move backward or clear a known value.
   * @returns Whether the candidate advances or preserves the known absolute retry time.
   */
  function isMonotonicRetryFloor(
    previous: number | null,
    next: number | null,
  ): boolean {
    return next !== null && (previous === null || next >= previous);
  }

  /** Resolves unallocated journal CAS outcomes without refreshing their original generation.
   * @param observed Caller-observed unallocated journal with exact original ETag.
   * @param record Monotonic unallocated refresh or exact-marker allocated target.
   * @param key Canonical operation journal key.
   * @param retryContext Persisted cooldown floor for the journal key.
   * @returns Exact target confirmation, original-ETag CAS result, or conservative refusal.
   */
  async function replaceUnallocatedJournal(
    observed: SyncRecordObservation<SyncUnallocatedPendingJournalRecord>,
    record: SyncPendingJournalRecord,
    key: SyncR2Key | undefined,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult> {
    if (key === undefined) return { kind: "refused" };
    let priorBytes: Uint8Array;
    let replacementBytes: Uint8Array;
    try {
      priorBytes = await encodeSyncPublication(observed.value);
      replacementBytes = await encodeSyncPublication(record);
    } catch {
      return { kind: "refused" };
    }
    if (!equalBytes(priorBytes, observed.observed.bytes)) {
      return { kind: "refused" };
    }
    const current = await readRecord("journal", key, record.vaultId, (value) =>
      value.kind === "journal" ? value : undefined,
    );
    if (current.kind === "unavailable") return { kind: "effect_unknown" };
    if (current.kind === "absent") return { kind: "refused" };
    if (equalBytes(current.observation.observed.bytes, replacementBytes)) {
      if (record.allocationState === "allocated") {
        const authority = await validateOwnLaneReservation(
          observed.value,
          record,
        );
        if (authority.kind !== "valid") return authority;
      }
      return { kind: "confirmed" };
    }
    if (
      !equalBytes(current.observation.observed.bytes, priorBytes) ||
      !sameR2Generation(current.observation.observed, observed.observed)
    ) {
      return { kind: "refused" };
    }
    const authority = await validateUnallocatedTransition(
      observed.value,
      record,
    );
    if (authority.kind !== "valid") return authority;
    return replaceRecord("journal", observed, record, key, retryContext);
  }

  /** Advances allocated journals while preserving reservation identity and terminal CAS rules.
   * @param observed Exact pending allocated journal generation supplied by the caller.
   * @param record Allocated monotonic progress or a valid terminal journal.
   * @param key Canonical operation journal key.
   * @param retryContext Persisted cooldown floor for the journal key.
   * @returns Exact-CAS result without refreshing any non-terminal allocation state.
   */
  async function replaceAllocatedJournal(
    observed: SyncRecordObservation<
      Exclude<SyncPendingJournalRecord, SyncUnallocatedPendingJournalRecord>
    >,
    record: Exclude<SyncJournalRecord, SyncUnallocatedPendingJournalRecord>,
    key: SyncR2Key | undefined,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult> {
    if (key === undefined) return { kind: "refused" };
    if (
      !isAllowedAllocatedJournalTransition(observed.value, record) &&
      !(await isAllowedAbortedWitnessSettlement(observed.value, record))
    ) {
      return { kind: "refused" };
    }
    const pendingPhase =
      observed.value.status === "pending" &&
      observed.value.stepEvidence.step === "commit_journal" &&
      observed.value.stepEvidence.precondition.kind === "journal_phase" &&
      observed.value.stepEvidence.precondition.status === "pending";
    if (pendingPhase && record.status === "pending") {
      return { kind: "refused" };
    }
    const refreshJournalPhase = pendingPhase
      ? () =>
          readRecord("journal", key, record.vaultId, (candidate) =>
            candidate.kind === "journal" ? candidate : undefined,
          )
      : undefined;
    return replaceRecord(
      "journal",
      observed,
      record,
      key,
      retryContext,
      refreshJournalPhase,
    );
  }

  /** Advances only retry timing on an unchanged terminal lane-commit journal.
   * @param observed Exact terminal journal generation supplied by the mutation state machine.
   * @param record Same terminal outcome with a nondecreasing safe lane retry floor.
   * @param key Canonical operation journal key.
   * @param retryContext Persisted cooldown floor for the journal key.
   * @returns Exact update confirmation or conservative conditional-write certainty.
   */
  async function replaceTerminalRetryFloor(
    observed: SyncRecordObservation<SyncJournalRecord>,
    record: SyncJournalRecord,
    key: SyncR2Key,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult> {
    return replaceRecord("journal", observed, record, key, retryContext, () =>
      readRecord("journal", key, record.vaultId, (candidate) =>
        candidate.kind === "journal" ? candidate : undefined,
      ),
    );
  }

  /** Reads the exact operation journal only after the matching vault marker validates.
   * @param vaultId Validated immutable sync-v1 namespace.
   * @param operationId Canonical operation UUID identifying one journal key.
   * @returns Typed absence, unavailability, or decoded journal with exact R2 observation.
   */
  async function readJournalRecord(
    vaultId: SyncVaultIdDto,
    operationId: SyncOperationIdDto,
  ): Promise<SyncRecordRead<SyncJournalRecord>> {
    const key = buildKey(() => syncOperationKey(vaultId, operationId), vaultId);
    return readRecord("journal", key, vaultId, (record) =>
      record.kind === "journal" &&
      record.vaultId === vaultId &&
      record.operationId === operationId
        ? record
        : undefined,
    );
  }

  /** Allows only a verified pre-existing stale-abort witness to settle a ready event step.
   * @param previous Exact allocated pending journal at its fixed event-publication step.
   * @param next Candidate journal-only phase that would advance that event step.
   * @returns Whether the immutable event exactly witnesses the persisted step timestamp.
   */
  async function isAllowedAbortedWitnessSettlement(
    previous: Exclude<
      SyncPendingJournalRecord,
      SyncUnallocatedPendingJournalRecord
    >,
    next: Exclude<SyncJournalRecord, SyncUnallocatedPendingJournalRecord>,
  ): Promise<boolean> {
    if (
      previous.status !== "pending" ||
      previous.stepEvidence.step !== "create_event" ||
      previous.stepEvidence.attempt.state !== "ready" ||
      next.status !== "pending" ||
      next.allocationState !== "allocated" ||
      next.stepEvidence.step !== "commit_journal"
    ) {
      return false;
    }
    const eventKey = buildKey(
      () =>
        syncFeedEventKey(
          previous.vaultId,
          previous.reservation.lane,
          previous.reservation.sequence,
        ),
      previous.vaultId,
    );
    if (eventKey === undefined) return false;
    const event = await readRecord(
      "feedEvent",
      eventKey,
      previous.vaultId,
      (candidate) =>
        candidate.kind !== "journal" &&
        candidate.kind !== "laneHead" &&
        candidate.vaultId === previous.vaultId &&
        candidate.lane === previous.reservation.lane &&
        candidate.sequence === previous.reservation.sequence
          ? candidate
          : undefined,
    );
    if (event.kind !== "observed") return false;
    const witness = event.observation.value;
    return (
      witness.kind === "aborted" &&
      witness.vaultId === previous.vaultId &&
      witness.lane === previous.reservation.lane &&
      witness.sequence === previous.reservation.sequence &&
      witness.operationId === previous.operationId &&
      witness.reason === "stale_revision" &&
      witness.committedAtEpochMs === previous.stepEvidence.committedAtEpochMs &&
      witness.committedAtEpochMs >
        previous.reservation.previousCommittedAtEpochMs
    );
  }

  /** Creates an unallocated request after exact key, namespace, and lane snapshot validation.
   * @param record Initial journal containing no reservation or publication-step evidence.
   * @param retryContext Persisted cooldown floor returned by an earlier create attempt.
   * @returns Confirmed exact replay, create result, or conservative refusal/uncertainty.
   */
  async function createUnallocatedJournal(
    record: SyncUnallocatedPendingJournalRecord,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult> {
    const marker = await validateMarker(record.vaultId);
    if (marker.kind === "refused") return { kind: "refused" };
    if (marker.kind === "unavailable") return { kind: "effect_unknown" };
    let bytes: Uint8Array;
    try {
      bytes = await encodeSyncPublication(record);
    } catch {
      return { kind: "refused" };
    }
    const existing = await readJournalRecord(
      record.vaultId,
      record.operationId,
    );
    if (existing.kind === "unavailable") return { kind: "effect_unknown" };
    if (existing.kind === "observed") {
      return equalBytes(existing.observation.observed.bytes, bytes)
        ? { kind: "confirmed" }
        : { kind: "refused" };
    }
    const lane = await validateLaneObservation(record);
    if (lane.kind !== "valid") return lane;
    const key = buildKey(
      () => syncOperationKey(record.vaultId, record.operationId),
      record.vaultId,
    );
    return createRecord("journal", record, key, retryContext);
  }

  /** Compares complete exact-R2 generation evidence without refreshing ETags.
   * @param current Fresh or caller-carried private R2 observation.
   * @param original Persisted exact observation that the CAS was authorized against.
   * @returns Whether key, ETag, upload time, and complete body bytes are identical.
   */
  function sameR2Generation(
    current: SyncRecordObservation<SyncJournalRecord>["observed"],
    original: SyncRecordObservation<SyncJournalRecord>["observed"],
  ): boolean {
    return (
      current.key === original.key &&
      current.etag === original.etag &&
      current.uploaded.getTime() === original.uploaded.getTime() &&
      equalBytes(current.bytes, original.bytes)
    );
  }

  /** Reads and decodes one exact marker-gated Worker-private receipt key.
   * @param vaultId Receipt namespace identity.
   * @param operationId Receipt's immutable operation identity.
   * @returns Absent, unavailable, or receipt bytes tied to the exact R2 generation.
   */
  async function readHeadRefusalReceiptRecord(
    vaultId: SyncVaultIdDto,
    operationId: SyncOperationIdDto,
  ): Promise<SyncRecordRead<SyncHeadRefusalReceiptRecord>> {
    const key = buildKey(
      () => syncHeadRefusalReceiptKey(vaultId, operationId),
      vaultId,
    );
    if (key === undefined || (await validateMarker(vaultId)).kind !== "valid") {
      return { kind: "unavailable" };
    }
    let raw: SyncR2ReadResult;
    try {
      raw = await objects.read(
        key,
        SYNC_PUBLICATION_LIMITS.headRefusalReceiptBytes,
      );
    } catch {
      return { kind: "unavailable" };
    }
    if (raw.kind !== "observed") return raw;
    try {
      const value = await decodeSyncHeadRefusalReceipt(
        key,
        raw.observation.bytes,
        vaultId,
      );
      return {
        kind: "observed",
        observation: { value, observed: raw.observation },
      };
    } catch {
      return { kind: "unavailable" };
    }
  }

  /** Writes only after exact journal, reservation, stale-head and target-digest preflight.
   * @param receipt Candidate bounded private no-effect evidence.
   * @param target Intended strict head value whose bytes are covered by the receipt digest.
   * @param noEffect Direct no-effect provenance returned by the original conditional head attempt.
   * @param retryContext Caller-carried receipt-key cooldown floor.
   * @returns Exact create result; divergent receipt or evidence stays unknown.
   * This journal preflight is not an atomic cross-key fence; recovery must recheck the current same-generation claim.
   */
  async function createHeadRefusalReceiptRecord(
    receipt: SyncHeadRefusalReceiptRecord,
    target: SyncHeadRecord,
    noEffect: SyncR2NoEffectOutcome,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult> {
    const receiptKey = buildKey(
      () => syncHeadRefusalReceiptKey(receipt.vaultId, receipt.operationId),
      receipt.vaultId,
    );
    if (receiptKey === undefined) return { kind: "refused" };
    const marker = await validateMarker(receipt.vaultId);
    if (marker.kind === "unavailable") return { kind: "effect_unknown" };
    if (marker.kind !== "valid") return { kind: "refused" };

    let receiptBytes: Uint8Array;
    let targetBytes: Uint8Array;
    try {
      receiptBytes = await encodeSyncHeadRefusalReceipt(receipt);
      targetBytes = await encodeSyncRecord({ kind: "head", record: target });
    } catch {
      return { kind: "refused" };
    }
    const targetDigest = await sha256Hex(targetBytes);
    if (targetDigest === undefined) return { kind: "effect_unknown" };
    if (
      receipt.refusalSource !== noEffect.noEffectProvenance ||
      receipt.headTargetSha256 !== targetDigest
    ) {
      return { kind: "refused" };
    }

    const journal = await readJournalRecord(
      receipt.vaultId,
      receipt.operationId,
    );
    if (journal.kind === "unavailable") return { kind: "effect_unknown" };
    if (
      journal.kind !== "observed" ||
      !receiptMatchesCurrentClaim(receipt, target, journal.observation.value)
    ) {
      return { kind: "effect_unknown" };
    }
    const lane = await readLaneHeadRecord(receipt.vaultId, receipt.lane);
    if (
      lane.kind !== "observed" ||
      lane.observation.value.pending?.operationId !== receipt.operationId ||
      lane.observation.value.pending.nextSequence !== receipt.sequence
    ) {
      return { kind: "effect_unknown" };
    }
    const competitorBytes = decodeBase64Url(receipt.competingHead.bytes);
    const headKey = createSyncR2Key(receipt.headKey, receipt.vaultId);
    if (competitorBytes === undefined || headKey === undefined) {
      return { kind: "effect_unknown" };
    }
    let currentHead: SyncR2ReadResult;
    try {
      currentHead = await objects.read(headKey, SYNC_RECORD_LIMITS.headBytes);
    } catch {
      return { kind: "effect_unknown" };
    }
    if (
      currentHead.kind !== "observed" ||
      currentHead.observation.etag !== receipt.competingHead.etag ||
      currentHead.observation.uploaded.getTime() !==
        receipt.competingHead.uploadedAtEpochMs ||
      !equalBytes(currentHead.observation.bytes, competitorBytes)
    ) {
      return { kind: "effect_unknown" };
    }
    let decodedHead: Awaited<ReturnType<typeof decodeSyncRecord>>;
    try {
      decodedHead = await decodeSyncRecord(
        "head",
        receipt.headKey,
        competitorBytes,
        receipt.vaultId,
      );
    } catch {
      return { kind: "effect_unknown" };
    }
    if (
      decodedHead.kind !== "head" ||
      !isStaleCompetingHead(journal.observation.value, decodedHead.record) ||
      sameReceiptPrecondition(receipt, currentHead.observation)
    ) {
      return { kind: "effect_unknown" };
    }
    let result: SyncR2WriteResult;
    try {
      result = await objects.create(receiptKey, receiptBytes, retryContext);
    } catch {
      return { kind: "effect_unknown" };
    }
    return result.kind === "refused" ? { kind: "effect_unknown" } : result;
  }

  /** Advances an unclaimed head-write journal only when its exact stale-head and lane evidence remain current.
   * @param observed Exact generation-zero ready journal observation.
   * @param competingHead Linked current-head observation that proves the original parent is stale.
   * @param record Fixed abort-only event step for the already reserved sequence.
   * @returns Exact CAS certainty; changed or unavailable proof leaves the lane blocked.
   */
  async function replaceJournalFromReadyHeadCasAbortRecord(
    observed: SyncRecordObservation<SyncJournalRecord>,
    competingHead: SyncRecordObservation<SyncHeadRecord>,
    record: SyncJournalRecord,
  ): Promise<SyncR2WriteResult> {
    const previous = observed.value;
    if (
      previous.status !== "pending" ||
      previous.allocationState !== "allocated" ||
      previous.stepEvidence.step !== "write_head"
    ) {
      return { kind: "refused" };
    }
    const key = buildKey(
      () => syncOperationKey(previous.vaultId, previous.operationId),
      previous.vaultId,
    );
    const headKey = buildKey(
      () => syncHeadKey(previous.vaultId, previous.request.path),
      previous.vaultId,
    );
    if (
      key === undefined ||
      headKey === undefined ||
      observed.observed.key !== key ||
      previous.stepEvidence.key !== headKey ||
      !isAllowedReadyHeadCasAbortTransition(previous, record) ||
      competingHead.observed.key !== headKey ||
      competingHead.value.vaultId !== previous.vaultId ||
      competingHead.value.path !== previous.request.path ||
      !isStaleCompetingHead(previous, competingHead.value)
    ) {
      return { kind: "refused" };
    }

    let previousBytes: Uint8Array;
    let competingBytes: Uint8Array;
    try {
      previousBytes = await encodeSyncPublication(previous);
      competingBytes = await encodeSyncRecord({
        kind: "head",
        record: competingHead.value,
      });
    } catch {
      return { kind: "refused" };
    }
    if (!equalBytes(previousBytes, observed.observed.bytes)) {
      return { kind: "refused" };
    }

    const currentJournal = await readJournalRecord(
      previous.vaultId,
      previous.operationId,
    );
    if (currentJournal.kind === "unavailable") {
      return { kind: "effect_unknown" };
    }
    if (
      currentJournal.kind !== "observed" ||
      !equalBytes(currentJournal.observation.observed.bytes, previousBytes) ||
      !sameR2Generation(currentJournal.observation.observed, observed.observed)
    ) {
      return { kind: "refused" };
    }

    const lane = await readLaneHeadRecord(
      previous.vaultId,
      previous.reservation.lane,
    );
    if (lane.kind === "unavailable") return { kind: "effect_unknown" };
    const expectedPreviousSequence = syncSequenceSchema.safeParse(
      (BigInt(previous.reservation.sequence) - 1n)
        .toString()
        .padStart(SYNC_SEQUENCE_WIDTH, "0"),
    );
    if (
      lane.kind !== "observed" ||
      !expectedPreviousSequence.success ||
      lane.observation.value.pending?.operationId !== previous.operationId ||
      lane.observation.value.pending.nextSequence !==
        previous.reservation.sequence ||
      lane.observation.value.committedSequence !==
        expectedPreviousSequence.data ||
      lane.observation.value.committedAtEpochMs !==
        previous.reservation.previousCommittedAtEpochMs
    ) {
      return { kind: "effect_unknown" };
    }

    const marker = await validateMarker(previous.vaultId);
    if (marker.kind === "unavailable") return { kind: "effect_unknown" };
    if (marker.kind === "refused") return { kind: "refused" };
    let currentHead: SyncR2ReadResult;
    try {
      currentHead = await objects.read(headKey, SYNC_RECORD_LIMITS.headBytes);
    } catch {
      return { kind: "effect_unknown" };
    }
    if (currentHead.kind === "unavailable") return { kind: "effect_unknown" };
    if (
      currentHead.kind !== "observed" ||
      currentHead.observation.etag !== competingHead.observed.etag ||
      currentHead.observation.uploaded.getTime() !==
        competingHead.observed.uploaded.getTime() ||
      !equalBytes(currentHead.observation.bytes, competingBytes) ||
      !equalBytes(currentHead.observation.bytes, competingHead.observed.bytes)
    ) {
      return { kind: "refused" };
    }
    let decodedHead: Awaited<ReturnType<typeof decodeSyncRecord>>;
    try {
      decodedHead = await decodeSyncRecord(
        "head",
        headKey,
        currentHead.observation.bytes,
        previous.vaultId,
      );
    } catch {
      return { kind: "effect_unknown" };
    }
    if (
      decodedHead.kind !== "head" ||
      !isStaleCompetingHead(previous, decodedHead.record)
    ) {
      return { kind: "refused" };
    }
    return replaceRecord("journal", observed, record, key, undefined);
  }

  /** CASes a receipt-authorized refusal step without refreshing the observed journal generation.
   * @param observed Exact generation-one attempting journal observation selected by recovery.
   * @param receipt Strict private receipt expected at its one operation-bound key.
   * @param target Original intended head whose exact digest the receipt binds.
   * @param record Fixed abort-only event step to persist before any later event claim.
   * @returns Exact journal CAS result, leaving changed or unavailable evidence unresolved.
   */
  async function replaceJournalFromHeadRefusalReceiptRecord(
    observed: SyncRecordObservation<SyncJournalRecord>,
    receipt: SyncHeadRefusalReceiptRecord,
    target: SyncHeadRecord,
    record: SyncJournalRecord,
  ): Promise<SyncR2WriteResult> {
    const key = buildKey(
      () =>
        syncOperationKey(observed.value.vaultId, observed.value.operationId),
      observed.value.vaultId,
    );
    if (
      key === undefined ||
      observed.observed.key !== key ||
      !isAllowedHeadRefusalReceiptTransition(observed.value, record, receipt)
    ) {
      return { kind: "refused" };
    }

    let receiptBytes: Uint8Array;
    let targetBytes: Uint8Array;
    try {
      receiptBytes = await encodeSyncHeadRefusalReceipt(receipt);
      targetBytes = await encodeSyncRecord({ kind: "head", record: target });
    } catch {
      return { kind: "refused" };
    }
    const targetDigest = await sha256Hex(targetBytes);
    if (targetDigest === undefined) return { kind: "effect_unknown" };
    const journal = observed.value;
    if (
      journal.status !== "pending" ||
      journal.allocationState !== "allocated" ||
      !receiptMatchesCurrentClaim(receipt, target, journal) ||
      receipt.headTargetSha256 !== targetDigest
    ) {
      return { kind: "refused" };
    }
    const savedReceipt = await readHeadRefusalReceiptRecord(
      receipt.vaultId,
      receipt.operationId,
    );
    if (
      savedReceipt.kind !== "observed" ||
      !equalBytes(savedReceipt.observation.observed.bytes, receiptBytes)
    ) {
      return { kind: "effect_unknown" };
    }

    const lane = await readLaneHeadRecord(receipt.vaultId, receipt.lane);
    if (
      lane.kind !== "observed" ||
      lane.observation.value.pending?.operationId !== receipt.operationId ||
      lane.observation.value.pending.nextSequence !== receipt.sequence ||
      lane.observation.value.committedAtEpochMs !==
        journal.reservation.previousCommittedAtEpochMs
    ) {
      return { kind: "effect_unknown" };
    }
    const expectedPreviousSequence = syncSequenceSchema.safeParse(
      (BigInt(receipt.sequence) - 1n)
        .toString()
        .padStart(SYNC_SEQUENCE_WIDTH, "0"),
    );
    if (
      !expectedPreviousSequence.success ||
      lane.observation.value.committedSequence !== expectedPreviousSequence.data
    ) {
      return { kind: "effect_unknown" };
    }

    const headKey = createSyncR2Key(receipt.headKey, receipt.vaultId);
    const competitorBytes = decodeBase64Url(receipt.competingHead.bytes);
    if (headKey === undefined || competitorBytes === undefined) {
      return { kind: "effect_unknown" };
    }
    let currentHead: SyncR2ReadResult;
    try {
      currentHead = await objects.read(headKey, SYNC_RECORD_LIMITS.headBytes);
    } catch {
      return { kind: "effect_unknown" };
    }
    if (
      currentHead.kind !== "observed" ||
      currentHead.observation.etag !== receipt.competingHead.etag ||
      currentHead.observation.uploaded.getTime() !==
        receipt.competingHead.uploadedAtEpochMs ||
      !equalBytes(currentHead.observation.bytes, competitorBytes) ||
      sameReceiptPrecondition(receipt, currentHead.observation)
    ) {
      return { kind: "effect_unknown" };
    }
    let decodedHead: Awaited<ReturnType<typeof decodeSyncRecord>>;
    try {
      decodedHead = await decodeSyncRecord(
        "head",
        receipt.headKey,
        competitorBytes,
        receipt.vaultId,
      );
    } catch {
      return { kind: "effect_unknown" };
    }
    if (
      decodedHead.kind !== "head" ||
      !isStaleCompetingHead(journal, decodedHead.record)
    ) {
      return { kind: "effect_unknown" };
    }
    return replaceRecord("journal", observed, record, key, undefined);
  }

  return {
    readJournal: readJournalRecord,
    createJournal: createUnallocatedJournal,
    replaceJournal(observed, record, retryContext) {
      const key = buildKey(
        () => syncOperationKey(record.vaultId, record.operationId),
        record.vaultId,
      );
      if (observed.value.status !== "pending") {
        if (
          !isAllowedTerminalJournalUpdate(observed.value, record) ||
          key === undefined
        ) {
          return Promise.resolve({ kind: "refused" });
        }
        return replaceTerminalRetryFloor(observed, record, key, retryContext);
      }
      if (!sameJournalIdentity(observed.value, record)) {
        return Promise.resolve({ kind: "refused" });
      }
      if (observed.value.allocationState === "unallocated") {
        if (record.status !== "pending") {
          return Promise.resolve({ kind: "refused" });
        }
        return replaceUnallocatedJournal(
          { value: observed.value, observed: observed.observed },
          record,
          key,
          retryContext,
        );
      }
      if (record.allocationState !== "allocated") {
        return Promise.resolve({ kind: "refused" });
      }
      return replaceAllocatedJournal(
        { value: observed.value, observed: observed.observed },
        record,
        key,
        retryContext,
      );
    },
    replaceJournalFromReadyHeadCasAbort(observed, competingHead, record) {
      return replaceJournalFromReadyHeadCasAbortRecord(
        observed,
        competingHead,
        record,
      );
    },
    readLaneHead: readLaneHeadRecord,
    createLaneHead(record, retryContext) {
      const key = buildKey(
        () => syncFeedLaneHeadKey(record.vaultId, record.lane),
        record.vaultId,
      );
      if (
        record.committedSequence !== INITIAL_LANE_SEQUENCE ||
        record.committedAtEpochMs !== 0 ||
        record.pending !== undefined
      ) {
        return Promise.resolve({ kind: "refused" });
      }
      return createRecord("laneHead", record, key, retryContext);
    },
    replaceLaneHead(observed, record, retryContext) {
      if (!isAllowedLaneHeadTransition(observed.value, record)) {
        return Promise.resolve({ kind: "refused" });
      }
      const key = buildKey(
        () => syncFeedLaneHeadKey(record.vaultId, record.lane),
        record.vaultId,
      );
      return replaceRecord("laneHead", observed, record, key, retryContext);
    },
    readEvent(vaultId, lane, sequence) {
      const key = buildKey(
        () => syncFeedEventKey(vaultId, lane, sequence),
        vaultId,
      );
      return readRecord("feedEvent", key, vaultId, (record) =>
        record.kind !== "journal" &&
        record.kind !== "laneHead" &&
        record.vaultId === vaultId &&
        record.lane === lane &&
        record.sequence === sequence
          ? record
          : undefined,
      );
    },
    createEvent(record, retryContext) {
      const key = buildKey(
        () => syncFeedEventKey(record.vaultId, record.lane, record.sequence),
        record.vaultId,
      );
      return createRecord("feedEvent", record, key, retryContext);
    },
    readHeadRefusalReceipt: readHeadRefusalReceiptRecord,
    createHeadRefusalReceipt: createHeadRefusalReceiptRecord,
    replaceJournalFromHeadRefusalReceipt(observed, receipt, target, record) {
      return replaceJournalFromHeadRefusalReceiptRecord(
        observed,
        receipt,
        target,
        record,
      );
    },
  };
}

/** Binds a receipt and target head to the currently persisted first write-head claim.
 * @param receipt Receipt identity, exact original condition, and lane position.
 * @param target Canonical intended head whose full digest is checked by the caller.
 * @param journal Currently reread operation state that must own generation one.
 * @returns Whether every immutable request, key, condition, claim, and reservation field agrees.
 */
function receiptMatchesCurrentClaim(
  receipt: SyncHeadRefusalReceiptRecord,
  target: SyncHeadRecord,
  journal: SyncJournalRecord,
): boolean {
  if (
    journal.status !== "pending" ||
    journal.allocationState !== "allocated" ||
    journal.stepEvidence.step !== "write_head" ||
    journal.stepEvidence.attempt.state !== "attempting" ||
    journal.stepEvidence.attempt.generation !== 1 ||
    journal.stepEvidence.attempt.claimId !== receipt.claimId ||
    journal.vaultId !== receipt.vaultId ||
    journal.operationId !== receipt.operationId ||
    journal.reservation.lane !== receipt.lane ||
    journal.reservation.sequence !== receipt.sequence ||
    journal.stepEvidence.key !== receipt.headKey ||
    !samePublicationPrecondition(
      journal.stepEvidence.precondition,
      receipt.headPrecondition,
    )
  ) {
    return false;
  }
  const request = journal.request;
  if (
    request.vaultId !== target.vaultId ||
    request.operationId !== target.operationId ||
    request.path !== target.path ||
    request.revision !== target.revision ||
    request.origin !== target.origin ||
    request.contentSha256 !== target.contentSha256
  ) {
    return false;
  }
  if (request.kind === "tombstone") {
    return (
      target.kind === "tombstone" &&
      target.parent.kind === "revision" &&
      target.parent.revision === request.parent.revision
    );
  }
  if (
    target.kind !== "live" ||
    target.mediaType !== request.mediaType ||
    target.byteSize !== journal.payload?.byteSize
  ) {
    return false;
  }
  if (request.kind === "create") {
    return (
      target.parent.kind === "never_seen" &&
      request.parent.kind === "never_seen"
    );
  }
  return (
    target.parent.kind === "revision" &&
    target.parent.revision === request.parent.revision
  );
}

/** Requires the current exact competitor to reject the request's original parent.
 * @param journal Current exact operation state and original parent condition.
 * @param head Strict competing current-head record validated against its key.
 * @returns Whether this exact head proves the request parent is stale.
 */
function isStaleCompetingHead(
  journal: SyncJournalRecord,
  head: SyncHeadRecord,
): boolean {
  if (
    journal.status !== "pending" ||
    journal.allocationState !== "allocated" ||
    head.vaultId !== journal.vaultId ||
    head.path !== journal.request.path ||
    head.operationId === journal.operationId ||
    head.revision === journal.request.revision
  ) {
    return false;
  }
  return (
    journal.request.kind === "create" ||
    head.revision !== journal.request.parent.revision
  );
}

/** Rejects a receipt whose competitor has returned to its exact original head generation.
 * @param receipt Definite refusal evidence carrying the original precondition.
 * @param competitor Exact current R2 observation being compared to that precondition.
 * @returns Whether every original generation field and byte matches again.
 */
function sameReceiptPrecondition(
  receipt: SyncHeadRefusalReceiptRecord,
  competitor: SyncR2Observed,
): boolean {
  const precondition = receipt.headPrecondition;
  if (precondition.kind === "absent") return false;
  const originalBytes = decodeBase64Url(precondition.bytes);
  return (
    originalBytes !== undefined &&
    competitor.etag === precondition.etag &&
    competitor.uploaded.getTime() === precondition.uploadedAtEpochMs &&
    equalBytes(competitor.bytes, originalBytes)
  );
}

/** Hashes exact canonical record bytes using Web Crypto without text normalization.
 * @param bytes Canonical intended-head bytes whose exact digest binds the receipt.
 * @returns Lowercase hexadecimal digest, or undefined when the crypto capability fails; failed hashing grants no receipt or journal authority.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string | undefined> {
  try {
    const input = bytes.slice();
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", input.buffer),
    );
    return Array.from(digest, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  } catch {
    return undefined;
  }
}

/** Allows only exact next-sequence reservation or release of the currently owned marker.
 * @param previous Exact caller-observed lane state.
 * @param next Candidate lane state encoded for the same canonical lane key.
 * @returns Whether the transition preserves one owner and strictly monotonic high water.
 */
function isAllowedLaneHeadTransition(
  previous: SyncLaneHeadRecord,
  next: SyncLaneHeadRecord,
): boolean {
  if (previous.vaultId !== next.vaultId || previous.lane !== next.lane) {
    return false;
  }
  if (previous.pending === undefined) {
    return (
      next.pending !== undefined &&
      next.committedSequence === previous.committedSequence &&
      next.committedAtEpochMs === previous.committedAtEpochMs &&
      next.pending.nextSequence ===
        nextEventSequence(previous.committedSequence)
    );
  }
  return (
    next.pending === undefined &&
    next.committedSequence === previous.pending.nextSequence &&
    next.committedAtEpochMs > previous.committedAtEpochMs
  );
}

/** Computes one fixed-width successor without wrapping the protocol's maximum sequence.
 * @param current Current committed lane sequence retained by an exact prior observation.
 * @returns Its non-zero successor, or undefined when the lane is exhausted.
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

/** Accepts only attempt/floor progress on an unchanged terminal lane-commit outcome.
 * @param previous Terminal record whose mutation, position, and original lane condition are frozen.
 * @param next Candidate terminal record carrying a permitted claim or retry-floor transition.
 * @returns Whether only the lane attempt state and its monotonic retry floor advance.
 */
function isAllowedTerminalJournalUpdate(
  previous: SyncJournalRecord,
  next: SyncJournalRecord,
): boolean {
  if (
    (previous.status !== "committed" && previous.status !== "aborted") ||
    previous.allocationState !== "allocated" ||
    previous.stepEvidence.step !== "commit_lane" ||
    next.status !== previous.status ||
    next.allocationState !== "allocated" ||
    next.stepEvidence.step !== "commit_lane" ||
    previous.vaultId !== next.vaultId ||
    previous.operationId !== next.operationId ||
    !sameMutationRequest(previous.request, next.request) ||
    (previous.payload === null) !== (next.payload === null) ||
    previous.payload?.byteSize !== next.payload?.byteSize ||
    previous.reservation.lane !== next.reservation.lane ||
    previous.reservation.sequence !== next.reservation.sequence ||
    previous.reservation.previousCommittedAtEpochMs !==
      next.reservation.previousCommittedAtEpochMs ||
    previous.position.lane !== next.position.lane ||
    previous.position.sequence !== next.position.sequence ||
    previous.committedAtEpochMs !== next.committedAtEpochMs ||
    previous.stepEvidence.key !== next.stepEvidence.key ||
    !samePublicationPrecondition(
      previous.stepEvidence.precondition,
      next.stepEvidence.precondition,
    )
  ) {
    return false;
  }
  if (previous.status === "committed") {
    if (next.status !== "committed" || previous.revision !== next.revision) {
      return false;
    }
  } else if (next.status !== "aborted" || previous.reason !== next.reason) {
    return false;
  }
  return isAllowedAttemptTransition(
    previous.stepEvidence,
    next.stepEvidence,
    true,
  );
}

/** Admits only receipt-backed generation-one head refusal to a fixed abort event step.
 * @param previous Exact current head-write claim selected for receipt recovery.
 * @param next Candidate journal containing the immutable abort intent and event time.
 * @param receipt Private receipt whose claim, condition, key, and reservation must match.
 * @returns Whether this one same-operation, same-claim transition preserves all authority fields.
 */
function isAllowedHeadRefusalReceiptTransition(
  previous: SyncJournalRecord,
  next: SyncJournalRecord,
  receipt: SyncHeadRefusalReceiptRecord,
): boolean {
  if (
    previous.status !== "pending" ||
    previous.allocationState !== "allocated" ||
    previous.stepEvidence.step !== "write_head" ||
    previous.stepEvidence.attempt.state !== "attempting" ||
    previous.stepEvidence.attempt.generation !== 1 ||
    next.status !== "pending" ||
    next.allocationState !== "allocated" ||
    next.stepEvidence.step !== "create_event" ||
    next.stepEvidence.outcomeIntent !== "aborted" ||
    next.stepEvidence.key !==
      syncFeedEventKey(
        previous.vaultId,
        previous.reservation.lane,
        previous.reservation.sequence,
      ) ||
    next.stepEvidence.precondition.kind !== "absent" ||
    next.stepEvidence.retryAfterEpochMs !== null ||
    next.stepEvidence.attempt.state !== "ready" ||
    next.stepEvidence.attempt.generation !== 0 ||
    !Number.isSafeInteger(next.stepEvidence.committedAtEpochMs) ||
    next.stepEvidence.committedAtEpochMs <=
      previous.reservation.previousCommittedAtEpochMs ||
    !sameJournalIdentity(previous, next) ||
    previous.reservation.lane !== next.reservation.lane ||
    previous.reservation.sequence !== next.reservation.sequence ||
    previous.reservation.previousCommittedAtEpochMs !==
      next.reservation.previousCommittedAtEpochMs
  ) {
    return false;
  }
  return (
    receipt.vaultId === previous.vaultId &&
    receipt.operationId === previous.operationId &&
    receipt.claimId === previous.stepEvidence.attempt.claimId &&
    receipt.generation === previous.stepEvidence.attempt.generation &&
    receipt.headKey === previous.stepEvidence.key &&
    receipt.lane === previous.reservation.lane &&
    receipt.sequence === previous.reservation.sequence &&
    samePublicationPrecondition(
      previous.stepEvidence.precondition,
      receipt.headPrecondition,
    )
  );
}

/** Admits one generation-zero head refusal into its fixed abort-only event step.
 * @param previous Exact pending write-head state that has never authorized a target PUT.
 * @param next Candidate event state retaining the same request and reserved lane position.
 * @returns Whether this is the sole ready-head to stale-abort transition.
 */
function isAllowedReadyHeadCasAbortTransition(
  previous: SyncJournalRecord,
  next: SyncJournalRecord,
): boolean {
  if (
    previous.status !== "pending" ||
    previous.allocationState !== "allocated" ||
    previous.stepEvidence.step !== "write_head" ||
    previous.stepEvidence.attempt.state !== "ready" ||
    previous.stepEvidence.attempt.generation !== 0 ||
    next.status !== "pending" ||
    next.allocationState !== "allocated" ||
    next.stepEvidence.step !== "create_event" ||
    next.stepEvidence.outcomeIntent !== "aborted" ||
    next.stepEvidence.key !==
      syncFeedEventKey(
        previous.vaultId,
        previous.reservation.lane,
        previous.reservation.sequence,
      ) ||
    next.stepEvidence.precondition.kind !== "absent" ||
    next.stepEvidence.retryAfterEpochMs !== null ||
    next.stepEvidence.attempt.state !== "ready" ||
    next.stepEvidence.attempt.generation !== 0 ||
    !Number.isSafeInteger(next.stepEvidence.committedAtEpochMs) ||
    next.stepEvidence.committedAtEpochMs <=
      previous.reservation.previousCommittedAtEpochMs ||
    !sameJournalIdentity(previous, next) ||
    previous.reservation.lane !== next.reservation.lane ||
    previous.reservation.sequence !== next.reservation.sequence ||
    previous.reservation.previousCommittedAtEpochMs !==
      next.reservation.previousCommittedAtEpochMs
  ) {
    return false;
  }
  return true;
}

/** Admits exact claim, recovery, tuple-advance, unclaimed stale-abort, or terminalization edges.
 * @param previous Pending allocated journal state authenticated by the caller's exact observation.
 * @param next Candidate journal state that must preserve request and won reservation identity.
 * @returns Whether the journal advances without skipping or rewriting attempt authority.
 */
function isAllowedAllocatedJournalTransition(
  previous: Exclude<
    SyncPendingJournalRecord,
    SyncUnallocatedPendingJournalRecord
  >,
  next: Exclude<SyncJournalRecord, SyncUnallocatedPendingJournalRecord>,
): boolean {
  const priorStep = previous.stepEvidence;
  const nextStep = next.stepEvidence;
  if (priorStep.step === "commit_journal") {
    return (
      previous.status === "pending" &&
      next.status !== "pending" &&
      nextStep.step === "commit_lane" &&
      nextStep.attempt.state === "ready" &&
      nextStep.attempt.generation === 0
    );
  }
  if (next.status !== "pending") return false;
  if (nextStep.step === "commit_journal") {
    return (
      priorStep.step === "create_event" && priorStep.attempt.state !== "ready"
    );
  }

  if (sameExternalStepTuple(priorStep, nextStep)) {
    return isAllowedAttemptTransition(priorStep, nextStep, false);
  }
  if (
    priorStep.step === "immutable_create" &&
    priorStep.attempt.state === "ready" &&
    nextStep.step === "create_event"
  ) {
    return isAllowedUnclaimedStaleParentShortcut(previous, next);
  }
  if (
    nextStep.step === "create_event" &&
    nextStep.outcomeIntent === "aborted"
  ) {
    return false;
  }
  if (priorStep.step === nextStep.step && priorStep.key === nextStep.key) {
    return false;
  }
  return (
    priorStep.attempt.state !== "ready" &&
    nextStep.attempt.state === "ready" &&
    nextStep.attempt.generation === 0 &&
    isForwardPublicationStep(priorStep.step, nextStep.step)
  );
}

/** Admits only the no-target stale-parent transition to an abort-intent event.
 * @param previous Ready immutable target tuple with no durable claim that could authorize a PUT.
 * @param next Ready event tuple with its fixed time and exact reserved event key.
 * @returns Whether the candidate records only the narrowly permitted aborted outcome.
 * The mutation state machine must first prove staleness; journal readiness alone is not parent evidence.
 */
function isAllowedUnclaimedStaleParentShortcut(
  previous: Extract<SyncPendingJournalRecord, { allocationState: "allocated" }>,
  next: Extract<
    SyncJournalRecord,
    { status: "pending"; allocationState: "allocated" }
  >,
): boolean {
  const priorStep = previous.stepEvidence;
  const nextStep = next.stepEvidence;
  const eventKey = syncFeedEventKey(
    previous.vaultId,
    previous.reservation.lane,
    previous.reservation.sequence,
  );
  return (
    priorStep.step === "immutable_create" &&
    priorStep.precondition.kind === "absent" &&
    priorStep.attempt.state === "ready" &&
    priorStep.attempt.generation === 0 &&
    nextStep.step === "create_event" &&
    nextStep.outcomeIntent === "aborted" &&
    nextStep.key === eventKey &&
    nextStep.precondition.kind === "absent" &&
    nextStep.retryAfterEpochMs === null &&
    nextStep.attempt.state === "ready" &&
    nextStep.attempt.generation === 0 &&
    Number.isSafeInteger(nextStep.committedAtEpochMs) &&
    nextStep.committedAtEpochMs >
      previous.reservation.previousCommittedAtEpochMs
  );
}

/** Restricts journal progression to the publication order and the stale-parent abort shortcut.
 * @param previous Durable external-write step just reconciled by exact target evidence.
 * @param next Candidate next step recorded before any later target dispatch.
 * @returns Whether the closed step sequence advances without returning to earlier authority.
 */
function isForwardPublicationStep(
  previous: SyncPublicationStepEvidence["step"],
  next: SyncPublicationStepEvidence["step"],
): boolean {
  if (previous === "immutable_create") {
    return (
      next === "immutable_create" ||
      next === "write_head" ||
      next === "create_event"
    );
  }
  return previous === "write_head" && next === "create_event";
}

/** Requires one exact external target tuple before attempt state may change.
 * @param previous Existing external step and its saved original condition.
 * @param next Candidate external step whose attempt authority may advance.
 * @returns Whether step, key, event intent/time, and exact precondition remain unchanged.
 */
function sameExternalStepTuple(
  previous: Extract<SyncPublicationStepEvidence, { attempt: unknown }>,
  next: Extract<SyncPublicationStepEvidence, { attempt: unknown }>,
): boolean {
  return (
    previous.step === next.step &&
    previous.key === next.key &&
    (previous.step !== "create_event" ||
      (next.step === "create_event" &&
        previous.committedAtEpochMs === next.committedAtEpochMs &&
        previous.outcomeIntent === next.outcomeIntent)) &&
    samePublicationPrecondition(previous.precondition, next.precondition)
  );
}

/** Enforces claim generation, owner identity, prior floor, and observed cooldown edges.
 * @param previous Existing attempt state for an exact external target tuple.
 * @param next Candidate attempt state for the same tuple.
 * @param allowFloorOnly Whether terminal status-preserving transitions may raise only the floor.
 * @returns Whether the tagged attempt transition is monotonic and claim-bound.
 */
function isAllowedAttemptTransition(
  previous: Extract<SyncPublicationStepEvidence, { attempt: unknown }>,
  next: Extract<SyncPublicationStepEvidence, { attempt: unknown }>,
  allowFloorOnly: boolean,
): boolean {
  const priorAttempt = previous.attempt;
  const nextAttempt = next.attempt;
  const priorFloor = previous.retryAfterEpochMs;
  const nextFloor = next.retryAfterEpochMs;
  if (nextFloor !== null && priorFloor !== null && nextFloor < priorFloor) {
    return false;
  }
  if (
    allowFloorOnly &&
    sameAttemptState(priorAttempt, nextAttempt) &&
    (nextFloor === priorFloor ||
      (nextFloor !== null && (priorFloor === null || nextFloor >= priorFloor)))
  ) {
    return true;
  }
  if (priorAttempt.state === "ready") {
    return (
      nextAttempt.state === "attempting" &&
      nextAttempt.generation === 1 &&
      nextAttempt.claimedAtEpochMs >= minimumTargetRetryFloor(previous) &&
      nextFloor === priorFloor
    );
  }
  if (priorAttempt.state === "attempting") {
    return (
      nextAttempt.state === "retry_wait" &&
      nextAttempt.claimId === priorAttempt.claimId &&
      nextAttempt.generation === priorAttempt.generation &&
      nextAttempt.observedAtEpochMs >= priorAttempt.claimedAtEpochMs &&
      nextFloor !== null &&
      nextFloor >= nextAttempt.observedAtEpochMs + SYNC_R2_WRITE_COOLDOWN_MS
    );
  }
  if (nextAttempt.state === "attempting") {
    return (
      Number.isSafeInteger(priorAttempt.generation + 1) &&
      nextAttempt.generation === priorAttempt.generation + 1 &&
      nextAttempt.claimId !== priorAttempt.claimId &&
      nextAttempt.claimedAtEpochMs >= minimumTargetRetryFloor(previous) &&
      nextFloor === priorFloor
    );
  }
  return false;
}

/** Computes the latest persisted target cooldown before a new claim may begin.
 * @param evidence External step whose original precondition and retry floor remain fixed.
 * @returns Earliest target-key time supported by its exact precondition evidence.
 */
function minimumTargetRetryFloor(
  evidence: Extract<SyncPublicationStepEvidence, { attempt: unknown }>,
): number {
  const uploadedCooldown =
    evidence.precondition.kind === "observed"
      ? evidence.precondition.uploadedAtEpochMs + SYNC_R2_WRITE_COOLDOWN_MS
      : 0;
  return Math.max(evidence.retryAfterEpochMs ?? 0, uploadedCooldown);
}

/** Compares attempt substates without relying on incidental object-property ordering.
 * @param previous Persisted attempt state before the candidate transition.
 * @param next Candidate attempt state that may differ only when authority changes.
 * @returns Whether the tag, generation, claim, and state-specific timestamps are identical.
 */
function sameAttemptState(
  previous: Extract<
    SyncPublicationStepEvidence,
    { attempt: unknown }
  >["attempt"],
  next: Extract<SyncPublicationStepEvidence, { attempt: unknown }>["attempt"],
): boolean {
  if (
    previous.state !== next.state ||
    previous.generation !== next.generation
  ) {
    return false;
  }
  if (previous.state === "ready" || next.state === "ready") return true;
  if (previous.claimId !== next.claimId || previous.state !== next.state) {
    return false;
  }
  return previous.state === "attempting"
    ? next.state === "attempting" &&
        previous.claimedAtEpochMs === next.claimedAtEpochMs
    : next.state === "retry_wait" &&
        previous.observedAtEpochMs === next.observedAtEpochMs &&
        previous.retryAfterEpochMs === next.retryAfterEpochMs;
}

/** Compares an original journal or external target precondition field-for-field.
 * @param previous Persisted condition that authorizes the exact CAS target.
 * @param next Candidate condition that must not refresh original evidence.
 * @returns Whether the condition kind and every associated field are identical.
 */
function samePublicationPrecondition(
  previous: SyncPublicationStepEvidence["precondition"],
  next: SyncPublicationStepEvidence["precondition"],
): boolean {
  if (previous.kind !== next.kind) return false;
  if (previous.kind === "absent") return true;
  if (previous.kind === "journal_phase") {
    return next.kind === "journal_phase" && previous.status === next.status;
  }
  return (
    next.kind === "observed" &&
    previous.etag === next.etag &&
    previous.bytes === next.bytes &&
    previous.uploadedAtEpochMs === next.uploadedAtEpochMs
  );
}

/** Preserves request identity while allowing only unallocated-to-allocated journal authority.
 * @param previous Exact pending journal state being replaced.
 * @param next Candidate journal state for that same durable operation.
 * @returns Whether immutable request and lane identity remain stable without allocation rewind.
 */
function sameJournalIdentity(
  previous: SyncPendingJournalRecord,
  next: SyncJournalRecord,
): boolean {
  if (
    previous.vaultId !== next.vaultId ||
    previous.operationId !== next.operationId ||
    !sameMutationRequest(previous.request, next.request) ||
    previous.payload?.byteSize !== next.payload?.byteSize
  ) {
    return false;
  }
  if (previous.allocationState === "unallocated") {
    if (next.status === "pending" && next.allocationState === "unallocated") {
      return previous.lane === next.lane;
    }
    return (
      next.allocationState === "allocated" &&
      previous.lane === next.reservation.lane
    );
  }
  return (
    next.allocationState === "allocated" &&
    previous.reservation.lane === next.reservation.lane &&
    previous.reservation.sequence === next.reservation.sequence &&
    previous.reservation.previousCommittedAtEpochMs ===
      next.reservation.previousCommittedAtEpochMs
  );
}

/** Compares complete normalized mutation requests without treating field order as identity.
 * @param left Original immutable journal request.
 * @param right Candidate request that must replay the same operation exactly.
 * @returns Whether every discriminated request field is identical.
 */
function sameMutationRequest(
  left: SyncMutationRequest,
  right: SyncMutationRequest,
): boolean {
  if (
    left.kind !== right.kind ||
    left.vaultId !== right.vaultId ||
    left.path !== right.path ||
    left.operationId !== right.operationId ||
    left.revision !== right.revision ||
    left.origin !== right.origin
  ) {
    return false;
  }
  switch (left.kind) {
    case "create":
      return (
        right.kind === "create" &&
        right.parent.kind === "never_seen" &&
        left.parent.kind === "never_seen" &&
        left.contentSha256 === right.contentSha256 &&
        left.content === right.content &&
        left.mediaType === right.mediaType
      );
    case "update":
      return (
        right.kind === "update" &&
        right.parent.kind === "revision" &&
        left.parent.kind === "revision" &&
        left.parent.revision === right.parent.revision &&
        left.contentSha256 === right.contentSha256 &&
        left.content === right.content &&
        left.mediaType === right.mediaType
      );
    case "tombstone":
      return (
        right.kind === "tombstone" &&
        right.parent.kind === "revision" &&
        left.parent.kind === "revision" &&
        left.parent.revision === right.parent.revision &&
        left.contentSha256 === right.contentSha256
      );
  }
}

/** Returns the closed key family represented by one publication record.
 * @param record Strict publication value selected from the persisted union.
 * @returns Journal, lane-head, or immutable event family.
 */
function publicationKind(record: SyncPublicationRecord): SyncPublicationKind {
  if (record.kind === "journal") return "journal";
  if (record.kind === "laneHead") return "laneHead";
  return "feedEvent";
}

/** Rebuilds a canonical protocol key from the typed record identity.
 * @param record Publication record whose identity names exactly one key.
 * @returns Full canonical key within the record's vault namespace.
 */
function recordKey(record: SyncPublicationRecord): string {
  switch (record.kind) {
    case "journal":
      return syncOperationKey(record.vaultId, record.operationId);
    case "laneHead":
      return syncFeedLaneHeadKey(record.vaultId, record.lane);
    case "changed":
    case "aborted":
      return syncFeedEventKey(record.vaultId, record.lane, record.sequence);
  }
}

/** Compares exact record bytes without JSON normalization or ETag substitution.
 * @param left First bounded UTF-8 byte sequence.
 * @param right Second bounded UTF-8 byte sequence.
 * @returns Whether the sequences have identical lengths and byte values.
 */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}
