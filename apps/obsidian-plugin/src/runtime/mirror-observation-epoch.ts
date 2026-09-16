/** Session notifications are presentation mechanics and never become runtime policy. */
export interface MirrorRuntimeSessionAttachment {
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
  private attachment: MirrorRuntimeSessionAttachment | null = null;
  private epoch = 0;
  private layoutReady = false;

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
      this.layoutReady = false;
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
    this.attachment = null;
    this.layoutReady = false;
    return true;
  }

  /**
   * Accepts at most one layout-ready callback for the current attachment epoch.
   * @param sessionId - Enable-lifetime identity receiving layout readiness.
   * @returns Ready epoch, duplicate callback, or stale-session classification.
   */
  markLayoutReady(sessionId: string): MirrorLayoutReadyResult {
    if (this.attachment?.id !== sessionId) return { kind: "stale" };
    if (this.layoutReady) return { kind: "duplicate" };
    this.layoutReady = true;
    return { kind: "ready", epoch: this.epoch };
  }

  /**
   * @param sessionId - Enable-lifetime identity to compare.
   * @returns Whether the supplied session still owns observation presentation.
   */
  isAttached(sessionId: string): boolean {
    return this.attachment?.id === sessionId;
  }

  /** @returns Whether the current epoch may begin host reconciliation or operations. */
  isLayoutReady(): boolean {
    return this.attachment !== null && this.layoutReady;
  }

  /** @returns Current epoch only while attached and layout-ready. */
  readyEpoch(): number | null {
    return this.isLayoutReady() ? this.epoch : null;
  }

  /** Notifies only the current attached presentation session. */
  notify(): void {
    this.attachment?.onChanged();
  }
}
