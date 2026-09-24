import {
  LocalInspectionKind,
  LocalVaultFailureReason,
} from "@core/local-vault/local-vault.constants";
import type { ReadOnlyLocalVault } from "@core/local-vault/read-only-local-vault.port";
import { isReconciliationPreservationNamespacePath } from "@core/local-vault/reconciliation-preservation-namespace";
import {
  classifyReconciliation,
  isReconciliationReviewable,
} from "@core/mirror/divergence-classifier";
import {
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  MUTATION_ACTION,
  MUTATION_EFFECT_CERTAINTY,
} from "@core/mirror/mirror.constants";
import type {
  ConditionalMutationPrecondition,
  ContentMutationAction,
  ContentSha256,
  CurrentNoteState,
  MirrorOperationId,
  RecoverySnapshotId,
  RecoverySnapshotState,
} from "@core/mirror/mirror.types";
import {
  inspectBoundedMirrorInventory,
  inspectBoundedRecoveryInventory,
} from "@core/mirror/mirror-inventory";
import {
  MAX_MIRROR_TRACKED_PATHS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
} from "@core/mirror/mirror-state.constants";
import type {
  MirrorAcknowledgement,
  MirrorDeviceState,
  MirrorPathState,
  MirrorStateSnapshot,
} from "@core/mirror/mirror-state.types";
import type { MirrorStateOwner } from "@core/mirror/mirror-state-owner";
import {
  allowedReconciliationActions,
  isReconciliationActionAllowed,
  reconciliationAuthorityForAction,
} from "@core/mirror/reconciliation-decision-policy";
import {
  isHistoryReconciliationOperation,
  isNonHistoryReconciliationOperation,
  isRefinedHistoryReconciliationOperation,
} from "@core/mirror/reconciliation-operation";
import {
  areRequiredReconciliationPreservationsVerified,
  requiredReconciliationPreservations,
} from "@core/mirror/reconciliation-preservation-policy";
import type {
  EphemeralReconciliationGapGroupReview,
  ReconciliationAdmissionRequest,
  ReconciliationDiscoveryResult,
  ReconciliationGapGroupAdmissionRequest,
  ReconciliationGapGroupAdmissionResult,
  ReconciliationGapGroupReviewRequest,
  ReconciliationGapGroupReviewResult,
  ReconciliationObservationSource,
  ReconciliationRecoverySelectionResult,
  ReconciliationRemoteReader,
  ReconciliationReviewDependencies,
  ReconciliationReviewFailure,
  ReconciliationReviewQuery,
  ReconciliationReviewRequest,
  ReconciliationReviewResult,
} from "@core/mirror/reconciliation-review.types";
import {
  HISTORY_CLEANUP_STEP_PHASE,
  HISTORY_DECISION_KIND,
  HISTORY_PROGRESS_KIND,
  HISTORY_REMOTE_EFFECT_KIND,
  LOCAL_EFFECT_OBSERVATION_KIND,
  RECONCILIATION_ACTION,
  RECONCILIATION_AUTHORITY_SOURCE,
  RECONCILIATION_CLASSIFICATION,
  RECONCILIATION_GAP_REVIEW_KIND,
  RECONCILIATION_GAP_REVIEW_STATUS,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_LOCAL_STABILITY,
  RECONCILIATION_OBSERVATION_COVERAGE,
  RECONCILIATION_OPERATION_PHASE,
  RECONCILIATION_PATH_REFERENCE_KIND,
  RECONCILIATION_PRESERVATION_SIDE,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
  RECONCILIATION_REVIEW_RETENTION,
  RECONCILIATION_REVIEW_STATUS,
} from "@core/mirror/reconciliation-state.constants";
import type {
  EphemeralReconciliationReview,
  ReconciliationAction,
  ReconciliationAdmissionAction,
  ReconciliationGapGroupReview,
  ReconciliationHistoryOperation,
  ReconciliationNonHistoryOperation,
  ReconciliationOperation,
  ReconciliationPathEvidence,
  ReconciliationReview,
  ReconciliationReviewSnapshot,
} from "@core/mirror/reconciliation-state.types";
import { reconciliationReviewSnapshotsEqual } from "@core/mirror/reconciliation-state-validation";
import type {
  RemoteBridgeFailure,
  RemoteBridgeResult,
} from "@core/mirror/remote-bridge.types";
import { RenameHistoryGroupPolicy } from "@core/mirror/rename-history-group-policy";
import type { NotePath } from "@core/note-path/note-path.types";

/**
 * Read-only M4 review and stale-decision admission service.
 *
 * Candidate discovery and evidence sampling use only read ports. Open reviews live
 * in this process and are never written to device state; only an explicit admitted
 * action creates the content-free durable review/operation pair through the state
 * owner.
 */
export class ReconciliationReviewService implements ReconciliationReviewQuery {
  private readonly reviews = new Map<string, EphemeralReconciliationReview>();
  private readonly gapGroupReviews = new Map<
    string,
    EphemeralReconciliationGapGroupReview
  >();
  private readonly observations: ReconciliationObservationSource;
  private positiveInventory = new Set<NotePath>();
  private localInventoryAvailable = false;
  private candidates = new Set<NotePath>();

  /**
   * @param local - Read-only eligible-note inventory and stable saved-file reader.
   * @param remote - Read-only exact-state, content and recovery metadata reader.
   * @param stateOwner - Serialized durable owner used only at decision admission.
   * @param dependencies - Runtime identity, generation, hashing and ID seams.
   */
  constructor(
    private readonly local: ReadOnlyLocalVault,
    private readonly remote: ReconciliationRemoteReader,
    private readonly stateOwner: MirrorStateOwner,
    private readonly dependencies: ReconciliationReviewDependencies,
    private readonly historyGroups = new RenameHistoryGroupPolicy(),
  ) {
    this.observations = dependencies.observations;
  }

  /**
   * Samples the exact reservations of one active gap-fenced operation and derives target-scoped child reviews.
   *
   * @param request - Predecessor and UI session identity.
   * @returns A complete process-local group and per-target reviews, or a refusal that retains all reservations.
   */
  async createGapGroupReview(
    request: ReconciliationGapGroupReviewRequest,
  ): Promise<ReconciliationGapGroupReviewResult> {
    const before = this.stateOwner.snapshot();
    const initialPredecessor = before.state.reconciliationOperations.find(
      (operation) =>
        operation.operationId === request.predecessorOperationId &&
        operation.observationCoverage ===
          RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired &&
        operation.phase !== RECONCILIATION_OPERATION_PHASE.completed &&
        operation.phase !== RECONCILIATION_OPERATION_PHASE.stale,
    );
    if (initialPredecessor === undefined) return { kind: "not-reviewable" };
    let predecessor: ReconciliationOperation = initialPredecessor;
    const predecessorOperationId = predecessor.operationId;
    const paths = predecessor.reservations.map(
      (reservation) => reservation.path,
    );
    let sampled = await this.sample(
      predecessor.snapshot.targetPath,
      paths,
      predecessor.snapshot.recovery?.id ?? null,
    );
    if (sampled.kind === "failure") {
      return { kind: "failure", reason: sampled.reason };
    }
    if (
      !reservationScopeMatches(
        this.stateOwner
          .snapshot()
          .state.reconciliationOperations.find(
            (operation) => operation.operationId === predecessorOperationId,
          ),
        sampled.snapshot,
      ) ||
      !samePathSet(
        sampled.snapshot.paths.map((evidence) => evidence.path),
        paths,
      ) ||
      sampled.snapshot.paths.some(
        (evidence) =>
          evidence.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown ||
          evidence.remote.kind ===
            RECONCILIATION_REMOTE_EVIDENCE_KIND.unavailable,
      )
    ) {
      return { kind: "failure", reason: "evidence-unavailable" };
    }
    const recovered = await this.recoverExactGapEffects(
      predecessor,
      sampled.snapshot,
    );
    if (recovered === "persistence-failure") {
      return { kind: "failure", reason: "persistence-failure" };
    }
    if (recovered === "stale") {
      return { kind: "failure", reason: "stale-review" };
    }
    if (recovered === "recovered") {
      const current = this.stateOwner
        .snapshot()
        .state.reconciliationOperations.find(
          (operation) => operation.operationId === predecessorOperationId,
        );
      if (current === undefined) return { kind: "not-reviewable" };
      predecessor = current;
      sampled = await this.sample(
        current.snapshot.targetPath,
        paths,
        current.snapshot.recovery?.id ?? null,
      );
      if (sampled.kind === "failure") {
        return { kind: "failure", reason: sampled.reason };
      }
      if (
        !reservationScopeMatches(
          this.stateOwner
            .snapshot()
            .state.reconciliationOperations.find(
              (operation) => operation.operationId === predecessorOperationId,
            ),
          sampled.snapshot,
        ) ||
        !samePathSet(
          sampled.snapshot.paths.map((evidence) => evidence.path),
          paths,
        ) ||
        sampled.snapshot.paths.some(
          (evidence) =>
            evidence.local.kind ===
              RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown ||
            evidence.remote.kind ===
              RECONCILIATION_REMOTE_EVIDENCE_KIND.unavailable,
        )
      ) {
        return { kind: "failure", reason: "evidence-unavailable" };
      }
    }
    this.invalidateOverlapping(paths);
    const reviewId = this.dependencies.createOperationId();
    if (
      this.gapGroupReviews.has(reviewId) ||
      this.reviews.has(reviewId) ||
      hasPersistedGapIdentityCollision(before.state, reviewId) ||
      predecessor.operationId === reviewId
    ) {
      return { kind: "failure", reason: "stale-review" };
    }
    const children: EphemeralReconciliationReview[] = [];
    const unreviewablePaths: NotePath[] = [];
    const currentState = this.stateOwner.snapshot().state;
    const historyGroup = this.historyGroups.derive(
      currentState,
      predecessor.snapshot.targetPath,
    );
    const historyGroupCoversReservations =
      historyGroup.kind === "group" &&
      samePathSet(historyGroup.paths, paths) &&
      this.currentStateMatches(currentState, sampled.snapshot) &&
      this.historyGroups.createProgress(
        currentState,
        sampled.snapshot,
        { kind: HISTORY_DECISION_KIND.retainIndependent },
        predecessor.operationId,
        this.dependencies.createOperationId,
      ) !== undefined &&
      sampled.snapshot.paths.every((evidence) => {
        const targetSnapshot = singleTargetSnapshot(
          sampled.snapshot,
          evidence.path,
        );
        const classification = classifyReconciliation(targetSnapshot);
        return (
          classification === RECONCILIATION_CLASSIFICATION.deferredHistory ||
          classification === RECONCILIATION_CLASSIFICATION.aligned
        );
      });
    if (historyGroupCoversReservations) {
      const childReviewId = this.dependencies.createOperationId();
      if (
        childReviewId === reviewId ||
        this.reviews.has(childReviewId) ||
        this.gapGroupReviews.has(childReviewId) ||
        hasPersistedGapIdentityCollision(before.state, childReviewId) ||
        childReviewId === predecessor.operationId
      ) {
        return { kind: "failure", reason: "stale-review" };
      }
      const targetContent = sampled.pathContents.get(
        sampled.snapshot.targetPath,
      );
      const child: EphemeralReconciliationReview = {
        retention: RECONCILIATION_REVIEW_RETENTION.ephemeral,
        reviewId: childReviewId,
        classification: RECONCILIATION_CLASSIFICATION.deferredHistory,
        status: RECONCILIATION_REVIEW_STATUS.pending,
        snapshot: sampled.snapshot,
        operationId: null,
        sessionId: request.sessionId,
        allowedActions: [RECONCILIATION_ACTION.resolveHistory],
        sampledLocalText: targetContent?.localText ?? null,
        sampledRemoteText: targetContent?.remoteText ?? null,
        gapPredecessorId: predecessor.operationId,
      };
      this.reviews.set(child.reviewId, child);
      children.push(child);
    } else {
      for (const evidence of sampled.snapshot.paths) {
        const snapshot = singleTargetSnapshot(sampled.snapshot, evidence.path);
        const classification = classifyReconciliation(snapshot);
        const restoreSuccessor = isGapRestoreSuccessor(predecessor, snapshot, {
          kind: RECONCILIATION_ACTION.keepLocal,
        });
        if (
          classification === RECONCILIATION_CLASSIFICATION.aligned &&
          !restoreSuccessor
        ) {
          continue;
        }
        if (
          (classification === RECONCILIATION_CLASSIFICATION.deferredHistory ||
            !isReconciliationReviewable(snapshot)) &&
          !restoreSuccessor
        ) {
          unreviewablePaths.push(evidence.path);
          continue;
        }
        const allowedActions = gapSuccessorActions(snapshot, restoreSuccessor);
        if (allowedActions.length === 0) {
          unreviewablePaths.push(evidence.path);
          continue;
        }
        const childReviewId = this.dependencies.createOperationId();
        if (
          childReviewId === reviewId ||
          this.reviews.has(childReviewId) ||
          this.gapGroupReviews.has(childReviewId) ||
          hasPersistedGapIdentityCollision(before.state, childReviewId) ||
          childReviewId === predecessor.operationId
        ) {
          return { kind: "failure", reason: "stale-review" };
        }
        const content = sampled.pathContents.get(evidence.path);
        const child: EphemeralReconciliationReview = {
          retention: RECONCILIATION_REVIEW_RETENTION.ephemeral,
          reviewId: childReviewId,
          classification,
          status: RECONCILIATION_REVIEW_STATUS.pending,
          snapshot,
          operationId: null,
          sessionId: request.sessionId,
          allowedActions,
          sampledLocalText: content?.localText ?? null,
          sampledRemoteText: content?.remoteText ?? null,
          gapPredecessorId: predecessor.operationId,
        };
        this.reviews.set(child.reviewId, child);
        children.push(child);
      }
    }
    const group: EphemeralReconciliationGapGroupReview = {
      retention: RECONCILIATION_REVIEW_RETENTION.ephemeral,
      reviewId,
      predecessorOperationId: predecessor.operationId,
      sessionId: request.sessionId,
      snapshot: sampled.snapshot,
      childReviewIds: children.map((child) => child.reviewId),
      unreviewablePaths: unreviewablePaths.toSorted((left, right) =>
        left.localeCompare(right),
      ),
    };
    this.gapGroupReviews.set(group.reviewId, group);
    return { kind: "created", review: { group, children } };
  }

