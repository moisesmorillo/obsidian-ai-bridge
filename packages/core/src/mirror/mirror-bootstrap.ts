import { LocalInspectionKind } from "@core/local-vault/local-vault.constants";
import type { ReadOnlyLocalVault } from "@core/local-vault/read-only-local-vault.port";
import type { FairMirrorScheduler } from "@core/mirror/fair-mirror-scheduler";
import {
  MAX_REMOTE_INVENTORY_PAGES,
  MIRROR_BOOTSTRAP_INCOMPLETE_REASON,
  MIRROR_INVENTORY_INCOMPLETE_REASON,
} from "@core/mirror/mirror-autosync.constants";
import {
  inspectBoundedMirrorInventory,
  type MirrorInventoryResult,
} from "@core/mirror/mirror-inventory";
import type { MirrorPathRuntime } from "@core/mirror/mirror-path-runtime";
import { applyGlobalRemoteFailure } from "@core/mirror/mirror-remote-failure-policy";
import {
  MAX_MIRROR_TRACKED_PATHS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_GLOBAL_BLOCK_REASON,
} from "@core/mirror/mirror-state.constants";
import type {
  MirrorDeviceState,
  MirrorStateSnapshot,
} from "@core/mirror/mirror-state.types";
import type {
  MirrorStateCommitResult,
  MirrorStateOwner,
} from "@core/mirror/mirror-state-owner";
import type {
  MirrorBootstrapIncompleteReason,
  MirrorBootstrapResult,
  MirrorSynchronizerRuntime,
} from "@core/mirror/mirror-synchronizer.types";
import type {
  RemoteBridge,
  RemoteBridgeDescription,
} from "@core/mirror/remote-bridge.types";
import type { NotePath } from "@core/note-path/note-path.types";

/** Dedicated scheduler reservation for the reporting-only inventory traversal. */
const INVENTORY_RESERVATION_KEY = "mirror:inventory";

/** Atomic bootstrap path merge without a partial over-capacity result. */
type BootstrapPathMergeResult =
  | { readonly kind: "merged"; readonly state: MirrorDeviceState }
  | { readonly kind: "capacity-exceeded" };

/**
 * Owns remote handshake, local enumeration, durable batch admission, and reporting inventory.
 *
 * Inventory traversal delegates page/cursor policy to `inspectBoundedMirrorInventory`.
 * Admission is one indexed state transition and invokes `onAdmitted` before waiting for
 * reporting inventory, allowing positive reconciliation to use the remaining scheduler slot.
 */
export class MirrorBootstrapCoordinator {
  private inventory: MirrorInventoryResult | null = null;

  /** Connects read-only discovery and serialized admission to the existing scheduler and observation-generation owner. */
  constructor(
    private readonly local: ReadOnlyLocalVault,
    private readonly remote: RemoteBridge,
    private readonly stateOwner: MirrorStateOwner,
    private readonly scheduler: FairMirrorScheduler,
    private readonly runtime: MirrorSynchronizerRuntime,
    private readonly pathRuntime: MirrorPathRuntime,
  ) {}

  /** @returns Most recent bounded reporting inventory result. */
  inventoryResult(): MirrorInventoryResult | null {
    return this.inventory;
  }

