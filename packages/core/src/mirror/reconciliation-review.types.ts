import type {
  MirrorDeviceState,
  MirrorStateSnapshot,
} from "@core/mirror/mirror-state.types";
import type {
  EphemeralReconciliationReview,
  ReconciliationAction,
  ReconciliationClassification,
  ReconciliationReviewSnapshot,
  ReconciliationRuntimeIdentity,
} from "@core/mirror/reconciliation-state.types";
import type {
  RemoteBridge,
  RemoteBridgeFailure,
} from "@core/mirror/remote-bridge.types";
import type { NotePath } from "@core/note-path/note-path.types";

/** Read-only subset required by the review engine; no mutation capability crosses this port. */
export type ReconciliationRemoteReader = Pick<
  RemoteBridge,
  | "describe"
  | "listNotes"
  | "readNote"
  | "inspectNote"
  | "listRecovery"
  | "inspectRecovery"
>;

/** Runtime identity provider used to bind a review to its current owner and listener epoch. */
export interface ReconciliationRuntimeIdentitySource {
  /** @returns Current owner, configuration, listener, writer and lifecycle identity. */
  current(): ReconciliationRuntimeIdentity;
}

/** Observation-generation source that distinguishes same-text local saves. */
export interface ReconciliationObservationSource {
  /** @param path - Local path being sampled. @returns A positive generation for the current observation epoch. */
  ensure(path: NotePath): number;
  /** @param path - Local path whose host event was observed. @returns The newly allocated generation. */
  observe(path: NotePath): number;
  /** @param path - Local path being checked for stale evidence. @returns Current positive generation, or zero before first sampling. */
  current(path: NotePath): number;
}

/** Explicit host/runtime values required for deterministic review sampling. */
export interface ReconciliationReviewDependencies {
  readonly runtime: ReconciliationRuntimeIdentitySource;
  readonly observations: ReconciliationObservationSource;
  /** @returns SHA-256 of exact transient UTF-8 text. */
  readonly hashContent: (
    content: string,
  ) => Promise<import("@core/mirror/mirror.types").ContentSha256>;
  /** @returns Fresh UUID-v4 review/operation identity. */
  readonly createOperationId: () => import("@core/mirror/mirror.types").MirrorOperationId;
}

/** Optional extra evidence requested when a review includes a destination or recovery selection. */
export interface ReconciliationReviewRequest {
  readonly targetPath: NotePath;
  readonly sessionId: import("@core/mirror/mirror.types").MirrorOperationId;
  readonly relatedPaths?: readonly NotePath[];
  readonly destinationPath?: NotePath | null;
  readonly recoveryId?:
    | import("@core/mirror/mirror.types").RecoverySnapshotId
    | null;
}

/** Candidate union and completeness result returned to a future review list. */
export type ReconciliationDiscoveryResult =
  | {
      readonly kind: "complete";
      readonly candidates: readonly NotePath[];
      readonly reviews: readonly EphemeralReconciliationReview[];
    }
  | {
      readonly kind: "incomplete";
      readonly candidates: readonly NotePath[];
      readonly reviews: readonly EphemeralReconciliationReview[];
      readonly localFailure: boolean;
      readonly remoteFailure: RemoteBridgeFailure | "capacity-exceeded" | null;
    };

/** Read-only review result; no durable state is changed by discovery or sampling. */
export type ReconciliationReviewResult =
  | { readonly kind: "created"; readonly review: EphemeralReconciliationReview }
  | { readonly kind: "not-reviewable" }
  | { readonly kind: "failure"; readonly reason: ReconciliationReviewFailure };

/** Closed review/admission failures safe for application and UI projections. */
export type ReconciliationReviewFailure =
  | "evidence-unavailable"
  | "review-not-found"
  | "stale-review"
  | "action-not-allowed"
  | "reservation-conflict"
  | "invalid-lifecycle-or-authority"
  | "persistence-failure"
  | "not-a-candidate";

/** Explicit action request carrying review/session identity and optional destination selection. */
export interface ReconciliationAdmissionRequest {
  readonly reviewId: import("@core/mirror/mirror.types").MirrorOperationId;
  readonly sessionId: import("@core/mirror/mirror.types").MirrorOperationId;
  readonly action: ReconciliationAction;
  readonly destinationPath?: NotePath | null;
}

/** Durable admission result; operation is present only after the serialized owner commit. */
export type ReconciliationAdmissionResult =
  | {
      readonly kind: "admitted";
      readonly operation: import("@core/mirror/reconciliation-state.types").ReconciliationOperation;
      readonly snapshot: MirrorStateSnapshot;
    }
  | {
      readonly kind: "rejected";
      readonly reason: ReconciliationReviewFailure;
      readonly snapshot: MirrorStateSnapshot;
    };

/** Action kind exposed to future UI without embedding presentation policy. */
export type ReconciliationAllowedAction = ReconciliationAction["kind"];

/** Read-only candidate and ephemeral-review query surface. */
export interface ReconciliationReviewQuery {
  /** @returns Current bounded candidate union and ephemeral reviews. */
  discover(): Promise<ReconciliationDiscoveryResult>;
  /** @returns Open reviews owned by the requested UI session. */
  listOpen(
    sessionId: import("@core/mirror/mirror.types").MirrorOperationId,
  ): readonly EphemeralReconciliationReview[];
}

/** Snapshot input used by the pure classifier and action table. */
export type ReconciliationClassificationInput = ReconciliationReviewSnapshot;

/** Classification plus action set suitable for a future read-only detail view. */
export interface ReconciliationReviewProjection {
  readonly classification: ReconciliationClassification;
  readonly allowedActions: readonly ReconciliationAllowedAction[];
}

/** Pure transition input for state-owner admission tests. */
export interface ReconciliationAdmissionState {
  readonly state: MirrorDeviceState;
  readonly review: EphemeralReconciliationReview;
}