  /**
   * Recovers only exact operation-bound effects visible in the complete fresh sample.
   * No host or remote mutation capability is used, and the gap fence is retained.
   *
   * @param operation - Current gap-fenced non-history operation.
   * @param snapshot - Complete current evidence for its reservation scope.
   * @returns Whether exact evidence was committed, stale, unavailable, or absent.
   */
  private async recoverExactGapEffects(
    operation: ReconciliationOperation,
    snapshot: ReconciliationReviewSnapshot,
  ): Promise<"unchanged" | "recovered" | "stale" | "persistence-failure"> {
    if (!isNonHistoryReconciliationOperation(operation)) return "unchanged";
    let localEffect = operation.localEffect;
    let remoteEffect = operation.remoteEffect;
    let localEffectObservation = operation.localEffectObservation;
    const preparedObservation =
      localEffectObservation.kind === LOCAL_EFFECT_OBSERVATION_KIND.prepared
        ? localEffectObservation
        : undefined;
    const localPostcondition =
      preparedObservation === undefined
        ? undefined
        : snapshot.paths.find(
            (evidence) => evidence.path === preparedObservation.path,
          );
    if (
      preparedObservation !== undefined &&
      localEffect !== MUTATION_EFFECT_CERTAINTY.confirmed &&
      localEffect !== MUTATION_EFFECT_CERTAINTY.definitelyRefused &&
      localPostcondition?.local.kind ===
        RECONCILIATION_LOCAL_EVIDENCE_KIND.live &&
      localPostcondition.local.contentSha256 ===
        preparedObservation.expectedHash
    ) {
      localEffect = MUTATION_EFFECT_CERTAINTY.confirmed;
      localEffectObservation = {
        ...preparedObservation,
        kind: LOCAL_EFFECT_OBSERVATION_KIND.confirmed,
        postconditionHash: preparedObservation.expectedHash,
      };
    }
    if (
      remoteEffect !== MUTATION_EFFECT_CERTAINTY.confirmed &&
      hasExactGapRemoteReceipt(operation, snapshot)
    ) {
      remoteEffect = MUTATION_EFFECT_CERTAINTY.confirmed;
    }
    if (
      localEffect === operation.localEffect &&
      remoteEffect === operation.remoteEffect &&
      localEffectObservation === operation.localEffectObservation
    ) {
      return "unchanged";
    }
    const phase = recoveredGapOperationPhase({
      ...operation,
      localEffect,
      remoteEffect,
      localEffectObservation,
    });
    const committed = await this.stateOwner.transition((state) => {
      const current = state.reconciliationOperations.find(
        (candidate) => candidate.operationId === operation.operationId,
      );
      if (
        current === undefined ||
        !isNonHistoryReconciliationOperation(current) ||
        current.observationCoverage !==
          RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired ||
        current.phase !== operation.phase ||
        current.localEffect !== operation.localEffect ||
        current.remoteEffect !== operation.remoteEffect ||
        !reservationScopeMatches(current, snapshot) ||
        !reconciliationReviewSnapshotsEqual(
          current.snapshot,
          operation.snapshot,
        ) ||
        !this.currentStateMatches(state, snapshot)
      ) {
        return undefined;
      }
      return {
        ...state,
        reconciliationOperations: state.reconciliationOperations.map(
          (candidate) =>
            candidate.operationId === current.operationId
              ? {
                  ...current,
                  phase,
                  localEffect,
                  remoteEffect,
                  localEffectObservation,
                }
              : candidate,
        ),
      };
    });
    if (committed.kind === "save-failed") return "persistence-failure";
    return committed.kind === "committed" ? "recovered" : "stale";
  }

  /**
   * Builds the bounded union of tracked, local-positive, remote-visible and
   * recovery-metadata paths. Inventory failures remain explicit and never grant
   * absence or deletion authority.
   *
   * @returns Candidate paths plus currently open session-owned reviews.
   */
  async discover(): Promise<ReconciliationDiscoveryResult> {
    const state = this.stateOwner.snapshot().state;
    const candidates = new Set<NotePath>();
    let localFailure = false;
    let remoteFailureValue: RemoteBridgeFailure | "capacity-exceeded" | null =
      null;

    for (const entry of state.paths) {
      this.addCandidate(candidates, entry.path);
      this.addRelatedHistoryCandidates(candidates, entry);
    }
    const localInventory = await this.local.list();
    if (localInventory.kind === LocalInspectionKind.ok) {
      this.localInventoryAvailable = true;
      this.positiveInventory = new Set(
        localInventory.entries.map((entry) => entry.path),
      );
      for (const entry of localInventory.entries) {
        if (!this.addCandidate(candidates, entry.path)) {
          remoteFailureValue = "capacity-exceeded";
        }
      }
    } else {
      localFailure = true;
      this.localInventoryAvailable = false;
      this.positiveInventory = new Set();
    }

    const remoteInventory = await inspectBoundedMirrorInventory(this.remote);
    for (const path of remoteInventory.paths) {
      if (!this.addCandidate(candidates, path))
        remoteFailureValue = "capacity-exceeded";
    }
    if (remoteInventory.kind === "incomplete") {
      remoteFailureValue = remoteInventory.remoteFailure ?? "capacity-exceeded";
    }

    const recoveryInventory = await inspectBoundedRecoveryInventory(
      this.remote,
    );
    for (const path of recoveryInventory.paths) {
      if (!this.addCandidate(candidates, path))
        remoteFailureValue = "capacity-exceeded";
    }
    if (recoveryInventory.kind === "incomplete") {
      remoteFailureValue =
        recoveryInventory.remoteFailure ?? "capacity-exceeded";
    }

    this.candidates = candidates;
    const reviews = this.openReviews();
    if (localFailure || remoteFailureValue !== null) {
      return {
        kind: "incomplete",
        candidates: sortedPaths(candidates),
        reviews,
        localFailure,
        remoteFailure: remoteFailureValue,
      };
    }
    return { kind: "complete", candidates: sortedPaths(candidates), reviews };
  }

  /**
   * Samples one candidate and retains a new process-local review ID. Existing
   * overlapping reviews are invalidated rather than refreshed in place.
   *
   * @param request - Target/session and optional destination/recovery selections.
   * @returns Ephemeral review, a non-reviewable result, or a typed read failure.
   */
  async createReview(
    request: ReconciliationReviewRequest,
  ): Promise<ReconciliationReviewResult> {
    if (!this.isCandidate(request.targetPath)) {
      return { kind: "failure", reason: "not-a-candidate" };
    }
    const paths = this.reviewPaths(request);
    const sampled = await this.sample(
      request.targetPath,
      paths,
      request.recoveryId ?? null,
    );
    if (sampled.kind === "failure") return sampled;
    const currentState = this.stateOwner.snapshot().state;
    const restoredPublication = isRestoredPublicationSnapshot(sampled.snapshot)
      ? this.restorePredecessor(currentState, sampled.snapshot, {
          kind: RECONCILIATION_ACTION.keepLocal,
        })
      : undefined;
    const localEffectSuccessor = this.localEffectPredecessor(
      currentState,
      sampled.snapshot,
    );
    if (
      !isReconciliationReviewable(sampled.snapshot) &&
      restoredPublication === undefined &&
      localEffectSuccessor === undefined
    ) {
      return { kind: "not-reviewable" };
    }
    this.invalidateOverlapping(sampled.snapshot.paths.map((path) => path.path));
    const review: EphemeralReconciliationReview = {
      retention: RECONCILIATION_REVIEW_RETENTION.ephemeral,
      reviewId: this.dependencies.createOperationId(),
      classification: classifyReconciliation(sampled.snapshot),
      status: RECONCILIATION_REVIEW_STATUS.pending,
      snapshot: sampled.snapshot,
      operationId: null,
      sessionId: request.sessionId,
      allowedActions:
        restoredPublication !== undefined
          ? [RECONCILIATION_ACTION.keepLocal]
          : localEffectSuccessor !== undefined &&
              classifyReconciliation(sampled.snapshot) ===
                RECONCILIATION_CLASSIFICATION.aligned
            ? [RECONCILIATION_ACTION.defer]
            : allowedReconciliationActions(sampled.snapshot),
      sampledLocalText: sampled.localText,
      sampledRemoteText: sampled.remoteText,
    };
    this.reviews.set(review.reviewId, review);
    return { kind: "created", review };
  }

  /**
   * Resamples a review's original paths and selection under a fresh ID. The old
   * process-local snapshot is stale immediately and is never modified in place.
   *
   * @param reviewId - Existing review identity.
   * @param sessionId - UI/session identity that owns the review.
   * @returns Newly sampled review or a typed stale/not-found failure.
   */
  async refreshReview(
    reviewId: ReconciliationReviewRequest["sessionId"],
    sessionId: ReconciliationReviewRequest["sessionId"],
  ): Promise<ReconciliationReviewResult> {
    const current = this.reviews.get(reviewId);
    if (current === undefined) {
      return { kind: "failure", reason: "review-not-found" };
    }
    if (
      current.sessionId !== sessionId ||
      current.status !== RECONCILIATION_REVIEW_STATUS.pending ||
      current.gapPredecessorId !== undefined
    ) {
      return { kind: "failure", reason: "stale-review" };
    }
    this.markStale(reviewId);
    const result = await this.createReview({
      targetPath: current.snapshot.targetPath,
      sessionId,
      relatedPaths: current.snapshot.paths.map((evidence) => evidence.path),
      recoveryId: current.snapshot.recovery?.id ?? null,
    });
    return result;
  }

  /**
   * Lists only pending reviews owned by one UI session.
   * @param sessionId - UI/session identity.
   * @returns Open reviews owned by that session only.
   */
  listOpen(
    sessionId: ReconciliationReviewRequest["sessionId"],
  ): readonly EphemeralReconciliationReview[] {
    return [...this.reviews.values()].filter(
      (review) =>
        review.sessionId === sessionId &&
        review.status === RECONCILIATION_REVIEW_STATUS.pending,
    );
  }

  /** @inheritdoc */
  async listRecoverySelections(): Promise<ReconciliationRecoverySelectionResult> {
    const inventory = await inspectBoundedRecoveryInventory(this.remote);
    const recoveries = [...inventory.states].toSorted(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.revision.localeCompare(right.revision),
    );
    return inventory.kind === "complete"
      ? { kind: "complete", recoveries }
      : { kind: "incomplete", recoveries };
  }

  /**
   * Returns one explicitly requested transient text sample for the exact pending session.
   *
   * @param reviewId - Ephemeral review identity.
   * @param sessionId - Exact UI session owner.
   * @param side - Sample side selected by the operator.
   * @returns Literal bounded text, or null when stale/unavailable.
   */
  preview(
    reviewId: ReconciliationReviewRequest["sessionId"],
    sessionId: ReconciliationReviewRequest["sessionId"],
    side: "local" | "remote",
  ): string | null {
    const review = this.reviews.get(reviewId);
    if (
      review === undefined ||
      review.sessionId !== sessionId ||
      review.status !== RECONCILIATION_REVIEW_STATUS.pending
    ) {
      return null;
    }
    return side === "local"
      ? review.sampledLocalText
      : review.sampledRemoteText;
  }