  /**
   * Performs one non-retrying handshake and atomic local bootstrap admission.
   *
   * @param onStarted - Called after initial fail-closed prerequisites admit read-only work.
   * @param onAdmitted - Called after durable admission and before inventory completion.
   * @returns Explicit completion or fail-closed result without deletion authority.
   */
  async run(
    onStarted: () => void,
    onAdmitted: () => void,
  ): Promise<MirrorBootstrapResult> {
    const initial = this.stateOwner.snapshot();
    if (!isBootstrapAdmissionCandidate(initial)) {
      return { kind: "inactive", eligiblePaths: [], inventory: null };
    }
    this.pathRuntime.beginBootstrapScan();
    onStarted();
    const description = await this.remote.describe();
    if (description.kind === "failure") {
      await applyGlobalRemoteFailure(this.stateOwner, description.failure);
      return { kind: "inactive", eligiblePaths: [], inventory: null };
    }
    if (
      !currentIdentityMatches(this.stateOwner.snapshot(), description.value)
    ) {
      await this.stateOwner.transition((state) => ({
        ...state,
        globalBlockReason: MIRROR_GLOBAL_BLOCK_REASON.designationMismatch,
      }));
      return { kind: "inactive", eligiblePaths: [], inventory: null };
    }
    let inventory: MirrorInventoryResult = {
      kind: "incomplete",
      paths: [],
      pagesRead: MAX_REMOTE_INVENTORY_PAGES,
      reason: MIRROR_INVENTORY_INCOMPLETE_REASON.pageBudgetExhausted,
    };
    const inventoryCompletion = this.scheduler.enqueueAndWait({
      key: INVENTORY_RESERVATION_KEY,
      run: async () => {
        inventory = await inspectBoundedMirrorInventory(this.remote);
        this.inventory = inventory;
      },
    });
    if (inventoryCompletion === undefined) {
      throw new Error("Mirror inventory reservation invariant failed.");
    }
    const bootstrapGeneration = this.pathRuntime.nextGeneration();
    const local = await this.local.list();
    if (local.kind !== LocalInspectionKind.ok) {
      await inventoryCompletion;
      return {
        kind: "local-incomplete",
        eligiblePaths: [],
        inventory,
      };
    }
    const observedAt = this.runtime.nowMilliseconds();
    const observations = local.entries.map((entry) => ({
      path: entry.path,
      generation: bootstrapGeneration,
    }));
    let reducerFailure: MirrorBootstrapIncompleteReason | undefined;
    const admission = await this.stateOwner.transition((state) => {
      if (!bootstrapIdentityMatches(state, description.value)) {
        reducerFailure = MIRROR_BOOTSTRAP_INCOMPLETE_REASON.staleTransition;
        return undefined;
      }
      const merged = mergeBootstrapPaths(state, observations);
      if (merged.kind === "capacity-exceeded") {
        reducerFailure =
          MIRROR_BOOTSTRAP_INCOMPLETE_REASON.pathCapacityExceeded;
        return undefined;
      }
      return merged.state;
    });
    const admissionFailure =
      reducerFailure ??
      bootstrapCommitFailure(admission) ??
      (admission.snapshot.persistenceAvailable
        ? undefined
        : MIRROR_BOOTSTRAP_INCOMPLETE_REASON.persistenceFailed);
    if (admissionFailure !== undefined) {
      await inventoryCompletion;
      return {
        kind: "state-incomplete",
        eligiblePaths: [],
        inventory,
        reason: admissionFailure,
      };
    }
    const admittedPathByPath = new Map(
      admission.snapshot.state.paths.map(
        (entry) => [entry.path, entry] as const,
      ),
    );
    for (const observation of observations) {
      const current = admittedPathByPath.get(observation.path);
      this.pathRuntime.recordObservation(
        observation.path,
        observation.generation,
        observedAt,
        true,
        current?.desired.kind !== MIRROR_DESIRED_STATE_KIND.dirtyPresent,
      );
    }
    onAdmitted();
    await inventoryCompletion;
    const associated = new Set(
      this.stateOwner
        .snapshot()
        .state.paths.flatMap((entry) =>
          entry.acknowledgement.kind ===
          MIRROR_ACKNOWLEDGEMENT_KIND.unassociated
            ? []
            : [entry.path],
        ),
    );
    return {
      kind: "complete",
      eligiblePaths: local.entries.map((entry) => entry.path),
      inventory,
      unassociatedRemotePaths: inventory.paths.filter(
        (path) => !associated.has(path),
      ),
    };
  }
}

/** @returns Whether read-only bootstrap work may begin without granting mutation. */
function isBootstrapAdmissionCandidate(snapshot: MirrorStateSnapshot): boolean {
  return (
    snapshot.persistenceAvailable &&
    snapshot.state.lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.active &&
    snapshot.state.globalBlockReason === null
  );
}

/** @returns Whether the post-handshake owner snapshot still has the same writer identity. */
function currentIdentityMatches(
  snapshot: MirrorStateSnapshot,
  description: RemoteBridgeDescription,
): boolean {
  return bootstrapIdentityMatches(snapshot.state, description);
}

/** @returns Whether serialized admission still belongs to the handshake identity. */
function bootstrapIdentityMatches(
  state: MirrorDeviceState,
  description: RemoteBridgeDescription,
): boolean {
  return (
    state.lifecycle.kind === MIRROR_DEVICE_LIFECYCLE_KIND.active &&
    state.globalBlockReason === null &&
    state.lifecycle.associationId === description.associationId &&
    state.deviceId === description.writerId
  );
}

/** @returns Explicit bootstrap refusal for every non-commit owner result. */
function bootstrapCommitFailure(
  result: MirrorStateCommitResult,
): MirrorBootstrapIncompleteReason | undefined {
  switch (result.kind) {
    case "committed":
      return undefined;
    case "stale":
      return MIRROR_BOOTSTRAP_INCOMPLETE_REASON.staleTransition;
    case "invalid-transition":
      return MIRROR_BOOTSTRAP_INCOMPLETE_REASON.invalidTransition;
    case "save-failed":
      return MIRROR_BOOTSTRAP_INCOMPLETE_REASON.persistenceFailed;
  }
}

/** @returns One indexed merge or an atomic capacity refusal. */
function mergeBootstrapPaths(
  state: MirrorDeviceState,
  observations: readonly {
    readonly path: NotePath;
    readonly generation: number;
  }[],
): BootstrapPathMergeResult {
  const pathByPath = new Map(
    state.paths.map((entry) => [entry.path, entry] as const),
  );
  for (const observation of observations) {
    const current = pathByPath.get(observation.path);
    if (current === undefined) {
      if (pathByPath.size >= MAX_MIRROR_TRACKED_PATHS) {
        return { kind: "capacity-exceeded" };
      }
      pathByPath.set(observation.path, {
        path: observation.path,
        acknowledgement: { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
        unresolvedMutation: null,
        desired: {
          kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent,
          observationGeneration: observation.generation,
        },
        blockedReason: null,
      });
      continue;
    }
    if (
      current.desired.kind === MIRROR_DESIRED_STATE_KIND.dirtyPresent &&
      current.desired.observationGeneration > observation.generation
    ) {
      continue;
    }
    pathByPath.set(observation.path, {
      ...current,
      desired: {
        kind: MIRROR_DESIRED_STATE_KIND.dirtyPresent,
        observationGeneration: observation.generation,
      },
    });
  }
  return {
    kind: "merged",
    state: { ...state, paths: [...pathByPath.values()] },
  };
}
