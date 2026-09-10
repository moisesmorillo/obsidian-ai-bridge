import type {
  ApiErrorCode,
  ApiErrorResponse,
  HealthResponse,
  NoteListResponse,
  NoteWriteResponse,
} from "@obsidian-ai-bridge/protocol";
import {
  AUTHENTICATION_SCHEME,
  WWW_AUTHENTICATE_HEADER,
} from "@worker/auth/auth.constants";
import {
  createApiErrorResponse,
  getApiErrorDefinition,
} from "@worker/http/api-errors";
import {
  CACHE_CONTROL_HEADER,
  CACHE_CONTROL_NO_STORE,
  HTTP_STATUS,
  JSON_RESPONSE_CONTENT_TYPE,
  MARKDOWN_CONTENT_TYPE,
} from "@worker/http/http.constants";
import type { Context } from "hono";

type JsonResponseBody =
  | ApiErrorResponse
  | HealthResponse
  | NoteListResponse
  | NoteWriteResponse;

/** Creates an uncached JSON response with the stable M1 media type. */
export function createJsonResponse<
  Body extends JsonResponseBody,
  Status extends 200 | 201,
>(context: Context, body: Body, status: Status) {
  return context.json(body, status, {
    [CACHE_CONTROL_HEADER]: CACHE_CONTROL_NO_STORE,
    "Content-Type": JSON_RESPONSE_CONTENT_TYPE,
  });
}

/** Maps a stable error code to the public M1 error envelope and status. */
export function createErrorResponse(code: ApiErrorCode): Response {
  const definition = getApiErrorDefinition(code);
  const headers = new Headers({
    [CACHE_CONTROL_HEADER]: CACHE_CONTROL_NO_STORE,
    "Content-Type": JSON_RESPONSE_CONTENT_TYPE,
  });

  if (code === "unauthorized") {
    headers.set(WWW_AUTHENTICATE_HEADER, AUTHENTICATION_SCHEME.bearer);
  }

  return new Response(JSON.stringify(createApiErrorResponse(code)), {
    status: definition.status,
    headers,
  });
}

/** Serializes an API error with a status that may carry a response body. */
function createTypedErrorResponse<Status extends 400 | 401 | 404 | 413 | 415>(
  context: Context,
  code: ApiErrorCode,
  status: Status,
) {
  return context.json(createApiErrorResponse(code), status, {
    [CACHE_CONTROL_HEADER]: CACHE_CONTROL_NO_STORE,
    "Content-Type": JSON_RESPONSE_CONTENT_TYPE,
  });
}

/** Creates a 400 response for path and request-body validation failures. */
export function createBadRequestResponse(
  context: Context,
  code: "invalid_path" | "invalid_body",
) {
  return createTypedErrorResponse(context, code, HTTP_STATUS.badRequest);
}

/** Creates a 401 response with the required bearer-authentication challenge. */
export function createUnauthorizedResponse(context: Context) {
  return context.json(
    createApiErrorResponse("unauthorized"),
    HTTP_STATUS.unauthorized,
    {
      [CACHE_CONTROL_HEADER]: CACHE_CONTROL_NO_STORE,
      "Content-Type": JSON_RESPONSE_CONTENT_TYPE,
      [WWW_AUTHENTICATE_HEADER]: AUTHENTICATION_SCHEME.bearer,
    },
  );
}

/** Creates a 404 response that does not reveal implementation details. */
export function createNotFoundResponse(context: Context) {
  return createTypedErrorResponse(context, "not_found", HTTP_STATUS.notFound);
}

/** Creates a 413 response for note payloads above the configured limit. */
export function createPayloadTooLargeResponse(context: Context) {
  return createTypedErrorResponse(
    context,
    "payload_too_large",
    HTTP_STATUS.payloadTooLarge,
  );
}

/** Creates a 415 response for request bodies outside the raw-text contract. */
export function createUnsupportedMediaTypeResponse(context: Context) {
  return createTypedErrorResponse(
    context,
    "unsupported_media_type",
    HTTP_STATUS.unsupportedMediaType,
  );
}

/** Creates the established plain-text note response. */
export function createNoteContentResponse(context: Context, content: string) {
  return context.text(content, HTTP_STATUS.ok, {
    [CACHE_CONTROL_HEADER]: CACHE_CONTROL_NO_STORE,
    "Content-Type": MARKDOWN_CONTENT_TYPE,
  });
}
