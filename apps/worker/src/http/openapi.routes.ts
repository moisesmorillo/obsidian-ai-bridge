import { createRoute, z } from "@hono/zod-openapi";
import { APPLICATION_ETAG_PATTERN } from "@obsidian-ai-bridge/core";
import {
  API_ERROR_CODE,
  API_ROUTE_PARAMETER,
  applicationEtagSchema,
  BRIDGE_NOTE_FORMAT,
  BRIDGE_NOTE_FORMATS,
  createMutationAcknowledgementSchema,
  currentNoteStateSchema,
  encodedNotePathSchema,
  HTTP_METHOD,
  healthResponseSchema,
  MIRROR_API_V2_QUERY_PARAMETER,
  MIRROR_API_V2_SEGMENT,
  matchingContentMutationAcknowledgementSchema,
  mirrorAssociationIdSchema,
  mirrorCursorSchema,
  mirrorDescriptionSchema,
  mirrorOperationIdSchema,
  mirrorWriterIdSchema,
  notePageSchema,
  purgedRecoverySnapshotStateSchema,
  recoveryPageSchema,
  recoverySnapshotIdSchema,
  recoverySnapshotStateSchema,
  sealedRecoverySnapshotStateSchema,
  tombstoneMutationResponseSchema,
} from "@obsidian-ai-bridge/protocol";
import {
  AUTHENTICATION_SCHEME,
  WWW_AUTHENTICATE_HEADER,
} from "@worker/auth/auth.constants";
import type { ClientPermission } from "@worker/auth/auth.types";
import {
  CACHE_CONTROL_HEADER,
  CACHE_CONTROL_NO_STORE,
  HTTP_HEADER,
  HTTP_STATUS,
  JSON_CONTENT_TYPE,
  MARKDOWN_CONTENT_TYPE,
  MARKDOWN_MEDIA_TYPE,
  PLAIN_TEXT_MEDIA_TYPE,
  SUPPORTED_NOTE_CONTENT_TYPE_PATTERN,
} from "@worker/http/http.constants";
import {
  ROUTE_OPERATION_POLICY,
  toOpenApiV2RoutePath,
  V2_ROUTE_POLICY,
  type V2RouteMethod,
} from "@worker/http/v2-route-policy";

/**
 * Converts one canonical route method to the lowercase OpenAPI representation.
 *
 * @param method - Method owned by the public v2 route policy.
 * @returns Equivalent OpenAPI operation method.
 */
function toOpenApiMethod(
  method: V2RouteMethod,
): "delete" | "get" | "post" | "put" {
  switch (method) {
    case HTTP_METHOD.delete:
      return "delete";
    case HTTP_METHOD.get:
      return "get";
    case HTTP_METHOD.post:
      return "post";
    case HTTP_METHOD.put:
      return "put";
  }
}

/**
 * Describes the exact permission owned by one route-policy operation.
 *
 * @param permission - Independent client capability required before dispatch.
 * @returns Public OpenAPI prose derived from the authorization owner.
 */
function permissionDescription(permission: ClientPermission): string {
  return `Requires the ${permission} permission.`;
}

/** OpenAPI security-scheme identifier shared by authenticated routes. */
const OPENAPI_BEARER_SECURITY_SCHEME = "bearerAuth";

/** OpenAPI security requirement shared by authenticated routes. */
const bearerSecurity = [{ [OPENAPI_BEARER_SECURITY_SCHEME]: [] }];

/** Canonical encoded note identifier parameter. */
const notePathParameters = z.object({
  [API_ROUTE_PARAMETER.notePath]: encodedNotePathSchema.describe(
    "Literal canonical unpadded base64url identifier for a validated lowercase-.md NotePath; percent-encoded aliases are rejected.",
  ),
});

/** Canonical recovery UUID parameter. */
const recoveryIdParameters = z.object({
  [API_ROUTE_PARAMETER.recoveryId]: recoverySnapshotIdSchema,
});

