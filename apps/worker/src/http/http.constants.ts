export const API_PREFIX = "/api/v1";
export const HEALTH_ROUTE = "/health";
export const NOTES_ROUTE = `${API_PREFIX}/notes`;
export const OPENAPI_ROUTE = "/openapi.json";
export const API_REFERENCE_ROUTE = "/docs";

/** HTTP header names consumed by the Worker transport. */
export const HTTP_HEADER = {
  contentLength: "Content-Length",
  contentType: "Content-Type",
} as const;

export const CACHE_CONTROL_HEADER = "Cache-Control";
export const CACHE_CONTROL_NO_STORE = "no-store";
export const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";
export const JSON_CONTENT_TYPE = "application/json";
export const JSON_RESPONSE_CONTENT_TYPE = "application/json; charset=utf-8";
export const MARKDOWN_MEDIA_TYPE = "text/markdown";
export const PLAIN_TEXT_MEDIA_TYPE = "text/plain";
export const SUPPORTED_NOTE_MEDIA_TYPES = [
  MARKDOWN_MEDIA_TYPE,
  PLAIN_TEXT_MEDIA_TYPE,
] as const;

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

export const API_ERROR_MESSAGE = {
  unauthorized: "Authentication is required.",
  invalid_path: "The note path is invalid.",
  unsupported_media_type:
    "The request body must use Markdown or plain text content.",
  invalid_body: "The request body must be valid UTF-8 text.",
  payload_too_large: "The note exceeds the 1 MiB size limit.",
  not_found: "The requested resource was not found.",
  internal_error: "An internal error occurred.",
} as const;
