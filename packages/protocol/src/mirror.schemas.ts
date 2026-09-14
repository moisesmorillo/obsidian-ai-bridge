import {
  APPLICATION_ETAG_PATTERN,
  BASE64URL_PATTERN,
  CONTENT_SHA_256_PATTERN,
  decodeNotePath,
  isNormalizedNotePath,
  MAX_MIRROR_CURSOR_LENGTH,
  MAX_MIRROR_PAGE_SIZE,
  MAX_MUTATION_ATTEMPTS,
  MAX_MUTATION_EVIDENCE_ATTEMPTS,
  MAX_NOTE_SIZE_BYTES,
  MUTATION_ACTION,
  MUTATION_EFFECT_CERTAINTY,
  RECOVERY_RETENTION_MILLISECONDS,
  RECOVERY_SNAPSHOT_STATE_KIND,
  UUID_V4_PATTERN,
} from "@obsidian-ai-bridge/core";
import { MIRROR_PROTOCOL_ID } from "@protocol/protocol.constants";
import { z } from "zod";

/** Validates a canonical UUID-v4 mirror association identity. */
export const mirrorAssociationIdSchema = z
  .string()
  .regex(
    UUID_V4_PATTERN,
    "Expected a canonical lowercase UUID-v4 association ID.",
  );

/** Validates a canonical UUID-v4 designated mirror-writer identity. */
export const mirrorWriterIdSchema = z
  .string()
  .regex(UUID_V4_PATTERN, "Expected a canonical lowercase UUID-v4 writer ID.");

/** Validates a canonical UUID-v4 idempotency identity for one mirror operation. */
export const mirrorOperationIdSchema = z
  .string()
  .regex(
    UUID_V4_PATTERN,
    "Expected a canonical lowercase UUID-v4 operation ID.",
  );

/** Validates a canonical UUID-v4 application current-generation revision. */
export const applicationRevisionSchema = z
  .string()
  .regex(UUID_V4_PATTERN, "Expected a canonical lowercase UUID-v4 revision.");

/** Validates a canonical UUID-v4 recovery snapshot identity. */
export const recoverySnapshotIdSchema = z
  .string()
  .regex(
    UUID_V4_PATTERN,
    "Expected a canonical lowercase UUID-v4 recovery ID.",
  );

/** Validates a canonical lowercase hexadecimal SHA-256 content digest. */
export const contentSha256Schema = z
  .string()
  .regex(
    CONTENT_SHA_256_PATTERN,
    "Expected a lowercase hexadecimal SHA-256 digest.",
  );

/** Validates the only strong ETag format accepted for M3 current generations. */
export const applicationEtagSchema = z
  .string()
  .regex(APPLICATION_ETAG_PATTERN, "Expected one strong M3 application ETag.");

/** Validates a canonical unpadded base64url route identifier for one safe NotePath. */
export const encodedNotePathSchema = z
  .string()
  .regex(BASE64URL_PATTERN, "Expected canonical unpadded base64url syntax.")
  .refine(
    (value) => decodeNotePath(value) !== undefined,
    "Expected a canonical identifier for a normalized Markdown note path.",
  );

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

/** Absence-only creation acknowledgement returned with HTTP 201. */
export const createMutationAcknowledgementSchema = z
  .object({
    path: notePathSchema,
    revision: applicationRevisionSchema,
    receipt: createOperationReceiptSchema,
  })
  .strict();

/** Matching live-update or tombstone-recreation acknowledgement returned with HTTP 200. */
export const matchingContentMutationAcknowledgementSchema = z
  .object({
    path: notePathSchema,
    revision: applicationRevisionSchema,
    receipt: updateOperationReceiptSchema,
  })
  .strict()
  .superRefine(validateFreshAcknowledgement);

/** Recoverable tombstone acknowledgement that cannot claim a content action. */
export const tombstoneMutationAcknowledgementSchema = z
  .object({
    path: notePathSchema,
    revision: applicationRevisionSchema,
    receipt: tombstoneOperationReceiptSchema,
  })
  .strict()
  .superRefine(validateFreshAcknowledgement);

/** Validated metadata acknowledgement for the exact current generation stored. */
export const mutationAcknowledgementSchema = z.union([
  createMutationAcknowledgementSchema,
  matchingContentMutationAcknowledgementSchema,
  tombstoneMutationAcknowledgementSchema,
]);

/**
 * Rejects a matching mutation that reuses its parent application revision.
 *
 * @param acknowledgement - Matching acknowledgement being validated.
 * @param context - Zod refinement context receiving invariant failures.
 */
