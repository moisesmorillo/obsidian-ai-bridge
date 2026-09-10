import {
  API_ERROR_CODE,
  type ApiErrorCode,
} from "@obsidian-ai-bridge/protocol";
import {
  AUTHENTICATION_SCHEME,
  WWW_AUTHENTICATE_HEADER,
} from "@worker/auth/auth.constants";
import {
  CACHE_CONTROL_HEADER,
  CACHE_CONTROL_NO_STORE,
  HTTP_HEADER,
  JSON_RESPONSE_CONTENT_TYPE,
  MARKDOWN_CONTENT_TYPE,
} from "@worker/http/http.constants";

/** Common cache policy applied to every body-bearing M1 response. */
const COMMON_RESPONSE_HEADERS = {
  [CACHE_CONTROL_HEADER]: CACHE_CONTROL_NO_STORE,
};

/**
 * Builds headers shared by JSON API responses.
 *
 * @returns Cache and media-type headers for a JSON response.
 */
export function createJsonResponseHeaders() {
  return {
    ...COMMON_RESPONSE_HEADERS,
    [HTTP_HEADER.contentType]: JSON_RESPONSE_CONTENT_TYPE,
  };
}

/**
 * Builds headers for a JSON error response, including an auth challenge when required.
 *
 * @param code - Protocol error code represented by the response.
 * @returns Cache, media-type, and conditional authentication headers.
 */
export function createApiErrorResponseHeaders(code: ApiErrorCode) {
  if (code !== API_ERROR_CODE.unauthorized) {
    return createJsonResponseHeaders();
  }

  return {
    ...createJsonResponseHeaders(),
    [WWW_AUTHENTICATE_HEADER]: AUTHENTICATION_SCHEME.bearer,
  };
}

/**
 * Builds headers for a Markdown note-content response.
 *
 * @returns Cache and Markdown media-type headers.
 */
export function createNoteContentResponseHeaders() {
  return {
    ...COMMON_RESPONSE_HEADERS,
    [HTTP_HEADER.contentType]: MARKDOWN_CONTENT_TYPE,
  };
}
