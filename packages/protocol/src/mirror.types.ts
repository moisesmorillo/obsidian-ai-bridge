import type {
  applicationEtagSchema,
  applicationRevisionSchema,
  conditionalMutationPreconditionSchema,
  conditionalMutationRequestSchema,
  contentSha256Schema,
  currentNoteStateSchema,
  mirrorAssociationIdSchema,
  mirrorCursorSchema,
  mirrorDescriptionSchema,
  mirrorOperationIdSchema,
  mirrorWriterIdSchema,
  mutationAcknowledgementSchema,
  mutationResultSchema,
  notePageSchema,
  notePathSchema,
  operationReceiptSchema,
  recoveryPageSchema,
  recoverySnapshotIdSchema,
  recoverySnapshotStateSchema,
  tombstoneMutationResponseSchema,
  unresolvedMutationIntentSchema,
} from "@protocol/mirror.schemas";
import type { z } from "zod";

/** Wire representation of a validated M3 mirror association identity. */
export type MirrorAssociationIdDto = z.infer<typeof mirrorAssociationIdSchema>;

/** Wire representation of a validated M3 designated writer identity. */
export type MirrorWriterIdDto = z.infer<typeof mirrorWriterIdSchema>;

/** Wire representation of a validated M3 operation identity. */
export type MirrorOperationIdDto = z.infer<typeof mirrorOperationIdSchema>;

/** Wire representation of a fresh M3 application revision. */
export type ApplicationRevisionDto = z.infer<typeof applicationRevisionSchema>;

/** Wire representation of a strong M3 application ETag. */
export type ApplicationEtagDto = z.infer<typeof applicationEtagSchema>;

/** Wire representation of a canonical SHA-256 content digest. */
export type ContentSha256Dto = z.infer<typeof contentSha256Schema>;

/** Wire representation of one canonical M3 NotePath. */
export type NotePathDto = z.infer<typeof notePathSchema>;

/** Wire representation of a bounded opaque page cursor. */
export type MirrorCursorDto = z.infer<typeof mirrorCursorSchema>;

/** Wire representation of the authenticated Worker mirror capability description. */
export type MirrorDescriptionDto = z.infer<typeof mirrorDescriptionSchema>;

/** Wire representation of a closed conditional mutation requirement. */
export type ConditionalMutationPreconditionDto = z.infer<
  typeof conditionalMutationPreconditionSchema
>;

/** Wire representation of a conditional mutation's identity/precondition metadata. */
export type ConditionalMutationRequestDto = z.infer<
  typeof conditionalMutationRequestSchema
>;

/** Wire representation of exact operation evidence retained by an M3 generation. */
export type OperationReceiptDto = z.infer<typeof operationReceiptSchema>;

/** Wire representation of a current-generation mutation acknowledgment. */
export type MutationAcknowledgementDto = z.infer<
  typeof mutationAcknowledgementSchema
>;

/** Wire representation of a closed M3 current-note state observation. */
export type CurrentNoteStateDto = z.infer<typeof currentNoteStateSchema>;

/** Wire representation of a validated recovery snapshot identity. */
export type RecoverySnapshotIdDto = z.infer<typeof recoverySnapshotIdSchema>;

/** Wire representation of a closed recovery lifecycle state. */
export type RecoverySnapshotStateDto = z.infer<
  typeof recoverySnapshotStateSchema
>;

/** Wire representation of a bounded M3 note inventory page. */
export type NotePageDto = z.infer<typeof notePageSchema>;

/** Wire representation of a bounded M3 recovery metadata page. */
export type RecoveryPageDto = z.infer<typeof recoveryPageSchema>;

/** Wire representation of a content-free unresolved per-path M3 intent. */
export type UnresolvedMutationIntentDto = z.infer<
  typeof unresolvedMutationIntentSchema
>;

/** Wire representation of a confirmed recoverable tombstone transition. */
export type TombstoneMutationResponseDto = z.infer<
  typeof tombstoneMutationResponseSchema
>;

/** Wire representation of closed mutation effect certainty. */
export type MutationResultDto = z.infer<typeof mutationResultSchema>;
