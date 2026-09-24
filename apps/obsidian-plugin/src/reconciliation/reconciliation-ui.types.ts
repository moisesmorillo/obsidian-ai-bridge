import type {
  MirrorOperationId,
  NotePath,
  ReconciliationAdmissionAction,
  ReconciliationClassification,
  RecoverySelectionState,
  RecoverySnapshotId,
} from "@obsidian-ai-bridge/core";

/** Sanitized candidate list result exposed to commands and modals. */
export type ReconciliationCandidateList =
  | { readonly kind: "available"; readonly candidates: readonly NotePath[] }
  | { readonly kind: "incomplete"; readonly candidates: readonly NotePath[] }
  | { readonly kind: "unavailable" };

/** Content-free review detail supplied by the application owner. */
export interface ReconciliationReviewDetail {
  readonly reviewId: MirrorOperationId;
  readonly targetPath: NotePath;
  /** Validated destination sampled by the application owner, when requested. */
  readonly destinationPath: NotePath | null;
  readonly classification: ReconciliationClassification;
  readonly allowedActions: readonly ReconciliationAdmissionAction["kind"][];
  /** Bounded current-group candidates accepted for a history cleanup selection. */
  readonly historyCandidates: readonly NotePath[];
}

/** Content-free recovery selector row with application-owned actionability. */
export interface RecoverySelectionDetail {
  readonly id: RecoverySnapshotId;
  readonly path: NotePath;
  readonly state: RecoverySelectionState;
  readonly recoverUntil: string | null;
  /** Whether a complete inventory may offer this exact metadata row for resampling. */
  readonly actionable: boolean;
}

/** Bounded recovery inventory outcome without transport or body details. */
export type RecoverySelectionList =
  | {
      readonly kind: "available" | "incomplete";
      readonly recoveries: readonly RecoverySelectionDetail[];
    }
  | { readonly kind: "unavailable" };

/** Content-free active gap candidate retained until an exact fresh transfer commits. */
export interface ReconciliationObservationGapCandidate {
  /** Exact predecessor operation fenced across the observation gap. */
  readonly operationId: MirrorOperationId;
  /** Complete predecessor reservation set in lexical order. */
  readonly paths: readonly NotePath[];
}

/** Bounded gap candidate list; incomplete state is never treated as no gaps. */
export type ReconciliationObservationGapList =
  | {
      readonly kind: "available";
      readonly candidates: readonly ReconciliationObservationGapCandidate[];
    }
  | { readonly kind: "unavailable" };

/** One ordinary target review or exact complete-history decision in a gap-group sample. */
export interface ReconciliationGapChildDetail {
  /** Ephemeral exact action identity. */
  readonly reviewId: MirrorOperationId;
  /** Changed reserved path sampled for this independent successor action. */
  readonly targetPath: NotePath;
  /** Classification derived from current local and remote evidence. */
  readonly classification: ReconciliationClassification;
  /** Actions supported without expanding the predecessor's reservation scope. */
  readonly allowedActions: readonly ReconciliationAdmissionAction["kind"][];
  /** Current complete history-group paths offered for an explicit cleanup choice. */
  readonly historyCandidates: readonly NotePath[];
}

/** Complete fresh gap review exposed without transient note bodies. */
export interface ReconciliationGapReviewDetail {
  /** Ephemeral complete reservation-group review identity. */
  readonly reviewId: MirrorOperationId;
  /** Gap-fenced predecessor whose authority may be settled or atomically transferred. */
  readonly predecessorOperationId: MirrorOperationId;
  /** Full reservation set included in the common evidence snapshot. */
  readonly paths: readonly NotePath[];
  /** Ordinary changed-path children or one complete-history successor review. */
  readonly children: readonly ReconciliationGapChildDetail[];
  /** Paths that prevent any partial transfer and must remain reserved. */
  readonly unreviewablePaths: readonly NotePath[];
}

/** Result of creating a fresh complete gap-group review. */
export type ReconciliationGapReviewCreationResult =
  | { readonly kind: "created"; readonly review: ReconciliationGapReviewDetail }
  | { readonly kind: "unavailable" | "not-reviewable" | "failed" };

/** One ordinary target or complete-history decision submitted in an atomic gap batch. */
export interface ReconciliationGapActionSelection {
  /** Exact child review selected in the complete gap group. */
  readonly reviewId: MirrorOperationId;
  /** Explicit operator-selected ordinary action. */
  readonly action: ReconciliationAdmissionAction;
}

/** Fixed command result safe for text-only UI. */
export type ReconciliationUiCommandResult =
  | { readonly kind: "completed" | "admitted" }
  | { readonly kind: "stale" | "unavailable" | "failed" };

/** Narrow application projection consumed by text-only commands and modals. */
export interface ReconciliationUiOwner {
  /** @returns Current bounded candidate projection for one attached session. */
  readonly listReconciliationCandidates: (
    sessionId: string,
  ) => Promise<ReconciliationCandidateList>;
  /** @returns Current unresolved gap owners and exact path reservations. */
  readonly listObservationGaps: (
    sessionId: string,
  ) => ReconciliationObservationGapList;
  /** @returns A fresh complete review of one exact gap predecessor. */
  readonly createObservationGapReview: (
    sessionId: string,
    predecessorOperationId: MirrorOperationId,
  ) => Promise<ReconciliationGapReviewCreationResult>;
  /** Clears a pending complete gap review and all child samples. */
  readonly closeObservationGapReview: (
    sessionId: string,
    reviewId: MirrorOperationId,
  ) => void;
  /** @returns Atomic no-effect settlement or all-child gap transfer outcome. */
  readonly submitObservationGapReview: (
    sessionId: string,
    reviewId: MirrorOperationId,
    actions: readonly ReconciliationGapActionSelection[],
  ) => Promise<ReconciliationUiCommandResult>;
  /** @returns Current bounded recovery metadata for one attached session. */
  readonly listRecoverySelections: (
    sessionId: string,
  ) => Promise<RecoverySelectionList>;
  /** @returns A fresh content-free review detail, or null when stale. */
  readonly createReconciliationReview: (
    sessionId: string,
    path: NotePath,
    recoveryId?: RecoverySnapshotId | null,
    destinationPath?: string | null,
  ) => Promise<ReconciliationReviewDetail | null>;
  /** @returns Literal sampled text only after explicit side selection. */
  readonly reconciliationPreview: (
    sessionId: string,
    reviewId: MirrorOperationId,
    side: "local" | "remote",
  ) => string | null;
  /** Clears one pending transient review owned by the session. */
  readonly closeReconciliationReview: (
    sessionId: string,
    reviewId: MirrorOperationId,
  ) => void;
  /** @returns Sanitized result after submitting one typed reviewed decision. */
  readonly submitReconciliation: (
    sessionId: string,
    reviewId: MirrorOperationId,
    action: ReconciliationAdmissionAction,
    destinationPath?: NotePath | null,
  ) => Promise<ReconciliationUiCommandResult>;
}
