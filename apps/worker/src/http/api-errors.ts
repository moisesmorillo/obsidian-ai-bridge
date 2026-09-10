import type {
  ApiErrorCode,
  ApiErrorResponse,
} from "@obsidian-ai-bridge/protocol";
import { API_ERROR_MESSAGE, HTTP_STATUS } from "@worker/http/http.constants";
import type { ApiErrorDefinition } from "@worker/http/http.types";

const API_ERROR_DEFINITIONS: {
  readonly [Code in ApiErrorCode]: ApiErrorDefinition;
} = {
  unauthorized: {
    code: "unauthorized",
    message: API_ERROR_MESSAGE.unauthorized,
    status: HTTP_STATUS.unauthorized,
  },
  invalid_path: {
    code: "invalid_path",
    message: API_ERROR_MESSAGE.invalid_path,
    status: HTTP_STATUS.badRequest,
  },
  unsupported_media_type: {
    code: "unsupported_media_type",
    message: API_ERROR_MESSAGE.unsupported_media_type,
    status: HTTP_STATUS.unsupportedMediaType,
  },
  invalid_body: {
    code: "invalid_body",
    message: API_ERROR_MESSAGE.invalid_body,
    status: HTTP_STATUS.badRequest,
  },
  payload_too_large: {
    code: "payload_too_large",
    message: API_ERROR_MESSAGE.payload_too_large,
    status: HTTP_STATUS.payloadTooLarge,
  },
  not_found: {
    code: "not_found",
    message: API_ERROR_MESSAGE.not_found,
    status: HTTP_STATUS.notFound,
  },
  internal_error: {
    code: "internal_error",
    message: API_ERROR_MESSAGE.internal_error,
    status: HTTP_STATUS.internalServerError,
  },
};

/** Resolves the HTTP-only representation of a stable protocol error. */
export function getApiErrorDefinition(code: ApiErrorCode): ApiErrorDefinition {
  return API_ERROR_DEFINITIONS[code];
}

/** Builds a protocol-compatible error envelope without implementation details. */
export function createApiErrorResponse(code: ApiErrorCode): ApiErrorResponse {
  const definition = getApiErrorDefinition(code);
  return { error: { code: definition.code, message: definition.message } };
}
