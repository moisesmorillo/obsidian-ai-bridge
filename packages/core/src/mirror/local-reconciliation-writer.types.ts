import type {
  LOCAL_RECONCILIATION_DISPATCH_MODE,
  LOCAL_RECONCILIATION_FAILURE,
  LOCAL_RECONCILIATION_REFUSAL,
  LOCAL_RECONCILIATION_WRITE_OUTCOME,
} from "@core/mirror/local-reconciliation-writer.constants";
import type {
  ContentSha256,
  MirrorOperationId,
  MutationEffectCertainty,
} from "@core/mirror/mirror.types";
import type { ReconciliationPreservationReceipt } from "@core/mirror/reconciliation-state.types";
import type { NotePath } from "@core/note-path/note-path.types";

/** Generated reserved path that can only be constructed from an operation UUID and closed side. */
export type ReconciliationPreservationPath = string & {
  readonly __brand: "ReconciliationPreservationPath";
};

/** Whether a local write is a first effect or exact recovery for the same durable operation. */
export type LocalReconciliationDispatchMode =
  (typeof LOCAL_RECONCILIATION_DISPATCH_MODE)[keyof typeof LOCAL_RECONCILIATION_DISPATCH_MODE];

/** Exact transient content and digest to create at one eligible absent destination. */
export interface CreateEligibleLocalRequest {
  readonly operationId: MirrorOperationId;
  readonly path: NotePath;
  readonly content: string;
  readonly contentSha256: ContentSha256;
  readonly mode: LocalReconciliationDispatchMode;
}

/** Exact compare-and-replace request bound to sampled text, digest, and observation generation. */
export interface ReplaceEligibleLocalRequest {
  readonly operationId: MirrorOperationId;
  readonly path: NotePath;
  readonly expectedContent: string;
  readonly expectedContentSha256: ContentSha256;
  /** Process-local event generation checked by core before dispatch; it is not a host filesystem revision. */
  readonly expectedObservationGeneration: number;
  readonly replacementContent: string;
  readonly replacementContentSha256: ContentSha256;
  readonly mode: LocalReconciliationDispatchMode;
}

/** Generated create-only preservation request; no caller-supplied archive path is accepted. */
export interface CreatePreservationLocalRequest {
  readonly operationId: MirrorOperationId;
  readonly side: ReconciliationPreservationReceipt["side"];
  readonly content: string;
  readonly contentSha256: ContentSha256;
  readonly mode: LocalReconciliationDispatchMode;
}

/** Postcondition proof obtained by rereading exact saved bytes after a host effect or adoption. */
export interface ConfirmedLocalReconciliationWrite {
  readonly kind: "confirmed";
  readonly outcome: (typeof LOCAL_RECONCILIATION_WRITE_OUTCOME)[keyof typeof LOCAL_RECONCILIATION_WRITE_OUTCOME];
  readonly path: NotePath | ReconciliationPreservationPath;
  readonly contentSha256: ContentSha256;
  readonly sizeBytes: number;
}

/** Proven precondition refusal for which the requested content effect did not occur. */
export interface RefusedLocalReconciliationWrite {
  readonly kind: "refused";
  readonly reason: (typeof LOCAL_RECONCILIATION_REFUSAL)[keyof typeof LOCAL_RECONCILIATION_REFUSAL];
  readonly effect: Extract<MutationEffectCertainty, "definitely-refused">;
}

/** Sanitized host or postcondition failure with explicit content-effect certainty. */
export interface FailedLocalReconciliationWrite {
  readonly kind: "failed";
  readonly reason: (typeof LOCAL_RECONCILIATION_FAILURE)[keyof typeof LOCAL_RECONCILIATION_FAILURE];
  readonly effect: Extract<
    MutationEffectCertainty,
    "definitely-refused" | "unknown"
  >;
}

/** Closed writer result; only confirmed carries postcondition evidence. */
export type LocalReconciliationWriteResult =
  | ConfirmedLocalReconciliationWrite
  | RefusedLocalReconciliationWrite
  | FailedLocalReconciliationWrite;
