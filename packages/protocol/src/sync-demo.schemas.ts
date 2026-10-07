import { contentSha256Schema } from "@protocol/mirror.schemas";
import { MIRROR_MEDIA_TYPE } from "@protocol/protocol.constants";
import {
  SYNC_ERROR_CODES,
  SYNC_FEED_LANE_COUNT,
} from "@protocol/sync.constants";
import {
  syncDeviceIdSchema,
  syncEventSequenceSchema,
  syncIdentifierSchema,
  syncNotePathSchema,
  syncOpaqueCursorSchema,
  syncOperationIdSchema,
  syncRevisionSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import {
  MAX_SYNC_DEMO_CONTENT_BYTES,
  MAX_SYNC_DEMO_FEED_EVENTS,
  SYNC_DEMO_BINDING_HEADER,
  SYNC_DEMO_OPERATION,
  SYNC_DEMO_TRANSPORT_ERROR,
} from "@protocol/sync-demo.constants";
import { z } from "zod";

/** Optional paired client expectations of server-selected identity; absent pairs preserve REST compatibility and partial/malformed pairs grant no admission. */
export const syncDemoBindingHeadersSchema = z
  .object({
    [SYNC_DEMO_BINDING_HEADER.vaultId]: syncVaultIdSchema
      .optional()
      .describe(
        "Expected configured synthetic vault; never selects authority. Supply together with expected origin.",
      ),
    [SYNC_DEMO_BINDING_HEADER.origin]: syncDeviceIdSchema
      .optional()
      .describe(
        "Expected authenticated participant's configured origin; never grants permissions. Supply together with expected vault.",
      ),
  })
  .strict()
  .refine(
    (headers) =>
      (headers[SYNC_DEMO_BINDING_HEADER.vaultId] === undefined) ===
      (headers[SYNC_DEMO_BINDING_HEADER.origin] === undefined),
  );
/** Sanitized transport failures, distinct from domain operation/journal certainty and free of submitted identity values. */
export const syncDemoTransportFailureSchema = z
  .object({
    kind: z.literal("error"),
    code: z.enum(Object.values(SYNC_DEMO_TRANSPORT_ERROR)),
  })
  .strict();

/** Exact parent evidence shared by the demo request and response contracts. */
const parentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("never_seen") }).strict(),
  z
    .object({ kind: z.literal("revision"), revision: syncRevisionSchema })
    .strict(),
]);
/** Well-formed Unicode Markdown measured in UTF-8 bytes; lone surrogates cannot silently become replacement bytes. */
const contentSchema = z
  .string()
  .refine(
    (content) =>
      content.isWellFormed() &&
      new TextEncoder().encode(content).byteLength <=
        MAX_SYNC_DEMO_CONTENT_BYTES,
  );
