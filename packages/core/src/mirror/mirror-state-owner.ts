import type { MutationAcknowledgement } from "@core/mirror/mirror.types";
import { applyMutationAcknowledgement } from "@core/mirror/mirror-acknowledgement";
import type {
  MirrorDeviceState,
  MirrorStateSnapshot,
} from "@core/mirror/mirror-state.types";
import { isDurableMutationAdmissionAllowed } from "@core/mirror/mirror-state-policy";
import type {
  MirrorStateStore,
  MirrorStateStoreFailure,
} from "@core/mirror/mirror-state-store.port";
import { isMirrorDeviceStateConsistent } from "@core/mirror/mirror-state-validation";

/** Closed result of a compare-and-transition state-owner request. */
export type MirrorStateCommitResult =
  | { readonly kind: "committed"; readonly snapshot: MirrorStateSnapshot }
  | { readonly kind: "stale"; readonly snapshot: MirrorStateSnapshot }
  | {
      readonly kind: "invalid-transition";
      readonly snapshot: MirrorStateSnapshot;
    }
  | {
      readonly kind: "save-failed";
      readonly reason: MirrorStateStoreFailure;
      readonly snapshot: MirrorStateSnapshot;
    };

/**
 * Serializes complete validate/persist/publish transitions for one device ledger.
 *
 * A caller supplies the revision it observed. The reducer runs only after all older
 * work settles and only when that revision is still current. Persistence precedes
 * publication, so queued stale snapshots can never overwrite newer committed state.
 * Any save failure conservatively denies mutation admission while retaining the
 * previously committed state and unresolved evidence.
 */
export class MirrorStateOwner {
  private state: MirrorDeviceState;
  private revision = 0;
  private persistenceAvailable = true;
  private pendingTransitions = 0;
  private queue: Promise<void> = Promise.resolve();

  /**
   * @param initialState - Already validated authoritative device-local state.
   * @param store - Adapter that requests replacement of one complete serialized snapshot.
   * @throws When initial state violates core application invariants.
   */
  constructor(
    initialState: MirrorDeviceState,
    private readonly store: MirrorStateStore,
  ) {
    if (!isMirrorDeviceStateConsistent(initialState)) {
      throw new Error("Invalid initial mirror device state.");
    }
    this.state = initialState;
  }

  /** @returns The current committed state and compare-and-transition revision. */
  snapshot(): MirrorStateSnapshot {
    return this.createSnapshot(0);
  }

  /**
   * Applies one complete transition against an explicitly observed revision.
   *
   * @param expectedRevision - Revision from the caller's prior snapshot.
   * @param transition - Core-owned policy transition; `undefined` rejects invalid requests.
   * @returns Commit, stale, validation, or sanitized persistence outcome.
   */
  commit(
    expectedRevision: number,
    transition: (current: MirrorDeviceState) => MirrorDeviceState | undefined,
  ): Promise<MirrorStateCommitResult> {
    return this.enqueue(async () => {
      if (expectedRevision !== this.revision) {
        return { kind: "stale", snapshot: this.settledOperationSnapshot() };
      }
      return this.apply(transition);
    });
  }

  /**
   * Applies one validated remote ACK only to its exact persisted unresolved intent.
   *
   * @param expectedRevision - State revision observed when the remote operation began.
   * @param acknowledgement - Validated remote generation and complete operation receipt.
   * @returns Commit/stale/mismatch/persistence outcome; a mismatch never changes state.
   */
  applyAcknowledgement(
    expectedRevision: number,
    acknowledgement: MutationAcknowledgement,
  ): Promise<MirrorStateCommitResult> {
    return this.commit(expectedRevision, (current) =>
      applyMutationAcknowledgement(current, acknowledgement),
    );
  }

