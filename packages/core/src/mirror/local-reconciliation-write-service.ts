import type {
  AuthorizedCreateEligibleRequest,
  AuthorizedReplaceEligibleRequest,
  LocalReconciliationCommandResult,
} from "@core/mirror/local-reconciliation-write-service.types";
import {
  LOCAL_RECONCILIATION_DISPATCH_MODE,
  LOCAL_RECONCILIATION_WRITE_OUTCOME,
} from "@core/mirror/local-reconciliation-writer.constants";
import type { LocalReconciliationWriter } from "@core/mirror/local-reconciliation-writer.port";
import type { LocalReconciliationWriteResult } from "@core/mirror/local-reconciliation-writer.types";
import { MUTATION_EFFECT_CERTAINTY } from "@core/mirror/mirror.constants";
import type {
  ContentSha256,
  MirrorOperationId,
} from "@core/mirror/mirror.types";
import { createMirrorOperationId } from "@core/mirror/mirror-identifiers";
import type { MirrorDeviceState } from "@core/mirror/mirror-state.types";
import type { MirrorStateOwner } from "@core/mirror/mirror-state-owner";
import { isDurableMutationAdmissionAllowed } from "@core/mirror/mirror-state-policy";
import { isNonHistoryReconciliationOperation } from "@core/mirror/reconciliation-operation";
import {
  areRequiredReconciliationPreservationsVerified,
  requiredReconciliationPreservations,
} from "@core/mirror/reconciliation-preservation-policy";
import {
  LOCAL_EFFECT_OBSERVATION_KIND,
  RECONCILIATION_ACTION,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_OPERATION_PHASE,
  RECONCILIATION_PRESERVATION_SIDE,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
} from "@core/mirror/reconciliation-state.constants";
import type {
  LocalEffectObservation,
  ReconciliationEventKind,
  ReconciliationNonHistoryOperation,
  ReconciliationOperation,
  ReconciliationPathEvidence,
} from "@core/mirror/reconciliation-state.types";

/** Digest seam that binds transient command bodies to admitted content-free evidence. */
export interface LocalReconciliationWriteCryptography {
  /** @returns SHA-256 of exact UTF-8 text without persisting the body. */
  hashContent(content: string): Promise<ContentSha256>;
}

/** Exact listener/event identity seams for durable synthetic local-effect fencing. */
export interface LocalReconciliationObservationRuntime {
  /** @returns Fresh synthetic effect UUID-v4. */
  createEffectId(): MirrorOperationId;
  /** @returns Current attached listener epoch. */
  listenerEpoch(): number;
  /** @returns Current event generation for one eligible path. */
  currentGeneration(path: AuthorizedCreateEligibleRequest["path"]): number;
}

/**
 * Authorizes and records narrow eligible local writes without completing an M4 action.
 *
 * This Slice 3 service supports only exact remote-to-local create/replace primitives
 * for already admitted `use-remote` or revision-adoption operations. It advances no
 * baseline, dispatches no remote mutation, and leaves confirmed effects partial for
 * later action-specific orchestration. Durable `mutating-local` is persisted before
 * host I/O so a save failure after the effect resumes in same-operation recovery mode.
 */
export class LocalReconciliationWriteService {
  /**
   * @param writer - Narrow host effect adapter.
   * @param stateOwner - Serialized durable operation and reservation owner.
   * @param cryptography - Exact transient text digest provider.
   * @param observations - Optional owner-scoped synthetic effect/event identity source.
   */
  constructor(
    private readonly writer: LocalReconciliationWriter,
    private readonly stateOwner: MirrorStateOwner,
    private readonly cryptography: LocalReconciliationWriteCryptography,
    private readonly observations?: LocalReconciliationObservationRuntime,
  ) {}

