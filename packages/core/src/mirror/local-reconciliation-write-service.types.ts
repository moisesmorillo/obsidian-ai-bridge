import type { MirrorOperationId } from "@core/mirror/mirror.types";
import type { MirrorStateSnapshot } from "@core/mirror/mirror-state.types";
import type { NotePath } from "@core/note-path/note-path.types";

/** Closed authorization failures for uncomposed Slice 3 local-write primitives. */
export type LocalReconciliationCommandRejection =
  | "operation-not-found"
  | "operation-not-active"
  | "wrong-action"
  | "wrong-phase"
  | "reservation-mismatch"
  | "path-evidence-mismatch"
  | "source-evidence-mismatch"
  | "persistence-failure";

/** Exact create-only command whose body must match admitted remote evidence. */
export interface AuthorizedCreateEligibleRequest {
  readonly operationId: MirrorOperationId;
  readonly path: NotePath;
  readonly content: string;
}

/** Exact compare-and-replace command whose two bodies must match admitted evidence. */
export interface AuthorizedReplaceEligibleRequest {
  readonly operationId: MirrorOperationId;
  readonly path: NotePath;
  readonly expectedContent: string;
  readonly replacementContent: string;
}

/** Durable result for one local primitive; no baseline or remote state is advanced. */
export type LocalReconciliationCommandResult =
  | {
      readonly kind: "confirmed" | "evidence-required" | "blocked";
      readonly snapshot: MirrorStateSnapshot;
    }
  | {
      readonly kind: "rejected";
      readonly reason: LocalReconciliationCommandRejection;
      readonly snapshot: MirrorStateSnapshot;
    };
