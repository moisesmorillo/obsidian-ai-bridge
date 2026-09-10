import {
  API_ERROR_CODE,
  type ApiErrorCode,
} from "@obsidian-ai-bridge/protocol";
import {
  createApiErrorResponse,
  getApiErrorDefinition,
} from "@worker/http/api-errors";
import type { JsonResponseBody } from "@worker/http/api-responses.types";
import type { WorkerContext } from "@worker/http/hono.types";
import { HTTP_STATUS } from "@worker/http/http.constants";
import type {
  ClientErrorStatus,
  SuccessfulJsonStatus,
} from "@worker/http/http.types";
import {
  createApiErrorResponseHeaders,
  createJsonResponseHeaders,
  createNoteContentResponseHeaders,
} from "@worker/http/http-response-headers";

/**
 * Creates an uncached JSON response with the stable M1 media type.
 *
 * @param context - Typed Worker request context used to serialize the body.
 * @param body - Protocol or transport response body.
 * @param status - Successful HTTP status for the response.
 * @returns The serialized JSON response.
 */
export function createJsonResponse<
  Body extends JsonResponseBody,
  Status extends SuccessfulJsonStatus,
>(context: WorkerContext, body: Body, status: Status) {
  return context.json(body, status, createJsonResponseHeaders());
}

/**
 * Maps a stable error code to the public M1 error envelope and status.
 *
 * @param code - Protocol error code selected by the transport boundary.
 * @returns A sanitized JSON error response with the mapped status.
 */
export function createErrorResponse(code: ApiErrorCode): Response {
  const definition = getApiErrorDefinition(code);

  return new Response(JSON.stringify(createApiErrorResponse(code)), {
    status: definition.status,
    headers: createApiErrorResponseHeaders(code),
  });
}

/**
 * Serializes an API error through a typed Worker context.
 *
 * @param context - Typed Worker request context used to serialize the body.
 * @param code - Protocol error code selected by the transport boundary.
 * @param status - HTTP error status associated with the handler branch.
 * @returns The serialized JSON error response.
 */
function createTypedErrorResponse<Status extends ClientErrorStatus>(
  context: WorkerContext,
  code: ApiErrorCode,
  status: Status,
) {
  return context.json(
    createApiErrorResponse(code),
    status,
    createApiErrorResponseHeaders(code),
  );
}

/**
 * Creates a 400 response for path and request-body validation failures.
 *
 * @param context - Typed Worker request context used to serialize the response.
 * @param code - Specific protocol error explaining the validation failure.
 * @returns The mapped bad-request response.
 */
export function createBadRequestResponse(
  context: WorkerContext,
  code: typeof API_ERROR_CODE.invalidPath | typeof API_ERROR_CODE.invalidBody,
) {
  return createTypedErrorResponse(context, code, HTTP_STATUS.badRequest);
}

/**
 * Creates a 401 response with the required bearer-authentication challenge.
 *
 * @param context - Typed Worker request context used to serialize the response.
 * @returns The authentication challenge response.
 */
export function createUnauthorizedResponse(context: WorkerContext) {
  return createTypedErrorResponse(
    context,
    API_ERROR_CODE.unauthorized,
    HTTP_STATUS.unauthorized,
  );
}

/**
 * Creates a 404 response that does not reveal implementation details.
 *
 * @param context - Typed Worker request context used to serialize the response.
 * @returns The not-found response.
 */
export function createNotFoundResponse(context: WorkerContext) {
  return createTypedErrorResponse(
    context,
    API_ERROR_CODE.notFound,
    HTTP_STATUS.notFound,
  );
}

/**
 * Creates a 413 response for note payloads above the configured limit.
 *
 * @param context - Typed Worker request context used to serialize the response.
 * @returns The payload-too-large response.
 */
export function createPayloadTooLargeResponse(context: WorkerContext) {
  return createTypedErrorResponse(
    context,
    API_ERROR_CODE.payloadTooLarge,
    HTTP_STATUS.payloadTooLarge,
  );
}

/**
 * Creates a 415 response for request bodies outside the raw-text contract.
 *
 * @param context - Typed Worker request context used to serialize the response.
 * @returns The unsupported-media-type response.
 */
export function createUnsupportedMediaTypeResponse(context: WorkerContext) {
  return createTypedErrorResponse(
    context,
    API_ERROR_CODE.unsupportedMediaType,
    HTTP_STATUS.unsupportedMediaType,
  );
}

/**
 * Creates the established plain-text note response.
 *
 * @param context - Typed Worker request context used to serialize the response.
 * @param content - Note content returned without adding transport markup.
 * @returns The Markdown content response.
 */
export function createNoteContentResponse(
  context: WorkerContext,
  content: string,
) {
  return context.text(
    content,
    HTTP_STATUS.ok,
    createNoteContentResponseHeaders(),
  );
}
