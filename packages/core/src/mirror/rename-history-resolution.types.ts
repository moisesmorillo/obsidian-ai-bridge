import type { MirrorOperationId } from "@core/mirror/mirror.types";
import type { MirrorStateSnapshot } from "@core/mirror/mirror-state.types";
import type { ReconciliationHistoryOperation } from "@core/mirror/reconciliation-state.types";

/** Finite settlement from one history parent execution turn. */
export type RenameHistoryResolutionResult =
  | {
      readonly kind:
        | "completed"
        | "progressed"
        | "blocked"
        | "evidence-required";
      readonly snapshot: MirrorStateSnapshot;
    }
  | {
      readonly kind: "rejected";
      readonly reason:
        | "operation-not-found"
        | "operation-not-active"
        | "legacy-migration-attention"
        | "evidence-changed"
        | "persistence-failure";
      readonly snapshot: MirrorStateSnapshot;
    };

/** Parent selector used to resume exactly one durable history operation. */
export interface RenameHistoryResolutionRequest {
  readonly operationId: MirrorOperationId;
}

/** Content loader constrained to exact sampled remote source evidence. */
export interface RenameHistoryContentSource {
  /**
   * @param operation - Refined history parent.
   * @param stepIndex - Current ordered step index.
   * @returns Exact transient source body, or null when current evidence cannot prove it.
   */
  readExactSource(
    operation: ReconciliationHistoryOperation,
    stepIndex: number,
  ): Promise<string | null>;
}