  /**
   * Closes one pending review owned by the exact UI session and discards all bodies.
   *
   * @param reviewId - Ephemeral review identity.
   * @param sessionId - Exact presentation session owner.
   * @returns Whether a pending review was invalidated.
   */
  closeReview(
    reviewId: ReconciliationReviewRequest["sessionId"],
    sessionId: ReconciliationReviewRequest["sessionId"],
  ): boolean {
    const review = this.reviews.get(reviewId);
    if (
      review === undefined ||
      review.sessionId !== sessionId ||
      review.status !== RECONCILIATION_REVIEW_STATUS.pending
    ) {
      return false;
    }
    this.reviews.set(reviewId, staleReview(review));
    return true;
  }

  /**
   * Invalidates one process-local gap group owned by the exact presentation session.
   * @param reviewId - Ephemeral complete group identity.
   * @param sessionId - Exact presentation identity that owns the group.
   * @returns Whether this call invalidated and cleared a pending group.
   */
  closeGapGroupReview(
    reviewId: MirrorOperationId,
    sessionId: ReconciliationReviewRequest["sessionId"],
  ): boolean {
    const group = this.gapGroupReviews.get(reviewId);
    if (group === undefined || group.sessionId !== sessionId) return false;
    this.invalidateGapGroup(group);
    return true;
  }

  /**
   * Invalidates every pending review for one detached presentation session.
   *
   * @param sessionId - Session whose transient authority is ending.
   */
  invalidateSession(sessionId: ReconciliationReviewRequest["sessionId"]): void {
    for (const review of this.reviews.values()) {
      if (
        review.sessionId === sessionId &&
        review.status === RECONCILIATION_REVIEW_STATUS.pending
      ) {
        this.reviews.set(review.reviewId, staleReview(review));
      }
    }
    for (const group of this.gapGroupReviews.values()) {
      if (group.sessionId === sessionId) this.invalidateGapGroup(group);
    }
  }

  /**
   * Invalidates every open review and discards sampled bodies. Runtime replacement,
   * listener gaps and unload call this boundary; no stale review is resurrected.
   */
  invalidate(): void {
    for (const review of this.reviews.values()) {
      if (review.status === RECONCILIATION_REVIEW_STATUS.pending) {
        this.reviews.set(review.reviewId, staleReview(review));
      }
    }
    for (const group of this.gapGroupReviews.values()) {
      this.invalidateGapGroup(group);
    }
  }

  /**
   * Revalidates the exact review and current evidence, then serially persists the
   * durable operation and linked review through `MirrorStateOwner`. No effect port
   * is present in this service, so admission itself cannot mutate local or remote data.
   *
   * @param request - Review/session/action identity supplied by an operator.
   * @returns Durable operation only after the owner commit, or a typed rejection.
   */
  async admit(
    request: ReconciliationAdmissionRequest,
  ): Promise<
    import("@core/mirror/reconciliation-review.types").ReconciliationAdmissionResult
  > {
    const review = this.reviews.get(request.reviewId);
    const before = this.stateOwner.snapshot();
    if (review === undefined) return rejected("review-not-found", before);
    if (
      review.sessionId !== request.sessionId ||
      review.status !== RECONCILIATION_REVIEW_STATUS.pending
    ) {
      return rejected("stale-review", before);
    }
    if (review.gapPredecessorId !== undefined) {
      return rejected("action-not-allowed", before);
    }
    const selectedDestination = request.destinationPath ?? null;
    if (
      selectedDestination !== null &&
      !review.snapshot.paths.some(
        (evidence) => evidence.path === selectedDestination,
      )
    ) {
      return rejected("action-not-allowed", before);
    }
    const sampled = await this.sample(
      review.snapshot.targetPath,
      review.snapshot.paths.map((evidence) => evidence.path),
      review.snapshot.recovery?.id ?? null,
    );
    if (sampled.kind === "failure") return rejected(sampled.reason, before);
    if (
      !reconciliationReviewSnapshotsEqual(review.snapshot, sampled.snapshot)
    ) {
      this.markStale(request.reviewId);
      return rejected("stale-review", this.stateOwner.snapshot());
    }
    const derivedAction = this.deriveAdmissionAction(
      before.state,
      sampled.snapshot,
      request.action,
    );
    if (derivedAction === undefined) {
      return rejected("action-not-allowed", this.stateOwner.snapshot());
    }
    const restoredPublication = this.restorePredecessor(
      before.state,
      sampled.snapshot,
      derivedAction,
    );
    if (
      !isReconciliationActionAllowed(sampled.snapshot, derivedAction) &&
      !(
        derivedAction.kind === RECONCILIATION_ACTION.keepLocal &&
        isRestoredPublicationSnapshot(sampled.snapshot) &&
        restoredPublication !== undefined
      )
    ) {
      return rejected("action-not-allowed", this.stateOwner.snapshot());
    }
    const operationId = this.dependencies.createOperationId();
    if (operationId === review.reviewId) {
      return rejected("stale-review", this.stateOwner.snapshot());
    }
    const committed = await this.stateOwner.transition((state) => {
      if (!this.currentStateMatches(state, sampled.snapshot)) return undefined;
      if (!this.isAdmissionLifecycleAllowed(state, sampled.snapshot))
        return undefined;
      const action = this.deriveAdmissionAction(
        state,
        sampled.snapshot,
        request.action,
      );
      if (action === undefined) return undefined;
      const restorePredecessor = this.restorePredecessor(
        state,
        sampled.snapshot,
        action,
      );
      const localEffectPredecessor = this.localEffectPredecessor(
        state,
        sampled.snapshot,
      );
      const transferablePredecessor =
        restorePredecessor ?? localEffectPredecessor;
      if (
        this.hasReservationConflict(
          state,
          sampled.snapshot,
          transferablePredecessor?.operationId,
        )
      ) {
        return undefined;
      }
      if (this.hasOpenReviewConflict(review)) return undefined;
      const reservations = this.createReservations(
        state,
        sampled.snapshot,
        selectedDestination,
      );
      if (reservations === undefined) return undefined;
      const historyProgress =
        action.kind === RECONCILIATION_ACTION.resolveHistory
          ? this.historyGroups.createProgress(
              state,
              sampled.snapshot,
              action.decision,
              operationId,
              this.dependencies.createOperationId,
            )
          : undefined;
      if (
        action.kind === RECONCILIATION_ACTION.resolveHistory &&
        historyProgress === undefined
      ) {
        return undefined;
      }
      const phase =
        action.kind === RECONCILIATION_ACTION.defer ||
        (historyProgress !== undefined &&
          historyProgress.nextStepIndex === null)
          ? RECONCILIATION_OPERATION_PHASE.completed
          : RECONCILIATION_OPERATION_PHASE.admitted;
      const common = {
        observationCoverage: RECONCILIATION_OBSERVATION_COVERAGE.continuous,
        gapSuccessorOperationIds: [],
        operationId,
        reviewId: review.reviewId,
        authority: reconciliationAuthorityForAction(action),
        phase,
        snapshot: sampled.snapshot,
        destinationPath: selectedDestination,
        reservations,
        preservationReceipts: [],
        successorOperationId: null,
      };
      let operation: ReconciliationOperation;
      if (
        action.kind === RECONCILIATION_ACTION.resolveHistory &&
        historyProgress !== undefined
      ) {
        operation = {
          ...common,
          authority: RECONCILIATION_AUTHORITY_SOURCE.historyDecision,
          action,
          historyProgress,
        } satisfies ReconciliationHistoryOperation;
      } else {
        if (action.kind === RECONCILIATION_ACTION.resolveHistory) {
          return undefined;
        }
        const target = sampled.snapshot.paths.find(
          (evidence) => evidence.path === sampled.snapshot.targetPath,
        );
        if (target === undefined) return undefined;
        operation = {
          ...common,
          action,
          localEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
          remoteEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
          localEffectObservation: actionMayWriteLocal(action.kind)
            ? { kind: LOCAL_EFFECT_OBSERVATION_KIND.notStarted }
            : {
                kind: LOCAL_EFFECT_OBSERVATION_KIND.notRequired,
                path: sampled.snapshot.targetPath,
                listenerEpoch: sampled.snapshot.runtime.listenerEpoch,
                beforeGeneration:
                  target.local.kind ===
                  RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown
                    ? 0
                    : target.local.observationGeneration,
                successor: null,
              },
        };
      }
      const durableReview: ReconciliationReview = {
        retention: RECONCILIATION_REVIEW_RETENTION.durable,
        reviewId: review.reviewId,
        classification: classifyReconciliation(sampled.snapshot),
        status:
          phase === RECONCILIATION_OPERATION_PHASE.completed
            ? RECONCILIATION_REVIEW_STATUS.completed
            : RECONCILIATION_REVIEW_STATUS.staged,
        snapshot: sampled.snapshot,
        operationId,
      };
      const transferredState =
        transferablePredecessor === undefined
          ? state
          : transferReconciliationOwnership(
              state,
              transferablePredecessor,
              operation.operationId,
            );
      return {
        ...transferredState,
        reconciliationReviews: [
          ...transferredState.reconciliationReviews,
          durableReview,
        ],
        reconciliationOperations: [
          ...transferredState.reconciliationOperations,
          operation,
        ],
      };
    });
    if (committed.kind !== "committed") {
      const reason =
        committed.kind === "save-failed"
          ? "persistence-failure"
          : committed.kind === "stale"
            ? "stale-review"
            : "reservation-conflict";
      return rejected(reason, committed.snapshot);
    }
    const operation = committed.snapshot.state.reconciliationOperations.find(
      (candidate) => candidate.operationId === operationId,
    );
    /* c8 ignore next -- a successful owner commit always appends the operation. */
    if (operation === undefined)
      return rejected("persistence-failure", committed.snapshot);
    this.reviews.set(review.reviewId, {
      ...review,
      status:
        operation.phase === RECONCILIATION_OPERATION_PHASE.completed
          ? RECONCILIATION_REVIEW_STATUS.completed
          : RECONCILIATION_REVIEW_STATUS.staged,
      operationId,
      sampledLocalText: null,
      sampledRemoteText: null,
    });
    return { kind: "admitted", operation, snapshot: committed.snapshot };
  }

