import {
  HISTORY_PROGRESS_KIND,
  isHistoryReconciliationOperation,
  isReconciliationEffectDispatchAllowed,
  type MirrorOperationId,
  type MirrorStateOwner,
  RECONCILIATION_EFFECT_DISPATCH_KIND,
  type ReconciliationEffectDispatchKind,
} from "@obsidian-ai-bridge/core";
import type { MirrorObservationEpochCoordinator } from "@obsidian-plugin/runtime/mirror-observation-epoch";

/** Result of an atomic lease check immediately around one synchronous host dispatch call. */
export type MirrorEffectDispatchResult<Value> =
  | { readonly kind: "dispatched"; readonly value: Value }
  | { readonly kind: "not-ready" };

/** Runtime capability used by local and Fetch adapters at the exact effect boundary. */
export interface MirrorEffectDispatchAuthority {
  /**
   * Rebinds effect permission to the published connection; null closes every dispatch gate.
   * @param generation - Current configuration generation, or null while no connection is authoritative.
   */
  setConfigurationGeneration(generation: number | null): void;
  /**
   * Invokes one synchronous effect only while its durable owner and ready lease still agree.
   * @param operationId - M4 operation/step identity or M3 mutation intent identity.
   * @param kind - Exact local/remote effect boundary used to check durable phase authority.
   * @param effect - Synchronous host/Fetch invocation; the gate cannot span an awaited effect.
   * @returns The effect result, or `not-ready` without invoking the effect.
   */
  dispatch<Value>(
    operationId: MirrorOperationId,
    kind: ReconciliationEffectDispatchKind,
    effect: () => Value,
  ): MirrorEffectDispatchResult<Value>;
}

/**
 * Binds dispatch to the ready epoch, persisted mutation admission, and exact M4 owner.
 *
 * M4 step IDs resolve through their parent history operation, then require the exact
 * current step and effect phase. Blocked, uncertain, terminal, or gap-fenced work
 * cannot dispatch even after a new lease is open; historical epochs are not reused.
 */
export class MirrorEffectDispatchGate implements MirrorEffectDispatchAuthority {
  /** Generation bound to the current connection; null denies effects. */
  private configurationGeneration: number | null = null;

  /** @param stateOwner - Serialized operation and M3 intent authority. */
  constructor(
    private readonly stateOwner: MirrorStateOwner,
    private readonly epochs: MirrorObservationEpochCoordinator,
  ) {}

  /** @inheritdoc */
  setConfigurationGeneration(generation: number | null): void {
    this.configurationGeneration = generation;
  }

  /** @inheritdoc */
  dispatch<Value>(
    operationId: MirrorOperationId,
    kind: ReconciliationEffectDispatchKind,
    effect: () => Value,
  ): MirrorEffectDispatchResult<Value> {
    const epoch = this.authorizedEpoch(operationId, kind);
    if (epoch === null) return { kind: "not-ready" };
    return this.epochs.dispatch(epoch, effect);
  }

  /** Resolves exact M4 phase authority or a current untracked remote-mutation lease.
   * @param operationId - Durable M4 owner/step or untracked remote intent identity.
   * @param kind - Effect boundary whose persisted phase must authorize dispatch.
   * @returns Current ready epoch when this effect is authorized, otherwise null.
   */
  private authorizedEpoch(
    operationId: MirrorOperationId,
    kind: ReconciliationEffectDispatchKind,
  ): number | null {
    const currentEpoch = this.epochs.readyEpoch();
    const stateSnapshot = this.stateOwner.snapshot();
    if (
      currentEpoch === null ||
      this.configurationGeneration === null ||
      !stateSnapshot.mutationAdmissionAllowed
    ) {
      return null;
    }
    const operation = stateSnapshot.state.reconciliationOperations.find(
      (candidate) =>
        candidate.operationId === operationId ||
        (isHistoryReconciliationOperation(candidate) &&
          candidate.historyProgress.kind === HISTORY_PROGRESS_KIND.refined &&
          candidate.historyProgress.steps.some(
            (step) => step.stepId === operationId,
          )),
    );
    if (operation === undefined) {
      return kind === RECONCILIATION_EFFECT_DISPATCH_KIND.remoteMutation
        ? currentEpoch
        : null;
    }
    if (
      operation.snapshot.runtime.configurationGeneration !==
        this.configurationGeneration ||
      operation.snapshot.runtime.listenerEpoch !== currentEpoch ||
      !isReconciliationEffectDispatchAllowed(operation, operationId, kind)
    ) {
      return null;
    }
    return currentEpoch;
  }
}