  /**
   * Creates one exact eligible absent target from admitted remote live evidence.
   *
   * @param request - Operation, exact reserved path, and transient remote body.
   * @returns Confirmed partial effect or a durable refusal/evidence state.
   */
  async createEligible(
    request: AuthorizedCreateEligibleRequest,
  ): Promise<LocalReconciliationCommandResult> {
    const authorization = await this.authorizeCreate(request);
    if (authorization.kind === "rejected") return authorization;
    const prepared = await this.prepare(
      authorization.operation,
      authorization.mode,
      request.path,
      authorization.replacementHash,
    );
    if (prepared.kind !== "prepared") return prepared;
    const result = await this.writer.createEligible({
      operationId: request.operationId,
      path: request.path,
      content: request.content,
      contentSha256: authorization.replacementHash,
      mode: authorization.mode,
    });
    return this.settle(
      request.operationId,
      request.path,
      authorization.replacementHash,
      "create",
      authorization.mode,
      result,
    );
  }

  /**
   * Atomically replaces one exact sampled eligible target with admitted remote bytes.
   *
   * @param request - Operation/path plus exact sampled current and replacement text.
   * @returns Confirmed partial effect or a durable stale/unknown/refusal state.
   */
  async replaceEligible(
    request: AuthorizedReplaceEligibleRequest,
  ): Promise<LocalReconciliationCommandResult> {
    const authorization = await this.authorizeReplace(request);
    if (authorization.kind === "rejected") return authorization;
    const prepared = await this.prepare(
      authorization.operation,
      authorization.mode,
      request.path,
      authorization.replacementHash,
    );
    if (prepared.kind !== "prepared") return prepared;
    const result = await this.writer.replaceEligible({
      operationId: request.operationId,
      path: request.path,
      expectedContent: request.expectedContent,
      expectedContentSha256: authorization.expectedHash,
      expectedObservationGeneration: authorization.observationGeneration,
      replacementContent: request.replacementContent,
      replacementContentSha256: authorization.replacementHash,
      mode: authorization.mode,
    });
    return this.settle(
      request.operationId,
      request.path,
      authorization.replacementHash,
      "replace",
      authorization.mode,
      result,
    );
  }

  /** @returns Create authorization bound to exact absent target and remote live hash. */
  private async authorizeCreate(
    request: AuthorizedCreateEligibleRequest,
  ): Promise<CreateAuthorization | RejectedCommand> {
    const before = this.stateOwner.snapshot();
    if (!before.persistenceAvailable) {
      return rejected("persistence-failure", before);
    }
    if (!before.mutationAdmissionAllowed) {
      return rejected("operation-not-active", before);
    }
    const operation = findActiveOperation(before.state, request.operationId);
    if (operation === undefined) {
      return rejected(
        before.state.reconciliationOperations.some(
          (candidate) => candidate.operationId === request.operationId,
        )
          ? "operation-not-active"
          : "operation-not-found",
        before,
      );
    }
    if (!actionAllowsCreate(operation)) {
      return rejected("wrong-action", before);
    }
    const target = pathEvidence(operation, request.path);
    const replacementHash = createSourceHash(operation, request.path);
    if (
      target === undefined ||
      target.local.kind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.absent ||
      replacementHash === undefined
    ) {
      return rejected("path-evidence-mismatch", before);
    }
    if (!ownsPath(operation, request.path)) {
      /* v8 ignore next -- consistent evidence-authorized create paths are operation reservations. */
      return rejected("reservation-mismatch", before);
    }
    const mode = dispatchMode(operation, request.path, replacementHash);
    if (mode === undefined) return rejected("wrong-phase", before);
    const bodyHash = await this.hash(request.content);
    if (bodyHash !== replacementHash) {
      return rejected("source-evidence-mismatch", before);
    }
    return {
      kind: "authorized",
      operation,
      replacementHash,
      mode,
    };
  }

