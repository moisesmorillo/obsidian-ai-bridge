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