  /**
   * Settles a fully aligned no-effect gap or atomically transfers every changed target to fresh ordinary reviews.
   *
   * @param request - Complete group identity and all child action choices.
   * @returns Serialized settlement/transfer or a refusal that leaves the predecessor active.
   */
  async admitGapGroup(
    request: ReconciliationGapGroupAdmissionRequest,
  ): Promise<ReconciliationGapGroupAdmissionResult> {
    const before = this.stateOwner.snapshot();
    const group = this.gapGroupReviews.get(request.reviewId);
    if (group === undefined) return gapRejected("review-not-found", before);
    if (group.sessionId !== request.sessionId) {
      return gapRejected("stale-review", before);
    }
    const predecessor = findGapPredecessor(
      before.state,
      group.predecessorOperationId,
    );
    if (predecessor === undefined) return gapRejected("stale-review", before);
    const sampled = await this.sample(
      group.snapshot.targetPath,
      group.snapshot.paths.map((evidence) => evidence.path),
      group.snapshot.recovery?.id ?? null,
    );
    if (sampled.kind === "failure") {
      return gapRejected(sampled.reason, this.stateOwner.snapshot());
    }
    if (!reconciliationReviewSnapshotsEqual(group.snapshot, sampled.snapshot)) {
      await this.persistStaleGapGroup(group);
      return gapRejected("stale-review", this.stateOwner.snapshot());
    }
    if (request.actions.length === 0) {
      return this.settleGapGroupWithoutEffects(
        group,
        predecessor,
        sampled.snapshot,
      );
    }
    if (
      group.unreviewablePaths.length !== 0 ||
      request.actions.length !== group.childReviewIds.length ||
      new Set(request.actions.map((action) => action.reviewId)).size !==
        request.actions.length ||
      group.childReviewIds.some(
        (reviewId) =>
          !request.actions.some((action) => action.reviewId === reviewId),
      )
    ) {
      return gapRejected("action-not-allowed", before);
    }
    if (!gapEffectRecoveryIsComplete(predecessor, sampled.snapshot)) {
      return gapRejected("action-not-allowed", before);
    }

    const plans: GapSuccessorPlan[] = [];
    const reservedPaths = new Set<NotePath>();
    const operationIds = new Set<MirrorOperationId>([
      predecessor.operationId,
      group.reviewId,
      ...group.childReviewIds,
      ...before.state.reconciliationOperations.map(
        (operation) => operation.operationId,
      ),
      ...before.state.reconciliationReviews.map((review) => review.reviewId),
      ...before.state.reconciliationGapGroupReviews.map(
        (review) => review.reviewId,
      ),
    ]);
    for (const childReviewId of group.childReviewIds) {
      const child = this.reviews.get(childReviewId);
      const selection = request.actions.find(
        (action) => action.reviewId === childReviewId,
      );
      if (
        child === undefined ||
        selection === undefined ||
        child.sessionId !== request.sessionId ||
        child.status !== RECONCILIATION_REVIEW_STATUS.pending ||
        child.gapPredecessorId !== predecessor.operationId
      ) {
        return gapRejected("stale-review", before);
      }
      const historyChild = child.allowedActions.includes(
        RECONCILIATION_ACTION.resolveHistory,
      );
      const snapshot = historyChild
        ? sampled.snapshot
        : singleTargetSnapshot(sampled.snapshot, child.snapshot.targetPath);
      if (!reconciliationReviewSnapshotsEqual(child.snapshot, snapshot)) {
        await this.persistStaleGapGroup(group);
        return gapRejected("stale-review", this.stateOwner.snapshot());
      }
      const action = this.deriveAdmissionAction(
        before.state,
        snapshot,
        selection.action,
      );
      if (
        action === undefined ||
        action.kind === RECONCILIATION_ACTION.defer ||
        historyChild !==
          (action.kind === RECONCILIATION_ACTION.resolveHistory) ||
        (!isReconciliationActionAllowed(snapshot, action) &&
          !isGapRestoreSuccessor(predecessor, snapshot, action))
      ) {
        return gapRejected("action-not-allowed", before);
      }
      const selectedDestination = selection.destinationPath ?? null;
      if (
        selectedDestination !== null &&
        !snapshot.paths.some(
          (evidence) => evidence.path === selectedDestination,
        )
      ) {
        return gapRejected("action-not-allowed", before);
      }
      const reservations = this.createReservations(
        before.state,
        snapshot,
        selectedDestination,
      );
      if (
        reservations === undefined ||
        reservations.some((reservation) =>
          reservedPaths.has(reservation.path),
        ) ||
        this.hasReservationConflict(
          before.state,
          snapshot,
          predecessor.operationId,
        )
      ) {
        return gapRejected("reservation-conflict", before);
      }
      if (action.kind === RECONCILIATION_ACTION.resolveHistory) {
        const historyGroup = this.historyGroups.derive(
          before.state,
          snapshot.targetPath,
        );
        const predecessorPaths = predecessor.reservations.map(
          (reservation) => reservation.path,
        );
        if (
          selectedDestination !== null ||
          action.decision.kind === HISTORY_DECISION_KIND.deferHistory ||
          historyGroup.kind !== "group" ||
          !samePathSet(historyGroup.paths, predecessorPaths) ||
          !samePathSet(
            reservations.map((reservation) => reservation.path),
            predecessorPaths,
          )
        ) {
          return gapRejected("action-not-allowed", before);
        }
        const operationId = this.dependencies.createOperationId();
        if (operationIds.has(operationId)) {
          return gapRejected("stale-review", before);
        }
        operationIds.add(operationId);
        const historyProgress = this.historyGroups.createProgress(
          before.state,
          snapshot,
          action.decision,
          operationId,
          this.dependencies.createOperationId,
        );
        if (
          historyProgress === undefined ||
          (action.decision.kind === HISTORY_DECISION_KIND.executeCleanupPlan &&
            historyProgress.steps.length === 0) ||
          historyProgress.steps.some((step) => operationIds.has(step.stepId))
        ) {
          return gapRejected("action-not-allowed", before);
        }
        for (const step of historyProgress.steps) {
          operationIds.add(step.stepId);
        }
        for (const reservation of reservations) {
          reservedPaths.add(reservation.path);
        }
        const phase =
          historyProgress.nextStepIndex === null
            ? RECONCILIATION_OPERATION_PHASE.completed
            : RECONCILIATION_OPERATION_PHASE.admitted;
        const operation: ReconciliationHistoryOperation = {
          observationCoverage: RECONCILIATION_OBSERVATION_COVERAGE.continuous,
          gapSuccessorOperationIds: [],
          operationId,
          reviewId: child.reviewId,
          authority: RECONCILIATION_AUTHORITY_SOURCE.historyDecision,
          action,
          phase,
          snapshot,
          destinationPath: null,
          reservations,
          preservationReceipts: [],
          successorOperationId: null,
          historyProgress,
        };
        plans.push({
          review: child,
          operation,
          durableReview: {
            retention: RECONCILIATION_REVIEW_RETENTION.durable,
            reviewId: child.reviewId,
            classification: classifyReconciliation(snapshot),
            status:
              phase === RECONCILIATION_OPERATION_PHASE.completed
                ? RECONCILIATION_REVIEW_STATUS.completed
                : RECONCILIATION_REVIEW_STATUS.staged,
            snapshot,
            operationId,
          },
        });
        continue;
      }
      for (const reservation of reservations)
        reservedPaths.add(reservation.path);
      const target = snapshot.paths.find(
        (evidence) => evidence.path === snapshot.targetPath,
      );
      if (target === undefined) {
        return gapRejected("action-not-allowed", before);
      }
      const operationId = this.dependencies.createOperationId();
      if (operationIds.has(operationId)) {
        return gapRejected("stale-review", before);
      }
      operationIds.add(operationId);
      const operation: ReconciliationNonHistoryOperation = {
        observationCoverage: RECONCILIATION_OBSERVATION_COVERAGE.continuous,
        gapSuccessorOperationIds: [],
        operationId,
        reviewId: child.reviewId,
        authority: reconciliationAuthorityForAction(action),
        action,
        phase: RECONCILIATION_OPERATION_PHASE.admitted,
        snapshot,
        destinationPath: selectedDestination,
        reservations,
        preservationReceipts: [],
        successorOperationId: null,
        localEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
        remoteEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
        localEffectObservation: actionMayWriteLocal(action.kind)
          ? { kind: LOCAL_EFFECT_OBSERVATION_KIND.notStarted }
          : {
              kind: LOCAL_EFFECT_OBSERVATION_KIND.notRequired,
              path: snapshot.targetPath,
              listenerEpoch: snapshot.runtime.listenerEpoch,
              beforeGeneration:
                target.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown
                  ? 0
                  : target.local.observationGeneration,
              successor: null,
            },
      };
      plans.push({
        review: child,
        operation,
        durableReview: {
          retention: RECONCILIATION_REVIEW_RETENTION.durable,
          reviewId: child.reviewId,
          classification: classifyReconciliation(snapshot),
          status: RECONCILIATION_REVIEW_STATUS.staged,
          snapshot,
          operationId,
        },
      });
    }
    if (plans.length === 0) return gapRejected("action-not-allowed", before);

    const durableGroup: ReconciliationGapGroupReview = {
      kind: RECONCILIATION_GAP_REVIEW_KIND.gapGroup,
      reviewId: group.reviewId,
      predecessorOperationId: predecessor.operationId,
      status: RECONCILIATION_GAP_REVIEW_STATUS.completed,
      snapshot: sampled.snapshot,
      childReviewIds: plans.map((plan) => plan.review.reviewId),
    };
    const committed = await this.stateOwner.transition((state) => {
      const currentPredecessor = findGapPredecessor(
        state,
        predecessor.operationId,
      );
      if (
        this.gapGroupReviews.get(group.reviewId) !== group ||
        currentPredecessor === undefined ||
        !reservationScopeMatches(currentPredecessor, sampled.snapshot) ||
        !this.currentStateMatches(state, sampled.snapshot) ||
        !this.isAdmissionLifecycleAllowed(state, sampled.snapshot) ||
        !gapEffectRecoveryIsComplete(currentPredecessor, sampled.snapshot) ||
        plans.some(
          (plan) =>
            this.reviews.get(plan.review.reviewId) !== plan.review ||
            plan.review.sessionId !== request.sessionId ||
            plan.review.status !== RECONCILIATION_REVIEW_STATUS.pending ||
            !this.currentStateMatches(state, plan.operation.snapshot) ||
            (!isReconciliationActionAllowed(
              plan.operation.snapshot,
              plan.operation.action,
            ) &&
              !isGapRestoreSuccessor(
                currentPredecessor,
                plan.operation.snapshot,
                plan.operation.action,
              )) ||
            this.hasReservationConflict(
              state,
              plan.operation.snapshot,
              predecessor.operationId,
            ),
        ) ||
        new Set(
          plans.flatMap((plan) =>
            plan.operation.reservations.map((reservation) => reservation.path),
          ),
        ).size !==
          plans.reduce(
            (reservationCount, plan) =>
              reservationCount + plan.operation.reservations.length,
            0,
          )
      ) {
        return undefined;
      }
      const completedPredecessor: ReconciliationOperation = {
        ...currentPredecessor,
        phase: RECONCILIATION_OPERATION_PHASE.completed,
        gapSuccessorOperationIds: plans.map(
          (plan) => plan.operation.operationId,
        ),
      };
      const nextState: MirrorDeviceState = {
        ...state,
        reconciliationOperations: [
          ...state.reconciliationOperations.map((operation) =>
            operation.operationId === predecessor.operationId
              ? completedPredecessor
              : operation,
          ),
          ...plans.map((plan) => plan.operation),
        ],
        reconciliationReviews: [
          ...state.reconciliationReviews.map((review) =>
            review.reviewId === predecessor.reviewId
              ? { ...review, status: RECONCILIATION_REVIEW_STATUS.completed }
              : review,
          ),
          ...plans.map((plan) => plan.durableReview),
        ],
        reconciliationGapGroupReviews: [
          ...state.reconciliationGapGroupReviews,
          durableGroup,
        ],
      };
      return nextState;
    });
    if (committed.kind !== "committed") {
      return gapRejected(
        committed.kind === "save-failed"
          ? "persistence-failure"
          : "reservation-conflict",
        committed.snapshot,
      );
    }
    const operations = plans.map((plan) => {
      const operation = committed.snapshot.state.reconciliationOperations.find(
        (candidate) => candidate.operationId === plan.operation.operationId,
      );
      if (operation === undefined)
        throw new Error("Committed gap child missing.");
      this.reviews.set(plan.review.reviewId, {
        ...plan.review,
        status: plan.durableReview.status,
        operationId: operation.operationId,
        sampledLocalText: null,
        sampledRemoteText: null,
      });
      return operation;
    });
    this.gapGroupReviews.delete(group.reviewId);
    return {
      kind: "transferred",
      review: durableGroup,
      operations,
      snapshot: committed.snapshot,
    };
  }

  /**
   * Completes a predecessor only when a fresh group snapshot proves a genuinely effect-safe no-op.
   * @param group - Exact process-local gap review.
   * @param predecessor - Current active gap-fenced operation.
   * @param snapshot - Fresh immutable complete reservation-set evidence.
   * @returns Committed terminal review, or a refusal preserving the predecessor reservation.
   */
  private async settleGapGroupWithoutEffects(
    group: EphemeralReconciliationGapGroupReview,
    predecessor: ReconciliationOperation,
    snapshot: ReconciliationReviewSnapshot,
  ): Promise<ReconciliationGapGroupAdmissionResult> {
    if (
      group.childReviewIds.length !== 0 ||
      group.unreviewablePaths.length !== 0 ||
      !gapOperationCanSettleWithoutEffects(predecessor, snapshot)
    ) {
      return gapRejected("action-not-allowed", this.stateOwner.snapshot());
    }
    const durableGroup: ReconciliationGapGroupReview = {
      kind: RECONCILIATION_GAP_REVIEW_KIND.gapGroup,
      reviewId: group.reviewId,
      predecessorOperationId: predecessor.operationId,
      status: RECONCILIATION_GAP_REVIEW_STATUS.completed,
      snapshot,
      childReviewIds: [],
    };
    const committed = await this.stateOwner.transition((state) => {
      const current = findGapPredecessor(state, predecessor.operationId);
      if (
        this.gapGroupReviews.get(group.reviewId) !== group ||
        current === undefined ||
        !reservationScopeMatches(current, snapshot) ||
        !this.currentStateMatches(state, snapshot) ||
        !gapOperationCanSettleWithoutEffects(current, snapshot) ||
        !this.isAdmissionLifecycleAllowed(state, snapshot)
      ) {
        return undefined;
      }
      return {
        ...state,
        reconciliationOperations: state.reconciliationOperations.map(
          (operation) =>
            operation.operationId === current.operationId
              ? {
                  ...operation,
                  phase: RECONCILIATION_OPERATION_PHASE.completed,
                  gapSuccessorOperationIds: [],
                }
              : operation,
        ),
        reconciliationReviews: state.reconciliationReviews.map((review) =>
          review.reviewId === current.reviewId
            ? { ...review, status: RECONCILIATION_REVIEW_STATUS.completed }
            : review,
        ),
        reconciliationGapGroupReviews: [
          ...state.reconciliationGapGroupReviews,
          durableGroup,
        ],
      };
    });
    if (committed.kind !== "committed") {
      return gapRejected(
        committed.kind === "save-failed"
          ? "persistence-failure"
          : "reservation-conflict",
        committed.snapshot,
      );
    }
    this.gapGroupReviews.delete(group.reviewId);
    return {
      kind: "settled",
      review: durableGroup,
      snapshot: committed.snapshot,
    };
  }

