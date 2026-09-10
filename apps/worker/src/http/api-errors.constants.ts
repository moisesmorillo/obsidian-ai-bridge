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
  [API_ERROR_CODE.invalidPath]: "The note path is invalid.",
  [API_ERROR_CODE.unsupportedMediaType]:
    "The request body must use Markdown or plain text content.",
  [API_ERROR_CODE.invalidBody]: "The request body must be valid UTF-8 text.",
  [API_ERROR_CODE.payloadTooLarge]: "The note exceeds the 1 MiB size limit.",
  [API_ERROR_CODE.notFound]: "The requested resource was not found.",
  [API_ERROR_CODE.internalError]: "An internal error occurred.",
};

/**
 * HTTP status and message metadata for each stable protocol error code.
 *
 * The computed keys and `code` values reference the protocol source of truth;
 * this table only adds Worker-specific transport metadata.
 */
export const API_ERROR_DEFINITIONS: {
  readonly [Code in ApiErrorCode]: ApiErrorDefinition;
} = {
  [API_ERROR_CODE.unauthorized]: {
    code: API_ERROR_CODE.unauthorized,
    message: API_ERROR_MESSAGE[API_ERROR_CODE.unauthorized],
    status: HTTP_STATUS.unauthorized,
  },
  [API_ERROR_CODE.invalidPath]: {
    code: API_ERROR_CODE.invalidPath,
    message: API_ERROR_MESSAGE[API_ERROR_CODE.invalidPath],
    status: HTTP_STATUS.badRequest,
  },
  [API_ERROR_CODE.unsupportedMediaType]: {
    code: API_ERROR_CODE.unsupportedMediaType,
    message: API_ERROR_MESSAGE[API_ERROR_CODE.unsupportedMediaType],
    status: HTTP_STATUS.unsupportedMediaType,
  },
  [API_ERROR_CODE.invalidBody]: {
    code: API_ERROR_CODE.invalidBody,
    message: API_ERROR_MESSAGE[API_ERROR_CODE.invalidBody],
    status: HTTP_STATUS.badRequest,
  },
  [API_ERROR_CODE.payloadTooLarge]: {
    code: API_ERROR_CODE.payloadTooLarge,
    message: API_ERROR_MESSAGE[API_ERROR_CODE.payloadTooLarge],
    status: HTTP_STATUS.payloadTooLarge,
  },
  [API_ERROR_CODE.notFound]: {
    code: API_ERROR_CODE.notFound,
    message: API_ERROR_MESSAGE[API_ERROR_CODE.notFound],
    status: HTTP_STATUS.notFound,
  },
  [API_ERROR_CODE.internalError]: {
    code: API_ERROR_CODE.internalError,
    message: API_ERROR_MESSAGE[API_ERROR_CODE.internalError],
    status: HTTP_STATUS.internalServerError,
  },
};