/** Optional opaque pagination query. */
const cursorQuery = z.object({
  [MIRROR_API_V2_QUERY_PARAMETER.cursor]: mirrorCursorSchema
    .optional()
    .describe(
      "Opaque continuation returned by the immediately preceding page.",
    ),
});

/** Mutation identity request headers shared by every v2 mutation. */
const mutationIdentityHeaders = {
  [HTTP_HEADER.associationId]: mirrorAssociationIdSchema,
  [HTTP_HEADER.writerId]: mirrorWriterIdSchema,
  [HTTP_HEADER.operationId]: mirrorOperationIdSchema,
};

/** Matching application-generation and designation headers. */
const matchingMutationHeaders = z.object({
  ...mutationIdentityHeaders,
  [HTTP_HEADER.ifMatch]: applicationEtagSchema.describe(
    'Exactly one strong application ETag: "m3-<uuid-v4>".',
  ),
});

/** Required explicit media type even when a PUT carries zero body bytes. */
const noteContentTypeHeader = z
  .string()
  .regex(SUPPORTED_NOTE_CONTENT_TYPE_PATTERN)
  .openapi({
    description:
      "Required even for an omitted or zero-byte body; parameters and case variants are accepted at runtime.",
  });

/** Closest OpenAPI parameter model for the runtime cross-header XOR requirement. */
const putMutationHeaders = z.object({
  ...mutationIdentityHeaders,
  [HTTP_HEADER.contentType]: noteContentTypeHeader,
  [HTTP_HEADER.ifNoneMatch]: z.literal("*").optional().openapi({
    description:
      "Use alone for absence-only first creation; If-Match must be omitted.",
  }),
  [HTTP_HEADER.ifMatch]: applicationEtagSchema
    .optional()
    .describe(
      "Use alone for an exact live/tombstone generation; If-None-Match must be omitted.",
    ),
});

/** Mandatory cache policy on every API response. */
const cacheControlResponseHeader = {
  [CACHE_CONTROL_HEADER]: {
    schema: { type: "string", const: CACHE_CONTROL_NO_STORE },
    description: "Responses are never reusable from an HTTP cache.",
  },
} as const;

/** Bearer challenge returned with every authentication failure. */
const authenticationChallengeResponseHeader = {
  [WWW_AUTHENTICATE_HEADER]: {
    schema: { type: "string", const: AUTHENTICATION_SCHEME.bearer },
    description: "Required bearer authentication scheme.",
  },
} as const;

/** Strong application-generation response header. */
const applicationEtagResponseHeader = {
  [HTTP_HEADER.etag]: {
    schema: {
      type: "string",
      pattern: APPLICATION_ETAG_PATTERN.source,
    },
    description: 'Strong application ETag: "m3-<uuid-v4>".',
  },
} as const;

/** Public note-format response header for legacy or format-2 current notes. */
const noteFormatResponseHeader = {
  [HTTP_HEADER.noteFormat]: {
    schema: { type: "string", enum: BRIDGE_NOTE_FORMATS.slice() },
    description: "Public representation format.",
  },
} as const;

/** Recovery content is always decoded from a validated format-2 snapshot. */
const recoveryNoteFormatResponseHeader = {
  [HTTP_HEADER.noteFormat]: {
    schema: { type: "string", enum: Array.of(BRIDGE_NOTE_FORMAT.current) },
    description: "Recovery content is always public format 2.",
  },
} as const;

/**
 * Builds the exact JSON error envelope schema for one status-specific error code.
 *
 * @param code - Stable protocol code emitted for the documented status.
 * @returns OpenAPI content entry constrained to that code.
 */
function errorContentForCode(
  code: (typeof API_ERROR_CODE)[keyof typeof API_ERROR_CODE],
) {
  return {
    [JSON_CONTENT_TYPE]: {
      schema: z
        .object({
          error: z
            .object({ code: z.literal(code), message: z.string() })
            .strict(),
        })
        .strict(),
    },
  };
}

/**
 * Builds a 400 envelope constrained to the errors reachable by one route.
 *
 * @param codes - Closed error-code tuple reachable from the route.
 * @returns OpenAPI JSON content with an exact literal or enum code schema.
 */
