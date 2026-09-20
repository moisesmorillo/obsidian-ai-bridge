import { RECOVERY_SNAPSHOT_STATE_KIND } from "@core/mirror/mirror.constants";
import type { RecoverySnapshotState } from "@core/mirror/mirror.types";

/** Closed content-free recovery availability states exposed by the application query. */
export const RECOVERY_SELECTION_STATE = {
  prepared: "prepared",
  sealedActive: "sealed-active",
  sealedExpired: "sealed-expired",
  purged: "purged",
} as const;

/** Content-free recovery availability classification. */
export type RecoverySelectionState =
  (typeof RECOVERY_SELECTION_STATE)[keyof typeof RECOVERY_SELECTION_STATE];

/** Application-owned recovery metadata projection with explicit actionability. */
export interface RecoverySelectionProjection {
  readonly state: RecoverySelectionState;
  readonly actionable: boolean;
  readonly recoverUntil: string | null;
}

/**
 * Classifies one recovery generation without fetching its body or granting restore authority.
 *
 * The same expiry predicate is reused by restore execution so query and effect paths
 * cannot disagree about whether a sealed generation has expired.
 *
 * @param recovery - Exact bounded recovery metadata.
 * @param nowMilliseconds - Runtime clock instant used for sealed expiry.
 * @returns Sanitized availability and whether a complete inventory may offer selection.
 */
export function projectRecoverySelection(
  recovery: RecoverySnapshotState,
  nowMilliseconds: number,
): RecoverySelectionProjection {
  switch (recovery.kind) {
    case RECOVERY_SNAPSHOT_STATE_KIND.prepared:
      return {
        state: RECOVERY_SELECTION_STATE.prepared,
        actionable: true,
        recoverUntil: null,
      };
    case RECOVERY_SNAPSHOT_STATE_KIND.sealed:
      return isRecoverySnapshotExpired(recovery, nowMilliseconds)
        ? {
            state: RECOVERY_SELECTION_STATE.sealedExpired,
            actionable: false,
            recoverUntil: recovery.recoverUntil,
          }
        : {
            state: RECOVERY_SELECTION_STATE.sealedActive,
            actionable: true,
            recoverUntil: recovery.recoverUntil,
          };
    case RECOVERY_SNAPSHOT_STATE_KIND.purged:
      return {
        state: RECOVERY_SELECTION_STATE.purged,
        actionable: false,
        recoverUntil: recovery.recoverUntil,
      };
  }
}

/**
 * Compares every authority-bearing recovery metadata field without reading content.
 *
 * @param left - Previously projected metadata.
 * @param right - Freshly inspected metadata.
 * @returns Whether the recovery selection remains exact.
 */
export function recoverySnapshotStatesEqual(
  left: RecoverySnapshotState,
  right: RecoverySnapshotState,
): boolean {
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    left.associationId === right.associationId &&
    left.path === right.path &&
    left.revision === right.revision &&
    left.sourceRevision === right.sourceRevision &&
    left.contentSha256 === right.contentSha256 &&
    (left.kind === RECOVERY_SNAPSHOT_STATE_KIND.prepared ||
      (right.kind !== RECOVERY_SNAPSHOT_STATE_KIND.prepared &&
        left.recoverUntil === right.recoverUntil))
  );
}

/**
 * Applies the authoritative sealed-recovery expiry predicate.
 *
 * @param recovery - Recovery metadata whose sealed deadline may constrain restore.
 * @param nowMilliseconds - Runtime clock instant.
 * @returns Whether a sealed generation is at or beyond its retention deadline.
 */
export function isRecoverySnapshotExpired(
  recovery: RecoverySnapshotState,
  nowMilliseconds: number,
): boolean {
  return (
    recovery.kind === RECOVERY_SNAPSHOT_STATE_KIND.sealed &&
    Date.parse(recovery.recoverUntil) <= nowMilliseconds
  );
}