/** Identity supplied once by the caller; vault, origin and digest are server-owned. */
const mutationIdentity = {
  path: syncNotePathSchema,
  operationId: syncOperationIdSchema,
  revision: syncRevisionSchema,
  content: contentSchema,
};
/** Closed create/update wire command; deletion and generic operation-ID resume are absent. */
const mutationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...mutationIdentity,
      kind: z.literal("create"),
      parent: z.object({ kind: z.literal("never_seen") }).strict(),
    })
    .strict(),
  z
    .object({
      ...mutationIdentity,
      kind: z.literal("update"),
      parent: z
        .object({ kind: z.literal("revision"), revision: syncRevisionSchema })
        .strict(),
    })
    .strict(),
]);
/** Strict experimental request union, validated before service/storage resolution. */
export const syncDemoRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal(SYNC_DEMO_OPERATION.current),
      path: syncNotePathSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal(SYNC_DEMO_OPERATION.version),
      revision: syncRevisionSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal(SYNC_DEMO_OPERATION.mutate),
      mutation: mutationSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal(SYNC_DEMO_OPERATION.changes),
      cursor: syncOpaqueCursorSchema,
    })
    .strict(),
]);
/** Current metadata never embeds note content or storage implementation identifiers. */
const currentFields = {
  revision: syncRevisionSchema,
  parent: parentSchema,
  contentSha256: contentSha256Schema,
  byteSize: z.int().nonnegative().max(MAX_SYNC_DEMO_CONTENT_BYTES),
  mediaType: z.literal(MIRROR_MEDIA_TYPE.markdown),
  operationId: syncOperationIdSchema,
  origin: syncDeviceIdSchema,
};
/** Complete live immutable version; tombstones remain explicit metadata rather than local-delete authority. */
const versionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...currentFields,
      kind: z.literal("live"),
      vaultId: syncVaultIdSchema,
      path: syncNotePathSchema,
      content: contentSchema,
    })
    .strict(),
  z
    .object({
      ...currentFields,
      kind: z.literal("tombstone"),
      vaultId: syncVaultIdSchema,
      path: syncNotePathSchema,
      parent: z
        .object({ kind: z.literal("revision"), revision: syncRevisionSchema })
        .strict(),
    })
    .strict(),
]);
/** Closed contextual error variants preserve retry certainty without manufacturing a success. */
const failureSchema = z.union([
  z
    .object({
      kind: z.literal("error"),
      code: z.enum(
        SYNC_ERROR_CODES.filter(
          (code) =>
            ![
              "storage_throttled",
              "mutation_not_admitted",
              "operation_pending",
              "effect_unknown",
              "storage_unavailable",
            ].includes(code),
        ),
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("error"),
      code: z.literal("storage_throttled"),
      retryAfterEpochMs: z.int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("error"),
      code: z.literal("mutation_not_admitted"),
      operationId: syncOperationIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("error"),
      code: z.literal("operation_pending"),
      operationId: syncOperationIdSchema,
      retryAfterEpochMs: z.int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("error"),
      code: z.literal("effect_unknown"),
      operationId: syncOperationIdSchema.optional(),
      retryAfterEpochMs: z.int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("error"),
      code: z.literal("storage_unavailable"),
    })
    .strict(),
]);
/** Lane positions remain exact nonzero decimal strings, never numeric sequence approximations. */
const positionFields = {
  lane: z
    .int()
    .min(0)
    .max(SYNC_FEED_LANE_COUNT - 1),
  sequence: syncEventSequenceSchema,
};
/** Feed entries expose only committed metadata, including safe aborted-operation outcomes. */
const eventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("changed"),
      ...positionFields,
      path: syncNotePathSchema,
      result: z
        .object({
          kind: z.enum(["live", "tombstone"]),
          revision: syncRevisionSchema,
        })
        .strict(),
      operationId: syncOperationIdSchema,
      origin: syncDeviceIdSchema,
      committedAtEpochMs: z.int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("aborted"),
      ...positionFields,
      operationId: syncOperationIdSchema,
      reason: z.literal("stale_revision"),
      committedAtEpochMs: z.int().nonnegative(),
    })
    .strict(),
]);
/** Strict response union for bounded demo reads, exact mutation results and feed pages. */
export const syncDemoResponseSchema = z.union([
  failureSchema,
  z.object({ kind: z.literal("never_seen") }).strict(),
  z.object({ ...currentFields, kind: z.literal("live") }).strict(),
  z
    .object({
      ...currentFields,
      kind: z.literal("tombstone"),
      parent: z
        .object({ kind: z.literal("revision"), revision: syncRevisionSchema })
        .strict(),
    })
    .strict(),
  z.object({ kind: z.literal("absent") }).strict(),
  z.object({ kind: z.literal("present"), version: versionSchema }).strict(),
  z
    .object({
      kind: z.literal("committed"),
      revision: syncRevisionSchema,
      operationId: syncOperationIdSchema,
      position: z.object(positionFields).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("page"),
      events: z.array(eventSchema).max(MAX_SYNC_DEMO_FEED_EVENTS),
      nextCursor: syncOpaqueCursorSchema,
    })
    .strict(),
]);
/** Runtime schema for the three explicit lab participants; identity is assigned by server configuration only. */
export const syncDemoParticipantSchema = z
  .object({ clientId: syncIdentifierSchema, origin: syncDeviceIdSchema })
  .strict();