function validateFreshAcknowledgement(
  acknowledgement: {
    readonly revision: string;
    readonly receipt: {
      readonly precondition: { readonly revision: string };
    };
  },
  context: z.RefinementCtx,
): void {
  if (
    acknowledgement.revision === acknowledgement.receipt.precondition.revision
  ) {
    context.addIssue({
      code: "custom",
      message:
        "A stored generation revision must be fresh relative to its precondition.",
      path: ["revision"],
    });
  }
}

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
export const preparedRecoverySnapshotStateSchema = recoverySnapshotBaseSchema
  .extend({ kind: z.literal(RECOVERY_SNAPSHOT_STATE_KIND.prepared) })
  .strict();

/** Sealed recovery material has an immutable RFC 3339 retention deadline. */
export const sealedRecoverySnapshotStateSchema = recoverySnapshotBaseSchema
  .extend({
    kind: z.literal(RECOVERY_SNAPSHOT_STATE_KIND.sealed),
    recoverUntil: z.iso.datetime({ offset: true }),
  })
  .strict();

/** Purged recovery material retains only identity/retention metadata, never content. */
export const purgedRecoverySnapshotStateSchema = recoverySnapshotBaseSchema
  .extend({
    kind: z.literal(RECOVERY_SNAPSHOT_STATE_KIND.purged),
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

/** Authenticated Worker capabilities and static cooperating-writer designation. */
export const mirrorDescriptionSchema = z
  .object({
    protocol: z.literal(MIRROR_PROTOCOL_ID),
    associationId: mirrorAssociationIdSchema,
    writerId: mirrorWriterIdSchema,
    maxNoteSizeBytes: z.literal(MAX_NOTE_SIZE_BYTES),
    maxPageSize: z.literal(MAX_MIRROR_PAGE_SIZE),
    recoveryRetentionSeconds: z.literal(RECOVERY_RETENTION_MILLISECONDS / 1000),
  })
  .strict();

/** Recovery-sealing result returned with a confirmed tombstone acknowledgement. */
const tombstoneSealingResultSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal(MUTATION_EFFECT_CERTAINTY.notDispatched) })
    .strict(),
  z
    .object({ kind: z.literal(MUTATION_EFFECT_CERTAINTY.definitelyRefused) })
    .strict(),
  z
    .object({
      kind: z.literal(MUTATION_EFFECT_CERTAINTY.confirmed),
      recovery: sealedRecoverySnapshotStateSchema,
    })
    .strict(),
  z.object({ kind: z.literal(MUTATION_EFFECT_CERTAINTY.unknown) }).strict(),
]);

/** Exact confirmed recoverable-deletion result without recovery plaintext. */
export const tombstoneMutationResponseSchema = z
  .object({
    acknowledgement: tombstoneMutationAcknowledgementSchema,
    recovery: preparedRecoverySnapshotStateSchema,
    sealing: tombstoneSealingResultSchema,
  })
  .strict()
  .superRefine((response, context) => {
    const { acknowledgement, recovery } = response;
    if (
      acknowledgement.path !== recovery.path ||
      acknowledgement.receipt.associationId !== recovery.associationId ||
      acknowledgement.receipt.operationId !== recovery.id ||
      acknowledgement.receipt.precondition.revision !== recovery.sourceRevision
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A tombstone acknowledgement and prepared recovery must describe one deletion.",
      });
    }
    if (
      response.sealing.kind === MUTATION_EFFECT_CERTAINTY.confirmed &&
      (response.sealing.recovery.id !== recovery.id ||
        response.sealing.recovery.path !== recovery.path ||
        response.sealing.recovery.associationId !== recovery.associationId ||
        response.sealing.recovery.sourceRevision !== recovery.sourceRevision ||
        response.sealing.recovery.contentSha256 !== recovery.contentSha256)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Confirmed sealing metadata must identify the prepared deletion recovery.",
        path: ["sealing"],
      });
    }
  });

/** Closed client-observable effect certainty for a conditional note mutation. */
export const mutationResultSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal(MUTATION_EFFECT_CERTAINTY.notDispatched) })
    .strict(),
  z
    .object({ kind: z.literal(MUTATION_EFFECT_CERTAINTY.definitelyRefused) })
    .strict(),
  z
    .object({
      kind: z.literal(MUTATION_EFFECT_CERTAINTY.confirmed),
      acknowledgement: mutationAcknowledgementSchema,
    })
    .strict(),
  z.object({ kind: z.literal(MUTATION_EFFECT_CERTAINTY.unknown) }).strict(),
]);
