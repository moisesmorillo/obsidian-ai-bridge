/** Versioned URL prefix for the public M1 API. */
export const API_PREFIX = "/api/v1";

/** Unauthenticated liveness endpoint route. */
export const HEALTH_ROUTE = "/health";

/** Collection route for vault notes. */
export const NOTES_ROUTE = `${API_PREFIX}/notes`;

/** Route serving the generated OpenAPI document. */
export const OPENAPI_ROUTE = "/openapi.json";

/** Route serving the interactive Scalar API reference. */
export const API_REFERENCE_ROUTE = "/docs";

/** HTTP header names consumed by the Worker transport. */
export const HTTP_HEADER = {
  contentLength: "Content-Length",
  contentType: "Content-Type",
} as const;

/** HTTP header controlling cache behavior for API responses. */
export const CACHE_CONTROL_HEADER = "Cache-Control";

/** Cache policy applied to responses containing vault or auth-related data. */
export const CACHE_CONTROL_NO_STORE = "no-store";

/** Media type returned when a note is read. */
export const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

/** Media type used in OpenAPI response content declarations. */
export const JSON_CONTENT_TYPE = "application/json";

/** Media type returned for JSON API envelopes. */
export const JSON_RESPONSE_CONTENT_TYPE = "application/json; charset=utf-8";

/** Accepted Markdown request media type without parameters. */
export const MARKDOWN_MEDIA_TYPE = "text/markdown";

/** Accepted plain-text request media type without parameters. */
export const PLAIN_TEXT_MEDIA_TYPE = "text/plain";

/** Raw-text media types accepted by note writes. */
export const SUPPORTED_NOTE_MEDIA_TYPES = [
  MARKDOWN_MEDIA_TYPE,
  PLAIN_TEXT_MEDIA_TYPE,
] as const;

/** HTTP status values used by the M1 transport. */
export const HTTP_STATUS = {
  ok: 200,
  created: 201,
  noContent: 204,
  badRequest: 400,
  unauthorized: 401,
  notFound: 404,
  payloadTooLarge: 413,
  unsupportedMediaType: 415,
  internalServerError: 500,
} as const;
