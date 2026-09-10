import type {
  ApiErrorCode,
  ApiErrorResponse,
} from "@obsidian-ai-bridge/protocol";
import { API_ERROR_DEFINITIONS } from "@worker/http/api-errors.constants";
import type { ApiErrorDefinition } from "@worker/http/http.types";

/**
 * Resolves the HTTP-only representation of a stable protocol error.
 *
 * @param code - Protocol error code to map to HTTP metadata.
 * @returns The Worker transport definition for the error.
 */
export function getApiErrorDefinition(code: ApiErrorCode): ApiErrorDefinition {
  return API_ERROR_DEFINITIONS[code];
}

/**
 * Builds a protocol-compatible error envelope without implementation details.
 *
 * @param code - Protocol error code to expose in the envelope.
 * @returns A sanitized public API error response.
 */
export function createApiErrorResponse(code: ApiErrorCode): ApiErrorResponse {
  const definition = getApiErrorDefinition(code);
  return { error: { code: definition.code, message: definition.message } };
}