  /** Persists a stale complete review as audit evidence without releasing its predecessor. */
  private async persistStaleGapGroup(
    group: EphemeralReconciliationGapGroupReview,
  ): Promise<void> {
    for (const reviewId of group.childReviewIds) this.markStale(reviewId);
    const durableGroup: ReconciliationGapGroupReview = {
      kind: RECONCILIATION_GAP_REVIEW_KIND.gapGroup,
      reviewId: group.reviewId,
      predecessorOperationId: group.predecessorOperationId,
      status: RECONCILIATION_GAP_REVIEW_STATUS.stale,
      snapshot: group.snapshot,
      childReviewIds: [],
    };
    await this.stateOwner.transition((state) =>
      findGapPredecessor(state, group.predecessorOperationId) === undefined ||
      state.reconciliationGapGroupReviews.some(
        (review) => review.reviewId === group.reviewId,
      )
        ? undefined
        : {
            ...state,
            reconciliationGapGroupReviews: [
              ...state.reconciliationGapGroupReviews,
              durableGroup,
            ],
          },
    );
    this.gapGroupReviews.delete(group.reviewId);
  }

  /**
   * Creates the deterministic target/related path sample set.
   * @param request - Review target and optional related selections.
   * @returns Lexically ordered unique paths.
   */
  private reviewPaths(
    request: ReconciliationReviewRequest,
  ): readonly NotePath[] {
    const state = this.stateOwner.snapshot().state;
    const historyGroup = this.historyGroups.derive(state, request.targetPath);
    if (historyGroup.kind === "group") return historyGroup.paths;
    const paths = new Set<NotePath>([request.targetPath]);
    const localEffectPredecessor = state.reconciliationOperations.find(
      (operation) =>
        isNonHistoryReconciliationOperation(operation) &&
        operation.phase ===
          RECONCILIATION_OPERATION_PHASE.successorReviewRequired &&
        operation.reservations.some(
          (reservation) => reservation.path === request.targetPath,
        ),
    );
    for (const reservation of localEffectPredecessor?.reservations ?? []) {
      paths.add(reservation.path);
    }
    for (const path of request.relatedPaths ?? []) paths.add(path);
    if (
      request.destinationPath !== undefined &&
      request.destinationPath !== null
    ) {
      paths.add(request.destinationPath);
    }
    const statePath = state.paths.find(
      (entry) => entry.path === request.targetPath,
    );
    if (statePath?.desired.kind === MIRROR_DESIRED_STATE_KIND.renameDeferred) {
      paths.add(statePath.path);
      if (statePath.desired.destinationPath !== null) {
        paths.add(statePath.desired.destinationPath);
      }
    }
    return sortedPaths(paths);
  }

  /**
   * Samples all path evidence and selected recovery metadata without retaining bodies durably.
   * @param targetPath - Path whose transient text may be returned.
   * @param paths - Bounded paths included in the immutable snapshot.
   * @param recoveryId - Optional recovery identity to inspect exactly.
   * @returns Sampled content-free evidence or an authority failure.
   */
  private async sample(
    targetPath: NotePath,
    paths: readonly NotePath[],
    recoveryId: RecoverySnapshotId | null,
  ): Promise<SampleResult> {
    const stateSnapshot = this.stateOwner.snapshot();
    const runtime = this.dependencies.runtime.current();
    if (
      runtime.deviceId !== stateSnapshot.state.deviceId ||
      !lifecycleEquals(runtime.lifecycle, stateSnapshot.state.lifecycle) ||
      runtime.lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.disabled
    ) {
      return { kind: "failure", reason: "invalid-lifecycle-or-authority" };
    }
    const description = await this.remote.describe();
    const remoteReady =
      description.kind === "success" &&
      description.value.associationId === runtime.lifecycle.associationId &&
      description.value.writerId === runtime.designatedWriterId;
    const evidence: ReconciliationPathEvidence[] = [];
    let localText: string | null = null;
    let remoteText: string | null = null;
    const pathContents = new Map<
      NotePath,
      { readonly localText: string | null; readonly remoteText: string | null }
    >();
    let selectedRecovery: RecoverySnapshotState | null = null;
    for (const path of paths) {
      const local = await this.sampleLocal(path);
      const remote = remoteReady
        ? await this.sampleRemote(path)
        : unavailableRemote();
      pathContents.set(path, {
        localText: local.text,
        remoteText: remote.text,
      });
      if (path === targetPath) {
        localText = local.text;
        remoteText = remote.text;
      }
      evidence.push({
        path,
        local: local.evidence,
        baseline: baselineFor(stateSnapshot.state, path),
        remote: remote.evidence,
        m3: m3For(stateSnapshot.state, path),
      });
      const remoteRecoveryId =
        remote.evidence.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone
          ? remote.evidence.recoveryId
          : null;
      const requestedRecoveryId = recoveryId ?? remoteRecoveryId;
      if (path === targetPath && requestedRecoveryId !== null) {
        const recovery = await this.remote.inspectRecovery(requestedRecoveryId);
        if (recovery.kind === "success") {
          if (recovery.value !== null && recovery.value.path === targetPath) {
            selectedRecovery = recovery.value;
          }
        } else if (recoveryId !== null) {
          const currentEvidence = evidence[evidence.length - 1];
          if (currentEvidence !== undefined) {
            evidence[evidence.length - 1] = {
              ...currentEvidence,
              remote: { kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.unavailable },
            };
          }
        }
      }
    }
    const snapshot: ReconciliationReviewSnapshot = {
      runtime,
      targetPath,
      paths: evidence,
      recovery: selectedRecovery,
    };
    return {
      kind: "sampled",
      snapshot,
      localText,
      remoteText,
      pathContents,
    };
  }

  /**
   * Samples stable local text exactly once and converts failures to conservative evidence.
   * @param path - Eligible local path.
   * @returns Local content-free evidence and transient target text.
   */
  private async sampleLocal(path: NotePath): Promise<LocalSample> {
    const generation = this.observations.ensure(path);
    try {
      const result = await this.local.read(path);
      if (this.observations.current(path) !== generation) {
        return unknownLocal();
      }
      if (result.kind === LocalInspectionKind.failed) {
        if (
          result.reason === LocalVaultFailureReason.missingFile &&
          (!this.localInventoryAvailable || !this.positiveInventory.has(path))
        ) {
          return {
            evidence: {
              kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.absent,
              stability: RECONCILIATION_LOCAL_STABILITY.stable,
              observationGeneration: generation,
            },
            text: null,
          };
        }
        return unknownLocal();
      }
      const hash = await this.dependencies.hashContent(result.content);
      if (this.observations.current(path) !== generation) {
        return unknownLocal();
      }
      return {
        evidence: {
          kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.live,
          stability: RECONCILIATION_LOCAL_STABILITY.stable,
          observationGeneration: generation,
          byteSize: result.sizeBytes,
          contentSha256: hash,
        },
        text: result.content,
      };
    } catch {
      return unknownLocal();
    }
  }

  /**
   * Samples exact remote state/content while refusing a refreshed latest generation.
   * @param path - Candidate remote path.
   * @returns Remote content-free evidence and transient target text.
   */
  private async sampleRemote(path: NotePath): Promise<RemoteSample> {
    const first = await this.remote.inspectNote(path);
    if (first.kind === "failure") return unavailableRemote();
    if (first.value.kind === "absent") return absentRemote();
    if (first.value.kind === "tombstone") {
      const second = await this.remote.inspectNote(path);
      return sameRemoteState(first.value, second)
        ? tombstoneRemote(first.value)
        : unavailableRemote();
    }
    const content = await this.remote.readNote(path);
    if (content.kind === "failure") return unavailableRemote();
    if (first.value.kind === "legacy") {
      if (content.value.kind !== "legacy") return unavailableRemote();
      const hash = await this.dependencies.hashContent(content.value.content);
      const second = await this.remote.inspectNote(path);
      return sameRemoteKind(first.value, second)
        ? legacyRemote(hash, content.value.content)
        : unavailableRemote();
    }
    if (
      content.value.kind !== "live" ||
      content.value.revision !== first.value.revision
    ) {
      return unavailableRemote();
    }
    const hash = await this.dependencies.hashContent(content.value.content);
    const second = await this.remote.inspectNote(path);
    if (!sameRemoteState(first.value, second)) return unavailableRemote();
    return liveRemote(first.value, hash, content.value.content);
  }

  /**
   * Adds state-owned deferred-history destinations without creating arbitrary path inventory.
   * @param candidates - Bounded candidate set.
   * @param entry - Existing M3 path entry.
   * @returns Nothing; the set is updated only within the candidate bound.
   */
  private addRelatedHistoryCandidates(
    candidates: Set<NotePath>,
    entry: MirrorPathState,
  ): void {
    if (
      entry.desired.kind === MIRROR_DESIRED_STATE_KIND.renameDeferred &&
      entry.desired.destinationPath !== null
    ) {
      this.addCandidate(candidates, entry.desired.destinationPath);
    }
  }

  /**
   * Adds a candidate only within the existing tracked-path bound.
   * @param candidates - Bounded candidate set.
   * @param path - Candidate path.
   * @returns Whether the path was added, already present, or intentionally excluded without exceeding capacity.
   */
  private addCandidate(candidates: Set<NotePath>, path: NotePath): boolean {
    if (isReconciliationPreservationNamespacePath(path)) return true;
    if (candidates.has(path)) return true;
    if (candidates.size >= MAX_MIRROR_TRACKED_PATHS) return false;
    candidates.add(path);
    return true;
  }

  /** @returns Whether a non-preservation path is in the last bounded candidate union. */
  private isCandidate(path: NotePath): boolean {
    if (isReconciliationPreservationNamespacePath(path)) return false;
    return (
      this.candidates.has(path) ||
      this.stateOwner
        .snapshot()
        .state.paths.some((entry) => entry.path === path)
    );
  }

  /**
   * Invalidates all reviews whose complete snapshot includes one replaced path.
   * @param paths - Paths whose evidence was replaced by a new review.
   * @returns Nothing; affected reviews become stale.
   */
  private invalidateOverlapping(paths: readonly NotePath[]): void {
    const affected = new Set(paths);
    for (const group of this.gapGroupReviews.values()) {
      if (
        group.snapshot.paths.some((evidence) => affected.has(evidence.path))
      ) {
        this.invalidateGapGroup(group);
      }
    }
    for (const review of this.reviews.values()) {
      if (
        review.status === RECONCILIATION_REVIEW_STATUS.pending &&
        review.snapshot.paths.some((evidence) => affected.has(evidence.path))
      ) {
        this.reviews.set(review.reviewId, staleReview(review));
      }
    }
  }

  /** Invalidates one complete transient gap review and every child body it owns. */
  private invalidateGapGroup(
    group: EphemeralReconciliationGapGroupReview,
  ): void {
    for (const reviewId of group.childReviewIds) this.markStale(reviewId);
    this.gapGroupReviews.delete(group.reviewId);
  }

  /**
   * Marks one process-local review stale and discards its sampled bodies.
   * @param reviewId - Review identity to invalidate.
   * @returns Nothing.
   */
  private markStale(reviewId: string): void {
    const review = this.reviews.get(reviewId);
    if (review !== undefined) this.reviews.set(reviewId, staleReview(review));
  }

  /**
   * Returns current pending ephemeral reviews with sampled bodies still transient.
   * @returns Pending process-local reviews.
   */
  private openReviews(): readonly EphemeralReconciliationReview[] {
    return [...this.reviews.values()].filter(
      (review) => review.status === RECONCILIATION_REVIEW_STATUS.pending,
    );
  }

  /**
   * Requires active lifecycle and exact current runtime evidence before durable admission.
   * @param state - Current state-owner value.
   * @param snapshot - Fresh evidence under admission.
   * @returns Whether admission lifecycle prerequisites hold.
   */
  private isAdmissionLifecycleAllowed(
    state: MirrorDeviceState,
    snapshot: ReconciliationReviewSnapshot,
  ): boolean {
    return (
      state.lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.active &&
      state.globalBlockReason === null &&
      snapshot.runtime.lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.active
    );
  }

