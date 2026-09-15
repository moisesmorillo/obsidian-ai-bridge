import {
  API_ROUTE_PARAMETER,
  applicationEtagSchema,
  conditionalMutationPreconditionSchema,
  conditionalMutationRequestSchema,
  currentNoteStateSchema,
  HTTP_METHOD,
  HTTP_STATUS_CODE,
  MIRROR_API_V2_PREFIX,
  MIRROR_API_V2_QUERY_PARAMETER,
  MIRROR_API_V2_ROUTE,
  MIRROR_API_V2_SEGMENT,
  MIRROR_HTTP_HEADER,
  MIRROR_MEDIA_TYPE,
  mirrorAssociationIdSchema,
  mirrorCursorSchema,
  mirrorDescriptionSchema,
  mutationAcknowledgementSchema,
  mutationResultSchema,
  notePageSchema,
  operationReceiptSchema,
  recoveryPageSchema,
  recoverySnapshotStateSchema,
  tombstoneMutationResponseSchema,
  unresolvedMutationIntentSchema,
} from "@obsidian-ai-bridge/protocol";
import { describe, expect, it } from "vitest";

const ASSOCIATION_ID = "8f4c6a20-2b51-4d86-9c55-df50d9390d96";
const WRITER_ID = "2b920a99-8ed3-4e3d-b3f8-607e786fcd15";
const OPERATION_ID = "b03f51ea-581e-4e4a-bec3-b89d4325d7c7";
const REVISION = "1c79a710-b532-4c32-9e14-cda5fa23a06d";
const PARENT_REVISION = "86b3f57b-33c2-4e13-b8f1-4f6c2ec1de80";
const RECOVERY_ID = "a5eaa17e-6e5c-4fb7-8585-8a5da7e5133b";
const SHA_256 = "a3".repeat(32);

const createReceipt = {
  action: "create",
  associationId: ASSOCIATION_ID,
  operationId: OPERATION_ID,
  precondition: { kind: "absent" },
  contentSha256: SHA_256,
};

const updateReceipt = {
  action: "update",
  associationId: ASSOCIATION_ID,
  operationId: OPERATION_ID,
  precondition: { kind: "matching-revision", revision: PARENT_REVISION },
  contentSha256: SHA_256,
};

const tombstoneReceipt = {
  action: "tombstone",
  associationId: ASSOCIATION_ID,
  operationId: OPERATION_ID,
  precondition: { kind: "matching-revision", revision: PARENT_REVISION },
};

