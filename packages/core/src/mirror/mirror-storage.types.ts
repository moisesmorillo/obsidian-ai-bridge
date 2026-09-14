import type {
  CURRENT_NOTE_STATE_KIND,
  RECOVERY_SNAPSHOT_STATE_KIND,
} from "@core/mirror/mirror.constants";
import type {
  ApplicationRevision,
  ContentOperationReceipt,
  ContentSha256,
  CurrentNoteState,
  LegacyCurrentNoteState,
  LiveCurrentNoteState,
  MirrorAssociationId,
  MirrorOperationId,
  MutationEffectResult,
  RecoverySnapshotId,
  RecoverySnapshotState,
  TombstoneCurrentNoteState,
  TombstoneOperationReceipt,
} from "@core/mirror/mirror.types";
import type { NotePath } from "@core/note-path/note-path.types";

/** Exact live envelope assembled by application policy for conditional storage. */
export interface LiveCurrentGenerationCandidate {
  readonly kind: typeof CURRENT_NOTE_STATE_KIND.live;
  readonly revision: ApplicationRevision;
  readonly receipt: ContentOperationReceipt;
  readonly contentSha256: ContentSha256;
  readonly content: string;
}

/** Exact content-free tombstone assembled by application deletion policy. */
export interface TombstoneCurrentGenerationCandidate {
  readonly kind: typeof CURRENT_NOTE_STATE_KIND.tombstone;
  readonly revision: ApplicationRevision;
  readonly receipt: TombstoneOperationReceipt;
  readonly deletedRevision: ApplicationRevision;
  readonly recoveryId: RecoverySnapshotId;
}

/** Metadata returned for the exact live generation accepted by conditional storage. */
export interface StoredLiveCurrentGeneration {
  readonly state: LiveCurrentNoteState;
  /** Storage-assigned timestamp for this exact successful generation. */
  readonly uploaded: Date;
}

/** Metadata returned for the exact tombstone accepted by conditional storage. */
export interface StoredTombstoneCurrentGeneration {
  readonly state: TombstoneCurrentNoteState;
  /** Storage-assigned timestamp used as authoritative recovery-deadline provenance. */
  readonly uploaded: Date;
}

/** Opaque CAS capability bound to one exact observed current-object generation. */
export interface CurrentGenerationReplacement {
  /** Conditionally replaces the observed generation with one live candidate. */
  writeLive(
    candidate: LiveCurrentGenerationCandidate,
  ): Promise<MutationEffectResult<StoredLiveCurrentGeneration>>;

  /** Conditionally replaces the observed generation with one tombstone candidate. */
  writeTombstone(
    candidate: TombstoneCurrentGenerationCandidate,
  ): Promise<MutationEffectResult<StoredTombstoneCurrentGeneration>>;
}

/** Recognized absent current-object observation. */
export interface AbsentCurrentGenerationObservation {
  readonly kind: typeof CURRENT_NOTE_STATE_KIND.absent;
  readonly state: Extract<CurrentNoteState, { readonly kind: "absent" }>;
}

/** Recognized legacy Markdown observation retaining content only at the application seam. */
export interface LegacyCurrentGenerationObservation {
  readonly kind: typeof CURRENT_NOTE_STATE_KIND.legacy;
  readonly state: LegacyCurrentNoteState;
  readonly content: string;
}

/** Exact live observation retaining plaintext and a generation-bound CAS capability. */
export interface LiveCurrentGenerationObservation {
  readonly kind: typeof CURRENT_NOTE_STATE_KIND.live;
  readonly state: LiveCurrentNoteState;
  readonly content: string;
  readonly uploaded: Date;
  readonly replacement: CurrentGenerationReplacement;
}

/** Exact tombstone observation retaining timestamp provenance and generation-bound CAS. */
export interface TombstoneCurrentGenerationObservation {
  readonly kind: typeof CURRENT_NOTE_STATE_KIND.tombstone;
  readonly state: TombstoneCurrentNoteState;
  readonly uploaded: Date;
  readonly replacement: CurrentGenerationReplacement;
}

/** Closed storage observation used by current-generation application policy. */
export type CurrentGenerationObservation =
  | AbsentCurrentGenerationObservation
  | LegacyCurrentGenerationObservation
  | LiveCurrentGenerationObservation
  | TombstoneCurrentGenerationObservation;

/** Bounded current-object scan page before application visibility filtering. */
export interface CurrentGenerationObservationPage {
  readonly states: readonly CurrentNoteState[];
  readonly nextCursor: string | null;
}

