/** Stable protocol version for shared envelope contracts. */
export const PROTOCOL_VERSION = "0.1" as const;

/** Capability identifier returned by the authenticated M3 Worker description. */
export const MIRROR_PROTOCOL_ID = "obsidian-ai-bridge-mirror-v2" as const;

/** Stable public URL prefix for the conditional mirror HTTP API. */
export const MIRROR_API_V2_PREFIX = "/api/v2";

/** Stable public route roots for the conditional mirror HTTP API. */
export const MIRROR_API_V2_ROUTE = {
  mirror: `${MIRROR_API_V2_PREFIX}/mirror`,
  notes: `${MIRROR_API_V2_PREFIX}/notes`,
  recovery: `${MIRROR_API_V2_PREFIX}/recovery`,
} as const;

/** Public HTTP headers shared by v2 clients, documentation, and the Worker. */
export const MIRROR_HTTP_HEADER = {
  associationId: "Bridge-Association-Id",
  authorization: "Authorization",
  contentType: "Content-Type",
  etag: "ETag",
  ifMatch: "If-Match",
  ifNoneMatch: "If-None-Match",
  noteFormat: "Bridge-Note-Format",
  operationId: "Bridge-Operation-Id",
  writerId: "Bridge-Writer-Id",
} as const;

/** Public media types used by v2 request and response representations. */
export const MIRROR_MEDIA_TYPE = {
  json: "application/json",
  jsonUtf8: "application/json; charset=utf-8",
  markdown: "text/markdown",
  markdownUtf8: "text/markdown; charset=utf-8",
  plainText: "text/plain",
} as const;

/** Public note representation markers exposed without private storage metadata. */
export const BRIDGE_NOTE_FORMAT = {
  legacy: "legacy",
  current: "2",
} as const;

/** Ordered public note formats used by response-header schemas. */
export const BRIDGE_NOTE_FORMATS = [
  BRIDGE_NOTE_FORMAT.legacy,
  BRIDGE_NOTE_FORMAT.current,
] as const;

/**
 * Stable error codes exposed by the Worker HTTP API.
 *
 * These values are part of the public wire contract and must not be changed
 * without a protocol versioning decision.
 */
export const API_ERROR_CODE = {
  unauthorized: "unauthorized",
  forbiddenWriter: "forbidden_writer",
  invalidPath: "invalid_path",
  invalidRequest: "invalid_request",
  unsupportedMediaType: "unsupported_media_type",
  invalidBody: "invalid_body",
  payloadTooLarge: "payload_too_large",
  notFound: "not_found",
  conflict: "conflict",
  mutationApiRetired: "mutation_api_retired",
  recoveryUnavailable: "recovery_unavailable",
  preconditionFailed: "precondition_failed",
  preconditionRequired: "precondition_required",
  internalError: "internal_error",
} as const;

/** Ordered protocol error-code values used by runtime schemas and iteration. */
export const API_ERROR_CODES = [
  API_ERROR_CODE.unauthorized,
  API_ERROR_CODE.forbiddenWriter,
  API_ERROR_CODE.invalidPath,
  API_ERROR_CODE.invalidRequest,
  API_ERROR_CODE.unsupportedMediaType,
  API_ERROR_CODE.invalidBody,
  API_ERROR_CODE.payloadTooLarge,
  API_ERROR_CODE.notFound,
  API_ERROR_CODE.conflict,
  API_ERROR_CODE.mutationApiRetired,
  API_ERROR_CODE.recoveryUnavailable,
  API_ERROR_CODE.preconditionFailed,
  API_ERROR_CODE.preconditionRequired,
  API_ERROR_CODE.internalError,
] as const;

/** Stable health status returned by the unauthenticated liveness endpoint. */
export const HEALTH_STATUS = { ok: "ok" } as const;
