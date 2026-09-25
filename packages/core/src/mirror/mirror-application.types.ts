import type {
  CURRENT_CONTENT_RESULT_KIND,
  MUTATION_EFFECT_CERTAINTY,
  RECOVERY_CONTENT_RESULT_KIND,
  RECOVERY_MAINTENANCE_RESULT_KIND,
  TOMBSTONE_WORKFLOW_STAGE_KIND,
} from "@core/mirror/mirror.constants";
import type {
  ApplicationRevision,
  ConditionalMutationPrecondition,
  ContentOperationReceipt,
  ContentSha256,
  CurrentNoteState,
  MirrorAssociationId,
  MirrorOperationId,
  MirrorWriterId,
  MutationAcknowledgement,
  MutationEffectCertainty,
  MutationEffectResult,
  RecoveryMutationResult,
  RecoverySnapshotState,
} from "@core/mirror/mirror.types";
import type {
  ObservedPreparedRecoveryGeneration,
  StoredTombstoneCurrentGeneration,
} from "@core/mirror/mirror-storage.types";
import type { NotePath } from "@core/note-path/note-path.types";

/** Deterministic cryptographic dependencies used to assemble persisted generations. */
export interface MirrorGenerationCryptography {
  /** Computes SHA-256 from the exact UTF-8 representation without normalization. */
  digest(content: string): Promise<ContentSha256>;

  /** Generates a fresh UUID-v4 application revision for one candidate generation. */
  generateRevision(): ApplicationRevision;
}

/** Narrow time source used only for recovery-deadline decisions. */
export interface MirrorClock {
  /** @returns The current instant used to withhold or purge expired recovery content. */
  now(): Date;
}

/** Exact prepared-generation proof required before a tombstone can be attempted. */
export type RecoveryPreparationProofResult =
  MutationEffectResult<ObservedPreparedRecoveryGeneration>;

/** Inputs needed to seal directly from one confirmed tombstone generation. */
export interface ConfirmedTombstoneSealRequest {
  readonly preparation: ObservedPreparedRecoveryGeneration;
  readonly tombstone: StoredTombstoneCurrentGeneration;
  readonly writerId: MirrorWriterId;
  readonly operationId: MirrorOperationId;
}

/** Result of a deletion after its current-head CAS has been confirmed. */
export interface ConfirmedTombstoneTransition {
  /** Exact acknowledgement from the successful current-generation PUT. */
  readonly acknowledgement: MutationAcknowledgement;
  /** Proven recovery generation retained for a later seal retry when needed. */
  readonly recovery: RecoverySnapshotState;
  /** Independent sealing effect; non-confirmation never rolls back the tombstone. */
  readonly sealing: RecoveryMutationResult;
}

/**
 * Recoverable tombstone result preserving both effect certainty and the workflow
 * stage to which that certainty applies.
 *
 * An unknown recovery-preparation result proves that the current-head mutation
 * was not attempted. Only an unknown tombstone-stage result leaves the current-head
 * effect uncertain.
 */
export type TombstoneMutationResult =
  | {
      readonly kind:
        | typeof MUTATION_EFFECT_CERTAINTY.notDispatched
        | typeof MUTATION_EFFECT_CERTAINTY.definitelyRefused;
      readonly stage: typeof TOMBSTONE_WORKFLOW_STAGE_KIND.current;
    }
  | {
      readonly kind: Exclude<
        MutationEffectCertainty,
        typeof MUTATION_EFFECT_CERTAINTY.confirmed
      >;
      readonly stage: typeof TOMBSTONE_WORKFLOW_STAGE_KIND.recoveryPreparation;
    }
  | {
      readonly kind: Exclude<
        MutationEffectCertainty,
        typeof MUTATION_EFFECT_CERTAINTY.confirmed
      >;
      readonly stage: typeof TOMBSTONE_WORKFLOW_STAGE_KIND.tombstone;
    }
  | {
      readonly kind: typeof MUTATION_EFFECT_CERTAINTY.confirmed;
      readonly stage: typeof TOMBSTONE_WORKFLOW_STAGE_KIND.complete;
      readonly confirmed: ConfirmedTombstoneTransition;
    };

