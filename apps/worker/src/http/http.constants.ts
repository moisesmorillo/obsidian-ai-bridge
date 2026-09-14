/** Versioned URL prefix for the retained M1 API. */
export const API_V1_PREFIX = "/api/v1";

/** Versioned URL prefix for the conditional mirror API. */
export const API_V2_PREFIX = "/api/v2";

/** Backward-compatible alias for the retained v1 prefix. */
export const API_PREFIX = API_V1_PREFIX;

/** Unauthenticated liveness endpoint route. */
export const HEALTH_ROUTE = "/health";

/** Retained v1 note collection route. */
export const NOTES_ROUTE = `${API_V1_PREFIX}/notes`;

/** V2 mirror capability route. */
export const MIRROR_ROUTE = `${API_V2_PREFIX}/mirror`;

/** V2 current-note collection route. */
export const V2_NOTES_ROUTE = `${API_V2_PREFIX}/notes`;

/** V2 recovery collection route. */
export const RECOVERY_ROUTE = `${API_V2_PREFIX}/recovery`;

/** Route serving the generated OpenAPI document. */
export const OPENAPI_ROUTE = "/openapi.json";

/** Route serving the interactive Scalar API reference. */
export const API_REFERENCE_ROUTE = "/docs";

/** HTTP header names consumed or emitted by the Worker transport. */
export const HTTP_HEADER = {
  accessControlAllowHeaders: "Access-Control-Allow-Headers",
  accessControlAllowMethods: "Access-Control-Allow-Methods",
  accessControlAllowOrigin: "Access-Control-Allow-Origin",
  accessControlExposeHeaders: "Access-Control-Expose-Headers",
  accessControlRequestHeaders: "Access-Control-Request-Headers",
  accessControlRequestMethod: "Access-Control-Request-Method",
  associationId: "Bridge-Association-Id",
  authorization: "Authorization",
  contentLength: "Content-Length",
  contentType: "Content-Type",
  etag: "ETag",
  ifMatch: "If-Match",
  ifModifiedSince: "If-Modified-Since",
  ifNoneMatch: "If-None-Match",
  ifUnmodifiedSince: "If-Unmodified-Since",
  noteFormat: "Bridge-Note-Format",
  operationId: "Bridge-Operation-Id",
  origin: "Origin",
  writerId: "Bridge-Writer-Id",
} as const;

/** Headers accepted by narrowly scoped v2 CORS preflight. */
export const V2_CORS_ALLOWED_HEADERS = [
  HTTP_HEADER.authorization,
  HTTP_HEADER.contentType,
  HTTP_HEADER.ifMatch,
  HTTP_HEADER.ifNoneMatch,
  HTTP_HEADER.operationId,
  HTTP_HEADER.associationId,
  HTTP_HEADER.writerId,
] as const;

/** Response metadata visible to browser Fetch clients. */
export const V2_CORS_EXPOSED_HEADERS = [
  HTTP_HEADER.etag,
  HTTP_HEADER.noteFormat,
] as const;

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

/** Flagless JSON-Schema-compatible syntax for supported note media types. */
export const SUPPORTED_NOTE_CONTENT_TYPE_PATTERN =
  /^\s*[Tt][Ee][Xx][Tt]\/(?:[Mm][Aa][Rr][Kk][Dd][Oo][Ww][Nn]|[Pp][Ll][Aa][Ii][Nn])\s*(?:;.*)?$/;

/** HTTP status values used by the Worker transport. */
export const HTTP_STATUS = {
  ok: 200,
  created: 201,
  noContent: 204,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  gone: 410,
  preconditionFailed: 412,
  payloadTooLarge: 413,
  unsupportedMediaType: 415,
  preconditionRequired: 428,
  internalServerError: 500,
  badGateway: 502,
} as const;
