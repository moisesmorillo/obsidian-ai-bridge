import {
  decodeNotePath,
  NotePayloadTooLargeError,
} from "@obsidian-ai-bridge/core";
import {
  API_ERROR_CODE,
  HEALTH_STATUS,
  type HealthResponse,
  type NoteListResponse,
  type NoteWriteResponse,
} from "@obsidian-ai-bridge/protocol";
import {
  createBadRequestResponse,
  createJsonResponse,
  createNoteContentResponse,
  createNotFoundResponse,
  createPayloadTooLargeResponse,
  createUnsupportedMediaTypeResponse,
} from "@worker/http/api-responses";
import type { WorkerContext } from "@worker/http/hono.types";
import { HTTP_HEADER, HTTP_STATUS } from "@worker/http/http.constants";
import { readNoteBody } from "@worker/http/note-body";
import { NOTE_BODY_RESULT_KIND } from "@worker/http/note-body.constants";
import { isSupportedNoteContentType } from "@worker/http/note-content-type";

/**
 * Decodes the route parameter without allowing it to escape the item route.
 *
 * @param context - Typed request context containing the encoded route segment.
 * @returns The validated note path, or `undefined` when the identifier is invalid.
 */
function decodeRequestNotePath(context: WorkerContext) {
  const encodedPath = context.req.param("path");
  return encodedPath === undefined ? undefined : decodeNotePath(encodedPath);
}

/**
 * Creates the handler for the unauthenticated liveness endpoint.
 *
 * @returns A handler that returns the stable health response.
 */
export function createHealthHandler() {
  return (context: WorkerContext) => {
    const response: HealthResponse = { status: HEALTH_STATUS.ok };
    return createJsonResponse(context, response, HTTP_STATUS.ok);
  };
}

/**
 * Creates the handler for authenticated note-list requests.
 *
 * @returns A handler that delegates note enumeration to the request service.
 */
export function createListNotesHandler() {
  return async (context: WorkerContext) => {
    const response: NoteListResponse = {
      notes: await context.var.noteService.list(),
    };
    return createJsonResponse(context, response, HTTP_STATUS.ok);
  };
}

/**
 * Creates the handler for reads addressed by canonical base64url note identifiers.
 *
 * @returns A handler that maps invalid identifiers and absent notes to API errors.
 */
export function createGetNoteHandler() {
  return async (context: WorkerContext) => {
    const path = decodeRequestNotePath(context);
    if (path === undefined) {
      return createBadRequestResponse(context, API_ERROR_CODE.invalidPath);
    }

    const content = await context.var.noteService.read(path);
    if (content === null) {
      return createNotFoundResponse(context);
    }

    return createNoteContentResponse(context, content);
  };
}

/**
 * Creates the handler for bounded UTF-8 Markdown and plain-text note writes.
 *
 * @returns A handler that validates transport input before invoking the note service.
 * @throws Rethrows unexpected service failures for the application error boundary.
 */
export function createPutNoteHandler() {
  return async (context: WorkerContext) => {
    const path = decodeRequestNotePath(context);
    if (path === undefined) {
      return createBadRequestResponse(context, API_ERROR_CODE.invalidPath);
    }
    if (
      !isSupportedNoteContentType(context.req.header(HTTP_HEADER.contentType))
    ) {
      return createUnsupportedMediaTypeResponse(context);
    }

    const body = await readNoteBody(context.req.raw);
    switch (body.kind) {
      case NOTE_BODY_RESULT_KIND.tooLarge:
        return createPayloadTooLargeResponse(context);
      case NOTE_BODY_RESULT_KIND.invalidEncoding:
        return createBadRequestResponse(context, API_ERROR_CODE.invalidBody);
      case NOTE_BODY_RESULT_KIND.ok:
        break;
      default: {
        const unexpectedBody: never = body;
        throw new Error(
          `Unexpected note-body result: ${String(unexpectedBody)}`,
        );
      }
    }

    try {
      const result = await context.var.noteService.write(path, body.content);
      const response: NoteWriteResponse = { path, stored: true };
      return createJsonResponse(
        context,
        response,
        result.created ? HTTP_STATUS.created : HTTP_STATUS.ok,
      );
    } catch (error) {
      if (error instanceof NotePayloadTooLargeError) {
        return createPayloadTooLargeResponse(context);
      }
      throw error;
    }
  };
}

/**
 * Creates the handler for idempotent note deletion.
 *
 * @returns A handler that delegates one validated delete operation and returns 204.
 */
export function createDeleteNoteHandler() {
  return async (context: WorkerContext) => {
    const path = decodeRequestNotePath(context);
    if (path === undefined) {
      return createBadRequestResponse(context, API_ERROR_CODE.invalidPath);
    }

    await context.var.noteService.delete(path);
    return new Response(null, { status: HTTP_STATUS.noContent });
  };
}

/**
 * Creates the fallback handler for hierarchical item URLs.
 *
 * @returns A handler that preserves the M1 invalid-path response.
 */
export function createInvalidPathHandler() {
  return (context: WorkerContext) =>
    createBadRequestResponse(context, API_ERROR_CODE.invalidPath);
}

/**
 * Creates the fallback handler for unsupported methods on valid note IDs.
 *
 * @returns A handler that preserves invalid-path and not-found semantics.
 */
export function createUnsupportedNoteMethodHandler() {
  return (context: WorkerContext) => {
    const path = decodeRequestNotePath(context);
    if (path === undefined) {
      return createBadRequestResponse(context, API_ERROR_CODE.invalidPath);
    }

    return createNotFoundResponse(context);
  };
}