  /**
   * Applies a core-policy transition to the latest state after older work settles.
   *
   * Pause/disable actions use this form so an earlier pending acknowledgement cannot
   * make the safety control disappear as a stale whole-state write.
   *
   * @param transition - Core policy transition evaluated against the latest state.
   * @returns Commit, validation, or persistence outcome.
   */
  transition(
    transition: (current: MirrorDeviceState) => MirrorDeviceState | undefined,
  ): Promise<MirrorStateCommitResult> {
    return this.enqueue(() => this.apply(transition));
  }

  /**
   * Queues a state barrier after prior transitions and avoids a storage write when policy returns the exact current state.
   *
   * A no-op still waits for earlier writes to settle, so callers can safely publish lifecycle authority from the resulting snapshot.
   *
   * @param transition - Core policy evaluated against the latest serialized state.
   * @returns Commit, unchanged-state success, validation, or sanitized persistence outcome.
   */
  transitionIfChanged(
    transition: (current: MirrorDeviceState) => MirrorDeviceState | undefined,
  ): Promise<MirrorStateCommitResult> {
    return this.enqueue(() => this.apply(transition, true));
  }

  /**
   * Persists the current authoritative snapshot before clearing a runtime save-failure fence.
   *
   * @returns Updated conservative snapshot; admission remains denied on another failure.
   */
  verifyPersistence(): Promise<MirrorStateSnapshot> {
    return this.enqueue(async () => {
      const saved = await this.store.save(this.state);
      this.persistenceAvailable = saved.kind === "saved";
      return this.settledOperationSnapshot();
    });
  }

  /**
   * Materializes the state that will be externally visible after the current
   * serialized operation leaves the pending-transition count.
   *
   * @returns Post-settlement state with admission fenced only by later work.
   */
  private settledOperationSnapshot(): MirrorStateSnapshot {
    return this.createSnapshot(1);
  }

  /**
   * Creates a snapshot while excluding operations whose completion is represented
   * by the returned result rather than by later pending work.
   *
   * @param settlingTransitions - Current operations to exclude from admission fencing.
   * @returns Current state and admission derived from the adjusted pending count.
   */
  private createSnapshot(settlingTransitions: 0 | 1): MirrorStateSnapshot {
    return {
      revision: this.revision,
      state: this.state,
      persistenceAvailable: this.persistenceAvailable,
      mutationAdmissionAllowed:
        this.persistenceAvailable &&
        this.pendingTransitions === settlingTransitions &&
        isDurableMutationAdmissionAllowed(this.state),
    };
  }

  /**
   * Validates and saves a queued transition before publishing/revision advance; typed save failure retains prior state and fences admission.
   *
   * @param transition - Queued pure state transition evaluated against the latest published ledger.
   * @param skipUnchanged - Whether exact current-state identity avoids persistence while retaining queue-barrier semantics.
   * @returns The committed or rejected transition outcome.
   */
  private async apply(
    transition: (current: MirrorDeviceState) => MirrorDeviceState | undefined,
    skipUnchanged = false,
  ): Promise<MirrorStateCommitResult> {
    const next = transition(this.state);
    if (next === undefined || !isMirrorDeviceStateConsistent(next)) {
      return {
        kind: "invalid-transition",
        snapshot: this.settledOperationSnapshot(),
      };
    }
    if (skipUnchanged && next === this.state) {
      return { kind: "committed", snapshot: this.settledOperationSnapshot() };
    }
    const saved = await this.store.save(next);
    if (saved.kind === "failed") {
      this.persistenceAvailable = false;
      return {
        kind: "save-failed",
        reason: saved.reason,
        snapshot: this.settledOperationSnapshot(),
      };
    }
    this.state = next;
    this.revision += 1;
    return { kind: "committed", snapshot: this.settledOperationSnapshot() };
  }

  /**
   * Appends one operation to the owner queue while keeping subsequent work alive.
   *
   * @param operation - Complete serialized operation.
   * @returns The operation's typed result.
   */
  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    this.pendingTransitions += 1;
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.pendingTransitions -= 1;
    });
  }
}
