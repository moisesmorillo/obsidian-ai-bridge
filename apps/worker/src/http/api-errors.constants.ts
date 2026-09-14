import {
  API_ERROR_CODE,
  type ApiErrorCode,
} from "@obsidian-ai-bridge/protocol";
import { HTTP_STATUS } from "@worker/http/http.constants";
import type { ApiErrorDefinition } from "@worker/http/http.types";

/** Stable user-facing messages paired with protocol error codes. */
export const API_ERROR_MESSAGE: {
  readonly [Code in ApiErrorCode]: string;
} = {
  [API_ERROR_CODE.unauthorized]: "Authentication is required.",
  [API_ERROR_CODE.forbiddenWriter]:
    "The configured mirror does not designate this writer.",
  [API_ERROR_CODE.invalidPath]: "The note path is invalid.",
  [API_ERROR_CODE.invalidRequest]: "The request metadata is invalid.",
  [API_ERROR_CODE.unsupportedMediaType]:
    "The request body must use Markdown or plain text content.",
  [API_ERROR_CODE.invalidBody]: "The request body must be valid UTF-8 text.",
  [API_ERROR_CODE.payloadTooLarge]: "The note exceeds the 1 MiB size limit.",
  [API_ERROR_CODE.notFound]: "The requested resource was not found.",
  [API_ERROR_CODE.conflict]:
    "The requested transition is not currently allowed.",
  [API_ERROR_CODE.mutationApiRetired]:
    "This mutation API has been retired; use the conditional v2 API.",
  [API_ERROR_CODE.recoveryUnavailable]:
    "Recovery content is no longer available.",
  [API_ERROR_CODE.preconditionFailed]:
    "The supplied application generation is stale or targets the wrong state.",
  [API_ERROR_CODE.preconditionRequired]:
    "A supported conditional request header is required.",
  [API_ERROR_CODE.internalError]: "An internal error occurred.",
};

/** Worker status mapping for every stable protocol error code. */
export const API_ERROR_DEFINITIONS: {
  readonly [Code in ApiErrorCode]: ApiErrorDefinition;
} = {
  [API_ERROR_CODE.unauthorized]: definition(
    API_ERROR_CODE.unauthorized,
    HTTP_STATUS.unauthorized,
  ),
  [API_ERROR_CODE.forbiddenWriter]: definition(
    API_ERROR_CODE.forbiddenWriter,
    HTTP_STATUS.forbidden,
  ),
  [API_ERROR_CODE.invalidPath]: definition(
    API_ERROR_CODE.invalidPath,
    HTTP_STATUS.badRequest,
  ),
  [API_ERROR_CODE.invalidRequest]: definition(
    API_ERROR_CODE.invalidRequest,
    HTTP_STATUS.badRequest,
  ),
  [API_ERROR_CODE.unsupportedMediaType]: definition(
    API_ERROR_CODE.unsupportedMediaType,
    HTTP_STATUS.unsupportedMediaType,
  ),
  [API_ERROR_CODE.invalidBody]: definition(
    API_ERROR_CODE.invalidBody,
    HTTP_STATUS.badRequest,
  ),
  [API_ERROR_CODE.payloadTooLarge]: definition(
    API_ERROR_CODE.payloadTooLarge,
    HTTP_STATUS.payloadTooLarge,
  ),
  [API_ERROR_CODE.notFound]: definition(
    API_ERROR_CODE.notFound,
    HTTP_STATUS.notFound,
  ),
  [API_ERROR_CODE.conflict]: definition(
    API_ERROR_CODE.conflict,
    HTTP_STATUS.conflict,
  ),
  [API_ERROR_CODE.mutationApiRetired]: definition(
    API_ERROR_CODE.mutationApiRetired,
    HTTP_STATUS.gone,
  ),
  [API_ERROR_CODE.recoveryUnavailable]: definition(
    API_ERROR_CODE.recoveryUnavailable,
    HTTP_STATUS.gone,
  ),
  [API_ERROR_CODE.preconditionFailed]: definition(
    API_ERROR_CODE.preconditionFailed,
    HTTP_STATUS.preconditionFailed,
  ),
  [API_ERROR_CODE.preconditionRequired]: definition(
    API_ERROR_CODE.preconditionRequired,
    HTTP_STATUS.preconditionRequired,
  ),
  [API_ERROR_CODE.internalError]: definition(
    API_ERROR_CODE.internalError,
    HTTP_STATUS.internalServerError,
  ),
};

/**
 * Builds one definition while keeping protocol code/message pairs synchronized.
 *
 * @param code - Stable protocol error identity.
 * @param status - HTTP status assigned by the Worker transport.
 * @returns Complete sanitized error definition.
 */
function definition<Code extends ApiErrorCode>(
  code: Code,
  status: ApiErrorDefinition["status"],
): ApiErrorDefinition {
  return { code, message: API_ERROR_MESSAGE[code], status };
}
