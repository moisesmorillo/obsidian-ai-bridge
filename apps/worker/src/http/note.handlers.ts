import {
  CURRENT_CONTENT_RESULT_KIND,
  decodeNotePath,
  type NotePath,
} from "@obsidian-ai-bridge/core";
import {
  API_ERROR_CODE,
  API_ROUTE_PARAMETER,
  HEALTH_STATUS,
  type HealthResponse,
  type NoteListResponse,
} from "@obsidian-ai-bridge/protocol";
import {
  createBadRequestResponse,
  createErrorResponse,
  createJsonResponse,
  createNoteContentResponse,
  createNotFoundResponse,
} from "@worker/http/api-responses";
import type { WorkerContext } from "@worker/http/hono.types";
import { HTTP_STATUS } from "@worker/http/http.constants";

/** Finite aggregation budget for the legacy complete-list route; exhaustion fails rather than returning a misleading partial list. */
const MAX_V1_LIST_PAGES = 1000;

/**
 * Reads one route parameter only when the original URL uses its literal spelling.
 *
 * Hono exposes URI-decoded parameters. Canonical note and recovery identifiers do
 * not contain percent signs, so accepting a decoded alias would give one resource
 * multiple HTTP spellings.
 *
 * @param context - Request carrying the untrusted route parameter.
 * @param name - Registered Hono parameter name.
 * @returns The Hono value only when no route segment was percent-encoded.
 */
export function literalRequestRouteParameter(
  context: WorkerContext,
  name: (typeof API_ROUTE_PARAMETER)[keyof typeof API_ROUTE_PARAMETER],
): string | undefined {
  if (new URL(context.req.url).pathname.includes("%")) return undefined;
  return context.req.param(name);
}

/**
 * Decodes one canonical literal route identifier without path-segment repair.
 *
 * @param context - Request carrying the encoded route segment.
 * @returns Validated path or `undefined` for malformed/noncanonical input.
 */
export function decodeRequestNotePath(
  context: WorkerContext,
): NotePath | undefined {
  const encodedPath = literalRequestRouteParameter(
    context,
    API_ROUTE_PARAMETER.notePath,
  );
  return encodedPath === undefined ? undefined : decodeNotePath(encodedPath);
}

/**
 * Creates the handler for the unauthenticated liveness endpoint.
 *
 * @returns A handler producing the stable health response.
 */
export function createHealthHandler() {
  return (context: WorkerContext) => {
    const response: HealthResponse = { status: HEALTH_STATUS.ok };
    return createJsonResponse(context, response, HTTP_STATUS.ok);
  };
}

/**
 * Creates the retained complete v1 note-list handler over envelope-aware pages.
 *
 * @returns A handler aggregating visible legacy/live paths.
 */
export function createListNotesHandler() {
  return async (context: WorkerContext) => {
    const notes = new Set<NotePath>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await context.var.mirrorServices.current.list(cursor);
      page.notes.forEach((path) => {
        notes.add(path);
      });
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      if (pages >= MAX_V1_LIST_PAGES && cursor !== undefined) {
        throw new Error("V1 inventory page limit exceeded");
      }
    } while (cursor !== undefined);

    const response: NoteListResponse = { notes: [...notes].sort() };
    return createJsonResponse(context, response, HTTP_STATUS.ok);
  };
}

/**
 * Creates the envelope-aware retained v1 content-read handler.
 *
 * @returns A handler decoding live envelopes and hiding tombstones.
 */
export function createGetNoteHandler() {
  return async (context: WorkerContext) => {
    const path = decodeRequestNotePath(context);
    if (path === undefined) {
      return createBadRequestResponse(context, API_ERROR_CODE.invalidPath);
    }

    const result = await context.var.mirrorServices.current.readContent(path);
    switch (result.kind) {
      case CURRENT_CONTENT_RESULT_KIND.absent:
      case CURRENT_CONTENT_RESULT_KIND.tombstone:
        return createNotFoundResponse(context);
      case CURRENT_CONTENT_RESULT_KIND.legacy:
      case CURRENT_CONTENT_RESULT_KIND.live:
        return createNoteContentResponse(context, result.content);
    }
  };
}

/**
 * Creates the authenticated v1 PUT retirement handler with no body or storage read.
 *
 * @returns A handler producing `410 mutation_api_retired`.
 */
export function createPutNoteHandler() {
  return (_context: WorkerContext) =>
    createErrorResponse(API_ERROR_CODE.mutationApiRetired);
}

/**
 * Creates the authenticated v1 DELETE retirement handler with no storage operation.
 *
 * @returns A handler producing `410 mutation_api_retired`.
 */
export function createDeleteNoteHandler() {
  return (_context: WorkerContext) =>
    createErrorResponse(API_ERROR_CODE.mutationApiRetired);
}

/**
 * Creates the fallback handler for hierarchical item URLs.
 *
 * @returns A handler producing a sanitized invalid-path response.
 */
export function createInvalidPathHandler() {
  return (context: WorkerContext) =>
    createBadRequestResponse(context, API_ERROR_CODE.invalidPath);
}

/**
 * Creates the fallback handler for unsupported methods on valid note IDs.
 *
 * @returns A handler preserving invalid-path and not-found behavior.
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
