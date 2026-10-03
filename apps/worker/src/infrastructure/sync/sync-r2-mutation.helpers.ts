import type { ContentSha256 } from "@core/mirror/mirror.types";
import type { SyncMutationPolicyErrorCode } from "@core/sync/sync-mutation-policy";
import {
  evaluateSyncMutation,
  isSyncMutationInputValid,
} from "@core/sync/sync-mutation-policy";
import type {
  SyncCurrentState,
  SyncMutationRequest,
  SyncMutationResult,
  SyncOperationRecord,
  SyncStoreFailure,
} from "@core/sync/sync-store.types";
import { decodeBase64Url, encodeBase64Url } from "@obsidian-ai-bridge/core";
import {
  syncContentKey,
  syncRecoveryKey,
  syncVersionKey,
} from "@protocol/sync.codec";
import {
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
import type { SyncEventSequenceDto } from "@protocol/sync.types";
import type {
  SyncFeedEventRecord,
  SyncJournalRecord,
  SyncLaneHeadRecord,
  SyncPublicationPrecondition,
  SyncPublicationStepEvidence,
  SyncUnallocatedPendingJournalRecord,
} from "@worker/infrastructure/sync/sync-publication.types";
import type {
  SyncR2WriteResult,
  SyncRecordObservation,
} from "@worker/infrastructure/sync/sync-r2.types";
import type {
  SyncHeadRecord,
  SyncRecoveryMetadata,
  SyncVersionMetadata,
} from "@worker/infrastructure/sync/sync-record.types";
import { sha256Content } from "@worker/storage/storage-crypto";

/** Validates mutation identifiers and closed action-specific fields at the R2 boundary.
 * @param request Caller-provided action and authority fields to validate before storage access.
 * @returns Whether the request has canonical identities and a valid action-specific shape.
 */
export function isValidMutationRequest(request: SyncMutationRequest): boolean {
  if (typeof request !== "object" || request === null) return false;
  if (
    !syncVaultIdSchema.safeParse(request.vaultId).success ||
    !syncNotePathSchema.safeParse(request.path).success ||
    !syncOperationIdSchema.safeParse(request.operationId).success ||
    !syncRevisionSchema.safeParse(request.revision).success ||
    !syncDeviceIdSchema.safeParse(request.origin).success
  ) {
    return false;
  }
  switch (request.kind) {
    case "create":
      return (
        isNeverSeenParent(request.parent) &&
        request.mediaType === "text/markdown" &&
        typeof request.content === "string"
      );
    case "update":
      return (
        isRevisionParent(request.parent) &&
        request.mediaType === "text/markdown" &&
        typeof request.content === "string"
      );
    case "tombstone":
      return isRevisionParent(request.parent);
    default:
      return false;
  }
}

/** Rejects intrinsic mutation input before any R2 observation and maps digest failures conservatively.
 * @param request Caller mutation whose parent, UTF-8 size, and digest must be checked before storage.
 * @returns `invalid_input` for rejected content, `storage_unavailable` when hashing cannot establish validity, or no failure.
 */
export async function validateMutationInput(
  request: SyncMutationRequest,
  hashContent: (content: string) => Promise<ContentSha256>,
): Promise<SyncStoreFailure | undefined> {
  try {
    return (await isSyncMutationInputValid(request, hashContent))
      ? undefined
      : { kind: "error", code: "invalid_input" };
  } catch {
    return storageUnavailable();
  }
}

/** Checks the create-only parent alternative without dereferencing malformed boundary input.
 * @param parent Parent value to validate before application policy.
 * @returns Whether the parent is the explicit never-seen alternative.
 */
function isNeverSeenParent(parent: SyncMutationRequest["parent"]): boolean {
  return (
    typeof parent === "object" &&
    parent !== null &&
    parent.kind === "never_seen"
  );
}

/** Checks the exact revision parent and protocol identity before dereferencing it.
 * @param parent Parent value to validate before application policy.
 * @returns Whether it carries a canonical protocol revision.
 */
function isRevisionParent(parent: SyncMutationRequest["parent"]): boolean {
  return (
    typeof parent === "object" &&
    parent !== null &&
    parent.kind === "revision" &&
    syncRevisionSchema.safeParse(parent.revision).success
  );
}

/** Evaluates core parent/target policy and converts digest failures conservatively.
 * @param request Exact requested mutation bound to its operation identity.
 * @param observed Verified current state used for parent and target policy.
 * @param prior Persisted same-operation replay evidence, when a journal already exists.
 * @returns The core decision, or storage-unavailable failure if digest calculation fails.
 */
export async function evaluateMutation(
  request: SyncMutationRequest,
  observed: SyncCurrentState,
  prior: SyncOperationRecord | undefined,
): Promise<
  Awaited<ReturnType<typeof evaluateSyncMutation>> | SyncStoreFailure
> {
  try {
    return await evaluateSyncMutation(request, observed, prior, sha256Content);
  } catch {
    return storageUnavailable();
  }
}

/** Projects a persisted journal into the pure core's operation replay evidence.
 * @param journal Validated durable operation state.
 * @returns Core replay evidence preserving committed position only for committed outcomes.
 */
export function operationRecord(
  journal: SyncJournalRecord,
): SyncOperationRecord {
  if (journal.status === "committed") {
    return {
      kind: "committed",
      request: journal.request,
      position: journal.position,
    };
  }
  return { kind: "pending", request: journal.request };
}

/** Encodes the exact observed generation for durable same-key CAS recovery.
 * @param observation R2 record observation whose complete generation must be fenced.
 * @returns Canonical ETag, bytes, and upload-time precondition evidence.
 */
export function observedPrecondition<T>(
  observation: SyncRecordObservation<T>,
): Extract<SyncPublicationPrecondition, { kind: "observed" }> {
  return {
    kind: "observed",
    etag: observation.observed.etag,
    bytes: encodeBase64Url(observation.observed.bytes),
    uploadedAtEpochMs: observation.observed.uploaded.getTime(),
  };
}

/** Matches one complete persisted ETag/bytes/upload timestamp against fresh exact R2 evidence.
 * @param precondition Persisted condition to prove without refreshing its generation.
 * @param current Fresh exact R2 observation for the same record.
 * @returns Whether all recorded generation fields match the fresh observation.
 */
export function matchesObservedPrecondition<T>(
  precondition: SyncPublicationPrecondition,
  current: SyncRecordObservation<T>,
): boolean {
  if (precondition.kind !== "observed") return false;
  const bytes = decodeBase64Url(precondition.bytes);
  return (
    bytes !== undefined &&
    precondition.etag === current.observed.etag &&
    precondition.uploadedAtEpochMs === current.observed.uploaded.getTime() &&
    equalBytes(bytes, current.observed.bytes)
  );
}

/** Matches an unallocated request's exact lane generation or verified absence.
 * @param precondition Lane evidence persisted before attempting its reservation.
 * @param current Fresh observation of that exact lane head.
 * @returns Whether the persisted lane condition still holds.
 */
export function matchesLanePrecondition(
  precondition: SyncUnallocatedPendingJournalRecord["laneObservation"]["precondition"],
  current: SyncRecordObservation<SyncLaneHeadRecord>,
): boolean {
  return matchesObservedPrecondition(precondition, current);
}

/** Chooses the first immutable create-only object for the request's action kind.
 * @param request Validated mutation selecting content or tombstone recovery storage.
 * @returns The immutable key whose body must be created first.
 */
export function firstImmutableKey(request: SyncMutationRequest): string {
  return request.kind === "tombstone"
    ? syncRecoveryKey(request.vaultId, request.operationId, "content")
    : syncContentKey(request.vaultId, request.revision);
}

/** Selects the next immutable key in the request's persisted body-before-metadata order.
 * @param journal Allocated pending mutation at its current immutable-create step.
 * @returns The next required key, or undefined after the immutable plan is complete.
 */
export function nextImmutableKey(
  journal: Extract<
    SyncJournalRecord,
    { status: "pending"; allocationState: "allocated" }
  >,
): string | undefined {
  const request = journal.request;
  if (request.kind !== "tombstone") {
    if (
      journal.stepEvidence.key ===
      syncContentKey(journal.vaultId, request.revision)
    ) {
      return syncVersionKey(journal.vaultId, request.revision);
    }
    return undefined;
  }
  if (
    journal.stepEvidence.key ===
    syncRecoveryKey(journal.vaultId, request.operationId, "content")
  ) {
    return syncRecoveryKey(journal.vaultId, request.operationId, "metadata");
  }
  if (
    journal.stepEvidence.key ===
    syncRecoveryKey(journal.vaultId, request.operationId, "metadata")
  ) {
    return syncVersionKey(journal.vaultId, request.revision);
  }
  return undefined;
}

/** Removes the lane-observation-only fields when allocation authority is won.
 * @param journal Unallocated journal whose exact lane evidence authorized allocation.
 * @returns The same request and payload without unallocated-only lane fields.
 */
export function withoutUnallocatedFields(
  journal: SyncUnallocatedPendingJournalRecord,
): Omit<SyncUnallocatedPendingJournalRecord, "lane" | "laneObservation"> {
  const {
    lane: _lane,
    laneObservation: _laneObservation,
    ...allocated
  } = journal;
  return allocated;
}

/** Computes the next event sequence without wrapping the protocol maximum.
 * @param current Last committed sequence on the lane.
 * @returns The next canonical sequence, or undefined at protocol exhaustion.
 */
export function nextEventSequence(
  current: SyncLaneHeadRecord["committedSequence"],
): SyncEventSequenceDto | undefined {
  if (current === SYNC_MAX_SEQUENCE) return undefined;
  const next = (BigInt(current) + 1n)
    .toString()
    .padStart(SYNC_SEQUENCE_WIDTH, "0");
  const parsed = syncEventSequenceSchema.safeParse(next);
  return parsed.success ? parsed.data : undefined;
}

/** Computes the exact predecessor sequence associated with a non-zero reservation.
 * @param sequence Reserved non-zero event sequence.
 * @returns Its immediately preceding committed sequence.
 */
export function previousSequence(
  sequence: SyncEventSequenceDto,
): SyncLaneHeadRecord["committedSequence"] {
  return syncSequenceSchema.parse(
    (BigInt(sequence) - 1n).toString().padStart(SYNC_SEQUENCE_WIDTH, "0"),
  );
}

/** Copies an allocated pending journal while changing only its current durable step.
 * @param journal Allocated request and reservation evidence to preserve exactly.
 * @param stepEvidence Next bounded publication step and its precondition.
 * @returns A pending journal differing only in its step evidence.
 */
export function withStep(
  journal: Extract<
    SyncJournalRecord,
    { status: "pending"; allocationState: "allocated" }
  >,
  stepEvidence: SyncPublicationStepEvidence,
): Extract<
  SyncJournalRecord,
  { status: "pending"; allocationState: "allocated" }
> {
  return { ...journal, stepEvidence };
}

/** Creates the immutable live version metadata from its full journaled request.
 * @param journal Allocated non-tombstone mutation with its exact payload size.
 * @returns The immutable live version record derived from that request.
 * @throws TypeError If the journal describes a tombstone without verified parent metadata.
 */
export function versionForRequest(
  journal: Extract<
    SyncJournalRecord,
    { status: "pending"; allocationState: "allocated" }
  >,
): SyncVersionMetadata {
  const request = journal.request;
  if (request.kind === "tombstone") {
    throw new TypeError(
      "Tombstone metadata requires its exact live parent version.",
    );
  }
  return {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId: request.vaultId,
    kind: "live",
    path: request.path,
    revision: request.revision,
    parent: request.parent,
    contentSha256: request.contentSha256,
    byteSize: journal.payload?.byteSize ?? 0,
    mediaType: request.mediaType,
    operationId: request.operationId,
    origin: request.origin,
  };
}

/** Builds exact tombstone metadata from the request and verified live parent.
 * @param journal Allocated tombstone request bound to its exact source revision.
 * @param source Verified live parent metadata supplying retained content attributes.
 * @returns Immutable tombstone metadata bound to the operation's requested revision.
 */
export function tombstoneVersionForRequest(
  journal: Extract<
    SyncJournalRecord,
    { status: "pending"; allocationState: "allocated" }
  >,
  source: Extract<SyncVersionMetadata, { readonly kind: "live" }>,
): SyncVersionMetadata {
  const request = journal.request;
  if (request.kind !== "tombstone") {
    throw new TypeError("Expected a tombstone request.");
  }
  return {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId: request.vaultId,
    kind: "tombstone",
    path: request.path,
    revision: request.revision,
    parent: { kind: "revision", revision: request.parent.revision },
    contentSha256: request.contentSha256,
    byteSize: source.byteSize,
    mediaType: source.mediaType,
    operationId: request.operationId,
    origin: request.origin,
  };
}

/** Builds exact recovery metadata for a verified tombstone source.
 * @param journal Allocated tombstone request retaining the source operation identity.
 * @param source Verified live parent whose exact bytes are preserved for recovery.
 * @returns Recovery metadata bound to the tombstone operation and source revision.
 */
export function recoveryForRequest(
  journal: Extract<
    SyncJournalRecord,
    { status: "pending"; allocationState: "allocated" }
  >,
  source: Extract<SyncVersionMetadata, { readonly kind: "live" }>,
): SyncRecoveryMetadata {
  const request = journal.request;
  if (request.kind !== "tombstone") {
    throw new TypeError("Expected a tombstone request.");
  }
  return {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId: request.vaultId,
    path: request.path,
    operationId: request.operationId,
    sourceRevision: source.revision,
    contentSha256: source.contentSha256,
    byteSize: source.byteSize,
    mediaType: source.mediaType,
    origin: source.origin,
  };
}

/** Matches the current core view to the exact mutation target head.
 * @param current Validated storage-independent current state.
 * @param head Persisted head candidate whose authority fields must match exactly.
 * @returns Whether the current state and head identify the same full revision.
 */
export function sameCurrentAndHead(
  current: SyncCurrentState,
  head: SyncHeadRecord,
): boolean {
  if (current.kind === "never_seen") return false;
  return (
    current.kind === head.kind &&
    current.revision === head.revision &&
    current.parent.kind === head.parent.kind &&
    (current.parent.kind === "never_seen" ||
      (head.parent.kind === "revision" &&
        current.parent.revision === head.parent.revision)) &&
    current.contentSha256 === head.contentSha256 &&
    current.byteSize === head.byteSize &&
    current.mediaType === head.mediaType &&
    current.operationId === head.operationId &&
    current.origin === head.origin
  );
}

/** Selects a stable monotonic event time after the lane's predecessor.
 * @param journal Allocated reservation containing its predecessor commit time.
 * @param now Server epoch milliseconds observed for this event attempt.
 * @returns An epoch-millisecond timestamp strictly after the predecessor.
 */
export function commitTime(
  journal: Extract<
    SyncJournalRecord,
    { status: "pending"; allocationState: "allocated" }
  >,
  now: number,
): number {
  return Math.max(now, journal.reservation.previousCommittedAtEpochMs + 1);
}

/** Returns a verified terminal mutation result or the typed stale-parent abort.
 * @param journal Persisted committed or conclusively aborted operation.
 * @returns The committed position or the stable stale-revision failure.
 */
export function terminalResult(
  journal: Extract<SyncJournalRecord, { status: "committed" | "aborted" }>,
): SyncMutationResult {
  if (journal.status === "aborted") {
    return { kind: "error", code: "stale_revision" };
  }
  return {
    kind: "committed",
    revision: journal.revision,
    operationId: journal.operationId,
    position: journal.position,
  };
}

/** Verifies one pending operation's immutable changed or stale-abort event identity.
 * @param journal Allocated pending operation and its current event-publication phase.
 * @param event Persisted candidate event for the reserved lane sequence.
 * @returns Whether the event is exact evidence for this operation and phase.
 */
export function eventMatchesRequest(
  journal: Extract<
    SyncJournalRecord,
    { status: "pending"; allocationState: "allocated" }
  >,
  event: SyncFeedEventRecord,
): boolean {
  if (
    event.vaultId !== journal.vaultId ||
    event.lane !== journal.reservation.lane ||
    event.sequence !== journal.reservation.sequence ||
    event.operationId !== journal.operationId ||
    event.committedAtEpochMs <=
      journal.reservation.previousCommittedAtEpochMs ||
    (journal.stepEvidence.step === "create_event" &&
      (event.committedAtEpochMs !== journal.stepEvidence.committedAtEpochMs ||
        event.kind !== journal.stepEvidence.outcomeIntent))
  ) {
    return false;
  }
  if (event.kind === "aborted") {
    return (
      event.reason === "stale_revision" &&
      (journal.stepEvidence.step === "create_event" ||
        journal.stepEvidence.step === "commit_journal")
    );
  }
  return (
    event.path === journal.request.path &&
    event.origin === journal.request.origin &&
    event.result.kind ===
      (journal.request.kind === "tombstone" ? "tombstone" : "live") &&
    event.result.revision === journal.request.revision
  );
}

/** Compares terminal records while ignoring only the monotonic retry-floor field.
 * @param left Verified terminal outcome whose authority is immutable.
 * @param right Persisted candidate that may carry an advanced retry floor.
 * @returns Whether both records preserve the same terminal outcome and identity.
 */
export function sameTerminalOutcome(
  left: Extract<SyncJournalRecord, { status: "committed" | "aborted" }>,
  right: SyncJournalRecord,
): boolean {
  if (
    right.status !== left.status ||
    right.allocationState !== "allocated" ||
    right.vaultId !== left.vaultId ||
    right.operationId !== left.operationId ||
    left.position.lane !== right.position.lane ||
    left.position.sequence !== right.position.sequence ||
    left.committedAtEpochMs !== right.committedAtEpochMs
  ) {
    return false;
  }
  const leftWithoutFloor = {
    ...left,
    stepEvidence: { ...left.stepEvidence, retryAfterEpochMs: null },
  };
  const rightWithoutFloor = {
    ...right,
    stepEvidence: { ...right.stepEvidence, retryAfterEpochMs: null },
  };
  return JSON.stringify(leftWithoutFloor) === JSON.stringify(rightWithoutFloor);
}

/** Preserves the contextual fields required by each rejected core policy outcome.
 * @param code Core policy rejection selected for transport through the store port.
 * @param operationId Stable operation identity required by resumable failures.
 * @returns The corresponding typed store failure with required context retained.
 */
export function mutationRejection(
  code: SyncMutationPolicyErrorCode,
  operationId: SyncMutationRequest["operationId"],
): SyncStoreFailure {
  switch (code) {
    case "invalid_input":
    case "stale_revision":
    case "operation_id_reused":
      return { kind: "error", code };
    case "operation_pending":
      return operationPending(operationId);
    case "effect_unknown":
      return effectUnknown(operationId);
  }
}

/** Returns an error when a read result is already a typed store failure.
 * @param value Read value or typed storage failure to narrow.
 * @returns Whether the value is a store failure.
 */
export function isStoreFailure<T>(
  value: T | SyncStoreFailure,
): value is SyncStoreFailure {
  return typeof value === "object" && value !== null && "code" in value;
}

/** Produces a stable pending outcome with its durable safe retry time when known.
 * @param operationId Stable identity of the operation that remains resumable.
 * @param retryAfterEpochMs Earliest safe retry time in Unix epoch milliseconds, when known.
 * @returns A pending failure retaining the operation and optional cooldown context.
 */
export function operationPending(
  operationId: SyncMutationRequest["operationId"],
  retryAfterEpochMs?: number,
): SyncStoreFailure {
  return retryAfterEpochMs === undefined
    ? { kind: "error", code: "operation_pending", operationId }
    : {
        kind: "error",
        code: "operation_pending",
        operationId,
        retryAfterEpochMs,
      };
}

/** Produces uncertain effect certainty bound to the mutation whose evidence is incomplete.
 * @param operationId Operation whose durable effect could not be established, when known.
 * @param retryAfterEpochMs Earliest safe re-observation time in Unix epoch milliseconds.
 * @returns An effect-unknown failure without asserting whether the write took effect.
 */
export function effectUnknown(
  operationId?: SyncMutationRequest["operationId"],
  retryAfterEpochMs?: number,
): SyncStoreFailure {
  if (operationId === undefined) {
    return retryAfterEpochMs === undefined
      ? { kind: "error", code: "effect_unknown" }
      : { kind: "error", code: "effect_unknown", retryAfterEpochMs };
  }
  return retryAfterEpochMs === undefined
    ? { kind: "error", code: "effect_unknown", operationId }
    : { kind: "error", code: "effect_unknown", operationId, retryAfterEpochMs };
}

/** Produces an unavailable storage result without exposing adapter details.
 * @returns The stable storage-unavailable failure.
 */
export function storageUnavailable(): SyncStoreFailure {
  return { kind: "error", code: "storage_unavailable" };
}

/** Extracts an optional safe retry floor from any one-key publication result.
 * @param result One-key write certainty returned by the publication adapter.
 * @returns The known retry floor in Unix epoch milliseconds, when present.
 */
export function writeRetryAfter(result: SyncR2WriteResult): number | undefined {
  return "retryAfterEpochMs" in result ? result.retryAfterEpochMs : undefined;
}

/** Converts a one-key write certainty into a stable operation result.
 * @param operationId Stable identity of the operation whose step was attempted.
 * @param result Publication certainty that determines whether retry is safe or unknown.
 * @returns The corresponding pending or effect-unknown mutation result.
 */
export function writeFailure(
  operationId: SyncMutationRequest["operationId"],
  result: SyncR2WriteResult,
): SyncMutationResult {
  if (result.kind === "throttled") {
    return operationPending(operationId, result.retryAfterEpochMs);
  }
  if (result.kind === "effect_unknown") {
    return effectUnknown(operationId, result.retryAfterEpochMs);
  }
  return operationPending(operationId);
}

/** Compares two byte arrays without decoding, normalizing, or truncating either body.
 * @param left First exact byte sequence.
 * @param right Second exact byte sequence.
 * @returns Whether both sequences have equal length and byte-for-byte contents.
 */
export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}
