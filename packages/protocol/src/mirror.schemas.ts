import {
  isApplicationEtag,
  isContentSha256,
  isNormalizedNotePath,
  isUuidV4,
  MAX_MIRROR_CURSOR_LENGTH,
  MAX_MIRROR_PAGE_SIZE,
  MAX_MUTATION_ATTEMPTS,
  MAX_MUTATION_EVIDENCE_ATTEMPTS,
  MUTATION_ACTION,
} from "@obsidian-ai-bridge/core";
import { z } from "zod";

/** Validates a canonical UUID-v4 mirror association identity. */
export const mirrorAssociationIdSchema = z
  .string()
  .refine(isUuidV4, "Expected a canonical lowercase UUID-v4 association ID.");

/** Validates a canonical UUID-v4 designated mirror-writer identity. */
export const mirrorWriterIdSchema = z
  .string()
  .refine(isUuidV4, "Expected a canonical lowercase UUID-v4 writer ID.");

/** Validates a canonical UUID-v4 idempotency identity for one mirror operation. */
export const mirrorOperationIdSchema = z
  .string()
  .refine(isUuidV4, "Expected a canonical lowercase UUID-v4 operation ID.");

/** Validates a canonical UUID-v4 application current-generation revision. */
export const applicationRevisionSchema = z
  .string()
  .refine(isUuidV4, "Expected a canonical lowercase UUID-v4 revision.");

/** Validates a canonical UUID-v4 recovery snapshot identity. */
export const recoverySnapshotIdSchema = z
  .string()
  .refine(isUuidV4, "Expected a canonical lowercase UUID-v4 recovery ID.");

/** Validates a canonical lowercase hexadecimal SHA-256 content digest. */
export const contentSha256Schema = z
  .string()
  .refine(isContentSha256, "Expected a lowercase hexadecimal SHA-256 digest.");

/** Validates the only strong ETag format accepted for M3 current generations. */
export const applicationEtagSchema = z
  .string()
  .refine(isApplicationEtag, "Expected one strong M3 application ETag.");

/** Reuses the canonical core NotePath predicate without URI repair or a duplicate rule set. */
export const notePathSchema = z
  .string()
  .refine(
    isNormalizedNotePath,
    "Expected a canonical normalized Markdown note path.",
  );

/** Validates opaque bounded pagination cursors without interpreting storage layout. */
export const mirrorCursorSchema = z
  .string()
  .min(1)
  .max(MAX_MIRROR_CURSOR_LENGTH);

/** Creates only when no recognized current object exists. */
const absentPreconditionSchema = z
  .object({ kind: z.literal("absent") })
  .strict();

/** Matches exactly one established application revision. */
const matchingRevisionPreconditionSchema = z
  .object({
    kind: z.literal("matching-revision"),
    revision: applicationRevisionSchema,
  })
  .strict();

/** Closed conditional requirement; weak, wildcard, list, and date forms have no representation. */
export const conditionalMutationPreconditionSchema = z.discriminatedUnion(
  "kind",
  [absentPreconditionSchema, matchingRevisionPreconditionSchema],
);

/** Receipt for an absence-only content creation. */
const createOperationReceiptSchema = z
  .object({
    action: z.literal(MUTATION_ACTION.create),
    associationId: mirrorAssociationIdSchema,
    operationId: mirrorOperationIdSchema,
    precondition: absentPreconditionSchema,
    contentSha256: contentSha256Schema,
  })
  .strict();

/** Receipt for a matching-revision content update or tombstone recreation. */
const updateOperationReceiptSchema = z
  .object({
    action: z.union([
      z.literal(MUTATION_ACTION.update),
      z.literal(MUTATION_ACTION.recreate),
    ]),
    associationId: mirrorAssociationIdSchema,
    operationId: mirrorOperationIdSchema,
    precondition: matchingRevisionPreconditionSchema,
    contentSha256: contentSha256Schema,
  })
  .strict();

/** Receipt for a matching-revision recoverable tombstone transition. */
const tombstoneOperationReceiptSchema = z
  .object({
    action: z.literal(MUTATION_ACTION.tombstone),
    associationId: mirrorAssociationIdSchema,
    operationId: mirrorOperationIdSchema,
    precondition: matchingRevisionPreconditionSchema,
  })
  .strict();

/**
 * Exact receipt retained in a current generation.
 *
 * The action determines whether creation is absent-only, a parent revision is
 * mandatory, and a content hash may exist.
 */
export const operationReceiptSchema = z.union([
  createOperationReceiptSchema,
  updateOperationReceiptSchema,
  tombstoneOperationReceiptSchema,
]);