describe("M3 mirror protocol schemas", () => {
  it("owns the stable public v2 routes, headers, and media types", () => {
    expect(MIRROR_API_V2_PREFIX).toBe("/api/v2");
    expect(MIRROR_API_V2_ROUTE).toEqual({
      mirror: "/api/v2/mirror",
      notes: "/api/v2/notes",
      recovery: "/api/v2/recovery",
    });
    expect(API_ROUTE_PARAMETER).toEqual({
      notePath: "path",
      recoveryId: "id",
    });
    expect(MIRROR_API_V2_SEGMENT).toEqual({
      content: "content",
      purge: "purge",
      seal: "seal",
      state: "state",
    });
    expect(MIRROR_API_V2_QUERY_PARAMETER.cursor).toBe("cursor");
    expect(HTTP_METHOD).toEqual({
      delete: "DELETE",
      get: "GET",
      post: "POST",
      put: "PUT",
    });
    expect(HTTP_STATUS_CODE).toMatchObject({
      ok: 200,
      created: 201,
      notFound: 404,
      gone: 410,
      preconditionFailed: 412,
      preconditionRequired: 428,
      rateLimited: 429,
      internalServerError: 500,
    });
    expect(MIRROR_HTTP_HEADER).toMatchObject({
      associationId: "Bridge-Association-Id",
      etag: "ETag",
      ifMatch: "If-Match",
      operationId: "Bridge-Operation-Id",
    });
    expect(MIRROR_MEDIA_TYPE).toMatchObject({
      json: "application/json",
      markdown: "text/markdown",
      markdownUtf8: "text/markdown; charset=utf-8",
    });
  });

  it("validates the Worker capability description", () => {
    expect(
      mirrorDescriptionSchema.parse({
        protocol: "obsidian-ai-bridge-mirror-v2",
        associationId: ASSOCIATION_ID,
        writerId: WRITER_ID,
        maxNoteSizeBytes: 1_048_576,
        maxPageSize: 50,
        recoveryRetentionSeconds: 2_592_000,
      }),
    ).toMatchObject({ protocol: "obsidian-ai-bridge-mirror-v2" });
  });
  it("validates canonical identities, digests, ETags, and bounded cursors", () => {
    expect(mirrorAssociationIdSchema.parse(ASSOCIATION_ID)).toBe(
      ASSOCIATION_ID,
    );
    expect(applicationEtagSchema.parse(`"m3-${REVISION}"`)).toBe(
      `"m3-${REVISION}"`,
    );
    expect(mirrorCursorSchema.parse("opaque-cursor")).toBe("opaque-cursor");
    expect(mirrorCursorSchema.safeParse("x".repeat(4097)).success).toBe(false);
    expect(
      mirrorAssociationIdSchema.safeParse(REVISION.toUpperCase()).success,
    ).toBe(false);
    expect(applicationEtagSchema.safeParse(`"${REVISION}"`).success).toBe(
      false,
    );
  });

  it("reuses the core NotePath predicate instead of accepting path-like strings", () => {
    expect(
      notePageSchema.parse({ notes: ["nested/雪.md"], nextCursor: null }),
    ).toEqual({ notes: ["nested/雪.md"], nextCursor: null });
    expect(
      notePageSchema.safeParse({
        notes: ["nested/../secret.md"],
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      notePageSchema.safeParse({
        notes: ["notes.md", "notes.md"],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  it("accepts only absent or exactly one matching revision precondition", () => {
    expect(
      conditionalMutationPreconditionSchema.parse({ kind: "absent" }),
    ).toEqual({
      kind: "absent",
    });
    expect(
      conditionalMutationPreconditionSchema.parse({
        kind: "matching-revision",
        revision: PARENT_REVISION,
      }),
    ).toEqual({ kind: "matching-revision", revision: PARENT_REVISION });
    expect(
      conditionalMutationPreconditionSchema.safeParse({
        kind: "matching-revision",
        revision: `W/"m3-${PARENT_REVISION}"`,
      }).success,
    ).toBe(false);
    expect(
      conditionalMutationPreconditionSchema.safeParse({
        kind: "absent",
        revision: PARENT_REVISION,
      }).success,
    ).toBe(false);
    expect(
      conditionalMutationRequestSchema.parse({
        action: "update",
        associationId: ASSOCIATION_ID,
        writerId: WRITER_ID,
        operationId: OPERATION_ID,
        path: "note.md",
        precondition: { kind: "matching-revision", revision: PARENT_REVISION },
      }),
    ).toMatchObject({ action: "update" });
    expect(
      conditionalMutationRequestSchema.safeParse({
        action: "create",
        associationId: ASSOCIATION_ID,
        writerId: WRITER_ID,
        operationId: OPERATION_ID,
        path: "note.md",
        precondition: { kind: "matching-revision", revision: PARENT_REVISION },
      }).success,
    ).toBe(false);
  });

  it("rejects receipt action, hash, and precondition combinations that cannot occur", () => {
    expect(operationReceiptSchema.parse(createReceipt)).toEqual(createReceipt);
    expect(operationReceiptSchema.parse(updateReceipt)).toEqual(updateReceipt);
    expect(operationReceiptSchema.parse(tombstoneReceipt)).toEqual(
      tombstoneReceipt,
    );
    expect(
      operationReceiptSchema.safeParse({
        ...createReceipt,
        precondition: { kind: "matching-revision", revision: PARENT_REVISION },
      }).success,
    ).toBe(false);
    expect(
      operationReceiptSchema.safeParse({
        ...updateReceipt,
        precondition: { kind: "absent" },
      }).success,
    ).toBe(false);
    expect(
      operationReceiptSchema.safeParse({
        ...tombstoneReceipt,
        contentSha256: SHA_256,
      }).success,
    ).toBe(false);
  });

  it("validates current live and tombstone generations as closed variants", () => {
    expect(
      currentNoteStateSchema.parse({
        kind: "live",
        path: "note.md",
        revision: REVISION,
        contentSha256: SHA_256,
        receipt: updateReceipt,
      }),
    ).toMatchObject({ kind: "live", revision: REVISION });
    expect(
      currentNoteStateSchema.parse({
        kind: "tombstone",
        path: "note.md",
        revision: REVISION,
        deletedRevision: PARENT_REVISION,
        recoveryId: OPERATION_ID,
        receipt: tombstoneReceipt,
      }),
    ).toMatchObject({ kind: "tombstone", recoveryId: OPERATION_ID });
    expect(
      currentNoteStateSchema.safeParse({
        kind: "live",
        path: "note.md",
        revision: REVISION,
        contentSha256: "b4".repeat(32),
        receipt: updateReceipt,
      }).success,
    ).toBe(false);
    expect(
      currentNoteStateSchema.safeParse({
        kind: "tombstone",
        path: "note.md",
        revision: REVISION,
        deletedRevision: REVISION,
        recoveryId: RECOVERY_ID,
        receipt: tombstoneReceipt,
      }).success,
    ).toBe(false);
    expect(
      currentNoteStateSchema.safeParse({
        kind: "tombstone",
        path: "note.md",
        revision: REVISION,
        deletedRevision: PARENT_REVISION,
        recoveryId: RECOVERY_ID,
        receipt: tombstoneReceipt,
      }).success,
    ).toBe(false);
    expect(
      currentNoteStateSchema.safeParse({ kind: "future", path: "note.md" })
        .success,
    ).toBe(false);
  });

  it("validates acknowledgements and recovery lifecycle variants without open metadata", () => {
    const acknowledgement = {
      path: "note.md",
      revision: REVISION,
      receipt: updateReceipt,
    };
    expect(mutationAcknowledgementSchema.parse(acknowledgement)).toEqual(
      acknowledgement,
    );
    expect(
      mutationAcknowledgementSchema.safeParse({
        ...acknowledgement,
        revision: PARENT_REVISION,
      }).success,
    ).toBe(false);
    expect(
      recoverySnapshotStateSchema.parse({
        kind: "sealed",
        id: RECOVERY_ID,
        associationId: ASSOCIATION_ID,
        path: "note.md",
        revision: REVISION,
        sourceRevision: PARENT_REVISION,
        contentSha256: SHA_256,
        recoverUntil: "2026-04-15T12:30:00.000Z",
      }),
    ).toMatchObject({ kind: "sealed", id: RECOVERY_ID });
    expect(
      recoverySnapshotStateSchema.safeParse({
        kind: "prepared",
        id: RECOVERY_ID,
        associationId: ASSOCIATION_ID,
        path: "note.md",
        revision: REVISION,
        sourceRevision: PARENT_REVISION,
        contentSha256: SHA_256,
        recoverUntil: "2026-04-15T12:30:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      recoverySnapshotStateSchema.safeParse({
        kind: "purged",
        id: RECOVERY_ID,
        associationId: ASSOCIATION_ID,
        path: "note.md",
        revision: REVISION,
        sourceRevision: PARENT_REVISION,
        contentSha256: SHA_256,
      }).success,
    ).toBe(false);
    expect(
      recoveryPageSchema.safeParse({
        recoveries: [],
        nextCursor: null,
        arbitraryMetadata: "rejected",
      }).success,
    ).toBe(false);
    expect(
      unresolvedMutationIntentSchema.parse({
        action: "update",
        associationId: ASSOCIATION_ID,
        writerId: WRITER_ID,
        operationId: OPERATION_ID,
        path: "note.md",
        precondition: { kind: "matching-revision", revision: PARENT_REVISION },
        contentSha256: SHA_256,
        mutationAttempts: 3,
        evidenceAttempts: 3,
      }),
    ).toMatchObject({ action: "update" });
    expect(
      unresolvedMutationIntentSchema.safeParse({
        action: "tombstone",
        associationId: ASSOCIATION_ID,
        writerId: WRITER_ID,
        operationId: OPERATION_ID,
        path: "note.md",
        precondition: { kind: "matching-revision", revision: PARENT_REVISION },
        mutationAttempts: 4,
        evidenceAttempts: 0,
      }).success,
    ).toBe(false);
  });

  it("validates confirmed tombstone transport results without recovery plaintext", () => {
    const response = {
      acknowledgement: {
        path: "note.md",
        revision: REVISION,
        receipt: tombstoneReceipt,
      },
      recovery: {
        kind: "prepared",
        id: OPERATION_ID,
        associationId: ASSOCIATION_ID,
        path: "note.md",
        revision: RECOVERY_ID,
        sourceRevision: PARENT_REVISION,
        contentSha256: SHA_256,
      },
      sealing: { kind: "not-dispatched" },
    };
    expect(tombstoneMutationResponseSchema.parse(response)).toEqual(response);
    expect(
      tombstoneMutationResponseSchema.safeParse({
        ...response,
        recovery: { ...response.recovery, content: "private" },
      }).success,
    ).toBe(false);
    expect(
      tombstoneMutationResponseSchema.safeParse({
        ...response,
        acknowledgement: {
          ...response.acknowledgement,
          receipt: updateReceipt,
        },
      }).success,
    ).toBe(false);
    expect(
      tombstoneMutationResponseSchema.safeParse({
        ...response,
        recovery: { ...response.recovery, path: "other.md" },
      }).success,
    ).toBe(false);
  });

  it("keeps mutation effect certainty closed and requires an acknowledgement for confirmation", () => {
    expect(
      mutationResultSchema.parse({
        kind: "confirmed",
        acknowledgement: {
          path: "note.md",
          revision: REVISION,
          receipt: updateReceipt,
        },
      }),
    ).toMatchObject({ kind: "confirmed" });
    expect(mutationResultSchema.parse({ kind: "unknown" })).toEqual({
      kind: "unknown",
    });
    expect(mutationResultSchema.safeParse({ kind: "confirmed" }).success).toBe(
      false,
    );
    expect(mutationResultSchema.safeParse({ kind: "retrying" }).success).toBe(
      false,
    );
  });

  it("does not confuse writer identity with a receipt field", () => {
    expect(WRITER_ID).not.toBe(ASSOCIATION_ID);
    expect(
      operationReceiptSchema.safeParse({
        ...createReceipt,
        writerId: WRITER_ID,
      }).success,
    ).toBe(false);
  });
});
