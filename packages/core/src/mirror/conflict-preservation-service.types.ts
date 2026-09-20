import type { MirrorOperationId } from "@core/mirror/mirror.types";
import type { MirrorStateSnapshot } from "@core/mirror/mirror-state.types";
import type { ReconciliationPreservationReceipt } from "@core/mirror/reconciliation-state.types";

/** Closed application-level reasons a preservation command cannot be authorized. */
export type ConflictPreservationRejection =
  | "operation-not-found"
  | "operation-not-active"
  | "wrong-phase"
  | "reservation-mismatch"
  | "preservation-not-required"
  | "source-evidence-mismatch"
  | "persistence-failure";

/** Exact transient preservation command; source paths never shape the archive destination. */
export interface ConflictPreservationRequest {
  readonly operationId: MirrorOperationId;
  /** Exact history step selector; absent only for existing non-history actions. */
  readonly stepId?: MirrorOperationId;
  readonly side: ReconciliationPreservationReceipt["side"];
  readonly content: string;
}

/** Durable preservation outcome after writer evidence and receipt persistence are ordered. */
export type ConflictPreservationResult =
  | {
      readonly kind: "verified";
      readonly receipt: ReconciliationPreservationReceipt;
      readonly snapshot: MirrorStateSnapshot;
    }
  | {
      readonly kind: "evidence-required" | "blocked";
      readonly snapshot: MirrorStateSnapshot;
    }
  | {
      readonly kind: "rejected";
      readonly reason: ConflictPreservationRejection;
      readonly snapshot: MirrorStateSnapshot;
    };