function badRequestContentForCodes(
  codes:
    | readonly [typeof API_ERROR_CODE.invalidPath]
    | readonly [typeof API_ERROR_CODE.invalidRequest]
    | readonly [
        typeof API_ERROR_CODE.invalidRequest,
        typeof API_ERROR_CODE.invalidBody,
      ]
    | readonly [
        typeof API_ERROR_CODE.invalidPath,
        typeof API_ERROR_CODE.invalidRequest,
        typeof API_ERROR_CODE.invalidBody,
      ],
) {
  const codeSchema = codes.length === 1 ? z.literal(codes[0]) : z.enum(codes);
  return {
    [JSON_CONTENT_TYPE]: {
      schema: z
        .object({
          error: z.object({ code: codeSchema, message: z.string() }).strict(),
        })
        .strict(),
    },
  };
}

/**
 * Adds the mandatory no-store policy to one documented error response.
 *
 * @param content - Status-specific JSON error envelope schema.
 * @param description - Public failure semantics without implementation detail.
 * @returns Complete OpenAPI error response contract.
 */
function documentedError(
  content: Readonly<Record<string, { readonly schema: z.ZodType }>>,
  description: string,
) {
  return { content, description, headers: cacheControlResponseHeader };
}

/** Reusable documented error responses with route-accurate protocol codes. */
const errors = {
  invalidPath: documentedError(
    badRequestContentForCodes([API_ERROR_CODE.invalidPath]),
    "The note route identifier is malformed or noncanonical.",
  ),
  invalidRequest: documentedError(
    badRequestContentForCodes([API_ERROR_CODE.invalidRequest]),
    "Request metadata or schema is malformed.",
  ),
  recoveryMutationBadRequest: documentedError(
    badRequestContentForCodes([
      API_ERROR_CODE.invalidRequest,
      API_ERROR_CODE.invalidBody,
    ]),
    "Recovery mutation metadata or body is malformed.",
  ),
  noteMutationBadRequest: documentedError(
    badRequestContentForCodes([
      API_ERROR_CODE.invalidPath,
      API_ERROR_CODE.invalidRequest,
      API_ERROR_CODE.invalidBody,
    ]),
    "Note path, mutation metadata, or body is malformed.",
  ),
  unauthorized: {
    ...documentedError(
      errorContentForCode(API_ERROR_CODE.unauthorized),
      "Bearer authentication failed.",
    ),
    headers: {
      ...cacheControlResponseHeader,
      ...authenticationChallengeResponseHeader,
    },
  },
  forbidden: documentedError(
    errorContentForCode(API_ERROR_CODE.forbiddenWriter),
    "The authenticated client lacks the operation permission or the static association/writer designation refused the mutation.",
  ),
  notFound: documentedError(
    errorContentForCode(API_ERROR_CODE.notFound),
    "The requested resource was not found.",
  ),
  conflict: documentedError(
    errorContentForCode(API_ERROR_CODE.conflict),
    "Recovery proof or retention policy refuses this transition.",
  ),
  recoveryUnavailable: documentedError(
    errorContentForCode(API_ERROR_CODE.recoveryUnavailable),
    "Sealed recovery content is expired or has been purged.",
  ),
  preconditionFailed: documentedError(
    errorContentForCode(API_ERROR_CODE.preconditionFailed),
    "The application generation is stale or targets the wrong state.",
  ),
  payloadTooLarge: documentedError(
    errorContentForCode(API_ERROR_CODE.payloadTooLarge),
    "The actual streamed UTF-8 body exceeds 1 MiB.",
  ),
  unsupportedMediaType: documentedError(
    errorContentForCode(API_ERROR_CODE.unsupportedMediaType),
    "An explicit text/markdown or text/plain content type is required.",
  ),
  preconditionRequired: documentedError(
    errorContentForCode(API_ERROR_CODE.preconditionRequired),
    "A supported conditional header is required.",
  ),
  internalServerError: documentedError(
    errorContentForCode(API_ERROR_CODE.internalError),
    "Sanitized storage or internal failure.",
  ),
};