/** One-read current content result that never leaks a tombstone body or CAS capability. */
export type CurrentContentResult =
  | {
      readonly kind: typeof CURRENT_CONTENT_RESULT_KIND.absent;
      readonly state: Extract<CurrentNoteState, { readonly kind: "absent" }>;
    }
  | {
      readonly kind: typeof CURRENT_CONTENT_RESULT_KIND.legacy;
      readonly state: Extract<CurrentNoteState, { readonly kind: "legacy" }>;
      readonly content: string;
    }
  | {
      readonly kind: typeof CURRENT_CONTENT_RESULT_KIND.live;
      readonly state: Extract<CurrentNoteState, { readonly kind: "live" }>;
      readonly content: string;
    }
  | {
      readonly kind: typeof CURRENT_CONTENT_RESULT_KIND.tombstone;
      readonly state: Extract<CurrentNoteState, { readonly kind: "tombstone" }>;
    };

/** Recovery retrieval states that never expose sealed content at or after expiry. */
export type RecoveryContentResult =
  | { readonly kind: typeof RECOVERY_CONTENT_RESULT_KIND.missing }
  | {
      readonly kind: typeof RECOVERY_CONTENT_RESULT_KIND.recoverable;
      readonly state: Exclude<
        RecoverySnapshotState,
        { readonly kind: "purged" }
      >;
      readonly content: string;
    }
  | {
      readonly kind: typeof RECOVERY_CONTENT_RESULT_KIND.expired;
      readonly state: Extract<
        RecoverySnapshotState,
        { readonly kind: "sealed" }
      >;
    }
  | {
      readonly kind: typeof RECOVERY_CONTENT_RESULT_KIND.purged;
      readonly state: Extract<
        RecoverySnapshotState,
        { readonly kind: "purged" }
      >;
    };

/** Detailed recovery-maintenance outcome used to preserve HTTP 404/409/412 semantics. */
export type RecoveryMaintenanceResult =
  | { readonly kind: typeof RECOVERY_MAINTENANCE_RESULT_KIND.missing }
  | {
      readonly kind: typeof RECOVERY_MAINTENANCE_RESULT_KIND.preconditionFailed;
    }
  | { readonly kind: typeof RECOVERY_MAINTENANCE_RESULT_KIND.conflict }
  | { readonly kind: typeof RECOVERY_MAINTENANCE_RESULT_KIND.notDispatched }
  | {
      readonly kind: typeof RECOVERY_MAINTENANCE_RESULT_KIND.confirmed;
      readonly confirmed: RecoverySnapshotState;
    }
  | { readonly kind: typeof RECOVERY_MAINTENANCE_RESULT_KIND.unknown };

/** Application write request whose action is selected from one explicit precondition.
 *
 * The adapter cannot select create, update, or recreation directly; the service derives
 * the permitted transition from observed state and retains exact storage CAS authority.
 */
export interface ConditionalContentWriteRequest {
  /** Configured remote association whose ownership must match existing generations. */
  readonly associationId: MirrorAssociationId;
  /** Configured writer identity; it is never accepted from the transport caller. */
  readonly writerId: MirrorWriterId;
  /** Caller-owned identity retained in the persisted operation receipt. */
  readonly operationId: MirrorOperationId;
  /** Literal validated vault-relative Markdown path. */
  readonly path: NotePath;
  /** Absence-only creation or exact-revision update/recreation requirement. */
  readonly precondition: ConditionalMutationPrecondition;
  /** Exact UTF-8 Markdown text, bounded by the application service. */
  readonly content: string;
}

/** Exact acknowledgment for a confirmed current-content write, excluding tombstone receipts. */
export interface ContentMutationAcknowledgement {
  /** Literal vault-relative path whose current generation was confirmed. */
  readonly path: NotePath;
  /** Application revision returned by the exact confirmed content PUT. */
  readonly revision: ApplicationRevision;
  /** Receipt whose action is create, update, or recreate, never tombstone. */
  readonly receipt: ContentOperationReceipt;
}

/** Public certainty result for one conditional current-content write. */
export type CurrentContentMutationResult =
  MutationEffectResult<ContentMutationAcknowledgement>;