  /** @returns Replacement authorization bound to live sampled text/generation and remote live hash. */
  private async authorizeReplace(
    request: AuthorizedReplaceEligibleRequest,
  ): Promise<ReplaceAuthorization | RejectedCommand> {
    const before = this.stateOwner.snapshot();
    if (!before.persistenceAvailable) {
      return rejected("persistence-failure", before);
    }
    if (!before.mutationAdmissionAllowed) {
      return rejected("operation-not-active", before);
    }
    const operation = findActiveOperation(before.state, request.operationId);
    if (operation === undefined) {
      return rejected(
        before.state.reconciliationOperations.some(
          (candidate) => candidate.operationId === request.operationId,
        )
          ? "operation-not-active"
          : "operation-not-found",
        before,
      );
    }
    if (!actionAllowsReplace(operation)) {
      return rejected("wrong-action", before);
    }
    const target = pathEvidence(operation, request.path);
    const replacementEvidenceHash = replaceSourceHash(operation, request.path);
    if (
      target === undefined ||
      target.local.kind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.live ||
      replacementEvidenceHash === undefined
    ) {
      return rejected("path-evidence-mismatch", before);
    }
    if (!ownsPath(operation, request.path)) {
      /* v8 ignore next -- consistent evidence-authorized replace paths are operation reservations. */
      return rejected("reservation-mismatch", before);
    }
    const mode = dispatchMode(operation, request.path, replacementEvidenceHash);
    if (mode === undefined) return rejected("wrong-phase", before);
    const [expectedHash, replacementHash] = await Promise.all([
      this.hash(request.expectedContent),
      this.hash(request.replacementContent),
    ]);
    if (
      expectedHash !== target.local.contentSha256 ||
      replacementHash !== replacementEvidenceHash
    ) {
      return rejected("source-evidence-mismatch", before);
    }
    return {
      kind: "authorized",
      operation,
      expectedHash: target.local.contentSha256,
      replacementHash: replacementEvidenceHash,
      observationGeneration: target.local.observationGeneration,
      mode,
    };
  }

  /**
   * Persists ambiguous local-effect preparation before invoking the host adapter.
   *
   * @param operation - Exact operation authorized from the prior owner snapshot.
   * @param mode - First-dispatch or same-operation recovery mode to revalidate.
   * @param path - Exact reserved local target.
   * @param expectedHash - Postcondition digest bound to the admitted evidence.
   * @returns Prepared authority or a typed durable rejection.
   */
  private async prepare(
    operation: ReconciliationNonHistoryOperation,
    mode: AuthorizedWrite["mode"],
    path: AuthorizedCreateEligibleRequest["path"],
    expectedHash: ContentSha256,
  ): Promise<PreparedWrite | LocalReconciliationCommandResult> {
    const committed = await this.stateOwner.transition((state) => {
      const current = findActiveOperation(state, operation.operationId);
      if (
        current === undefined ||
        dispatchMode(current, path, expectedHash) !== mode ||
        !isDurableMutationAdmissionAllowed(state)
      ) {
        return undefined;
      }
      const targetEvidence = pathEvidence(current, path);
      const localEffectObservation =
        mode === LOCAL_RECONCILIATION_DISPATCH_MODE.firstDispatch
          ? {
              kind:
                this.observations === undefined
                  ? LOCAL_EFFECT_OBSERVATION_KIND.recoveredV3
                  : LOCAL_EFFECT_OBSERVATION_KIND.prepared,
              effectId:
                this.observations?.createEffectId() ??
                fallbackEffectId(current.operationId),
              path,
              expectedHash,
              listenerEpoch:
                this.observations?.listenerEpoch() ??
                current.snapshot.runtime.listenerEpoch,
              beforeGeneration:
                this.observations?.currentGeneration(path) ??
                (targetEvidence?.local.kind ===
                  RECONCILIATION_LOCAL_EVIDENCE_KIND.live ||
                targetEvidence?.local.kind ===
                  RECONCILIATION_LOCAL_EVIDENCE_KIND.absent
                  ? targetEvidence.local.observationGeneration
                  : 0),
              postconditionHash: null,
              successor: null,
            }
          : current.localEffectObservation;
      return replaceOperation(state, {
        ...current,
        phase:
          current.action.kind === RECONCILIATION_ACTION.restoreRecovery
            ? RECONCILIATION_OPERATION_PHASE.restoredPendingReview
            : RECONCILIATION_OPERATION_PHASE.mutatingLocal,
        localEffect:
          mode === LOCAL_RECONCILIATION_DISPATCH_MODE.firstDispatch
            ? MUTATION_EFFECT_CERTAINTY.notDispatched
            : current.localEffect,
        localEffectObservation,
      });
    });
    if (
      committed.kind === "committed" &&
      committed.snapshot.mutationAdmissionAllowed
    ) {
      return { kind: "prepared" };
    }
    return rejected(
      committed.snapshot.persistenceAvailable
        ? "operation-not-active"
        : "persistence-failure",
      committed.snapshot,
    );
  }

