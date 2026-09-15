import type {
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  CURRENT_NOTE_STATE_KIND,
  MUTATION_ACTION,
  MUTATION_EFFECT_CERTAINTY,
  RECOVERY_SNAPSHOT_STATE_KIND,
} from "@core/mirror/mirror.constants";
import type { NotePath } from "@core/note-path/note-path.types";

/** Opaque UUID-v4 identity for one configured remote mirror association. */
export type MirrorAssociationId = string & {
  readonly __brand: "MirrorAssociationId";
};

/** Opaque UUID-v4 identity for the one designated cooperating mirror writer. */
export type MirrorWriterId = string & { readonly __brand: "MirrorWriterId" };

/** Opaque UUID-v4 identity reused only for exact retries of one mutation. */
export type MirrorOperationId = string & {
  readonly __brand: "MirrorOperationId";
};

/** Fresh server UUID-v4 identity for one application current generation. */
export type ApplicationRevision = string & {
  readonly __brand: "ApplicationRevision";
};

/**
 * Recovery snapshot identity derived from its deletion operation identity.
 *
 * The same UUID is retained so delayed preparation cannot create a different
 * snapshot for a tombstone operation.
 */
export type RecoverySnapshotId = MirrorOperationId;

/** Canonical lowercase hexadecimal SHA-256 of exact UTF-8 note content. */
export type ContentSha256 = string & { readonly __brand: "ContentSha256" };

/** Strong application ETag derived only from an M3 application revision. */
export type ApplicationEtag = string & { readonly __brand: "ApplicationEtag" };

/** One of the current-generation mutations authorized by the M3 protocol. */
export type MutationAction =
  (typeof MUTATION_ACTION)[keyof typeof MUTATION_ACTION];

/** Content-bearing mutation actions whose receipts carry a SHA-256 digest. */
export type ContentMutationAction = Exclude<
  MutationAction,
  typeof MUTATION_ACTION.tombstone
>;

/** Create-only requirement; it never authorizes overwriting an existing generation. */
export interface AbsentPrecondition {
  readonly kind: typeof CONDITIONAL_MUTATION_PRECONDITION_KIND.absent;
}

/** Exact application-revision requirement for an established current generation. */
export interface MatchingRevisionPrecondition {
  readonly kind: typeof CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision;
  readonly revision: ApplicationRevision;
}

/** Closed conditional requirement for every M3 current-generation mutation. */
export type ConditionalMutationPrecondition =
  | AbsentPrecondition
  | MatchingRevisionPrecondition;

/** Exact receipt retained in a live current generation after an absent create. */
export interface CreateOperationReceipt {
  readonly action: typeof MUTATION_ACTION.create;
  readonly associationId: MirrorAssociationId;
  readonly operationId: MirrorOperationId;
  readonly precondition: AbsentPrecondition;
  readonly contentSha256: ContentSha256;
}

/** Exact receipt retained after a matching-revision content mutation. */
export interface UpdateOperationReceipt {
  readonly action:
    | typeof MUTATION_ACTION.update
    | typeof MUTATION_ACTION.recreate;
  readonly associationId: MirrorAssociationId;
  readonly operationId: MirrorOperationId;
  readonly precondition: MatchingRevisionPrecondition;
  readonly contentSha256: ContentSha256;
}

/** Exact receipt retained after recoverably tombstoning a live generation. */
export interface TombstoneOperationReceipt {
  readonly action: typeof MUTATION_ACTION.tombstone;
  readonly associationId: MirrorAssociationId;
  readonly operationId: MirrorOperationId;
  readonly precondition: MatchingRevisionPrecondition;
}

/** Receipt for a live content generation, never a tombstone transition. */
export type ContentOperationReceipt =
  | CreateOperationReceipt
  | UpdateOperationReceipt;

/** Closed receipt form used as exact evidence of an M3 operation. */
export type OperationReceipt =
  | ContentOperationReceipt
  | TombstoneOperationReceipt;

/** Metadata acknowledgment for the exact current generation stored by a mutation. */
export interface MutationAcknowledgement {
  readonly path: NotePath;
  readonly revision: ApplicationRevision;
  readonly receipt: OperationReceipt;
}

/** Recognized absence of a current object; it is not mutation authorization. */
export interface AbsentCurrentNoteState {
  readonly kind: typeof CURRENT_NOTE_STATE_KIND.absent;
  readonly path: NotePath;
}

/** Untagged M1 raw Markdown; it must never be silently adopted as an M3 generation. */
export interface LegacyCurrentNoteState {
  readonly kind: typeof CURRENT_NOTE_STATE_KIND.legacy;
  readonly path: NotePath;
}

