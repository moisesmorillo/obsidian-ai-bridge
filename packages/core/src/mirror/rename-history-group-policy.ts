import { MUTATION_EFFECT_CERTAINTY } from "@core/mirror/mirror.constants";
import type { MirrorOperationId } from "@core/mirror/mirror.types";
import {
  MAX_MIRROR_TRACKED_PATHS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
} from "@core/mirror/mirror-state.constants";
import type {
  MirrorDeviceState,
  RenameDeferredMirrorState,
} from "@core/mirror/mirror-state.types";
import {
  HISTORY_CLEANUP_STEP_KIND,
  HISTORY_CLEANUP_STEP_PHASE,
  HISTORY_DECISION_KIND,
  HISTORY_PROGRESS_KIND,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_LOCAL_STABILITY,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
} from "@core/mirror/reconciliation-state.constants";
import type {
  HistoryAdmissionDecision,
  HistoryCleanupStep,
  HistoryDecision,
  ReconciliationReviewSnapshot,
  RefinedHistoryProgress,
} from "@core/mirror/reconciliation-state.types";
import type { NotePath } from "@core/note-path/note-path.types";

/** Complete current-evidence history group or a finite derivation failure. */
export type RenameHistoryGroupResult =
  | { readonly kind: "group"; readonly paths: readonly NotePath[] }
  | { readonly kind: "not-history" }
  | { readonly kind: "capacity-exceeded" };

/** Durable path entry whose desired state is one exact deferred rename edge. */
type RenameDeferredPathEntry = MirrorDeviceState["paths"][number] & {
  readonly desired: RenameDeferredMirrorState;
};

/**
 * Derives bounded connected rename groups solely from durable M3 deferred edges.
 *
 * The caller supplies only a seed path. Every source, destination, overlap, and chain
 * member is discovered from current state and returned once in lexical order.
 */
export class RenameHistoryGroupPolicy {
  /**
   * @param state - Current durable device state.
   * @param seedPath - Candidate path used only to select one connected component.
   * @returns Complete lexical group, no history component, or explicit capacity failure.
   */
  derive(
    state: MirrorDeviceState,
    seedPath: NotePath,
  ): RenameHistoryGroupResult {
    const edges = state.paths
      .map((entry) => entry.desired)
      .filter(
        (desired): desired is RenameDeferredMirrorState =>
          desired.kind === MIRROR_DESIRED_STATE_KIND.renameDeferred,
      );
    if (
      !edges.some(
        (edge) =>
          edge.sourcePath === seedPath || edge.destinationPath === seedPath,
      )
    ) {
      return { kind: "not-history" };
    }

    const paths = new Set<NotePath>([seedPath]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of edges) {
        const touchesGroup =
          paths.has(edge.sourcePath) ||
          (edge.destinationPath !== null && paths.has(edge.destinationPath));
        if (!touchesGroup) continue;
        const candidates =
          edge.destinationPath === null
            ? [edge.sourcePath]
            : [edge.sourcePath, edge.destinationPath];
        for (const path of candidates) {
          if (paths.has(path)) continue;
          paths.add(path);
          changed = true;
          if (paths.size > MAX_MIRROR_TRACKED_PATHS) {
            return { kind: "capacity-exceeded" };
          }
        }
      }
    }

