import type {
  ContentSha256,
  MirrorOperationId,
} from "@core/mirror/mirror.types";
import type { MIRROR_SYNCHRONIZER_PHASE } from "@core/mirror/mirror-autosync.constants";
import type { MirrorInventoryResult } from "@core/mirror/mirror-inventory";
import type { RemoteBridgeFailure } from "@core/mirror/remote-bridge.types";
import type { NotePath } from "@core/note-path/note-path.types";

/** Closed core runtime phase; it grants no durable writer activation by itself. */
export type MirrorSynchronizerPhase =
  (typeof MIRROR_SYNCHRONIZER_PHASE)[keyof typeof MIRROR_SYNCHRONIZER_PHASE];

/** Deterministic time and cryptographic seams required by core autosynchronization. */
export interface MirrorSynchronizerRuntime {
  /** @returns Monotonic scheduler time in milliseconds. */
  nowMilliseconds(): number;
  /** @returns SHA-256 of the exact UTF-8 text passed to a mutation. */
  hashContent(content: string): Promise<ContentSha256>;
  /** @returns Fresh UUID-v4 operation identity for a new durable intent. */
  createOperationId(): MirrorOperationId;
}

/** Bootstrap completion never implies destructive authority for scan absence. */
export type MirrorBootstrapResult =
  | {
      readonly kind: "complete";
      readonly eligiblePaths: readonly NotePath[];
      readonly inventory: MirrorInventoryResult;
      readonly unassociatedRemotePaths: readonly NotePath[];
    }
  | {
      readonly kind: "inactive";
      readonly eligiblePaths: readonly NotePath[];
      readonly inventory: MirrorInventoryResult | null;
    }
  | {
      readonly kind: "local-incomplete";
      readonly eligiblePaths: readonly NotePath[];
      readonly inventory: MirrorInventoryResult;
    };

/** One sanitized runtime outcome retained for status reporting without note text. */
export type MirrorPathJobOutcome =
  | { readonly kind: "acknowledged"; readonly path: NotePath }
  | { readonly kind: "unchanged"; readonly path: NotePath }
  | { readonly kind: "stale-read"; readonly path: NotePath }
  | { readonly kind: "local-unavailable"; readonly path: NotePath }
  | { readonly kind: "diverged"; readonly path: NotePath }
  | { readonly kind: "retry-wait"; readonly path: NotePath }
  | { readonly kind: "blocked"; readonly path: NotePath }
  | {
      readonly kind: "remote-failure";
      readonly path: NotePath;
      readonly failure: RemoteBridgeFailure;
    };