/** Metadata carried with a conditional mutation; raw content is bounded and parsed separately. */
export const conditionalMutationRequestSchema = z.union([
  z
    .object({
      action: z.literal(MUTATION_ACTION.create),
      associationId: mirrorAssociationIdSchema,
      writerId: mirrorWriterIdSchema,
      operationId: mirrorOperationIdSchema,
      path: notePathSchema,
      precondition: absentPreconditionSchema,
    })
    .strict(),
  z
    .object({
      action: z.union([
        z.literal(MUTATION_ACTION.update),
        z.literal(MUTATION_ACTION.recreate),
      ]),
      associationId: mirrorAssociationIdSchema,
      writerId: mirrorWriterIdSchema,
      operationId: mirrorOperationIdSchema,
      path: notePathSchema,
      precondition: matchingRevisionPreconditionSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal(MUTATION_ACTION.tombstone),
      associationId: mirrorAssociationIdSchema,
      writerId: mirrorWriterIdSchema,
      operationId: mirrorOperationIdSchema,
      path: notePathSchema,
      precondition: matchingRevisionPreconditionSchema,
    })
    .strict(),
]);

/** Persisted original intent metadata; plaintext note content has no representation here. */
export const unresolvedMutationIntentSchema = z.union([
  z
    .object({
      action: z.literal(MUTATION_ACTION.create),
      associationId: mirrorAssociationIdSchema,
      writerId: mirrorWriterIdSchema,
      operationId: mirrorOperationIdSchema,
      path: notePathSchema,
      precondition: absentPreconditionSchema,
      contentSha256: contentSha256Schema,
      mutationAttempts: z.int().min(0).max(MAX_MUTATION_ATTEMPTS),
      evidenceAttempts: z.int().min(0).max(MAX_MUTATION_EVIDENCE_ATTEMPTS),
    })
    .strict(),
  z
    .object({
      action: z.union([
        z.literal(MUTATION_ACTION.update),
        z.literal(MUTATION_ACTION.recreate),
      ]),
      associationId: mirrorAssociationIdSchema,
      writerId: mirrorWriterIdSchema,
      operationId: mirrorOperationIdSchema,
      path: notePathSchema,
      precondition: matchingRevisionPreconditionSchema,
      contentSha256: contentSha256Schema,
      mutationAttempts: z.int().min(0).max(MAX_MUTATION_ATTEMPTS),
      evidenceAttempts: z.int().min(0).max(MAX_MUTATION_EVIDENCE_ATTEMPTS),
    })
    .strict(),
  z
    .object({
      action: z.literal(MUTATION_ACTION.tombstone),
      associationId: mirrorAssociationIdSchema,
      writerId: mirrorWriterIdSchema,
      operationId: mirrorOperationIdSchema,
      path: notePathSchema,
      precondition: matchingRevisionPreconditionSchema,
      mutationAttempts: z.int().min(0).max(MAX_MUTATION_ATTEMPTS),
      evidenceAttempts: z.int().min(0).max(MAX_MUTATION_EVIDENCE_ATTEMPTS),
    })
    .strict(),
]);

/** Validated metadata acknowledgment for the current generation actually stored. */
export const mutationAcknowledgementSchema = z
  .object({
    path: notePathSchema,
    revision: applicationRevisionSchema,
    receipt: operationReceiptSchema,
  })
  .strict()
  .superRefine((acknowledgement, context) => {
    if (
      acknowledgement.receipt.precondition.kind === "matching-revision" &&
      acknowledgement.revision === acknowledgement.receipt.precondition.revision
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A stored generation revision must be fresh relative to its precondition.",
        path: ["revision"],
      });
    }
  });

/** Recognized absence is explicit state, not permission to overwrite an unknown object. */
const absentCurrentNoteStateSchema = z
  .object({ kind: z.literal("absent"), path: notePathSchema })
  .strict();

/** Untagged M1 Markdown is a legacy blocker rather than a live M3 generation. */
const legacyCurrentNoteStateSchema = z
  .object({ kind: z.literal("legacy"), path: notePathSchema })
  .strict();

/** Metadata-only current live M3 generation. */
const liveCurrentNoteStateSchema = z
  .object({
    kind: z.literal("live"),
    path: notePathSchema,
    revision: applicationRevisionSchema,
    contentSha256: contentSha256Schema,
    receipt: z.union([
      createOperationReceiptSchema,
      updateOperationReceiptSchema,
    ]),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.contentSha256 !== state.receipt.contentSha256) {
      context.addIssue({
        code: "custom",
        message:
          "A live generation hash must match its stored content receipt.",
        path: ["contentSha256"],
      });
    }
    if (
      state.receipt.precondition.kind === "matching-revision" &&
      state.revision === state.receipt.precondition.revision
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A live generation revision must be fresh relative to its parent.",
        path: ["revision"],
      });
    }
  });

