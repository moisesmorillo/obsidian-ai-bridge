import { createRoute, z } from "@hono/zod-openapi";
import {
  apiErrorResponseSchema,
  healthResponseSchema,
  noteListResponseSchema,
  noteWriteResponseSchema,
} from "@obsidian-ai-bridge/protocol";
import { AUTHENTICATION_SCHEME } from "@worker/auth/auth.constants";
import {
  HEALTH_ROUTE,
  HTTP_STATUS,
  JSON_CONTENT_TYPE,
  MARKDOWN_CONTENT_TYPE,
  MARKDOWN_MEDIA_TYPE,
  NOTES_ROUTE,
  PLAIN_TEXT_MEDIA_TYPE,
} from "@worker/http/http.constants";

/** OpenAPI security requirement shared by authenticated note routes. */
const bearerSecurity = [{ bearerAuth: [] }];

/** OpenAPI parameter schema for canonical encoded note identifiers. */
const notePathParameters = z.object({
  path: z.string().min(1).openapi({
    description:
      "Canonical unpadded base64url identifier for a normalized Markdown note path.",
    example: "SG9tZWxhYi9ETlMvVGVjaG5pdGl1bS5tZA",
  }),
});
/** Shared JSON error content declaration for OpenAPI responses. */
const errorContent = {
  [JSON_CONTENT_TYPE]: { schema: apiErrorResponseSchema },
};

/** OpenAPI route definition for the unauthenticated health endpoint. */
export const healthRoute = createRoute({
  method: "get",
  path: HEALTH_ROUTE,
  responses: {
    [HTTP_STATUS.ok]: {
      content: { [JSON_CONTENT_TYPE]: { schema: healthResponseSchema } },
      description: "Worker is available.",
    },
    [HTTP_STATUS.internalServerError]: {
      content: errorContent,
      description: "Unexpected failure.",
    },
  },
  summary: "Check Worker health",
  tags: ["system"],
});

/** OpenAPI route definition for listing authenticated notes. */
export const listNotesRoute = createRoute({
  method: "get",
  path: NOTES_ROUTE,
  responses: {
    [HTTP_STATUS.ok]: {
      content: { [JSON_CONTENT_TYPE]: { schema: noteListResponseSchema } },
      description: "Sorted list of stored normalized Markdown paths.",
    },
    [HTTP_STATUS.unauthorized]: {
      content: errorContent,
      description: "Bearer authentication failed.",
    },
    [HTTP_STATUS.internalServerError]: {
      content: errorContent,
      description: "Unexpected failure.",
    },
  },
  security: bearerSecurity,
  summary: "List notes",
  tags: ["notes"],
});

/** OpenAPI route definition for reading one authenticated note. */
export const getNoteRoute = createRoute({
  method: "get",
  path: `${NOTES_ROUTE}/{path}`,
  request: { params: notePathParameters },
  responses: {
    [HTTP_STATUS.ok]: {
      content: { [MARKDOWN_CONTENT_TYPE]: { schema: z.string() } },
      description: "Markdown note content.",
    },
    [HTTP_STATUS.badRequest]: {
      content: errorContent,
      description: "Invalid note identifier.",
    },
    [HTTP_STATUS.unauthorized]: {
      content: errorContent,
      description: "Bearer authentication failed.",
    },
    [HTTP_STATUS.notFound]: {
      content: errorContent,
      description: "Note does not exist.",
    },
    [HTTP_STATUS.internalServerError]: {
      content: errorContent,
      description: "Unexpected failure.",
    },
  },
  security: bearerSecurity,
  summary: "Read a note",
  tags: ["notes"],
});

/** OpenAPI route definition for creating or replacing one note. */
export const putNoteRoute = createRoute({
  method: "put",
  path: `${NOTES_ROUTE}/{path}`,
  request: {
    params: notePathParameters,
    body: {
      content: {
        [MARKDOWN_MEDIA_TYPE]: { schema: z.string() },
        [PLAIN_TEXT_MEDIA_TYPE]: { schema: z.string() },
      },
      description: "Raw UTF-8 Markdown or plain-text note content up to 1 MiB.",
      required: true,
    },
  },
  responses: {
    [HTTP_STATUS.ok]: {
      content: { [JSON_CONTENT_TYPE]: { schema: noteWriteResponseSchema } },
      description: "Existing note replaced.",
    },
    [HTTP_STATUS.created]: {
      content: { [JSON_CONTENT_TYPE]: { schema: noteWriteResponseSchema } },
      description: "Note created.",
    },
    [HTTP_STATUS.badRequest]: {
      content: errorContent,
      description: "Invalid path or UTF-8 body.",
    },
    [HTTP_STATUS.unauthorized]: {
      content: errorContent,
      description: "Bearer authentication failed.",
    },
    [HTTP_STATUS.payloadTooLarge]: {
      content: errorContent,
      description: "Note exceeds 1 MiB.",
    },
    [HTTP_STATUS.unsupportedMediaType]: {
      content: errorContent,
      description: "Unsupported content type.",
    },
    [HTTP_STATUS.internalServerError]: {
      content: errorContent,
      description: "Unexpected failure.",
    },
  },
  security: bearerSecurity,
  summary: "Create or replace a note",
  tags: ["notes"],
});

/** OpenAPI route definition for idempotently deleting one note. */
export const deleteNoteRoute = createRoute({
  method: "delete",
  path: `${NOTES_ROUTE}/{path}`,
  request: { params: notePathParameters },
  responses: {
    [HTTP_STATUS.noContent]: { description: "Note deleted or already absent." },
    [HTTP_STATUS.badRequest]: {
      content: errorContent,
      description: "Invalid note identifier.",
    },
    [HTTP_STATUS.unauthorized]: {
      content: errorContent,
      description: "Bearer authentication failed.",
    },
    [HTTP_STATUS.internalServerError]: {
      content: errorContent,
      description: "Unexpected failure.",
    },
  },
  security: bearerSecurity,
  summary: "Delete a note",
  tags: ["notes"],
});

/** OpenAPI document metadata and security-scheme configuration for M1. */
export const openApiConfiguration = {
  openapi: "3.1.0",
  info: { title: "AI Bridge M1 API", version: "0.1.0" },
  components: {
    securitySchemes: {
      bearerAuth: {
        scheme: AUTHENTICATION_SCHEME.bearer.toLowerCase(),
        type: "http",
      },
    },
  },
} as const;
