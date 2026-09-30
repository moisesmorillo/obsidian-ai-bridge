import type { SyncMutationRequest } from "@core/sync/sync-store.types";
import { decodeBase64Url } from "@obsidian-ai-bridge/core";
import {
  syncFeedEventKey,
  syncFeedLaneHeadKey,
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
  decodeSyncPublication,
  encodeSyncPublication,
} from "@worker/infrastructure/sync/sync-publication.codec";
import { SYNC_PUBLICATION_LIMITS } from "@worker/infrastructure/sync/sync-publication.constants";
import type {
  SyncFeedEventRecord,
  SyncJournalRecord,
  SyncLaneHeadRecord,
  SyncPendingJournalRecord,
  SyncPublicationKind,
  SyncPublicationRecord,
  SyncUnallocatedPendingJournalRecord,
} from "@worker/infrastructure/sync/sync-publication.types";
import type {
  SyncR2Key,
  SyncR2ObjectStore,
  SyncR2ReadResult,
  SyncR2RetryContext,
  SyncR2WriteResult,
  SyncRecordObservation,
  SyncRecordRead,
} from "@worker/infrastructure/sync/sync-r2.types";
import { createSyncR2Key } from "@worker/infrastructure/sync/sync-r2-key";
import { decodeSyncRecord } from "@worker/infrastructure/sync/sync-record.codec";

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
      Exclude<SyncJournalRecord, SyncUnallocatedPendingJournalRecord>
    >,
    record: Exclude<SyncJournalRecord, SyncUnallocatedPendingJournalRecord>,
    key: SyncR2Key | undefined,
    retryContext?: SyncR2RetryContext,
  ): Promise<SyncR2WriteResult> {
    if (key === undefined) return { kind: "refused" };
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

  return {
    readJournal: readJournalRecord,
    createJournal: createUnallocatedJournal,
    replaceJournal(observed, record, retryContext) {
      if (
        observed.value.status !== "pending" ||
        !sameJournalIdentity(observed.value, record)
      ) {
        return Promise.resolve({ kind: "refused" });
      }
      const key = buildKey(
        () => syncOperationKey(record.vaultId, record.operationId),
        record.vaultId,
      );
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
  };
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