/** OpenAPI route for unauthenticated liveness. */
export const healthRoute = createRoute({
  method: toOpenApiMethod(ROUTE_OPERATION_POLICY.public.health.method),
  path: ROUTE_OPERATION_POLICY.public.health.path,
  responses: {
    [HTTP_STATUS.ok]: {
      content: { [JSON_CONTENT_TYPE]: { schema: healthResponseSchema } },
      description: "Worker is available.",
      headers: cacheControlResponseHeader,
    },
    [HTTP_STATUS.internalServerError]: errors.internalServerError,
  },
  summary: "Check Worker health",
  tags: ["system"],
});

/** Authenticated v2 mirror capability description. */
export const getMirrorRoute = createRoute({
  method: toOpenApiMethod(V2_ROUTE_POLICY.mirror.operations.describe),
  path: toOpenApiV2RoutePath(V2_ROUTE_POLICY.mirror.path),
  responses: {
    [HTTP_STATUS.ok]: {
      content: { [JSON_CONTENT_TYPE]: { schema: mirrorDescriptionSchema } },
      description:
        "Protocol limits and configured non-secret writer designation.",
      headers: cacheControlResponseHeader,
    },
    [HTTP_STATUS.unauthorized]: errors.unauthorized,
    [HTTP_STATUS.forbidden]: errors.forbidden,
    [HTTP_STATUS.internalServerError]: errors.internalServerError,
  },
  security: bearerSecurity,
  description: permissionDescription(
    V2_ROUTE_POLICY.mirror.permissions.describe,
  ),
  summary: "Describe mirror capabilities",
  tags: ["v2 mirror"],
});

/** Paginated v2 current-note inventory. */
export const listV2NotesRoute = createRoute({
  method: toOpenApiMethod(V2_ROUTE_POLICY.notes.operations.list),
  path: toOpenApiV2RoutePath(V2_ROUTE_POLICY.notes.path),
  request: { query: cursorQuery },
  responses: {
    [HTTP_STATUS.ok]: {
      content: { [JSON_CONTENT_TYPE]: { schema: notePageSchema } },
      description:
        "At most 50 scanned objects; tombstones are hidden and continuation is opaque.",
      headers: cacheControlResponseHeader,
    },
    [HTTP_STATUS.badRequest]: errors.invalidRequest,
    [HTTP_STATUS.unauthorized]: errors.unauthorized,
    [HTTP_STATUS.forbidden]: errors.forbidden,
    [HTTP_STATUS.internalServerError]: errors.internalServerError,
  },
  security: bearerSecurity,
  description: permissionDescription(V2_ROUTE_POLICY.notes.permissions.list),
  summary: "List one current-note page",
  tags: ["v2 notes"],
});

/** V2 note content read. */
export const getV2NoteRoute = createRoute({
  method: toOpenApiMethod(V2_ROUTE_POLICY.note.operations.read),
  path: toOpenApiV2RoutePath(V2_ROUTE_POLICY.note.path),
  request: { params: notePathParameters },
  responses: {
    [HTTP_STATUS.ok]: {
      content: { [MARKDOWN_CONTENT_TYPE]: { schema: z.string() } },
      description:
        "Raw legacy/live Markdown; live responses include application ETag and Bridge-Note-Format.",
      headers: {
        ...cacheControlResponseHeader,
        ...applicationEtagResponseHeader,
        ...noteFormatResponseHeader,
      },
    },
    [HTTP_STATUS.badRequest]: errors.invalidPath,
    [HTTP_STATUS.unauthorized]: errors.unauthorized,
    [HTTP_STATUS.forbidden]: errors.forbidden,
    [HTTP_STATUS.notFound]: errors.notFound,
    [HTTP_STATUS.internalServerError]: errors.internalServerError,
  },
  security: bearerSecurity,
  description: permissionDescription(V2_ROUTE_POLICY.note.permissions.read),
  summary: "Read current note content",
  tags: ["v2 notes"],
});

