import type { ContentSha256 } from "@core/mirror/mirror.types";
import {
  RECONCILIATION_ACTION,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_PRESERVATION_SIDE,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
} from "@core/mirror/reconciliation-state.constants";
import type {
  ReconciliationNonHistoryOperation,
  ReconciliationPathEvidence,
} from "@core/mirror/reconciliation-state.types";
import type { NotePath } from "@core/note-path/note-path.types";

/**
 * Derives the only content digest an action may create at an absent local path.
 *
 * @param operation - Admitted action and immutable evidence.
 * @param path - Requested create destination.
 * @returns Evidence-bound source digest, or undefined when the action grants no create authority.
 */
export function localCreateSourceHash(
  operation: ReconciliationNonHistoryOperation,
  path: NotePath,
): ContentSha256 | undefined {
  const target = pathEvidence(operation, operation.snapshot.targetPath);
  if (target === undefined) return undefined;
  switch (operation.action.kind) {
    case RECONCILIATION_ACTION.useRemote:
    case RECONCILIATION_ACTION.adoptRevision:
      return path === operation.snapshot.targetPath &&
        target.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live
        ? target.remote.contentSha256
        : undefined;
    case RECONCILIATION_ACTION.keepBoth:
      if (path !== operation.destinationPath) return undefined;
      if (
        operation.action.primarySide === RECONCILIATION_PRESERVATION_SIDE.local
      ) {
        return target.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live
          ? target.remote.contentSha256
          : undefined;
      }
      return target.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live
        ? target.local.contentSha256
        : undefined;
    case RECONCILIATION_ACTION.forkLegacy:
      return path === operation.destinationPath &&
        target.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy
        ? target.remote.contentSha256
        : undefined;
    case RECONCILIATION_ACTION.restoreRecovery:
      return path ===
        (operation.destinationPath ?? operation.snapshot.targetPath)
        ? operation.snapshot.recovery?.contentSha256
        : undefined;
    case RECONCILIATION_ACTION.keepLocal:
    case RECONCILIATION_ACTION.acceptTombstone:
    case RECONCILIATION_ACTION.recreateRemote:
    case RECONCILIATION_ACTION.defer:
      return undefined;
  }
}

/**
 * Derives the only replacement digest an action may write over sampled local bytes.
 *
 * @param operation - Admitted action and immutable evidence.
 * @param path - Requested replacement path.
 * @returns Evidence-bound replacement digest, or undefined without replace authority.
 */
export function localReplaceSourceHash(
  operation: ReconciliationNonHistoryOperation,
  path: NotePath,
): ContentSha256 | undefined {
  const target = pathEvidence(operation, operation.snapshot.targetPath);
  if (target === undefined) return undefined;
  switch (operation.action.kind) {
    case RECONCILIATION_ACTION.useRemote:
      return path === operation.snapshot.targetPath &&
        target.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live
        ? target.remote.contentSha256
        : undefined;
    case RECONCILIATION_ACTION.keepBoth:
      return path === operation.snapshot.targetPath &&
        operation.action.primarySide ===
          RECONCILIATION_PRESERVATION_SIDE.remote &&
        target.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live
        ? target.remote.contentSha256
        : undefined;
    case RECONCILIATION_ACTION.restoreRecovery:
      return path ===
        (operation.destinationPath ?? operation.snapshot.targetPath)
        ? operation.snapshot.recovery?.contentSha256
        : undefined;
    case RECONCILIATION_ACTION.keepLocal:
    case RECONCILIATION_ACTION.adoptRevision:
    case RECONCILIATION_ACTION.acceptTombstone:
    case RECONCILIATION_ACTION.recreateRemote:
    case RECONCILIATION_ACTION.forkLegacy:
    case RECONCILIATION_ACTION.defer:
      return undefined;
  }
}

/**
 * Revalidates a persisted identified effect against action-owned path and digest policy.
 *
 * @param operation - Durable operation containing immutable action evidence.
 * @param path - Persisted local-effect path.
 * @param expectedHash - Persisted local-effect postcondition digest.
 * @returns Whether create or replacement policy authorizes the exact pair.
 */
export function isAuthorizedLocalEffectPostcondition(
  operation: ReconciliationNonHistoryOperation,
  path: NotePath,
  expectedHash: ContentSha256,
): boolean {
  return (
    localCreateSourceHash(operation, path) === expectedHash ||
    localReplaceSourceHash(operation, path) === expectedHash
  );
}

/** @returns Exact immutable path evidence owned by one operation. */
function pathEvidence(
  operation: ReconciliationNonHistoryOperation,
  path: NotePath,
): ReconciliationPathEvidence | undefined {
  return operation.snapshot.paths.find((evidence) => evidence.path === path);
}
