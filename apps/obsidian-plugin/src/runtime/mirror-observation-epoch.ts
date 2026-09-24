/** Session notifications are presentation mechanics and never become runtime policy. */
export interface MirrorRuntimeSessionAttachment {
  /** Unique enable-lifetime identity used to reject stale callbacks. */
  readonly id: string;
  /** Called after owner state changes; stale sessions are removed before invocation. */
  readonly onChanged: () => void;
}

/** Closed runtime attachment refusal. */
export type MirrorRuntimeAttachResult =
  | { readonly kind: "attached" }
  | { readonly kind: "already-attached" };

/** Accepted layout boundary for one unique observation attachment epoch. */
export type MirrorLayoutReadyResult =
  | { readonly kind: "ready"; readonly epoch: number }
  | { readonly kind: "duplicate" }
  | { readonly kind: "stale" };

/**
 * Owns enable-lifetime listener epochs independently from same-realm runtime work.
 *
 * Every attachment after a detached interval receives a new monotonic epoch. Layout
 * readiness is accepted once per epoch, so composition can require one fresh,
 * non-destructive reconciliation without resetting scheduler or transport ownership.
 */
export class MirrorObservationEpochCoordinator {
  /** Current enable-lifetime presentation owner, or null while detached. */
  private attachment: MirrorRuntimeSessionAttachment | null = null;
  /** Monotonic listener-continuity identity; it is never restored from persisted state. */
  private epoch = 0;
  /** Whether the current attachment has crossed its one layout-ready boundary. */
  private layoutBoundaryReady = false;
  /** Whether classification and event barriers have published effect authority. */
  private dispatchLeaseReady = false;
  /** Prevents lease republishing within one attachment after any invalidation. */
  private dispatchLeasePublished = false;

  /**
   * Acquires presentation and listener ownership for one plugin enable lifetime.
   * @param attachment - Current session callback and identity.
   * @returns New/current epoch, or a refusal while another session remains attached.
   */
  attach(
    attachment: MirrorRuntimeSessionAttachment,
  ): MirrorRuntimeAttachResult {
    if (this.attachment !== null && this.attachment.id !== attachment.id) {
      return { kind: "already-attached" };
    }
    if (this.attachment === null) {
      this.epoch += 1;
      this.layoutBoundaryReady = false;
      this.dispatchLeaseReady = false;
      this.dispatchLeasePublished = false;
    }
    this.attachment = attachment;
    return { kind: "attached" };
  }

  /**
   * Detaches only the matching observation epoch; long-lived work is untouched.
   * @param sessionId - Enable-lifetime identity being detached.
   * @returns Whether the current observation epoch was detached.
   */
  detach(sessionId: string): boolean {
    if (this.attachment?.id !== sessionId) return false;
    this.dispatchLeaseReady = false;
    this.layoutBoundaryReady = false;
    this.attachment = null;
    return true;
  }

  /**
   * Accepts at most one layout-ready callback for the current attachment epoch.
   * @param sessionId - Enable-lifetime identity receiving layout readiness.
   * @returns Ready epoch, duplicate callback, or stale-session classification.
   */
  markLayoutReady(sessionId: string): MirrorLayoutReadyResult {
    if (this.attachment?.id !== sessionId) return { kind: "stale" };
    if (this.layoutBoundaryReady) return { kind: "duplicate" };
    this.layoutBoundaryReady = true;
    return { kind: "ready", epoch: this.epoch };
  }

  /**
   * @param sessionId - Enable-lifetime identity to compare.
   * @returns Whether the supplied session still owns observation presentation.
   */
  isAttached(sessionId: string): boolean {
    return this.attachment?.id === sessionId;
  }

  /**
   * Publishes one effect lease after listener attachment, layout readiness, and caller-owned gap classification; invalidation requires a new attachment.
   * @param sessionId - Current enable-lifetime identity.
   * @returns Whether this attachment received the sole dispatch lease.
   */
  publishDispatchLease(sessionId: string): boolean {
    if (
      this.attachment?.id !== sessionId ||
      !this.layoutBoundaryReady ||
      this.dispatchLeasePublished
    ) {
      return false;
    }
    this.dispatchLeaseReady = true;
    this.dispatchLeasePublished = true;
    return true;
  }

  /**
   * Invalidates the dispatch lease synchronously while retaining attachment identity for teardown.
   * @param sessionId - Current enable-lifetime identity.
   * @returns Whether this session invalidated its lease.
   */
  invalidateDispatchLease(sessionId: string): boolean {
    if (this.attachment?.id !== sessionId || !this.dispatchLeaseReady) {
      return false;
    }
    this.dispatchLeaseReady = false;
    return true;
  }

  /** @returns Whether the current epoch may begin host reconciliation or operations. */
  isLayoutReady(): boolean {
    return (
      this.attachment !== null &&
      this.layoutBoundaryReady &&
      this.dispatchLeaseReady
    );
  }

  /** @returns Current epoch only while its serialized observation lease is published. */
  readyEpoch(): number | null {
    return this.isLayoutReady() ? this.epoch : null;
  }

  /**
   * Checks whether one durable operation epoch still owns the live dispatch lease.
   * @param expectedEpoch - Epoch bound to the durable review/operation.
   * @returns Whether the same ready attachment epoch remains current.
   */
  isDispatchEpochCurrent(expectedEpoch: number): boolean {
    return this.isLayoutReady() && expectedEpoch === this.epoch;
  }

  /**
   * Checks and invokes one synchronous host-dispatch boundary without an intervening await.
   * @param expectedEpoch - Epoch bound to the durable review/operation.
   * @param dispatch - Host call whose invocation starts the effect.
   * @returns Invocation result, or a no-dispatch refusal after lease invalidation.
   */
  dispatch<Value>(
    expectedEpoch: number,
    dispatch: () => Value,
  ):
    | { readonly kind: "dispatched"; readonly value: Value }
    | { readonly kind: "not-ready" } {
    if (!this.isDispatchEpochCurrent(expectedEpoch)) {
      return { kind: "not-ready" };
    }
    return { kind: "dispatched", value: dispatch() };
  }

  /** Notifies only the current attached presentation session. */
  notify(): void {
    this.attachment?.onChanged();
  }
}