/** Metadata-only current state read. */
export const getV2NoteStateRoute = createRoute({
  method: toOpenApiMethod(V2_ROUTE_POLICY.noteState.operations.inspect),
  path: toOpenApiV2RoutePath(V2_ROUTE_POLICY.noteState.path),
  request: { params: notePathParameters },
  responses: {
    [HTTP_STATUS.ok]: {
      content: { [JSON_CONTENT_TYPE]: { schema: currentNoteStateSchema } },
      description:
        "Absent, legacy, live, or tombstone metadata with no note content.",
      headers: {
        ...cacheControlResponseHeader,
        ...applicationEtagResponseHeader,
      },
    },
    [HTTP_STATUS.badRequest]: errors.invalidPath,
    [HTTP_STATUS.unauthorized]: errors.unauthorized,
    [HTTP_STATUS.forbidden]: errors.forbidden,
    [HTTP_STATUS.internalServerError]: errors.internalServerError,
  },
  security: bearerSecurity,
  description: permissionDescription(
    V2_ROUTE_POLICY.noteState.permissions.inspect,
  ),
  summary: "Inspect current note state",
  tags: ["v2 notes"],
});

/** Conditional v2 content mutation. */
export const putV2NoteRoute = createRoute({
  method: toOpenApiMethod(V2_ROUTE_POLICY.note.operations.write),
  path: toOpenApiV2RoutePath(V2_ROUTE_POLICY.note.path),
  request: {
    params: notePathParameters,
    headers: putMutationHeaders,
    body: {
      content: {
        [MARKDOWN_MEDIA_TYPE]: { schema: z.string() },
        [PLAIN_TEXT_MEDIA_TYPE]: { schema: z.string() },
      },
      description:
        "Raw UTF-8 note bytes up to 1 MiB. An omitted body with an explicit supported Content-Type means empty text.",
      required: false,
    },
  },
  responses: {
    [HTTP_STATUS.ok]: {
      content: {
        [JSON_CONTENT_TYPE]: {
          schema: matchingContentMutationAcknowledgementSchema,
        },
      },
      description: "Exact updated or recreated generation.",
      headers: {
        ...cacheControlResponseHeader,
        ...applicationEtagResponseHeader,
      },
    },
    [HTTP_STATUS.created]: {
      content: {
        [JSON_CONTENT_TYPE]: { schema: createMutationAcknowledgementSchema },
      },
      description:
        "Exact absence-only created generation. Content-Type is required even when the body is empty.",
      headers: {
        ...cacheControlResponseHeader,
        ...applicationEtagResponseHeader,
      },
    },
    [HTTP_STATUS.badRequest]: errors.noteMutationBadRequest,
    [HTTP_STATUS.unauthorized]: errors.unauthorized,
    [HTTP_STATUS.forbidden]: errors.forbidden,
    [HTTP_STATUS.preconditionFailed]: errors.preconditionFailed,
    [HTTP_STATUS.payloadTooLarge]: errors.payloadTooLarge,
    [HTTP_STATUS.unsupportedMediaType]: errors.unsupportedMediaType,
    [HTTP_STATUS.preconditionRequired]: errors.preconditionRequired,
    [HTTP_STATUS.internalServerError]: errors.internalServerError,
  },
  security: bearerSecurity,
  description: `${permissionDescription(V2_ROUTE_POLICY.note.permissions.write)} Exactly one precondition is required: If-None-Match: * for create, or one strong If-Match for update/recreate. Supplying neither or both is rejected.`,
  summary: "Conditionally create, update, or recreate a note",
  tags: ["v2 notes"],
});