    return {
      kind: "group",
      paths: [...paths].toSorted((left, right) => left.localeCompare(right)),
    };
  }

  /**
   * Resolves one process-local projected selection into the durable history decision.
   *
   * @param state - Current durable rename-edge authority.
   * @param snapshot - Complete immutable group evidence.
   * @param decision - Operator choice containing no durable canonical field.
   * @returns Durable decision, or undefined when projection membership/group evidence is stale.
   */
  deriveDecision(
    state: MirrorDeviceState,
    snapshot: ReconciliationReviewSnapshot,
    decision: HistoryAdmissionDecision,
  ): HistoryDecision | undefined {
    const group = this.derive(state, snapshot.targetPath);
    if (group.kind !== "group") return undefined;
    const sampledPaths = snapshot.paths
      .map((evidence) => evidence.path)
      .toSorted((left, right) => left.localeCompare(right));
    if (
      sampledPaths.length !== group.paths.length ||
      sampledPaths.some((path, index) => path !== group.paths[index])
    ) {
      return undefined;
    }
    if (
      decision.kind === HISTORY_DECISION_KIND.retainIndependent ||
      decision.kind === HISTORY_DECISION_KIND.deferHistory
    ) {
      return decision;
    }
    if (!group.paths.includes(decision.selectedCandidatePath)) return undefined;
    return {
      kind: HISTORY_DECISION_KIND.executeCleanupPlan,
      canonicalPath: decision.selectedCandidatePath,
    };
  }

  /**
   * Builds an ordered step ledger only from a complete exact group sample.
   *
   * @param state - Current durable M3 edge authority.
   * @param snapshot - Immutable complete grouped review evidence.
   * @param decision - Closed operator decision.
   * @param parentOperationId - Parent identity that step IDs must not reuse.
   * @param createOperationId - Fresh UUID-v4 source for Worker step identities.
   * @returns Refined no-effect/cleanup progress, or undefined for contradictory evidence.
   */
  createProgress(
    state: MirrorDeviceState,
    snapshot: ReconciliationReviewSnapshot,
    decision: HistoryDecision,
    parentOperationId: MirrorOperationId,
    createOperationId: () => MirrorOperationId,
  ): RefinedHistoryProgress | undefined {
    const group = this.derive(state, snapshot.targetPath);
    if (group.kind !== "group") return undefined;
    const sampledPaths = snapshot.paths
      .map((evidence) => evidence.path)
      .toSorted((left, right) => left.localeCompare(right));
    if (
      sampledPaths.length !== group.paths.length ||
      sampledPaths.some((path, index) => path !== group.paths[index])
    ) {
      return undefined;
    }
    if (
      decision.kind === HISTORY_DECISION_KIND.retainIndependent ||
      decision.kind === HISTORY_DECISION_KIND.deferHistory
    ) {
      return {
        kind: HISTORY_PROGRESS_KIND.refined,
        decision,
        steps: [],
        nextStepIndex: null,
      };
    }
    if (
      decision.canonicalPath !== null &&
      !group.paths.includes(decision.canonicalPath)
    ) {
      return undefined;
    }

    const cleanupEntries = state.paths.filter(
      (entry): entry is RenameDeferredPathEntry =>
        group.paths.includes(entry.path) &&
        entry.desired.kind === MIRROR_DESIRED_STATE_KIND.renameDeferred &&
        entry.path === entry.desired.sourcePath &&
        entry.desired.destinationPath !== null &&
        (decision.canonicalPath === null ||
          entry.desired.destinationPath === decision.canonicalPath),
    );
    const orderedEntries = orderCleanupEntries(cleanupEntries);
    if (orderedEntries === undefined) return undefined;
    const stepIds = new Set<MirrorOperationId>([parentOperationId]);
    const steps = orderedEntries.map(
      (entry): HistoryCleanupStep | undefined => {
        const desired = entry.desired;
        /* v8 ignore next -- cleanupEntries is narrowed by the rename-deferred filter above. */
        if (desired.kind !== MIRROR_DESIRED_STATE_KIND.renameDeferred) {
          return undefined;
        }
        const source = snapshot.paths.find(
          (evidence) => evidence.path === desired.sourcePath,
        );
        const destination = snapshot.paths.find(
          (evidence) => evidence.path === desired.destinationPath,
        );
        if (
          source?.local.kind !== RECONCILIATION_LOCAL_EVIDENCE_KIND.absent ||
          source.local.stability !== RECONCILIATION_LOCAL_STABILITY.stable ||
          source.remote.kind !== RECONCILIATION_REMOTE_EVIDENCE_KIND.live ||
          source.remote.associationId !== desired.associationId ||
          source.remote.revision !== desired.sourceExpectedRevision ||
          destination?.baseline.kind !== MIRROR_ACKNOWLEDGEMENT_KIND.live ||
          desired.destinationAcknowledgedRevision === null ||
          destination.baseline.revision !==
            desired.destinationAcknowledgedRevision ||
          destination.remote.kind !==
            RECONCILIATION_REMOTE_EVIDENCE_KIND.live ||
          destination.remote.associationId !== desired.associationId ||
          destination.remote.revision !==
            desired.destinationAcknowledgedRevision
        ) {
          return undefined;
        }
        const stepId = createOperationId();
        if (stepIds.has(stepId)) return undefined;
        stepIds.add(stepId);
        return {
          stepId,
          kind: HISTORY_CLEANUP_STEP_KIND.remoteFormerSourceCleanup,
          sourcePath: source.path,
          prerequisitePath: destination.path,
          sourceRevision: source.remote.revision,
          sourceContentSha256: source.remote.contentSha256,
          prerequisiteRevision: destination.remote.revision,
          localAbsenceGeneration: source.local.observationGeneration,
          phase: HISTORY_CLEANUP_STEP_PHASE.pending,
          remoteEffect: {
            kind: MUTATION_EFFECT_CERTAINTY.notDispatched,
          },
        };
      },
    );
    const validSteps = steps.filter(
      (step): step is HistoryCleanupStep => step !== undefined,
    );
    if (validSteps.length === 0 || validSteps.length !== steps.length) {
      return undefined;
    }
    return {
      kind: HISTORY_PROGRESS_KIND.refined,
      decision,
      steps: validSteps,
      nextStepIndex: 0,
    };
  }
}

/**
 * Orders former-source cleanup before cleanup of any path that is its prerequisite.
 *
 * @param entries - Exact deferred edges selected for one cleanup plan.
 * @returns Stable lexical topological order, or undefined for a cyclic plan.
 */
function orderCleanupEntries(
  entries: readonly RenameDeferredPathEntry[],
): readonly RenameDeferredPathEntry[] | undefined {
  let remaining = [...entries];
  const ordered: RenameDeferredPathEntry[] = [];
  while (remaining.length > 0) {
    const next = remaining
      .filter(
        (candidate) =>
          !remaining.some(
            (predecessor) =>
              predecessor.path !== candidate.path &&
              predecessor.desired.destinationPath === candidate.path,
          ),
      )
      .toSorted((left, right) => left.path.localeCompare(right.path))[0];
    if (next === undefined) return undefined;
    ordered.push(next);
    remaining = remaining.filter((candidate) => candidate.path !== next.path);
  }
  return ordered;
}