  /**
   * Persists one conservative successor event for a reserved prepared local effect.
   *
   * No callback is consumed as causally "own". Every owner-global generation after
   * preparation on any operation reservation is retained as bounded successor evidence
   * before M3 may observe that path.
   *
   * @param path - Eligible event path.
   * @param eventKind - Closed host event kind.
   * @param generation - Already allocated monotonic event generation.
   * @returns Whether one active operation durably accepted the event.
   */
  async observeReservedEvent(
    path: AuthorizedCreateEligibleRequest["path"],
    eventKind: ReconciliationEventKind,
    generation: number,
  ): Promise<boolean> {
    const committed = await this.stateOwner.transition((state) => {
      const operation = state.reconciliationOperations.find(
        (candidate): candidate is ReconciliationNonHistoryOperation =>
          isNonHistoryReconciliationOperation(candidate) &&
          candidate.reservations.some(
            (reservation) => reservation.path === path,
          ) &&
          candidate.phase !== RECONCILIATION_OPERATION_PHASE.completed &&
          candidate.phase !== RECONCILIATION_OPERATION_PHASE.stale,
      );
      if (operation === undefined) return undefined;
      const observation = operation.localEffectObservation;
      if (
        (observation.kind !== LOCAL_EFFECT_OBSERVATION_KIND.notRequired &&
          observation.kind !== LOCAL_EFFECT_OBSERVATION_KIND.prepared &&
          observation.kind !== LOCAL_EFFECT_OBSERVATION_KIND.confirmed &&
          observation.kind !== LOCAL_EFFECT_OBSERVATION_KIND.recoveredV3) ||
        generation <= observation.beforeGeneration
      ) {
        return undefined;
      }
      const successor = observation.successor;
      const eventKinds =
        successor === null
          ? [eventKind]
          : successor.eventKinds.includes(eventKind)
            ? successor.eventKinds
            : [...successor.eventKinds, eventKind];
      return replaceOperation(state, {
        ...operation,
        phase:
          operation.localEffect === MUTATION_EFFECT_CERTAINTY.confirmed ||
          operation.remoteEffect === MUTATION_EFFECT_CERTAINTY.confirmed
            ? RECONCILIATION_OPERATION_PHASE.successorReviewRequired
            : operation.phase,
        localEffectObservation: {
          ...observation,
          successor: {
            firstGeneration: successor?.firstGeneration ?? generation,
            latestGeneration: Math.max(
              successor?.latestGeneration ?? generation,
              generation,
            ),
            eventKinds,
          },
        },
      });
    });
    return committed.kind === "committed";
  }

