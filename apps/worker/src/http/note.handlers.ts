import {
  decodeNotePath,
  deleteNote,
  listNotes,
  NotePayloadTooLargeError,
  readNote,
  writeNote,
} from "@obsidian-ai-bridge/core";
import type {
  HealthResponse,
  NoteListResponse,
  NoteWriteResponse,
} from "@obsidian-ai-bridge/protocol";
import {
  createBadRequestResponse,
  createJsonResponse,
  createNoteContentResponse,
  createNotFoundResponse,
  createPayloadTooLargeResponse,
  createUnsupportedMediaTypeResponse,
} from "@worker/http/api-responses";
import type { HandlerDependencies } from "@worker/http/handlers.types";
import { HTTP_STATUS } from "@worker/http/http.constants";
import { readNoteBody } from "@worker/http/note-body";
import { isSupportedNoteContentType } from "@worker/http/note-content-type";
import type { Context } from "hono";

/** Decodes the route parameter without allowing it to escape the item route. */
function decodeRequestNotePath(context: Context) {
  const encodedPath = context.req.param("path");
  return encodedPath === undefined ? undefined : decodeNotePath(encodedPath);
}

/** Handles the unauthenticated liveness endpoint. */
export function createHealthHandler() {
  return (context: Context) => {
    const response: HealthResponse = { status: "ok" };
    return createJsonResponse(context, response, HTTP_STATUS.ok);
  };
}

/** Handles authenticated note-list requests. */
export function createListNotesHandler(dependencies: HandlerDependencies) {
  return async (context: Context) => {
    const response: NoteListResponse = {
      notes: [...(await listNotes(dependencies.repository))],
    };
    return createJsonResponse(context, response, HTTP_STATUS.ok);
  };
}

/** Handles reads for canonical base64url note identifiers. */
export function createGetNoteHandler(dependencies: HandlerDependencies) {
  return async (context: Context) => {
    const path = decodeRequestNotePath(context);
    if (path === undefined) {
      return createBadRequestResponse(context, "invalid_path");
    }

    const content = await readNote(dependencies.repository, path);
    if (content === null) {
      return createNotFoundResponse(context);
    }

    return createNoteContentResponse(context, content);
  };
}

/** Handles bounded UTF-8 Markdown and plain-text note writes. */
export function createPutNoteHandler(dependencies: HandlerDependencies) {
  return async (context: Context) => {
    const path = decodeRequestNotePath(context);
    if (path === undefined) {
      return createBadRequestResponse(context, "invalid_path");
    }
    if (!isSupportedNoteContentType(context.req.header("Content-Type"))) {
      return createUnsupportedMediaTypeResponse(context);
    }

    const body = await readNoteBody(context.req.raw);
    if (body.kind === "too_large") {
      return createPayloadTooLargeResponse(context);
    }
    if (body.kind === "invalid_encoding") {
      return createBadRequestResponse(context, "invalid_body");
    }

    try {
      const result = await writeNote(
        dependencies.repository,
        path,
        body.content,
      );
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

/** Handles idempotent note deletion for canonical identifiers. */
export function createDeleteNoteHandler(dependencies: HandlerDependencies) {
  return async (context: Context) => {
    const path = decodeRequestNotePath(context);
    if (path === undefined) {
      return createBadRequestResponse(context, "invalid_path");
    }

    await deleteNote(dependencies.repository, path);
    return new Response(null, { status: HTTP_STATUS.noContent });
  };
}

/** Retains the M1 invalid-path response for hierarchical item URLs. */
export function createInvalidPathHandler() {
  return (context: Context) =>
    createBadRequestResponse(context, "invalid_path");
}

/** Preserves the not-found result for unsupported methods on valid note IDs. */
export function createUnsupportedNoteMethodHandler() {
  return (context: Context) => {
    const path = decodeRequestNotePath(context);
    if (path === undefined) {
      return createBadRequestResponse(context, "invalid_path");
    }

    return createNotFoundResponse(context);
  };
}