/** Current live metadata without note content. */
export interface LiveCurrentNoteState {
  readonly kind: typeof CURRENT_NOTE_STATE_KIND.live;
  readonly path: NotePath;
  readonly revision: ApplicationRevision;
  readonly contentSha256: ContentSha256;
  readonly receipt: ContentOperationReceipt;
}

/** Current permanent tombstone metadata without recovery content. */
export interface TombstoneCurrentNoteState {
  readonly kind: typeof CURRENT_NOTE_STATE_KIND.tombstone;
  readonly path: NotePath;
  readonly revision: ApplicationRevision;
  readonly deletedRevision: ApplicationRevision;
  /** The tombstone receipt's exact deletion operation identity. */
  readonly recoveryId: RecoverySnapshotId;
  readonly receipt: TombstoneOperationReceipt;
}

/** Closed remote observation of a path's recognized current state. */
export type CurrentNoteState =
  | AbsentCurrentNoteState
  | LegacyCurrentNoteState
  | LiveCurrentNoteState
  | TombstoneCurrentNoteState;

/** Current state that has an application generation and supports exact receipt evidence. */
export type CurrentGenerationState =
  | LiveCurrentNoteState
  | TombstoneCurrentNoteState;

/** Recovery material prepared before a tombstone; it intentionally has no expiry. */
export interface PreparedRecoverySnapshotState {
  readonly kind: typeof RECOVERY_SNAPSHOT_STATE_KIND.prepared;
  readonly id: RecoverySnapshotId;
  readonly associationId: MirrorAssociationId;
  readonly path: NotePath;
  readonly revision: ApplicationRevision;
  readonly sourceRevision: ApplicationRevision;
  readonly contentSha256: ContentSha256;
}

/** Recovery material sealed to the tombstone-derived retention deadline. */
export interface SealedRecoverySnapshotState
  extends Omit<PreparedRecoverySnapshotState, "kind"> {
  readonly kind: typeof RECOVERY_SNAPSHOT_STATE_KIND.sealed;
  /** RFC 3339 instant calculated from the uploaded tombstone generation. */
  readonly recoverUntil: string;
}

/** Content-free retained recovery marker after conditional expiry purge. */
export interface PurgedRecoverySnapshotState
  extends Omit<PreparedRecoverySnapshotState, "kind"> {
  readonly kind: typeof RECOVERY_SNAPSHOT_STATE_KIND.purged;
  /** Original sealed retention deadline; a purge never extends it. */
  readonly recoverUntil: string;
}

/** Closed recovery state; unsealed material must not be treated as expired or purged. */
export type RecoverySnapshotState =
  | PreparedRecoverySnapshotState
  | SealedRecoverySnapshotState
  | PurgedRecoverySnapshotState;

/** Persistable original content mutation without retaining its plaintext body. */
export interface UnresolvedCreateMutationIntent {
  readonly action: typeof MUTATION_ACTION.create;
  readonly associationId: MirrorAssociationId;
  readonly writerId: MirrorWriterId;
  readonly operationId: MirrorOperationId;
  readonly path: NotePath;
  readonly precondition: AbsentPrecondition;
  readonly contentSha256: ContentSha256;
  readonly mutationAttempts: number;
  readonly evidenceAttempts: number;
}

/** Persistable matching-revision content mutation without retaining its plaintext body. */
export interface UnresolvedUpdateMutationIntent {
  readonly action:
    | typeof MUTATION_ACTION.update
    | typeof MUTATION_ACTION.recreate;
  readonly associationId: MirrorAssociationId;
  readonly writerId: MirrorWriterId;
  readonly operationId: MirrorOperationId;
  readonly path: NotePath;
  readonly precondition: MatchingRevisionPrecondition;
  readonly contentSha256: ContentSha256;
  readonly mutationAttempts: number;
  readonly evidenceAttempts: number;
}

/** Persistable matching-revision tombstone intent; it never carries note content or a digest. */
export interface UnresolvedTombstoneMutationIntent {
  readonly action: typeof MUTATION_ACTION.tombstone;
  readonly associationId: MirrorAssociationId;
  readonly writerId: MirrorWriterId;
  readonly operationId: MirrorOperationId;
  readonly path: NotePath;
  readonly precondition: MatchingRevisionPrecondition;
  readonly mutationAttempts: number;
  readonly evidenceAttempts: number;
}

/** Content-bearing unresolved intent supported by positive autosynchronization. */
export type UnresolvedContentMutationIntent =
  | UnresolvedCreateMutationIntent
  | UnresolvedUpdateMutationIntent;