  /**
   * Persists exact local effect certainty without advancing baseline or releasing reservations.
   *
   * @param operationId - Exact durable operation identity.
   * @param path - Reserved target affected by the adapter.
   * @param expectedHash - Evidence-bound digest required for confirmation.
   * @param primitive - Narrow command used to validate the adapter outcome.
   * @param mode - Dispatch mode used to preserve prior unknown certainty on recovery.
   * @param result - Typed adapter evidence to classify and persist.
   * @returns Durable confirmed, blocked, evidence-required, or rejected state.
   */
  private async settle(
    operationId: ReconciliationOperation["operationId"],
    path: AuthorizedCreateEligibleRequest["path"],
    expectedHash: ContentSha256,
    primitive: LocalWritePrimitive,
    mode: AuthorizedWrite["mode"],
    result: LocalReconciliationWriteResult,
  ): Promise<LocalReconciliationCommandResult> {
    const confirmed =
      result.kind === "confirmed" &&
      outcomeMatchesPrimitive(result.outcome, primitive) &&
      result.path === path &&
      result.contentSha256 === expectedHash;
    const effect = confirmed
      ? MUTATION_EFFECT_CERTAINTY.confirmed
      : mode === LOCAL_RECONCILIATION_DISPATCH_MODE.sameOperationRecovery ||
          (result.kind === "failed" && result.effect === "unknown") ||
          result.kind === "confirmed"
        ? MUTATION_EFFECT_CERTAINTY.unknown
        : MUTATION_EFFECT_CERTAINTY.definitelyRefused;
    const phase = confirmed
      ? RECONCILIATION_OPERATION_PHASE.partial
      : effect === MUTATION_EFFECT_CERTAINTY.unknown
        ? RECONCILIATION_OPERATION_PHASE.evidenceRequired
        : RECONCILIATION_OPERATION_PHASE.blocked;
    const committed = await this.stateOwner.transition((state) => {
      const operation = findActiveOperation(state, operationId);
      if (
        operation === undefined ||
        (operation.phase !== RECONCILIATION_OPERATION_PHASE.mutatingLocal &&
          operation.phase !==
            RECONCILIATION_OPERATION_PHASE.restoredPendingReview) ||
        !ownsPath(operation, path)
      ) {
        return undefined;
      }
      const observation = operation.localEffectObservation;
      const settledObservation: LocalEffectObservation =
        confirmed &&
        (observation.kind === LOCAL_EFFECT_OBSERVATION_KIND.prepared ||
          observation.kind === LOCAL_EFFECT_OBSERVATION_KIND.recoveredV3)
          ? {
              ...observation,
              kind: LOCAL_EFFECT_OBSERVATION_KIND.confirmed,
              postconditionHash: expectedHash,
            }
          : observation;
      const hasSuccessor =
        "successor" in settledObservation &&
        settledObservation.successor !== null;
      return replaceOperation(state, {
        ...operation,
        phase: hasSuccessor
          ? RECONCILIATION_OPERATION_PHASE.successorReviewRequired
          : confirmed &&
              operation.action.kind === RECONCILIATION_ACTION.restoreRecovery
            ? RECONCILIATION_OPERATION_PHASE.restoredPendingReview
            : phase,
        localEffect: effect,
        localEffectObservation: settledObservation,
      });
    });
    if (committed.kind !== "committed") {
      return rejected("persistence-failure", committed.snapshot);
    }
    return {
      kind: confirmed
        ? "confirmed"
        : effect === MUTATION_EFFECT_CERTAINTY.unknown
          ? "evidence-required"
          : "blocked",
      snapshot: committed.snapshot,
    };
  }

  /**
   * Returns a sanitized digest failure as a nonmatching sentinel.
   *
   * @param content - Exact transient text to hash.
   * @returns Its digest or undefined when hashing is unavailable.
   */
  private async hash(content: string): Promise<ContentSha256 | undefined> {
    try {
      return await this.cryptography.hashContent(content);
    } catch {
      return undefined;
    }
  }
}

/**
 * Derives a deterministic non-parent UUID only for compatibility callers lacking the v4 runtime seam.
 *
 * @param operationId - Parent operation identity.
 * @returns Distinct valid synthetic effect identity.
 */
