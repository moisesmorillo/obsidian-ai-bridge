import type { MUTATION_EFFECT_CERTAINTY } from "@core/mirror/mirror.constants";
import type {
  ApplicationRevision,
  ConditionalMutationRequest,
  CurrentNoteState,
  MirrorAssociationId,
  MirrorWriterId,
  MutationAcknowledgement,
  NotePage,
  RecoveryPage,
  RecoveryPurgeRequest,
  RecoverySealRequest,
  RecoverySnapshotId,
  RecoverySnapshotState,
} from "@core/mirror/mirror.types";
import type { REMOTE_BRIDGE_FAILURE } from "@core/mirror/remote-bridge.constants";
import type { NotePath } from "@core/note-path/note-path.types";

/** Closed sanitized failure classification for the remote bridge capability. */
export type RemoteBridgeFailure =
  (typeof REMOTE_BRIDGE_FAILURE)[keyof typeof REMOTE_BRIDGE_FAILURE];

/** Typed result for read-only remote operations. */
export type RemoteBridgeResult<Value> =
  | { readonly kind: "success"; readonly value: Value }
  | { readonly kind: "failure"; readonly failure: RemoteBridgeFailure };

/** Conditional mutation result retaining certainty both before dispatch and after possible remote effects. */
export type RemoteBridgeMutationResult<Value> =
  | {
      readonly kind: typeof MUTATION_EFFECT_CERTAINTY.confirmed;
      readonly confirmed: Value;
    }
  | {
      readonly kind: "failure";
      readonly failure: RemoteBridgeFailure;
      readonly effect:
        | typeof MUTATION_EFFECT_CERTAINTY.notDispatched
        | typeof MUTATION_EFFECT_CERTAINTY.definitelyRefused
        | typeof MUTATION_EFFECT_CERTAINTY.unknown;
    };

/** Authenticated Worker capabilities needed before automatic mirror activation. */
export interface RemoteBridgeDescription {
  readonly protocol: "obsidian-ai-bridge-mirror-v2";
  readonly associationId: MirrorAssociationId;
  readonly writerId: MirrorWriterId;
  readonly maxNoteSizeBytes: number;
  readonly maxPageSize: number;
  readonly recoveryRetentionSeconds: number;
}

/** Normal note-content read without turning a 404 into tombstone authority. */
export type RemoteNoteContent =
  | { readonly kind: "missing" }
  | { readonly kind: "legacy"; readonly content: string }
  | {
      readonly kind: "live";
      readonly revision: ApplicationRevision;
      readonly content: string;
    };

/** Recovery-content read result that preserves server expiry and purge withholding. */
export type RemoteRecoveryContent =
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "recoverable"; readonly content: string };

/** One globally coordinated request permit; release follows adapter settlement. */
export interface RemoteRequestPermit {
  /**
   * Rechecks the exact synchronous admission generation immediately before dispatch.
   * @returns Whether the permit still belongs to an open request lease.
   */
  isCurrent(): boolean;
  /** Releases the permit exactly once after the adapter stops owning the request. */
  release(): void;
}

/**
 * Narrow admission seam owned by the same-realm runtime coordinator.
 *
 * Transport never creates a private request pool; it asks this capability before
 * every network attempt and releases the returned permit when its bounded work
 * settles.
 */
export interface RemoteRequestAdmission {
  /** @returns A permit, or `undefined` when dispatch is currently disallowed. */
  admit(): Promise<RemoteRequestPermit | undefined>;
}

/** Platform-independent remote capability implemented by the plugin Fetch adapter. */
export interface RemoteBridge {
  /** Reads authenticated capabilities/designation without activating the caller. */
  describe(): Promise<RemoteBridgeResult<RemoteBridgeDescription>>;
  /** Reads one bounded reporting page with an opaque cursor; inventory absence grants no deletion authority. */
  listNotes(cursor?: string): Promise<RemoteBridgeResult<NotePage>>;
  /** Reads content while distinguishing legacy from revisioned live bytes; missing is not a tombstone. */
  readNote(path: NotePath): Promise<RemoteBridgeResult<RemoteNoteContent>>;
  /** Reads exact current generation/receipt metadata, including retained tombstones, without advancing a baseline. */
  inspectNote(path: NotePath): Promise<RemoteBridgeResult<CurrentNoteState>>;
  /** Attempts one original conditional request; failure certainty must not treat cancellation as rollback. */
  mutateNote(
    request: ConditionalMutationRequest,
  ): Promise<RemoteBridgeMutationResult<MutationAcknowledgement>>;
  /** Reads one bounded metadata page without recovering content or changing retention. */
  listRecovery(cursor?: string): Promise<RemoteBridgeResult<RecoveryPage>>;
  /** Reads recovery metadata; successful null means missing, distinct from unavailable transport. */
  inspectRecovery(
    id: RecoverySnapshotId,
  ): Promise<RemoteBridgeResult<RecoverySnapshotState | null>>;
  /** Reads prepared/unexpired content or explicit missing/unavailable status; never restores a local note. */
  readRecoveryContent(
    id: RecoverySnapshotId,
  ): Promise<RemoteBridgeResult<RemoteRecoveryContent>>;
  /** Requests exact-revision retention sealing; the remote service verifies the matching current tombstone. */
  sealRecovery(
    request: RecoverySealRequest,
  ): Promise<RemoteBridgeMutationResult<RecoverySnapshotState>>;
  /** Requests conditional expiry purge to a retained marker, not native storage deletion. */
  purgeRecovery(
    request: RecoveryPurgeRequest,
  ): Promise<RemoteBridgeMutationResult<RecoverySnapshotState>>;
}
