import type { MirrorOperationId } from "@core/mirror/mirror.types";
import type { MirrorStateSnapshot } from "@core/mirror/mirror-state.types";

/** Closed safe reasons an admitted reconciliation action cannot continue. */
export type ReconciliationActionExecutionRejection =
  | "operation-not-found"
  | "wrong-action"
  | "operation-not-active"
  | "evidence-changed"
  | "content-unavailable"
  | "preservation-failed"
  | "local-effect-failed"
  | "remote-effect-failed"
  | "recovery-unavailable"
  | "recovery-expired"
  | "persistence-failure";

/** Exact durable operation selected for action execution or restart recovery. */
export interface ReconciliationActionExecutionRequest {
  readonly operationId: MirrorOperationId;
}

/** Durable result of one finite action execution attempt. */
export type ReconciliationActionExecutionResult =
  | {
      readonly kind: "completed" | "restored-pending-review";
      readonly snapshot: MirrorStateSnapshot;
    }
  | {
      readonly kind: "evidence-required" | "blocked";
      readonly snapshot: MirrorStateSnapshot;
    }
  | {
      readonly kind: "rejected";
      readonly reason: ReconciliationActionExecutionRejection;
      readonly snapshot: MirrorStateSnapshot;
    };