function fallbackEffectId(operationId: MirrorOperationId): MirrorOperationId {
  const final = operationId.at(-1) === "0" ? "1" : "0";
  const candidate = createMirrorOperationId(
    `${operationId.slice(0, -1)}${final}`,
  );
  if (candidate === undefined || candidate === operationId) {
    throw new Error("Synthetic effect identity unavailable.");
  }
  return candidate;
}

/** Narrow primitive whose confirmed adapter outcomes are checked defensively. */
type LocalWritePrimitive = "create" | "replace";

/** Shared internal authorization fields for first dispatch and exact recovery. */
interface AuthorizedWrite {
  readonly kind: "authorized";
  readonly operation: ReconciliationNonHistoryOperation;
  readonly replacementHash: ContentSha256;
  readonly mode:
    | typeof LOCAL_RECONCILIATION_DISPATCH_MODE.firstDispatch
    | typeof LOCAL_RECONCILIATION_DISPATCH_MODE.sameOperationRecovery;
}

/** Internal create authorization. */
type CreateAuthorization = AuthorizedWrite;

/** Internal replace authorization with sampled local compare evidence. */
interface ReplaceAuthorization extends AuthorizedWrite {
  readonly expectedHash: ContentSha256;
  readonly observationGeneration: number;
}

/** Rejected command variant used to preserve discriminant narrowing during authorization. */
type RejectedCommand = Extract<
  LocalReconciliationCommandResult,
  { readonly kind: "rejected" }
>;

/** Internal marker proving durable pre-effect preparation committed. */
interface PreparedWrite {
  readonly kind: "prepared";
}

/**
 * @param state - Current authoritative durable state.
 * @param operationId - Exact operation identity to locate.
 * @returns Active operation by exact identity; terminal operations grant no capability.
 */
function findActiveOperation(
  state: MirrorDeviceState,
  operationId: ReconciliationOperation["operationId"],
): ReconciliationNonHistoryOperation | undefined {
  return state.reconciliationOperations.find(
    (operation): operation is ReconciliationNonHistoryOperation =>
      operation.operationId === operationId &&
      isNonHistoryReconciliationOperation(operation) &&
      operation.phase !== RECONCILIATION_OPERATION_PHASE.stale &&
      operation.phase !== RECONCILIATION_OPERATION_PHASE.completed,
  );
}

/**
 * Selects exact immutable evidence for one operation-owned effect path.
 *
 * @param operation - Durable operation carrying immutable evidence.
 * @param path - Requested target or destination path.
 * @returns Exact sampled path evidence when present.
 */
function pathEvidence(
  operation: ReconciliationNonHistoryOperation,
  path: AuthorizedCreateEligibleRequest["path"],
): ReconciliationPathEvidence | undefined {
  return operation.snapshot.paths.find((evidence) => evidence.path === path);
}

/** @returns Whether the admitted action can create one eligible local path. */
function actionAllowsCreate(
  operation: ReconciliationNonHistoryOperation,
): boolean {
  return (
    operation.action.kind === RECONCILIATION_ACTION.useRemote ||
    operation.action.kind === RECONCILIATION_ACTION.adoptRevision ||
    operation.action.kind === RECONCILIATION_ACTION.keepBoth ||
    operation.action.kind === RECONCILIATION_ACTION.forkLegacy ||
    operation.action.kind === RECONCILIATION_ACTION.restoreRecovery
  );
}

/** @returns Whether the admitted action can replace one exact eligible local path. */
function actionAllowsReplace(
  operation: ReconciliationNonHistoryOperation,
): boolean {
  return (
    operation.action.kind === RECONCILIATION_ACTION.useRemote ||
    operation.action.kind === RECONCILIATION_ACTION.keepBoth ||
    operation.action.kind === RECONCILIATION_ACTION.restoreRecovery
  );
}