  /**
   * Compares current durable baseline/M3 evidence and observation generations to the fresh sample.
   * @param state - Current state-owner value.
   * @param snapshot - Fresh evidence under admission.
   * @returns Whether every sampled authority dimension remains current.
   */
  private currentStateMatches(
    state: MirrorDeviceState,
    snapshot: ReconciliationReviewSnapshot,
  ): boolean {
    const currentRuntime = this.dependencies.runtime.current();
    if (!sameRuntime(currentRuntime, snapshot.runtime)) return false;
    for (const evidence of snapshot.paths) {
      const current = state.paths.find((entry) => entry.path === evidence.path);
      const currentView: ReconciliationReviewSnapshot = {
        ...snapshot,
        paths: snapshot.paths.map((candidate) =>
          candidate.path === evidence.path
            ? {
                ...candidate,
                baseline: current?.acknowledgement ?? {
                  kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated,
                },
                m3: m3For(state, candidate.path),
              }
            : candidate,
        ),
      };
      /* c8 ignore next -- the serialized owner normally fences this before admission. */
      if (!reconciliationReviewSnapshotsEqual(snapshot, currentView))
        return false;
      if (
        evidence.local.kind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown &&
        this.observations.current(evidence.path) !==
          evidence.local.observationGeneration
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Detects durable active operation overlap before the owner transition adds a new reservation.
   * @param state - Current durable state.
   * @param snapshot - Paths the new operation would reserve.
   * @param transferablePredecessorId - Exact restore/event predecessor released atomically.
   * @returns Whether another active operation overlaps those paths.
   */
  private hasReservationConflict(
    state: MirrorDeviceState,
    snapshot: ReconciliationReviewSnapshot,
    transferablePredecessorId?: ReconciliationOperation["operationId"],
  ): boolean {
    return state.reconciliationOperations.some(
      (operation) =>
        operation.operationId !== transferablePredecessorId &&
        operation.phase !== RECONCILIATION_OPERATION_PHASE.stale &&
        operation.phase !== RECONCILIATION_OPERATION_PHASE.completed &&
        operation.reservations.some((reservation) =>
          snapshot.paths.some((evidence) => evidence.path === reservation.path),
        ),
    );
  }

  /**
   * Finds the one local-first restore whose exact restored path may transfer to a
   * fresh reviewed successor in the same serialized admission transition.
   *
   * @param state - Current authoritative durable state.
   * @param snapshot - Fresh successor review snapshot.
   * @param action - Reviewed successor action; defer cannot release restore ownership.
   * @returns Exact transferable restore, or undefined without complete post-restore evidence.
   */
  private restorePredecessor(
    state: MirrorDeviceState,
    snapshot: ReconciliationReviewSnapshot,
    action: ReconciliationAction,
  ): ReconciliationOperation | undefined {
    if (action.kind === RECONCILIATION_ACTION.defer) return undefined;
    return state.reconciliationOperations.find((operation) => {
      if (
        !isNonHistoryReconciliationOperation(operation) ||
        operation.action.kind !== RECONCILIATION_ACTION.restoreRecovery ||
        operation.phase !==
          RECONCILIATION_OPERATION_PHASE.restoredPendingReview ||
        operation.localEffect !== MUTATION_EFFECT_CERTAINTY.confirmed ||
        operation.snapshot.recovery === null
      ) {
        return false;
      }
      const restoredPath =
        operation.destinationPath ?? operation.snapshot.targetPath;
      if (snapshot.targetPath !== restoredPath) return false;
      const before = operation.snapshot.paths.find(
        (evidence) => evidence.path === restoredPath,
      );
      const after = snapshot.paths.find(
        (evidence) => evidence.path === restoredPath,
      );
      return (
        before !== undefined &&
        before.local.kind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown &&
        after?.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live &&
        (snapshot.runtime.listenerEpoch !==
          operation.snapshot.runtime.listenerEpoch ||
          after.local.observationGeneration >
            before.local.observationGeneration) &&
        after.local.contentSha256 === operation.snapshot.recovery.contentSha256
      );
    });
  }

  /**
   * Finds the exact operation retaining a durable post-admission local-event range.
   *
   * @param state - Current authoritative durable state.
   * @param snapshot - Fresh complete successor review snapshot.
   * @returns Transferable predecessor, or undefined without complete reservation coverage.
   */
  private localEffectPredecessor(
    state: MirrorDeviceState,
    snapshot: ReconciliationReviewSnapshot,
  ): ReconciliationNonHistoryOperation | undefined {
    return state.reconciliationOperations.find(
      (operation): operation is ReconciliationNonHistoryOperation =>
        isNonHistoryReconciliationOperation(operation) &&
        operation.phase ===
          RECONCILIATION_OPERATION_PHASE.successorReviewRequired &&
        "successor" in operation.localEffectObservation &&
        operation.localEffectObservation.successor !== null &&
        operation.reservations.every((reservation) =>
          snapshot.paths.some((evidence) => evidence.path === reservation.path),
        ) &&
        operation.reservations.some(
          (reservation) => reservation.path === snapshot.targetPath,
        ),
    );
  }

  /**
   * Prevents a second pending process-local review from admitting overlapping paths.
   * @param current - Review attempting admission.
   * @returns Whether another pending review overlaps it.
   */
  private hasOpenReviewConflict(
    current: EphemeralReconciliationReview,
  ): boolean {
    return [...this.reviews.values()].some(
      (review) =>
        review.reviewId !== current.reviewId &&
        review.status === RECONCILIATION_REVIEW_STATUS.pending &&
        review.snapshot.paths.some((left) =>
          current.snapshot.paths.some((right) => left.path === right.path),
        ),
    );
  }

  /**
   * Converts a process-local admission request into the only durable action shape.
   *
   * History canonical paths are derived from the current complete group; presentation
   * can submit only a selected projected candidate. Ordinary actions pass through.
   *
   * @param state - Current durable group authority.
   * @param snapshot - Fresh complete immutable review evidence.
   * @param action - Process-local operator request.
   * @returns Durable action or undefined when history selection/group evidence is stale.
   */
  private deriveAdmissionAction(
    state: MirrorDeviceState,
    snapshot: ReconciliationReviewSnapshot,
    action: ReconciliationAdmissionAction,
  ): ReconciliationAction | undefined {
    if (action.kind !== RECONCILIATION_ACTION.resolveHistory) return action;
    const decision = this.historyGroups.deriveDecision(
      state,
      snapshot,
      action.decision,
    );
    return decision === undefined
      ? undefined
      : { kind: RECONCILIATION_ACTION.resolveHistory, decision };
  }

  /**
   * Creates lexical reservations for the full immutable snapshot.
   * @param state - Current state used to distinguish tracked paths.
   * @param snapshot - Complete sampled paths.
   * @param destinationPath - Explicit optional new destination.
   * @returns Reservations or undefined when a path relationship is invalid.
   */
  private createReservations(
    state: MirrorDeviceState,
    snapshot: ReconciliationReviewSnapshot,
    destinationPath: NotePath | null,
  ): ReconciliationOperation["reservations"] | undefined {
    const reservations = snapshot.paths.map((evidence) => {
      if (evidence.path === snapshot.targetPath) {
        return {
          path: evidence.path,
          kind: RECONCILIATION_PATH_REFERENCE_KIND.reviewTarget,
        } as const;
      }
      if (state.paths.some((entry) => entry.path === evidence.path)) {
        return {
          path: evidence.path,
          kind: RECONCILIATION_PATH_REFERENCE_KIND.tracked,
        } as const;
      }
      if (destinationPath === evidence.path && isAbsentDestination(evidence)) {
        return {
          path: evidence.path,
          kind: RECONCILIATION_PATH_REFERENCE_KIND.newDestination,
        } as const;
      }
      return undefined;
    });
    if (reservations.some((reservation) => reservation === undefined))
      return undefined;
    return reservations
      .filter(
        (reservation): reservation is NonNullable<typeof reservation> =>
          reservation !== undefined,
      )
      .toSorted((left, right) => left.path.localeCompare(right.path));
  }
}

/** One complete ordinary or history successor and its durable review projection. */
interface GapSuccessorPlan {
  readonly review: EphemeralReconciliationReview;
  readonly operation:
    | ReconciliationNonHistoryOperation
    | ReconciliationHistoryOperation;
  readonly durableReview: ReconciliationReview;
}

/**
 * Selects ordinary single-target actions that fit the predecessor's existing reservation scope.
 * @param snapshot - Fresh target-only evidence for one changed reserved path.
 * @param restoreSuccessor - Whether the special restored-pending-review contract applies.
 * @returns Actions that need neither a new destination nor a history-group decision.
 */
function gapSuccessorActions(
  snapshot: ReconciliationReviewSnapshot,
  restoreSuccessor: boolean,
): readonly ReconciliationAdmissionAction["kind"][] {
  if (restoreSuccessor) return [RECONCILIATION_ACTION.keepLocal];
  if (
    classifyReconciliation(snapshot) ===
    RECONCILIATION_CLASSIFICATION.deferredHistory
  ) {
    return [];
  }
  return allowedReconciliationActions(snapshot).filter(
    (action): action is ReconciliationAdmissionAction["kind"] =>
      action !== RECONCILIATION_ACTION.defer &&
      action !== RECONCILIATION_ACTION.keepBoth &&
      action !== RECONCILIATION_ACTION.forkLegacy &&
      action !== RECONCILIATION_ACTION.resolveHistory,
  );
}

/**
 * Finds the still-reserved operation that may be resolved by fresh gap evidence.
 * @param state - Current durable state.
 * @param operationId - Exact predecessor identity.
 * @returns Active gap-fenced predecessor only.
 */
function findGapPredecessor(
  state: MirrorDeviceState,
  operationId: MirrorOperationId,
): ReconciliationOperation | undefined {
  return state.reconciliationOperations.find(
    (operation) =>
      operation.operationId === operationId &&
      operation.observationCoverage ===
        RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired &&
      operation.phase !== RECONCILIATION_OPERATION_PHASE.completed &&
      operation.phase !== RECONCILIATION_OPERATION_PHASE.stale,
  );
}

/**
 * Checks every durable identity namespace before admitting one gap-review UUID.
 * @param state - Current durable mirror state.
 * @param reviewId - Candidate process-local group or child identity.
 * @returns Whether a durable operation, review or group already owns this ID.
 */
function hasPersistedGapIdentityCollision(
  state: MirrorDeviceState,
  reviewId: MirrorOperationId,
): boolean {
  return (
    state.reconciliationOperations.some(
      (operation) => operation.operationId === reviewId,
    ) ||
    state.reconciliationReviews.some(
      (review) => review.reviewId === reviewId,
    ) ||
    state.reconciliationGapGroupReviews.some(
      (review) => review.reviewId === reviewId,
    )
  );
}

/**
 * Confirms that a complete fresh group snapshot exactly covers one operation's retained reservations.
 * @param operation - Current candidate predecessor, if it still exists.
 * @param snapshot - Fresh complete path evidence.
 * @returns Whether both bounded path sets are identical.
 */
function reservationScopeMatches(
  operation: ReconciliationOperation | undefined,
  snapshot: ReconciliationReviewSnapshot,
): boolean {
  return (
    operation !== undefined &&
    samePathSet(
      operation.reservations.map((reservation) => reservation.path),
      snapshot.paths.map((evidence) => evidence.path),
    )
  );
}

/**
 * Recognizes a current exact M3 receipt for the one remote mutation implied by the old action.
 * @param operation - Gap-fenced operation whose remote call may have completed.
 * @param snapshot - Complete current sample of its exact reservation set.
 * @returns Whether the current remote generation proves that operation's requested mutation.
 */
function hasExactGapRemoteReceipt(
  operation: ReconciliationNonHistoryOperation,
  snapshot: ReconciliationReviewSnapshot,
): boolean {
  if (snapshot.runtime.lifecycle.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.active) {
    return false;
  }
  const target = operation.snapshot.paths.find(
    (evidence) => evidence.path === operation.snapshot.targetPath,
  );
  if (target === undefined) return false;
  let path: NotePath;
  let action: ContentMutationAction;
  let precondition: ConditionalMutationPrecondition;
  let expectedHash: ContentSha256;
  switch (operation.action.kind) {
    case RECONCILIATION_ACTION.keepLocal:
      if (target.local.kind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.live) {
        return false;
      }
      path = target.path;
      expectedHash = target.local.contentSha256;
      if (target.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.absent) {
        action = MUTATION_ACTION.create;
        precondition = {
          kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent,
        };
      } else if (
        target.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live
      ) {
        action = MUTATION_ACTION.update;
        precondition = {
          kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
          revision: target.remote.revision,
        };
      } else {
        return false;
      }
      break;
    case RECONCILIATION_ACTION.keepBoth: {
      if (
        target.local.kind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.live ||
        target.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.live
      ) {
        return false;
      }
      if (
        operation.action.primarySide === RECONCILIATION_PRESERVATION_SIDE.local
      ) {
        path = target.path;
        action = MUTATION_ACTION.update;
        expectedHash = target.local.contentSha256;
        precondition = {
          kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
          revision: target.remote.revision,
        };
        break;
      }
      const destination = operation.destinationPath;
      const destinationEvidence = operation.snapshot.paths.find(
        (evidence) => evidence.path === destination,
      );
      if (
        destination === null ||
        destinationEvidence?.remote.kind !==
          RECONCILIATION_REMOTE_EVIDENCE_KIND.absent
      ) {
        return false;
      }
      path = destination;
      action = MUTATION_ACTION.create;
      expectedHash = target.local.contentSha256;
      precondition = {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent,
      };
      break;
    }
    case RECONCILIATION_ACTION.recreateRemote:
      if (
        target.local.kind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.live ||
        target.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone
      ) {
        return false;
      }
      path = target.path;
      action = MUTATION_ACTION.recreate;
      expectedHash = target.local.contentSha256;
      precondition = {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
        revision: target.remote.revision,
      };
      break;
    case RECONCILIATION_ACTION.forkLegacy: {
      const destination = operation.destinationPath;
      const destinationEvidence = operation.snapshot.paths.find(
        (evidence) => evidence.path === destination,
      );
      if (
        destination === null ||
        target.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy ||
        destinationEvidence?.remote.kind !==
          RECONCILIATION_REMOTE_EVIDENCE_KIND.absent
      ) {
        return false;
      }
      path = destination;
      action = MUTATION_ACTION.create;
      expectedHash = target.remote.contentSha256;
      precondition = {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent,
      };
      break;
    }
    default:
      return false;
  }
  const current = snapshot.paths.find((evidence) => evidence.path === path);
  if (current?.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.live) {
    return false;
  }
  const receipt = current.remote.receipt;
  return (
    receipt.operationId === operation.operationId &&
    receipt.associationId === snapshot.runtime.lifecycle.associationId &&
    receipt.action === action &&
    receipt.contentSha256 === expectedHash &&
    receiptPreconditionMatches(receipt.precondition, precondition)
  );
}

/** @returns Whether two conditional mutation preconditions identify the same generation. */
function receiptPreconditionMatches(
  actual: ConditionalMutationPrecondition,
  expected: ConditionalMutationPrecondition,
): boolean {
  if (actual.kind !== expected.kind) return false;
  return (
    actual.kind === CONDITIONAL_MUTATION_PRECONDITION_KIND.absent ||
    (expected.kind ===
      CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision &&
      actual.revision === expected.revision)
  );
}

/** @returns A phase that records recovered effects without completing or unblocking the gap operation. */
function recoveredGapOperationPhase(
  operation: ReconciliationNonHistoryOperation,
): ReconciliationNonHistoryOperation["phase"] {
  if (
    operation.phase === RECONCILIATION_OPERATION_PHASE.blocked ||
    operation.phase === RECONCILIATION_OPERATION_PHASE.preserving
  ) {
    return operation.phase;
  }
  if (
    operation.action.kind === RECONCILIATION_ACTION.restoreRecovery &&
    operation.localEffect === MUTATION_EFFECT_CERTAINTY.confirmed
  ) {
    return RECONCILIATION_OPERATION_PHASE.restoredPendingReview;
  }
  return operation.phase === RECONCILIATION_OPERATION_PHASE.mutatingLocal ||
    operation.phase === RECONCILIATION_OPERATION_PHASE.mutatingRemote ||
    operation.phase === RECONCILIATION_OPERATION_PHASE.evidenceRequired
    ? RECONCILIATION_OPERATION_PHASE.partial
    : operation.phase;
}

/**
 * Allows transfer only after every potentially dispatched effect has exact conclusive evidence.
 * @param operation - Gap-fenced predecessor under review.
 * @returns Whether new reviews may replace the old effect authority.
 */
function gapEffectRecoveryIsComplete(
  operation: ReconciliationOperation,
  freshSnapshot: ReconciliationReviewSnapshot,
): boolean {
  if (isNonHistoryReconciliationOperation(operation)) {
    if (
      operation.localEffect === MUTATION_EFFECT_CERTAINTY.unknown ||
      operation.remoteEffect === MUTATION_EFFECT_CERTAINTY.unknown ||
      operation.localEffectObservation.kind ===
        LOCAL_EFFECT_OBSERVATION_KIND.prepared ||
      operation.localEffectObservation.kind ===
        LOCAL_EFFECT_OBSERVATION_KIND.legacyV3Unfenced
    ) {
      return false;
    }
    const confirmedEffect =
      operation.localEffect === MUTATION_EFFECT_CERTAINTY.confirmed ||
      operation.remoteEffect === MUTATION_EFFECT_CERTAINTY.confirmed;
    if (!confirmedEffect) {
      return (
        operation.phase === RECONCILIATION_OPERATION_PHASE.admitted &&
        operation.localEffect === MUTATION_EFFECT_CERTAINTY.notDispatched &&
        operation.remoteEffect === MUTATION_EFFECT_CERTAINTY.notDispatched &&
        operation.preservationReceipts.length === 0
      );
    }
    const requirements = requiredReconciliationPreservations(operation);
    return (
      requirements !== undefined &&
      areRequiredReconciliationPreservationsVerified(
        requirements,
        operation.preservationReceipts,
      ) &&
      isConfirmedLocalPostconditionCurrent(operation, freshSnapshot)
    );
  }
  if (!isHistoryReconciliationOperation(operation)) return false;
  if (!isRefinedHistoryReconciliationOperation(operation)) return false;
  const progress = operation.historyProgress;
  if (
    progress.kind !== HISTORY_PROGRESS_KIND.refined ||
    progress.steps.some(
      (step) =>
        step.remoteEffect.kind === HISTORY_REMOTE_EFFECT_KIND.unknown ||
        ((step.phase === HISTORY_CLEANUP_STEP_PHASE.mutatingRemote ||
          step.phase === HISTORY_CLEANUP_STEP_PHASE.evidenceRequired) &&
          step.remoteEffect.kind !==
            HISTORY_REMOTE_EFFECT_KIND.confirmedExactTombstoneReceipt),
    )
  ) {
    return false;
  }
  const pendingStep =
    progress.nextStepIndex === null
      ? undefined
      : progress.steps[progress.nextStepIndex];
  if (
    pendingStep?.phase === HISTORY_CLEANUP_STEP_PHASE.pending &&
    pendingStep.remoteEffect.kind ===
      HISTORY_REMOTE_EFFECT_KIND.notDispatched &&
    !operation.preservationReceipts.some(
      (receipt) => "stepId" in receipt && receipt.stepId === pendingStep.stepId,
    )
  ) {
    return true;
  }
  const requirements = requiredReconciliationPreservations(operation);
  return (
    requirements !== undefined &&
    areRequiredReconciliationPreservationsVerified(
      requirements,
      operation.preservationReceipts,
    )
  );
}

/**
 * Refuses no-effect terminalization when the predecessor contains restore or observed-successor authority.
 * @param operation - Gap-fenced predecessor.
 * @param snapshot - Fresh complete group evidence.
 * @returns Whether an atomic no-effect settlement is permitted.
 */
function gapOperationCanSettleWithoutEffects(
  operation: ReconciliationOperation,
  snapshot: ReconciliationReviewSnapshot,
): boolean {
  if (
    !gapEffectRecoveryIsComplete(operation, snapshot) ||
    operation.gapSuccessorOperationIds.length !== 0 ||
    snapshot.paths.some(
      (evidence) =>
        evidence.m3.unresolvedMutation !== null ||
        evidence.m3.deferredHistory !== null ||
        classifyReconciliation({
          ...snapshot,
          targetPath: evidence.path,
          paths: [evidence],
          recovery: null,
        }) !== RECONCILIATION_CLASSIFICATION.aligned,
    )
  ) {
    return false;
  }
  if (isNonHistoryReconciliationOperation(operation)) {
    if (
      operation.action.kind === RECONCILIATION_ACTION.restoreRecovery ||
      !gapSuccessorRangeIsCovered(operation, snapshot)
    ) {
      return false;
    }
    if (
      operation.localEffect !== MUTATION_EFFECT_CERTAINTY.confirmed &&
      operation.remoteEffect !== MUTATION_EFFECT_CERTAINTY.confirmed
    ) {
      return operation.phase === RECONCILIATION_OPERATION_PHASE.admitted;
    }
    return true;
  }
  if (!isRefinedHistoryReconciliationOperation(operation)) return false;
  const progress = operation.historyProgress;
  return (
    progress.kind === HISTORY_PROGRESS_KIND.refined &&
    progress.decision.kind === HISTORY_DECISION_KIND.executeCleanupPlan &&
    progress.nextStepIndex === null &&
    progress.steps.length > 0 &&
    progress.steps.every(
      (step) =>
        step.phase === HISTORY_CLEANUP_STEP_PHASE.completed &&
        step.remoteEffect.kind ===
          HISTORY_REMOTE_EFFECT_KIND.confirmedExactTombstoneReceipt,
    )
  );
}

/**
 * Keeps completed local effects subject to their exact operation-bound postcondition.
 * @param operation - Operation containing its synthetic local effect evidence.
 * @returns Whether the sampled evidence still matches the confirmed local postcondition.
 */
function isConfirmedLocalPostconditionCurrent(
  operation: ReconciliationNonHistoryOperation,
  freshSnapshot: ReconciliationReviewSnapshot,
): boolean {
  const effect = operation.localEffectObservation;
  if (effect.kind !== LOCAL_EFFECT_OBSERVATION_KIND.confirmed) {
    return operation.localEffect !== MUTATION_EFFECT_CERTAINTY.confirmed;
  }
  const evidence = freshSnapshot.paths.find(
    (path) => path.path === effect.path,
  );
  return (
    evidence?.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live &&
    evidence.local.contentSha256 === effect.expectedHash &&
    effect.postconditionHash === effect.expectedHash
  );
}

/**
 * Confirms that a complete fresh group sample includes any retained real successor range.
 * @param operation - Gap-fenced predecessor carrying exact post-effect event evidence.
 * @param snapshot - Fresh sample of every predecessor reservation.
 * @returns Whether the current sample is at least as recent as an event in its own epoch.
 */
function gapSuccessorRangeIsCovered(
  operation: ReconciliationNonHistoryOperation,
  snapshot: ReconciliationReviewSnapshot,
): boolean {
  const observation = operation.localEffectObservation;
  if (!("successor" in observation) || observation.successor === null) {
    return true;
  }
  const evidence = snapshot.paths.find(
    (candidate) => candidate.path === observation.path,
  );
  if (
    evidence === undefined ||
    evidence.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown
  ) {
    return false;
  }
  return (
    snapshot.runtime.listenerEpoch !== observation.listenerEpoch ||
    evidence.local.observationGeneration >=
      observation.successor.latestGeneration
  );
}

/**
 * Recognizes the one restore fence that must receive an ordinary reviewed child even when bytes align.
 * @param predecessor - Gap-fenced restore operation.
 * @param snapshot - Fresh child target sample.
 * @param action - Proposed ordinary successor action.
 * @returns Whether the child retains the existing restore-successor rule.
 */
function isGapRestoreSuccessor(
  predecessor: ReconciliationOperation,
  snapshot: ReconciliationReviewSnapshot,
  action: ReconciliationAction,
): boolean {
  if (
    !isNonHistoryReconciliationOperation(predecessor) ||
    predecessor.action.kind !== RECONCILIATION_ACTION.restoreRecovery ||
    predecessor.phase !==
      RECONCILIATION_OPERATION_PHASE.restoredPendingReview ||
    predecessor.localEffect !== MUTATION_EFFECT_CERTAINTY.confirmed ||
    predecessor.snapshot.recovery === null ||
    action.kind !== RECONCILIATION_ACTION.keepLocal ||
    snapshot.targetPath !==
      (predecessor.destinationPath ?? predecessor.snapshot.targetPath)
  ) {
    return false;
  }
  const before = predecessor.snapshot.paths.find(
    (evidence) => evidence.path === snapshot.targetPath,
  );
  const after = snapshot.paths.find(
    (evidence) => evidence.path === snapshot.targetPath,
  );
  return (
    before !== undefined &&
    before.local.kind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown &&
    after?.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live &&
    (snapshot.runtime.listenerEpoch !==
      predecessor.snapshot.runtime.listenerEpoch ||
      after.local.observationGeneration > before.local.observationGeneration) &&
    after.local.contentSha256 === predecessor.snapshot.recovery.contentSha256
  );
}

/**
 * Projects one group path into the existing exact single-target review contract.
 * @param group - Complete fresh group evidence.
 * @param targetPath - One target path owned by the ordinary child.
 * @returns Target-scoped snapshot retaining only its exact sample and selected recovery metadata.
 */
function singleTargetSnapshot(
  group: ReconciliationReviewSnapshot,
  targetPath: NotePath,
): ReconciliationReviewSnapshot {
  const evidence = group.paths.find((path) => path.path === targetPath);
  if (evidence === undefined)
    throw new Error("Gap target evidence is missing.");
  return {
    runtime: group.runtime,
    targetPath,
    paths: [evidence],
    recovery: group.targetPath === targetPath ? group.recovery : null,
  };
}

/**
 * Compares exact bounded reservation sets without allowing duplicate path evidence.
 * @param left - First ordered or unordered path set.
 * @param right - Second ordered or unordered path set.
 * @returns Whether both inputs contain the same unique paths.
 */
function samePathSet(
  left: readonly NotePath[],
  right: readonly NotePath[],
): boolean {
  return (
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.length === right.length &&
    left.every((path) => right.includes(path))
  );
}

/**
 * Creates a gap admission refusal using the current serialized snapshot.
 * @param reason - Sanitized non-effect refusal classification.
 * @param snapshot - Latest state-owner evidence.
 * @returns Refusal retaining old reservations.
 */
function gapRejected(
  reason: ReconciliationReviewFailure,
  snapshot: MirrorStateSnapshot,
): ReconciliationGapGroupAdmissionResult {
  return { kind: "rejected", reason, snapshot };
}

/** Result of one complete asynchronous snapshot sample. */
type SampleResult =
  | {
      readonly kind: "sampled";
      readonly snapshot: ReconciliationReviewSnapshot;
      readonly localText: string | null;
      readonly remoteText: string | null;
      readonly pathContents: ReadonlyMap<
        NotePath,
        {
          readonly localText: string | null;
          readonly remoteText: string | null;
        }
      >;
    }
  | {
      readonly kind: "failure";
      readonly reason: "invalid-lifecycle-or-authority";
    };

/** Local evidence plus transient target text from one stable read. */
type LocalSample = {
  readonly evidence: ReconciliationPathEvidence["local"];
  readonly text: string | null;
};
/** Remote evidence plus transient target text from one exact read barrier. */
type RemoteSample = {
  readonly evidence: ReconciliationPathEvidence["remote"];
  readonly text: string | null;
};

/**
 * Marks an ephemeral review stale without retaining sampled note bodies.
 * @param review - Existing process-local review.
 * @returns Stale metadata with no sampled bodies.
 */
function staleReview(
  review: EphemeralReconciliationReview,
): EphemeralReconciliationReview {
  return {
    ...review,
    status: RECONCILIATION_REVIEW_STATUS.stale,
    operationId: null,
    sampledLocalText: null,
    sampledRemoteText: null,
  };
}

/**
 * Returns a conservative local sample with no hash or body authority.
 * @returns Unknown local evidence.
 */
function unknownLocal(): LocalSample {
  return {
    evidence: {
      kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown,
      stability: RECONCILIATION_LOCAL_STABILITY.unknown,
    },
    text: null,
  };
}

/**
 * Returns a remote-unavailable sample that cannot authorize an effect.
 * @returns Unavailable remote evidence.
 */
function unavailableRemote(): RemoteSample {
  return {
    evidence: { kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.unavailable },
    text: null,
  };
}

/**
 * Returns exact physical absence, distinct from a tombstone.
 * @returns Physical-absence remote evidence.
 */
function absentRemote(): RemoteSample {
  return {
    evidence: { kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.absent },
    text: null,
  };
}

/**
 * Converts a validated legacy body to hash-only review evidence while keeping body transient.
 * @param hash - Digest of the exact transient legacy body.
 * @param text - Transient legacy body.
 * @returns Legacy remote evidence and transient text.
 */
function legacyRemote(
  hash: import("@core/mirror/mirror.types").ContentSha256,
  text: string,
): RemoteSample {
  return {
    evidence: {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy,
      contentSha256: hash,
    },
    text,
  };
}

/**
 * Converts exact tombstone metadata without manufacturing content.
 * @param state - Exact remote tombstone state.
 * @returns Tombstone evidence without a body.
 */
function tombstoneRemote(
  state: Extract<
    import("@core/mirror/mirror.types").CurrentNoteState,
    { readonly kind: "tombstone" }
  >,
): RemoteSample {
  return {
    evidence: {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone,
      associationId: state.receipt.associationId,
      revision: state.revision,
      deletedRevision: state.deletedRevision,
      recoveryId: state.recoveryId,
      receipt: state.receipt,
    },
    text: null,
  };
}

/**
 * Converts exact live metadata plus the separately hashed body.
 * @param state - Exact remote live state.
 * @param hash - Digest of the exact transient live body.
 * @param text - Transient live body.
 * @returns Live remote evidence and transient text.
 */
function liveRemote(
  state: Extract<
    import("@core/mirror/mirror.types").CurrentNoteState,
    { readonly kind: "live" }
  >,
  hash: import("@core/mirror/mirror.types").ContentSha256,
  text: string,
): RemoteSample {
  return {
    evidence: {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: state.receipt.associationId,
      revision: state.revision,
      contentSha256: hash,
      receipt: state.receipt,
    },
    text,
  };
}

/**
 * Compares remote metadata variants for the exact two-read sampling barrier.
 * @param left - First exact remote state.
 * @param right - Second remote state result.
 * @returns Whether the second read proves the first identity remained current.
 */
function sameRemoteState(
  left: CurrentNoteState,
  right: RemoteBridgeResult<CurrentNoteState>,
): boolean {
  return right.kind === "success" && sameRemoteKind(left, right);
}

/**
 * Compares all identity-bearing fields without comparing object identity.
 * @param left - First exact remote state.
 * @param right - Second remote state result.
 * @returns Whether both state identities agree.
 */
function sameRemoteKind(
  left: CurrentNoteState,
  right: RemoteBridgeResult<CurrentNoteState>,
): boolean {
  if (right.kind !== "success" || left.kind !== right.value.kind) return false;
  if (left.kind === "absent" || left.kind === "legacy") return true;
  if (left.kind === "live" && right.value.kind === "live") {
    return (
      left.revision === right.value.revision &&
      left.contentSha256 === right.value.contentSha256 &&
      left.receipt.operationId === right.value.receipt.operationId
    );
  }
  if (left.kind === "tombstone" && right.value.kind === "tombstone") {
    return (
      left.revision === right.value.revision &&
      left.deletedRevision === right.value.deletedRevision &&
      left.recoveryId === right.value.recoveryId &&
      left.receipt.operationId === right.value.receipt.operationId
    );
  }
  /* c8 ignore next -- this helper is called only after a legacy-kind first sample. */
  return false;
}

/**
 * Extracts the content-free durable baseline for a candidate path.
 * @param state - Current device state.
 * @param path - Candidate path.
 * @returns Recorded acknowledgement or unassociated state.
 */
function baselineFor(
  state: MirrorDeviceState,
  path: NotePath,
): MirrorAcknowledgement {
  return (
    state.paths.find((entry) => entry.path === path)?.acknowledgement ?? {
      kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated,
    }
  );
}

/**
 * Extracts unresolved M3 and deferred-history precedence evidence without consuming it.
 * @param state - Current device state.
 * @param path - Candidate path.
 * @returns M3 evidence for the path.
 */
function m3For(
  state: MirrorDeviceState,
  path: NotePath,
): ReconciliationPathEvidence["m3"] {
  const entry = state.paths.find((candidate) => candidate.path === path);
  return {
    unresolvedMutation: entry?.unresolvedMutation ?? null,
    deferredHistory:
      entry?.desired.kind === MIRROR_DESIRED_STATE_KIND.renameDeferred
        ? entry.desired
        : null,
  };
}

/**
 * Identifies the otherwise-M3-owned local generation that only a completed restore
 * successor may explicitly publish.
 *
 * @param snapshot - Fresh candidate snapshot for the restored path.
 * @returns Whether local bytes are live while both baseline and remote remain absent.
 */
function isRestoredPublicationSnapshot(
  snapshot: ReconciliationReviewSnapshot,
): boolean {
  const target = snapshot.paths.find(
    (evidence) => evidence.path === snapshot.targetPath,
  );
  return (
    target?.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live &&
    target.baseline.kind === MIRROR_ACKNOWLEDGEMENT_KIND.unassociated &&
    target.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.absent
  );
}

/**
 * Requires a genuinely absent local/remote unassociated destination before reserving it as new.
 * @param evidence - Candidate destination evidence.
 * @returns Whether the destination is safe to classify as new.
 */
function isAbsentDestination(evidence: ReconciliationPathEvidence): boolean {
  return (
    evidence.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.absent &&
    evidence.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.absent &&
    evidence.baseline.kind === MIRROR_ACKNOWLEDGEMENT_KIND.unassociated &&
    evidence.m3.unresolvedMutation === null &&
    evidence.m3.deferredHistory === null
  );
}

/**
 * Compares runtime identity including complete lifecycle binding and pause state.
 * @param left - Expected runtime identity.
 * @param right - Current runtime identity.
 * @returns Whether every authority dimension matches.
 */
function sameRuntime(
  left: ReconciliationReviewSnapshot["runtime"],
  right: ReconciliationReviewSnapshot["runtime"],
): boolean {
  return (
    left.runtimeOwnerVersion === right.runtimeOwnerVersion &&
    left.configurationGeneration === right.configurationGeneration &&
    left.listenerEpoch === right.listenerEpoch &&
    left.deviceId === right.deviceId &&
    left.designatedWriterId === right.designatedWriterId &&
    lifecycleEquals(left.lifecycle, right.lifecycle)
  );
}

/**
 * Compares lifecycle binding and pause reason without treating enabled variants as interchangeable.
 * @param left - Expected lifecycle.
 * @param right - Current lifecycle.
 * @returns Whether lifecycle identity matches exactly.
 */
function lifecycleEquals(
  left: ReconciliationReviewSnapshot["runtime"]["lifecycle"],
  right: ReconciliationReviewSnapshot["runtime"]["lifecycle"],
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === MIRROR_DEVICE_LIFECYCLE_KIND.disabled) return true;
  if (right.kind === MIRROR_DEVICE_LIFECYCLE_KIND.disabled) return false;
  if (
    left.associationId !== right.associationId ||
    left.origin !== right.origin
  )
    return false;
  return (
    left.kind !== MIRROR_DEVICE_LIFECYCLE_KIND.paused ||
    (right.kind === MIRROR_DEVICE_LIFECYCLE_KIND.paused &&
      left.reason === right.reason)
  );
}

/**
 * Creates a sorted immutable path list for deterministic snapshots and reservations.
 * @param paths - Candidate path set.
 * @returns Lexically ordered path list.
 */
function sortedPaths(paths: ReadonlySet<NotePath>): readonly NotePath[] {
  return [...paths].toSorted((left, right) => left.localeCompare(right));
}

/**
 * Completes one restore or event-fenced operation while atomically linking its reviewed successor.
 *
 * @param state - Current durable state containing the active predecessor.
 * @param predecessor - Exact restored- or successor-review predecessor.
 * @param successorOperationId - Newly admitted operation taking the same path.
 * @returns State with predecessor operation/review made terminal before successor append.
 */
function transferReconciliationOwnership(
  state: MirrorDeviceState,
  predecessor: ReconciliationOperation,
  successorOperationId: ReconciliationOperation["operationId"],
): MirrorDeviceState {
  return {
    ...state,
    reconciliationOperations: state.reconciliationOperations.map((operation) =>
      operation.operationId === predecessor.operationId
        ? {
            ...operation,
            phase: RECONCILIATION_OPERATION_PHASE.completed,
            successorOperationId,
          }
        : operation,
    ),
    reconciliationReviews: state.reconciliationReviews.map((review) =>
      review.reviewId === predecessor.reviewId
        ? { ...review, status: RECONCILIATION_REVIEW_STATUS.completed }
        : review,
    ),
  };
}

/**
 * Identifies ordinary actions that can dispatch an eligible local create or replace.
 *
 * @param kind - Closed admitted action kind.
 * @returns Whether the current operation requires synthetic local-effect observation state.
 */
function actionMayWriteLocal(
  kind: ReconciliationOperation["action"]["kind"],
): boolean {
  return (
    kind === RECONCILIATION_ACTION.useRemote ||
    kind === RECONCILIATION_ACTION.keepBoth ||
    kind === RECONCILIATION_ACTION.adoptRevision ||
    kind === RECONCILIATION_ACTION.restoreRecovery ||
    kind === RECONCILIATION_ACTION.forkLegacy
  );
}

/**
 * Converts an owner transition failure to an admission rejection with the latest snapshot.
 * @param reason - Sanitized admission failure.
 * @param snapshot - Latest owner snapshot.
 * @returns Typed admission rejection.
 */
function rejected(
  reason: import("@core/mirror/reconciliation-review.types").ReconciliationReviewFailure,
  snapshot: MirrorStateSnapshot,
): import("@core/mirror/reconciliation-review.types").ReconciliationAdmissionResult {
  return { kind: "rejected", reason, snapshot };
}
