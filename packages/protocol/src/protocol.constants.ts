/** Stable protocol version for shared envelope contracts. */
export const PROTOCOL_VERSION = "0.1" as const;

/**
 * Stable error codes exposed by the M1 HTTP API.
 *
 * These values are part of the public wire contract and must not be changed
 * without a protocol versioning decision.
 */
export const API_ERROR_CODE = {
  unauthorized: "unauthorized",
  invalidPath: "invalid_path",
  unsupportedMediaType: "unsupported_media_type",
  invalidBody: "invalid_body",
  payloadTooLarge: "payload_too_large",
  notFound: "not_found",
  internalError: "internal_error",
} as const;

/** Ordered protocol error-code values used by runtime schemas and iteration. */
export const API_ERROR_CODES = [
  API_ERROR_CODE.unauthorized,
  API_ERROR_CODE.invalidPath,
  API_ERROR_CODE.unsupportedMediaType,
  API_ERROR_CODE.invalidBody,
  API_ERROR_CODE.payloadTooLarge,
  API_ERROR_CODE.notFound,
  API_ERROR_CODE.internalError,
] as const;

/** Stable health status returned by the unauthenticated liveness endpoint. */
export const HEALTH_STATUS = { ok: "ok" } as const;
