import { MIRROR_DELETION_GRACE_MILLISECONDS } from "@core/mirror/mirror-autosync.constants";
import {
  invalidateRenamePlansForPath,
  recordPositiveObservation,
  recordRuntimeDeleteEvidence,
  recordRuntimeRenameEvidence,
} from "@core/mirror/mirror-lifecycle-state";
import type { MirrorPathRuntime } from "@core/mirror/mirror-path-runtime";
import {
  MAX_MIRROR_TRACKED_PATHS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
} from "@core/mirror/mirror-state.constants";
import type { MirrorStateOwner } from "@core/mirror/mirror-state-owner";
import type {
  MirrorDeleteObservationResult,
  MirrorFolderRenameResult,
  MirrorRenameObservationResult,
  MirrorSynchronizerRuntime,
} from "@core/mirror/mirror-synchronizer.types";
import { isNormalizedNotePath } from "@core/note-path/note-path";
import type { NotePath } from "@core/note-path/note-path.types";

/**
 * Owns admission of event-based delete/rename authority and bounded folder expansion.
 *
 * It receives only runtime observations from the facade. Scans and inventories have
 * no API into this owner, so they cannot manufacture destructive evidence.
 */
export class MirrorLifecyclePlanner {
  /** Connects event authority to serialized state and owner-local generation/time seams without host event dependencies. */
  constructor(
    private readonly stateOwner: MirrorStateOwner,
    private readonly runtime: MirrorSynchronizerRuntime,
    private readonly pathRuntime: MirrorPathRuntime,
  ) {}

  /**
   * Persists one associated runtime delete before any destructive dispatch.
   *
   * @param path - Exact path carried by a post-bootstrap runtime event.
   * @returns Durable authority admission outcome.
   */
  async observeDelete(path: NotePath): Promise<MirrorDeleteObservationResult> {
    const current = this.stateOwner
      .snapshot()
      .state.paths.find((entry) => entry.path === path);
    if (current?.desired.kind === MIRROR_DESIRED_STATE_KIND.runtimeDelete) {
      return { kind: "accepted" };
    }
    if (current?.acknowledgement.kind !== MIRROR_ACKNOWLEDGEMENT_KIND.live) {
      return { kind: "no-authority" };
    }
    const now = this.runtime.nowMilliseconds();
    const committed = await this.stateOwner.transition((state) =>
      recordRuntimeDeleteEvidence(state, {
        path,
        observationGeneration: this.pathRuntime.nextGeneration(),
        evidenceId: this.runtime.createOperationId(),
        graceDeadlineMilliseconds: now + MIRROR_DELETION_GRACE_MILLISECONDS,
      }),
    );
    if (committed.kind === "committed") {
      this.pathRuntime.recordDestructiveGrace(
        path,
        now + MIRROR_DELETION_GRACE_MILLISECONDS,
      );
      return { kind: "accepted" };
    }
    return committed.kind === "save-failed"
      ? { kind: "persistence-failed" }
      : { kind: "no-authority" };
  }

  /**
   * Persists a rename plan, or admits only the positive destination when the source
   * had no deletion authority at observation time.
   *
   * @param sourcePath - Pre-event eligible source identity.
   * @param destinationPath - Eligible destination, or `null` when excluded.
   * @returns Durable plan, positive-only, capacity, or persistence outcome.
   */
  async observeRename(
    sourcePath: NotePath,
    destinationPath: NotePath | null,
  ): Promise<MirrorRenameObservationResult> {
    const snapshot = this.stateOwner.snapshot();
    const source = snapshot.state.paths.find(
      (entry) => entry.path === sourcePath,
    );
    if (
      source?.desired.kind === MIRROR_DESIRED_STATE_KIND.renameDeferred &&
      source.desired.destinationPath === destinationPath
    ) {
      return { kind: "accepted" };
    }

    const sourceGeneration = this.pathRuntime.nextGeneration();
    const destinationGeneration =
      destinationPath === null ? null : this.pathRuntime.nextGeneration();
    const now = this.runtime.nowMilliseconds();
    if (source?.acknowledgement.kind !== MIRROR_ACKNOWLEDGEMENT_KIND.live) {
      const positive = await this.recordPositiveRenameDiscovery(
        sourcePath,
        destinationPath,
        destinationGeneration,
      );
      return positive ?? { kind: "no-authority" };
    }
    if (
      destinationPath !== null &&
      !snapshot.state.paths.some((entry) => entry.path === destinationPath) &&
      snapshot.state.paths.length >= MAX_MIRROR_TRACKED_PATHS
    ) {
      return { kind: "capacity-exceeded" };
    }

    const renameId = this.runtime.createOperationId();
    const committed = await this.stateOwner.transition((state) =>
      recordRuntimeRenameEvidence(state, {
        sourcePath,
        destinationPath,
        sourceObservationGeneration: sourceGeneration,
        destinationObservationGeneration: destinationGeneration,
        renameId,
        graceDeadlineMilliseconds: now + MIRROR_DELETION_GRACE_MILLISECONDS,
      }),
    );
    if (committed.kind === "committed") {
      this.pathRuntime.recordDestructiveGrace(
        sourcePath,
        now + MIRROR_DELETION_GRACE_MILLISECONDS,
      );
      if (destinationPath !== null && destinationGeneration !== null) {
        this.pathRuntime.recordObservation(
          destinationPath,
          destinationGeneration,
          now,
          false,
          true,
        );
      }
      return { kind: "accepted" };
    }
    return committed.kind === "save-failed"
      ? { kind: "persistence-failed" }
      : { kind: "no-authority" };
  }

