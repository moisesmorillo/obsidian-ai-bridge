import type {
  MirrorBootstrapProgressObserver,
  MirrorBootstrapResult,
} from "@obsidian-ai-bridge/core";

/** Narrow core reconciliation capability consumed by host lifecycle policy. */
export interface MirrorReconciliationSynchronizer {
  /** Starts or joins one core bootstrap and reports positive admission progress. */
  bootstrap(
    observer?: MirrorBootstrapProgressObserver,
  ): Promise<MirrorBootstrapResult>;
}

/** Identity of one host connection generation without exposing its adapter objects. */
export interface MirrorReconciliationIdentity {
  readonly attachmentEpoch: number;
  readonly configurationGeneration: number;
  readonly connectionId: number;
}

/** One host reconciliation request and its lifecycle-safe progress hooks. */
export interface MirrorReconciliationRequest
  extends MirrorReconciliationIdentity {
  readonly synchronizer: MirrorReconciliationSynchronizer;
  readonly force: boolean;
  readonly isCurrent: () => boolean;
  readonly onPositiveAdmission: () => void;
  readonly onSettled: () => void;
}

/** Sanitized result of host-side reconciliation orchestration. */
export type MirrorReconciliationResult =
  | { readonly kind: "complete" }
  | { readonly kind: "incomplete" }
  | { readonly kind: "stale" };

interface ActiveReconciliation extends MirrorReconciliationIdentity {
  readonly completion: Promise<MirrorReconciliationResult>;
}

/**
 * Owns the relationship between observation epochs and core bootstrap operations.
 *
 * Core may retain a bootstrap and scheduler across plugin replacement. This owner
 * waits for inherited work, then guarantees one fresh non-destructive scan for the
 * newly attached listener epoch. Positive-admission progress is forwarded before
 * reporting inventory settles, but only while the request identity remains current.
 */
export class MirrorReconciliationCoordinator {
  private active: ActiveReconciliation | null = null;
  private completed: MirrorReconciliationIdentity | null = null;

  /**
   * Reconciles one current observation/configuration/connection identity.
   * @param request - Current identity, synchronizer and lifecycle-safe callbacks.
   * @returns Completion classification for that exact identity.
   */
  async reconcile(
    request: MirrorReconciliationRequest,
  ): Promise<MirrorReconciliationResult> {
    const active = this.active;
    if (active !== null) {
      if (sameIdentity(active, request)) return active.completion;
      await active.completion;
      if (!request.isCurrent()) return { kind: "stale" };
      return this.reconcile(request);
    }
    if (!request.isCurrent()) return { kind: "stale" };
    if (
      !request.force &&
      this.completed !== null &&
      sameIdentity(this.completed, request)
    ) {
      return { kind: "complete" };
    }
    const completion = this.run(request);
    this.active = { ...identityOf(request), completion };
    return completion;
  }

  /** Invalidates completed reconciliation when a connection is retired or recovered. */
  invalidate(): void {
    this.completed = null;
  }

  private async run(
    request: MirrorReconciliationRequest,
  ): Promise<MirrorReconciliationResult> {
    try {
      const result = await request.synchronizer.bootstrap({
        onPositiveAdmission: () => {
          if (!request.isCurrent()) return;
          request.onPositiveAdmission();
        },
      });
      if (!request.isCurrent()) return { kind: "stale" };
      if (result.kind !== "complete") return { kind: "incomplete" };
      this.completed = identityOf(request);
      return { kind: "complete" };
    } finally {
      if (this.active?.completion !== undefined) {
        this.active = null;
      }
      if (request.isCurrent()) request.onSettled();
    }
  }
}

function identityOf(
  value: MirrorReconciliationIdentity,
): MirrorReconciliationIdentity {
  return {
    attachmentEpoch: value.attachmentEpoch,
    configurationGeneration: value.configurationGeneration,
    connectionId: value.connectionId,
  };
}

function sameIdentity(
  left: MirrorReconciliationIdentity,
  right: MirrorReconciliationIdentity,
): boolean {
  return (
    left.attachmentEpoch === right.attachmentEpoch &&
    left.configurationGeneration === right.configurationGeneration &&
    left.connectionId === right.connectionId
  );
}