/** Recovery-first conditional tombstone mutation. */
export const deleteV2NoteRoute = createRoute({
  method: toOpenApiMethod(V2_ROUTE_POLICY.note.operations.remove),
  path: toOpenApiV2RoutePath(V2_ROUTE_POLICY.note.path),
  request: { params: notePathParameters, headers: matchingMutationHeaders },
  responses: {
    [HTTP_STATUS.ok]: {
      content: {
        [JSON_CONTENT_TYPE]: { schema: tombstoneMutationResponseSchema },
      },
      description:
        "Exact tombstone generation and independent recovery sealing result.",
      headers: {
        ...cacheControlResponseHeader,
        ...applicationEtagResponseHeader,
      },
    },
    [HTTP_STATUS.badRequest]: errors.noteMutationBadRequest,
    [HTTP_STATUS.unauthorized]: errors.unauthorized,
    [HTTP_STATUS.forbidden]: errors.forbidden,
    [HTTP_STATUS.preconditionFailed]: errors.preconditionFailed,
    [HTTP_STATUS.payloadTooLarge]: errors.payloadTooLarge,
    [HTTP_STATUS.preconditionRequired]: errors.preconditionRequired,
    [HTTP_STATUS.internalServerError]: errors.internalServerError,
  },
  security: bearerSecurity,
  description: permissionDescription(V2_ROUTE_POLICY.note.permissions.remove),
  summary: "Recoverably tombstone a live note",
  tags: ["v2 notes"],
});

/** Paginated metadata-only recovery inventory. */
export const listRecoveryRoute = createRoute({
  method: toOpenApiMethod(V2_ROUTE_POLICY.recovery.operations.list),
  path: toOpenApiV2RoutePath(V2_ROUTE_POLICY.recovery.path),
  request: { query: cursorQuery },
  responses: {
    [HTTP_STATUS.ok]: {
      content: { [JSON_CONTENT_TYPE]: { schema: recoveryPageSchema } },
      description:
        "At most 50 prepared, sealed, or purged metadata entries without plaintext.",
      headers: cacheControlResponseHeader,
    },
    [HTTP_STATUS.badRequest]: errors.invalidRequest,
    [HTTP_STATUS.unauthorized]: errors.unauthorized,
    [HTTP_STATUS.forbidden]: errors.forbidden,
    [HTTP_STATUS.internalServerError]: errors.internalServerError,
  },
  security: bearerSecurity,
  description: permissionDescription(V2_ROUTE_POLICY.recovery.permissions.list),
  summary: "List recovery metadata",
  tags: ["v2 recovery"],
});

/** Metadata-only recovery item. */
export const getRecoveryRoute = createRoute({
  method: toOpenApiMethod(V2_ROUTE_POLICY.recoveryItem.operations.inspect),
  path: toOpenApiV2RoutePath(V2_ROUTE_POLICY.recoveryItem.path),
  request: { params: recoveryIdParameters },
  responses: {
    [HTTP_STATUS.ok]: {
      content: { [JSON_CONTENT_TYPE]: { schema: recoverySnapshotStateSchema } },
      description:
        "Recovery metadata only; use the distinct content endpoint for text.",
      headers: {
        ...cacheControlResponseHeader,
        ...applicationEtagResponseHeader,
      },
    },
    [HTTP_STATUS.badRequest]: errors.invalidRequest,
    [HTTP_STATUS.unauthorized]: errors.unauthorized,
    [HTTP_STATUS.forbidden]: errors.forbidden,
    [HTTP_STATUS.notFound]: errors.notFound,
    [HTTP_STATUS.internalServerError]: errors.internalServerError,
  },
  security: bearerSecurity,
  description: permissionDescription(
    V2_ROUTE_POLICY.recoveryItem.permissions.inspect,
  ),
  summary: "Inspect recovery metadata",
  tags: ["v2 recovery"],
});