/** Metadata-only current tombstone with the exact live generation it removed. */
const tombstoneCurrentNoteStateSchema = z
  .object({
    kind: z.literal("tombstone"),
    path: notePathSchema,
    revision: applicationRevisionSchema,
    deletedRevision: applicationRevisionSchema,
    recoveryId: recoverySnapshotIdSchema,
    receipt: tombstoneOperationReceiptSchema,
  })
  .strict()
  .superRefine((state, context) => {
    if (state.revision === state.deletedRevision) {
      context.addIssue({
        code: "custom",
        message:
          "A tombstone revision must be fresh relative to the deleted generation.",
        path: ["revision"],
      });
    }
    if (state.receipt.precondition.revision !== state.deletedRevision) {
      context.addIssue({
        code: "custom",
        message: "A tombstone receipt must match the deleted live generation.",
        path: ["receipt", "precondition", "revision"],
      });
    }
    if (state.recoveryId !== state.receipt.operationId) {
      context.addIssue({
        code: "custom",
        message:
          "A tombstone recovery identity must equal its deletion operation ID.",
        path: ["recoveryId"],
      });
    }
  });

/** Closed current-state DTO returned by explicit M3 state inspection. */
export const currentNoteStateSchema = z.discriminatedUnion("kind", [
  absentCurrentNoteStateSchema,
  legacyCurrentNoteStateSchema,
  liveCurrentNoteStateSchema,
  tombstoneCurrentNoteStateSchema,
]);

/** Shared bounded recovery metadata fields that intentionally exclude recovery text. */
const recoverySnapshotBaseSchema = z
  .object({
    id: recoverySnapshotIdSchema,
    associationId: mirrorAssociationIdSchema,
    path: notePathSchema,
    revision: applicationRevisionSchema,
    sourceRevision: applicationRevisionSchema,
    contentSha256: contentSha256Schema,
  })
  .strict();

/** Prepared recovery material cannot advertise a deadline before sealing. */
const preparedRecoverySnapshotStateSchema = recoverySnapshotBaseSchema
  .extend({ kind: z.literal("prepared") })
  .strict();

/** Sealed recovery material has an immutable RFC 3339 retention deadline. */
const sealedRecoverySnapshotStateSchema = recoverySnapshotBaseSchema
  .extend({
    kind: z.literal("sealed"),
    recoverUntil: z.iso.datetime({ offset: true }),
  })
  .strict();

/** Purged recovery material retains only identity/retention metadata, never content. */
const purgedRecoverySnapshotStateSchema = recoverySnapshotBaseSchema
  .extend({
    kind: z.literal("purged"),
    recoverUntil: z.iso.datetime({ offset: true }),
  })
  .strict();

/** Closed recovery lifecycle DTO; prepared snapshots cannot be purged or expired. */
export const recoverySnapshotStateSchema = z
  .discriminatedUnion("kind", [
    preparedRecoverySnapshotStateSchema,
    sealedRecoverySnapshotStateSchema,
    purgedRecoverySnapshotStateSchema,
  ])
  .superRefine((state, context) => {
    if (state.revision === state.sourceRevision) {
      context.addIssue({
        code: "custom",
        message:
          "A recovery generation revision must be fresh relative to its source.",
        path: ["revision"],
      });
    }
  });

/** One bounded page of live or legacy note paths and an opaque continuation. */
export const notePageSchema = z
  .object({
    notes: z.array(notePathSchema).max(MAX_MIRROR_PAGE_SIZE),
    nextCursor: mirrorCursorSchema.nullable(),
  })
  .strict()
  .superRefine((page, context) => {
    if (new Set(page.notes).size !== page.notes.length) {
      context.addIssue({
        code: "custom",
        message: "A note page cannot contain duplicate paths.",
        path: ["notes"],
      });
    }
  });

/** One bounded page of recovery metadata and an opaque continuation. */
export const recoveryPageSchema = z
  .object({
    recoveries: z.array(recoverySnapshotStateSchema).max(MAX_MIRROR_PAGE_SIZE),
    nextCursor: mirrorCursorSchema.nullable(),
  })
  .strict()
  .superRefine((page, context) => {
    const recoveryIds = page.recoveries.map((recovery) => recovery.id);
    if (new Set(recoveryIds).size !== recoveryIds.length) {
      context.addIssue({
        code: "custom",
        message:
          "A recovery page cannot contain duplicate snapshot identities.",
        path: ["recoveries"],
      });
    }
  });

/** Closed client-observable effect certainty for a conditional note mutation. */
export const mutationResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not-dispatched") }).strict(),
  z.object({ kind: z.literal("definitely-refused") }).strict(),
  z
    .object({
      kind: z.literal("confirmed"),
      acknowledgement: mutationAcknowledgementSchema,
    })
    .strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
]);