/** Prepared recovery envelope assembled before any current-head tombstone attempt. */
export interface PreparedRecoveryGenerationCandidate {
  readonly kind: typeof RECOVERY_SNAPSHOT_STATE_KIND.prepared;
  readonly id: RecoverySnapshotId;
  readonly associationId: MirrorAssociationId;
  readonly path: NotePath;
  readonly revision: ApplicationRevision;
  readonly sourceRevision: ApplicationRevision;
  readonly contentSha256: ContentSha256;
  readonly operationId: MirrorOperationId;
  readonly content: string;
}

/** Sealed recovery envelope preserving plaintext and immutable tombstone evidence. */
export interface SealedRecoveryGenerationCandidate {
  readonly kind: typeof RECOVERY_SNAPSHOT_STATE_KIND.sealed;
  readonly id: RecoverySnapshotId;
  readonly associationId: MirrorAssociationId;
  readonly path: NotePath;
  readonly revision: ApplicationRevision;
  readonly sourceRevision: ApplicationRevision;
  readonly contentSha256: ContentSha256;
  readonly operationId: MirrorOperationId;
  readonly previousRevision: ApplicationRevision;
  readonly tombstoneRevision: ApplicationRevision;
  readonly recoverUntil: string;
  readonly content: string;
}

/** Purged recovery marker assembled without any field capable of retaining plaintext. */
export interface PurgedRecoveryGenerationCandidate {
  readonly kind: typeof RECOVERY_SNAPSHOT_STATE_KIND.purged;
  readonly id: RecoverySnapshotId;
  readonly associationId: MirrorAssociationId;
  readonly path: NotePath;
  readonly revision: ApplicationRevision;
  readonly sourceRevision: ApplicationRevision;
  readonly contentSha256: ContentSha256;
  readonly operationId: MirrorOperationId;
  readonly previousRevision: ApplicationRevision;
  readonly tombstoneRevision: ApplicationRevision;
  readonly recoverUntil: string;
}

/** Opaque recovery CAS capability bound to one exact observed storage generation. */
export interface RecoveryGenerationReplacement {
  /** Conditionally seals only this observed prepared generation. */
  seal(
    candidate: SealedRecoveryGenerationCandidate,
  ): Promise<MutationEffectResult<ObservedSealedRecoveryGeneration>>;

  /** Conditionally purges only this observed sealed generation. */
  purge(
    candidate: PurgedRecoveryGenerationCandidate,
  ): Promise<MutationEffectResult<ObservedPurgedRecoveryGeneration>>;
}

/** Prepared recovery observation retaining exact recoverable text and storage CAS. */
export interface ObservedPreparedRecoveryGeneration {
  readonly kind: typeof RECOVERY_SNAPSHOT_STATE_KIND.prepared;
  readonly state: Extract<RecoverySnapshotState, { readonly kind: "prepared" }>;
  readonly content: string;
  readonly replacement: RecoveryGenerationReplacement;
}

/** Sealed recovery observation retaining immutable proof, text, and storage CAS. */
export interface ObservedSealedRecoveryGeneration {
  readonly kind: typeof RECOVERY_SNAPSHOT_STATE_KIND.sealed;
  readonly state: Extract<RecoverySnapshotState, { readonly kind: "sealed" }>;
  readonly content: string;
  /** Exact seal operation retained for read-only idempotency evidence. */
  readonly operationId: MirrorOperationId;
  /** Prepared revision consumed by the successful seal CAS. */
  readonly previousRevision: ApplicationRevision;
  readonly tombstoneRevision: ApplicationRevision;
  readonly replacement: RecoveryGenerationReplacement;
}

/** Content-free purged observation retained to block delayed preparation replays. */
export interface ObservedPurgedRecoveryGeneration {
  readonly kind: typeof RECOVERY_SNAPSHOT_STATE_KIND.purged;
  readonly state: Extract<RecoverySnapshotState, { readonly kind: "purged" }>;
  /** Exact purge operation retained for read-only idempotency evidence. */
  readonly operationId: MirrorOperationId;
  /** Sealed revision consumed by the successful purge CAS. */
  readonly previousRevision: ApplicationRevision;
  readonly tombstoneRevision: ApplicationRevision;
  readonly replacement: RecoveryGenerationReplacement;
}

/** Closed validated recovery observation; absence is represented separately as `null`. */
export type RecoveryGenerationObservation =
  | ObservedPreparedRecoveryGeneration
  | ObservedSealedRecoveryGeneration
  | ObservedPurgedRecoveryGeneration;

/** Bounded recovery metadata page without recoverable plaintext. */
export interface RecoveryGenerationObservationPage {
  readonly states: readonly RecoverySnapshotState[];
  readonly nextCursor: string | null;
}
