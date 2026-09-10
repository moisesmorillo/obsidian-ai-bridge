/** Stable protocol version for shared envelope contracts. */
export const PROTOCOL_VERSION = "0.1" as const;

/** Stable error codes exposed by the M1 HTTP API. */
export const API_ERROR_CODES = [
  "unauthorized",
  "invalid_path",
  "unsupported_media_type",
  "invalid_body",
  "payload_too_large",
  "not_found",
  "internal_error",
] as const;