  /**
   * Records positive discovery while invalidating stale cleanup dependencies.
   *
   * @param path - Eligible present path.
   * @returns Whether the positive observation persisted.
   */
  async observePresent(path: NotePath): Promise<boolean> {
    const generation = this.pathRuntime.nextGeneration();
    const now = this.runtime.nowMilliseconds();
    const current = this.stateOwner
      .snapshot()
      .state.paths.find((entry) => entry.path === path);
    const committed = await this.stateOwner.transition((state) =>
      recordPositiveObservation(state, path, generation),
    );
    if (committed.kind !== "committed") return false;
    this.pathRuntime.recordObservation(
      path,
      generation,
      now,
      false,
      current?.desired.kind !== MIRROR_DESIRED_STATE_KIND.dirtyPresent,
    );
    return true;
  }

  /**
   * Expands only the immutable pre-event tracked index under a directory boundary.
   *
   * `newFolder === null` means the destination folder is excluded. Invalid or
   * dot-prefixed generated destinations are treated the same way without reading them.
   *
   * @param oldFolder - Literal pre-event folder prefix.
   * @param newFolder - Eligible new prefix, or `null` when excluded.
   * @returns Counts for known, planned, and safely deferred descendants.
   */
  async observeFolderRename(
    oldFolder: string,
    newFolder: string | null,
  ): Promise<MirrorFolderRenameResult> {
    const prefix = folderPrefix(oldFolder);
    if (prefix === undefined) {
      return { planned: 0, deferred: 0, knownDescendants: 0 };
    }
    const snapshot = this.stateOwner.snapshot();
    const descendants = snapshot.state.paths
      .filter((entry) => entry.path.startsWith(prefix))
      .map((entry) => entry.path);
    const knownPaths = new Set(snapshot.state.paths.map((entry) => entry.path));
    let availablePaths = MAX_MIRROR_TRACKED_PATHS - knownPaths.size;
    let planned = 0;
    let deferred = 0;
    for (const sourcePath of descendants) {
      const suffix = sourcePath.slice(prefix.length);
      const destinationPath =
        newFolder === null
          ? null
          : eligibleGeneratedDestination(newFolder, suffix);
      const needsNewPath =
        destinationPath !== null && !knownPaths.has(destinationPath);
      if (needsNewPath && availablePaths === 0) {
        deferred += 1;
        continue;
      }
      const result = await this.observeRename(sourcePath, destinationPath);
      if (result.kind === "accepted") {
        planned += 1;
        if (needsNewPath && destinationPath !== null) {
          knownPaths.add(destinationPath);
          availablePaths -= 1;
        }
      } else {
        deferred += 1;
        if (result.kind === "persistence-failed") {
          deferred += descendants.length - planned - deferred;
          break;
        }
      }
    }
    return {
      planned,
      deferred,
      knownDescendants: descendants.length,
    };
  }

  /**
   * Invalidates old cleanup dependencies and records only destination presence when the source lacks a live ACK.
   *
   * @returns A persistence/capacity refusal, or undefined after recording positive discovery.
   */
  private async recordPositiveRenameDiscovery(
    sourcePath: NotePath,
    destinationPath: NotePath | null,
    destinationGeneration: number | null,
  ): Promise<MirrorRenameObservationResult | undefined> {
    const committed = await this.stateOwner.transition((state) => {
      const invalidated = invalidateRenamePlansForPath(state, sourcePath);
      if (destinationPath === null || destinationGeneration === null) {
        return invalidated;
      }
      return recordPositiveObservation(
        invalidated,
        destinationPath,
        destinationGeneration,
      );
    });
    if (committed.kind === "save-failed") return { kind: "persistence-failed" };
    if (committed.kind !== "committed") return { kind: "capacity-exceeded" };
    if (destinationPath !== null && destinationGeneration !== null) {
      this.pathRuntime.recordObservation(
        destinationPath,
        destinationGeneration,
        this.runtime.nowMilliseconds(),
        false,
        true,
      );
    }
    return undefined;
  }
}

/**
 * @param folder - Literal folder path without a trailing separator.
 * @returns A path-boundary-safe folder prefix, or no prefix for invalid syntax.
 */
function folderPrefix(folder: string): string | undefined {
  if (
    folder.length === 0 ||
    folder.startsWith("/") ||
    folder.endsWith("/") ||
    folder.includes("\\") ||
    folder
      .split("/")
      .some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
  ) {
    return undefined;
  }
  return `${folder}/`;
}

/**
 * @param folder - Literal destination folder.
 * @param suffix - Known eligible descendant suffix.
 * @returns One literal eligible destination without URI-decoding local names.
 */
function eligibleGeneratedDestination(
  folder: string,
  suffix: string,
): NotePath | null {
  if (folder.split("/").some((segment) => segment.startsWith("."))) return null;
  const destination = `${folder}/${suffix}`;
  return isNormalizedNotePath(destination) ? destination : null;
}
