import {
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_GLOBAL_BLOCK_REASON,
  MIRROR_PATH_BLOCK_REASON,
  type MirrorPathJobOutcome,
  type MirrorStateSnapshot,
  type MirrorSynchronizerPhase,
  type NotePath,
} from "@obsidian-ai-bridge/core";

/** Sanitized configuration status; malformed plugin data is never presented raw. */
export type MirrorConfigurationStatus =
  | "configured"
  | "unconfigured"
  | "invalid";

/** Sanitized writer role derived from local lifecycle and current verification. */
export type MirrorWriterStatus =
  | "active-writer"
  | "inactive"
  | "designation-mismatch";

/** Sanitized per-path state exposed by status UI without content or raw errors. */
export interface MirrorOperationalPathStatus {
  readonly path: NotePath;
  readonly state:
    | "retry-exhausted"
    | "unresolved-effect"
    | "diverged"
    | "rename-deferred"
    | "deletion-deferred"
    | "pending";
}

/** Complete text-safe operational status projection for one runtime owner. */
export interface MirrorOperationalStatus {
  readonly configuration: MirrorConfigurationStatus;
  readonly writer: MirrorWriterStatus;
  readonly bootstrap: MirrorSynchronizerPhase | "not-started";
  readonly globalBlockReason: string | null;
  readonly persistenceFenced: boolean;
  readonly pendingPaths: number;
  readonly pathStatuses: readonly MirrorOperationalPathStatus[];
  readonly lastOutcome: MirrorPathJobOutcome | null;
}

/**
 * Maps core state into a closed text-only status model.
 *
 * @param configuration - Strict settings decode/readiness classification.
 * @param snapshot - Authoritative device-local state-owner snapshot.
 * @param phase - Core bootstrap/observation phase when composed.
 * @param outcomes - Sanitized core outcomes keyed by tracked path.
 * @returns UI-safe metadata containing no bearer, body, response, or exception text.
 */
export function createMirrorOperationalStatus(
  configuration: MirrorConfigurationStatus,
  snapshot: MirrorStateSnapshot,
  phase: MirrorSynchronizerPhase | null,
  outcomes: ReadonlyMap<NotePath, MirrorPathJobOutcome>,
): MirrorOperationalStatus {
  const pathStatuses = snapshot.state.paths.flatMap((entry) => {
    if (entry.blockedReason !== null) {
      return [{ path: entry.path, state: mapBlocked(entry.blockedReason) }];
    }
    if (entry.desired.kind === MIRROR_DESIRED_STATE_KIND.renameDeferred) {
      return [{ path: entry.path, state: "rename-deferred" as const }];
    }
    if (entry.desired.kind === MIRROR_DESIRED_STATE_KIND.runtimeDelete) {
      return [{ path: entry.path, state: "deletion-deferred" as const }];
    }
    if (
      entry.desired.kind !== MIRROR_DESIRED_STATE_KIND.none ||
      entry.unresolvedMutation !== null
    ) {
      return [{ path: entry.path, state: "pending" as const }];
    }
    return [];
  });
  const writer =
    snapshot.state.globalBlockReason ===
    MIRROR_GLOBAL_BLOCK_REASON.designationMismatch
      ? "designation-mismatch"
      : snapshot.state.lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.active
        ? "active-writer"
        : "inactive";
  const lastOutcome = [...outcomes.values()].at(-1) ?? null;
  return {
    configuration,
    writer,
    bootstrap: phase ?? "not-started",
    globalBlockReason: snapshot.state.globalBlockReason,
    persistenceFenced: !snapshot.persistenceAvailable,
    pendingPaths: pathStatuses.length,
    pathStatuses,
    lastOutcome,
  };
}

/**
 * Formats status as plain text suitable for notices, modals, and status bars.
 * @param status - Closed sanitized operational projection.
 * @returns Plain text containing no bearer, body, raw response, or exception.
 */
export function formatMirrorOperationalStatus(
  status: MirrorOperationalStatus,
): string {
  const lines = [
    `Configuration: ${status.configuration}`,
    `Writer: ${status.writer}`,
    `Bootstrap: ${status.bootstrap}`,
    `Pending or blocked paths: ${status.pendingPaths}`,
    `Persistence fenced: ${status.persistenceFenced ? "yes" : "no"}`,
  ];
  if (status.globalBlockReason !== null) {
    lines.push(`Global block: ${status.globalBlockReason}`);
  }
  if (status.lastOutcome !== null) {
    lines.push(`Last outcome: ${status.lastOutcome.kind}`);
  }
  for (const path of status.pathStatuses) {
    lines.push(`${path.path}: ${path.state}`);
  }
  return lines.join("\n");
}

function mapBlocked(
  reason: (typeof MIRROR_PATH_BLOCK_REASON)[keyof typeof MIRROR_PATH_BLOCK_REASON],
): MirrorOperationalPathStatus["state"] {
  switch (reason) {
    case MIRROR_PATH_BLOCK_REASON.retryExhausted:
      return "retry-exhausted";
    case MIRROR_PATH_BLOCK_REASON.unresolvedEffect:
      return "unresolved-effect";
    case MIRROR_PATH_BLOCK_REASON.diverged:
    case MIRROR_PATH_BLOCK_REASON.handoffMismatch:
      return "diverged";
    case MIRROR_PATH_BLOCK_REASON.renameDeferred:
      return "rename-deferred";
  }
}
