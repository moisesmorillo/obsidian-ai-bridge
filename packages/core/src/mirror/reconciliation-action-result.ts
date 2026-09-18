import type { LocalReconciliationCommandResult } from "@core/mirror/local-reconciliation-write-service.types";
import type { MirrorStateSnapshot } from "@core/mirror/mirror-state.types";
import type {
  ReconciliationActionExecutionRejection,
  ReconciliationActionExecutionResult,
} from "@core/mirror/reconciliation-action-execution.types";
import type { ReconciliationRemoteMutationSettlement } from "@core/mirror/reconciliation-effect-executor";

/** Minimal current-state source for sanitized result projection. */
export interface ReconciliationActionStateSource {
  /** @returns Latest authoritative durable state. */
  snapshot(): MirrorStateSnapshot;
}

/** Closed preservation progress returned by the shared effect owner. */
export type ReconciliationPreservationProgress =
  | "verified"
  | "blocked"
  | "evidence-required"
  | "changed"
  | "persistence-failure";

/** @returns A sanitized rejection carrying current authoritative state. */
export function rejectReconciliationAction(
  source: ReconciliationActionStateSource,
  reason: ReconciliationActionExecutionRejection,
): ReconciliationActionExecutionResult {
  return { kind: "rejected", reason, snapshot: source.snapshot() };
}

/** @returns No result after verification, otherwise finite attention/rejection state. */
export function projectReconciliationPreservation(
  source: ReconciliationActionStateSource,
  progress: ReconciliationPreservationProgress,
): ReconciliationActionExecutionResult | undefined {
  if (progress === "verified") return undefined;
  if (progress === "blocked" || progress === "evidence-required") {
    return { kind: progress, snapshot: source.snapshot() };
  }
  return rejectReconciliationAction(
    source,
    progress === "persistence-failure"
      ? "persistence-failure"
      : "evidence-changed",
  );
}

/** @returns Sanitized local primitive projection. */
export function projectLocalReconciliationResult(
  result: LocalReconciliationCommandResult,
): ReconciliationActionExecutionResult {
  if (result.kind === "blocked" || result.kind === "evidence-required") {
    return { kind: result.kind, snapshot: result.snapshot };
  }
  if (result.kind === "rejected") {
    return {
      kind: "rejected",
      reason:
        result.reason === "persistence-failure"
          ? "persistence-failure"
          : "local-effect-failed",
      snapshot: result.snapshot,
    };
  }
  return { kind: "completed", snapshot: result.snapshot };
}

/** @returns Sanitized conditional remote settlement projection. */
export function projectRemoteReconciliationResult(
  result: Exclude<
    ReconciliationRemoteMutationSettlement,
    { readonly kind: "confirmed" }
  >,
): ReconciliationActionExecutionResult {
  if (result.kind === "blocked") {
    return { kind: "blocked", snapshot: result.snapshot };
  }
  if (result.kind === "evidence-required") {
    return { kind: "evidence-required", snapshot: result.snapshot };
  }
  return {
    kind: "rejected",
    reason:
      result.reason === "persistence-failure"
        ? "persistence-failure"
        : "remote-effect-failed",
    snapshot: result.snapshot,
  };
}