/**
 * Derives the only content digest an action may create at an absent local path.
 *
 * @param operation - Admitted action and immutable evidence.
 * @param path - Requested create destination.
 * @returns Evidence-bound source digest, or undefined when the action grants no create authority.
 */
function createSourceHash(
  operation: ReconciliationNonHistoryOperation,
  path: AuthorizedCreateEligibleRequest["path"],
): ContentSha256 | undefined {
  const target = pathEvidence(operation, operation.snapshot.targetPath);
  if (target === undefined) return undefined;
  switch (operation.action.kind) {
    case RECONCILIATION_ACTION.useRemote:
    case RECONCILIATION_ACTION.adoptRevision:
      return path === operation.snapshot.targetPath &&
        target.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live
        ? target.remote.contentSha256
        : undefined;
    case RECONCILIATION_ACTION.keepBoth:
      if (path !== operation.destinationPath) return undefined;
      if (
        operation.action.primarySide === RECONCILIATION_PRESERVATION_SIDE.local
      ) {
        return target.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live
          ? target.remote.contentSha256
          : undefined;
      }
      return target.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live
        ? target.local.contentSha256
        : undefined;
    case RECONCILIATION_ACTION.forkLegacy:
      return path === operation.destinationPath &&
        target.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy
        ? target.remote.contentSha256
        : undefined;
    case RECONCILIATION_ACTION.restoreRecovery:
      return path ===
        (operation.destinationPath ?? operation.snapshot.targetPath)
        ? operation.snapshot.recovery?.contentSha256
        : undefined;
    case RECONCILIATION_ACTION.keepLocal:
    case RECONCILIATION_ACTION.acceptTombstone:
    case RECONCILIATION_ACTION.recreateRemote:
    case RECONCILIATION_ACTION.defer:
      return undefined;
  }
}

/**
 * Derives the only replacement digest an action may write over sampled local bytes.
 *
 * @param operation - Admitted action and immutable evidence.
 * @param path - Requested replacement path.
 * @returns Evidence-bound replacement digest, or undefined without replace authority.
 */
function replaceSourceHash(
  operation: ReconciliationNonHistoryOperation,
  path: AuthorizedReplaceEligibleRequest["path"],
): ContentSha256 | undefined {
  const target = pathEvidence(operation, operation.snapshot.targetPath);
  if (target === undefined) return undefined;
  switch (operation.action.kind) {
    case RECONCILIATION_ACTION.useRemote:
      return path === operation.snapshot.targetPath &&
        target.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live
        ? target.remote.contentSha256
        : undefined;
    case RECONCILIATION_ACTION.keepBoth:
      return path === operation.snapshot.targetPath &&
        operation.action.primarySide ===
          RECONCILIATION_PRESERVATION_SIDE.remote &&
        target.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live
        ? target.remote.contentSha256
        : undefined;
    case RECONCILIATION_ACTION.restoreRecovery:
      return path ===
        (operation.destinationPath ?? operation.snapshot.targetPath)
        ? operation.snapshot.recovery?.contentSha256
        : undefined;
    case RECONCILIATION_ACTION.keepLocal:
    case RECONCILIATION_ACTION.adoptRevision:
    case RECONCILIATION_ACTION.acceptTombstone:
    case RECONCILIATION_ACTION.recreateRemote:
    case RECONCILIATION_ACTION.forkLegacy:
    case RECONCILIATION_ACTION.defer:
      return undefined;
  }
}

/**
 * @param operation - Active operation whose reservations are authoritative.
 * @param path - Requested effect path.
 * @returns Whether this active operation explicitly reserves the requested path.
 */
function ownsPath(
  operation: ReconciliationNonHistoryOperation,
  path: AuthorizedCreateEligibleRequest["path"],
): boolean {
  return operation.reservations.some(
    (reservation) => reservation.path === path,
  );
}