/** Closed per-path unresolved intent retained for exact evidence or safe retries. */
export type UnresolvedMutationIntent =
  | UnresolvedContentMutationIntent
  | UnresolvedTombstoneMutationIntent;

/** Effect certainty after a local mutation attempt, independent of UI/session lifetime. */
export type MutationEffectCertainty =
  (typeof MUTATION_EFFECT_CERTAINTY)[keyof typeof MUTATION_EFFECT_CERTAINTY];

/** Generic closed mutation result; only confirmation carries trusted resulting data. */
export type MutationEffectResult<Confirmed> =
  | { readonly kind: typeof MUTATION_EFFECT_CERTAINTY.notDispatched }
  | { readonly kind: typeof MUTATION_EFFECT_CERTAINTY.definitelyRefused }
  | {
      readonly kind: typeof MUTATION_EFFECT_CERTAINTY.confirmed;
      readonly confirmed: Confirmed;
    }
  | { readonly kind: typeof MUTATION_EFFECT_CERTAINTY.unknown };

/** Result of a current-note mutation; unknown effects must be resolved through exact evidence. */
export type ConditionalMutationResult =
  MutationEffectResult<MutationAcknowledgement>;

/** Content mutation request; the service computes/validates the receipt hash from content. */
export interface ConditionalCreateRequest {
  readonly action: typeof MUTATION_ACTION.create;
  readonly associationId: MirrorAssociationId;
  readonly writerId: MirrorWriterId;
  readonly operationId: MirrorOperationId;
  readonly path: NotePath;
  readonly precondition: AbsentPrecondition;
  readonly content: string;
}

/** Matching-revision content mutation request for an existing live generation. */
export interface ConditionalUpdateRequest {
  readonly action: typeof MUTATION_ACTION.update;
  readonly associationId: MirrorAssociationId;
  readonly writerId: MirrorWriterId;
  readonly operationId: MirrorOperationId;
  readonly path: NotePath;
  readonly precondition: MatchingRevisionPrecondition;
  readonly content: string;
}

/** Matching-revision content mutation request for an existing tombstone generation. */
export interface ConditionalRecreateRequest
  extends Omit<ConditionalUpdateRequest, "action"> {
  readonly action: typeof MUTATION_ACTION.recreate;
}

/** Matching-revision recoverable deletion request with no local body copy. */
export interface ConditionalTombstoneRequest {
  readonly action: typeof MUTATION_ACTION.tombstone;
  readonly associationId: MirrorAssociationId;
  readonly writerId: MirrorWriterId;
  readonly operationId: MirrorOperationId;
  readonly path: NotePath;
  readonly precondition: MatchingRevisionPrecondition;
}

/** Closed current-note mutation request; no replace-any mutation is representable. */
export type ConditionalMutationRequest =
  | ConditionalCreateRequest
  | ConditionalUpdateRequest
  | ConditionalRecreateRequest
  | ConditionalTombstoneRequest;

/** Request to prepare immutable recovery material before tombstoning its source generation. */
export interface RecoveryPreparationRequest {
  readonly id: RecoverySnapshotId;
  readonly associationId: MirrorAssociationId;
  readonly operationId: MirrorOperationId;
  readonly path: NotePath;
  readonly sourceRevision: ApplicationRevision;
  readonly contentSha256: ContentSha256;
  /** Transient exact source text; callers must not persist it in an intent ledger. */
  readonly content: string;
}

/** Application request to seal a prepared snapshot from proven current tombstone evidence. */
export interface RecoverySealRequest {
  readonly id: RecoverySnapshotId;
  readonly associationId: MirrorAssociationId;
  readonly writerId: MirrorWriterId;
  readonly operationId: MirrorOperationId;
  readonly expectedRevision: ApplicationRevision;
}

/** Conditional request to replace expired sealed recovery content with a retained marker. */
export interface RecoveryPurgeRequest {
  readonly id: RecoverySnapshotId;
  readonly associationId: MirrorAssociationId;
  readonly writerId: MirrorWriterId;
  readonly operationId: MirrorOperationId;
  readonly expectedRevision: ApplicationRevision;
}

/** Result of a recovery mutation; confirmation carries only validated metadata state. */
export type RecoveryMutationResult =
  MutationEffectResult<RecoverySnapshotState>;

/** One bounded page of live/legacy note paths; `nextCursor` is opaque to core policy. */
export interface NotePage {
  readonly notes: readonly NotePath[];
  readonly nextCursor: string | null;
}

/** One bounded page of recovery metadata; it never embeds recovery note content. */
export interface RecoveryPage {
  readonly recoveries: readonly RecoverySnapshotState[];
  readonly nextCursor: string | null;
}