/** Separate read-only recovery content endpoint. */
export const getRecoveryContentRoute = createRoute({
  method: toOpenApiMethod(V2_ROUTE_POLICY.recoveryContent.operations.read),
  path: toOpenApiV2RoutePath(V2_ROUTE_POLICY.recoveryContent.path),
  request: { params: recoveryIdParameters },
  responses: {
    [HTTP_STATUS.ok]: {
      content: { [MARKDOWN_CONTENT_TYPE]: { schema: z.string() } },
      description: "Prepared or unexpired sealed recovery text.",
      headers: {
        ...cacheControlResponseHeader,
        ...applicationEtagResponseHeader,
        ...recoveryNoteFormatResponseHeader,
      },
    },
    [HTTP_STATUS.badRequest]: errors.invalidRequest,
    [HTTP_STATUS.unauthorized]: errors.unauthorized,
    [HTTP_STATUS.forbidden]: errors.forbidden,
    [HTTP_STATUS.notFound]: errors.notFound,
    [HTTP_STATUS.gone]: errors.recoveryUnavailable,
    [HTTP_STATUS.internalServerError]: errors.internalServerError,
  },
  security: bearerSecurity,
  description: permissionDescription(
    V2_ROUTE_POLICY.recoveryContent.permissions.read,
  ),
  summary: "Read recoverable text",
  tags: ["v2 recovery"],
});

/**
 * Creates a conditional recovery maintenance route.
 *
 * @param action - Recovery transition represented by the route.
 * @returns OpenAPI route definition for explicit seal or purge.
 */
function recoveryMutationRoute(
  action:
    | typeof MIRROR_API_V2_SEGMENT.seal
    | typeof MIRROR_API_V2_SEGMENT.purge,
) {
  const isSeal = action === MIRROR_API_V2_SEGMENT.seal;
  const acknowledgementSchema = isSeal
    ? sealedRecoverySnapshotStateSchema
    : purgedRecoverySnapshotStateSchema;
  const method = isSeal
    ? V2_ROUTE_POLICY.recoverySeal.operations.seal
    : V2_ROUTE_POLICY.recoveryPurge.operations.purge;
  const path = isSeal
    ? V2_ROUTE_POLICY.recoverySeal.path
    : V2_ROUTE_POLICY.recoveryPurge.path;
  return createRoute({
    method: toOpenApiMethod(method),
    path: toOpenApiV2RoutePath(path),
    request: { params: recoveryIdParameters, headers: matchingMutationHeaders },
    responses: {
      [HTTP_STATUS.ok]: {
        content: {
          [JSON_CONTENT_TYPE]: { schema: acknowledgementSchema },
        },
        description: `Exact recovery generation after ${action}.`,
        headers: {
          ...cacheControlResponseHeader,
          ...applicationEtagResponseHeader,
        },
      },
      [HTTP_STATUS.badRequest]: errors.recoveryMutationBadRequest,
      [HTTP_STATUS.unauthorized]: errors.unauthorized,
      [HTTP_STATUS.forbidden]: errors.forbidden,
      [HTTP_STATUS.notFound]: errors.notFound,
      [HTTP_STATUS.conflict]: errors.conflict,
      [HTTP_STATUS.preconditionFailed]: errors.preconditionFailed,
      [HTTP_STATUS.payloadTooLarge]: errors.payloadTooLarge,
      [HTTP_STATUS.preconditionRequired]: errors.preconditionRequired,
      [HTTP_STATUS.internalServerError]: errors.internalServerError,
    },
    security: bearerSecurity,
    description: permissionDescription(
      isSeal
        ? V2_ROUTE_POLICY.recoverySeal.permissions.seal
        : V2_ROUTE_POLICY.recoveryPurge.permissions.purge,
    ),
    summary: isSeal
      ? "Seal prepared recovery"
      : "Purge expired recovery content",
    tags: ["v2 recovery"],
  });
}

/** Explicit recovery sealing route. */
export const sealRecoveryRoute = recoveryMutationRoute(
  MIRROR_API_V2_SEGMENT.seal,
);

/** Explicit expired recovery purge route. */
export const purgeRecoveryRoute = recoveryMutationRoute(
  MIRROR_API_V2_SEGMENT.purge,
);

/** OpenAPI 3.1 metadata and bearer security configuration. */
export const openApiConfiguration = {
  openapi: "3.1.0",
  info: { title: "AI Bridge Worker API", version: "0.1.0" },
  components: {
    securitySchemes: {
      [OPENAPI_BEARER_SECURITY_SCHEME]: {
        scheme: AUTHENTICATION_SCHEME.bearer.toLowerCase(),
        type: "http",
      },
    },
  },
} as const;