/**
 * Chooses first dispatch only from a pre-effect phase and recovery only from an
 * ambiguous in-progress/evidence phase. Verified preservation is required when the
 * central matrix demanded it; strict state validation has already bound identities.
 *
 * @param operation - Active operation to classify for dispatch.
 * @param path - Exact effect destination.
 * @param expectedHash - Exact postcondition digest.
 * @returns First dispatch, same-operation recovery, or undefined when fenced.
 */
function dispatchMode(
  operation: ReconciliationNonHistoryOperation,
  path: AuthorizedCreateEligibleRequest["path"],
  expectedHash: ContentSha256,
): AuthorizedWrite["mode"] | undefined {
  const requirements = requiredReconciliationPreservations(operation);
  if (
    requirements === undefined ||
    !areRequiredReconciliationPreservationsVerified(
      requirements,
      operation.preservationReceipts,
    )
  ) {
    return undefined;
  }
  if (
    operation.phase === RECONCILIATION_OPERATION_PHASE.admitted ||
    operation.phase === RECONCILIATION_OPERATION_PHASE.preserving
  ) {
    return LOCAL_RECONCILIATION_DISPATCH_MODE.firstDispatch;
  }
  if (
    operation.phase === RECONCILIATION_OPERATION_PHASE.partial &&
    operation.localEffect === MUTATION_EFFECT_CERTAINTY.confirmed &&
    "expectedHash" in operation.localEffectObservation &&
    (operation.localEffectObservation.path !== path ||
      operation.localEffectObservation.expectedHash !== expectedHash)
  ) {
    return LOCAL_RECONCILIATION_DISPATCH_MODE.firstDispatch;
  }
  if (
    operation.phase === RECONCILIATION_OPERATION_PHASE.partial ||
    operation.phase === RECONCILIATION_OPERATION_PHASE.mutatingLocal ||
    operation.phase === RECONCILIATION_OPERATION_PHASE.restoredPendingReview ||
    (operation.phase === RECONCILIATION_OPERATION_PHASE.evidenceRequired &&
      operation.localEffect === MUTATION_EFFECT_CERTAINTY.unknown)
  ) {
    return LOCAL_RECONCILIATION_DISPATCH_MODE.sameOperationRecovery;
  }
  return undefined;
}

/**
 * @param outcome - Confirmed outcome claimed by the adapter.
 * @param primitive - Narrow command that produced the result.
 * @returns Whether the outcome is possible for the invoked primitive.
 */
function outcomeMatchesPrimitive(
  outcome: Extract<
    LocalReconciliationWriteResult,
    { readonly kind: "confirmed" }
  >["outcome"],
  primitive: LocalWritePrimitive,
): boolean {
  if (outcome === LOCAL_RECONCILIATION_WRITE_OUTCOME.adopted) return true;
  return primitive === "create"
    ? outcome === LOCAL_RECONCILIATION_WRITE_OUTCOME.created
    : outcome === LOCAL_RECONCILIATION_WRITE_OUTCOME.replaced;
}

/**
 * Replaces one durable operation while retaining every unrelated reservation and review.
 *
 * @param state - Current durable state.
 * @param replacement - Validated operation replacement.
 * @returns State with only the matching operation replaced.
 */
function replaceOperation(
  state: MirrorDeviceState,
  replacement: ReconciliationOperation,
): MirrorDeviceState {
  return {
    ...state,
    reconciliationOperations: state.reconciliationOperations.map((operation) =>
      operation.operationId === replacement.operationId
        ? replacement
        : operation,
    ),
  };
}

/**
 * @param reason - Closed application rejection reason.
 * @param snapshot - Latest authoritative state-owner snapshot.
 * @returns Typed command rejection.
 */
function rejected(
  reason: import("@core/mirror/local-reconciliation-write-service.types").LocalReconciliationCommandRejection,
  snapshot: import("@core/mirror/mirror-state.types").MirrorStateSnapshot,
): RejectedCommand {
  return { kind: "rejected", reason, snapshot };
}
