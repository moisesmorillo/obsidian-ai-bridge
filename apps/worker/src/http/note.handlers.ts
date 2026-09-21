import { decodeNotePath, type NotePath } from "@obsidian-ai-bridge/core";
import {
  API_ROUTE_PARAMETER,
  HEALTH_STATUS,
  type HealthResponse,
} from "@obsidian-ai-bridge/protocol";
import { createJsonResponse } from "@worker/http/api-responses";
import type { WorkerContext } from "@worker/http/hono.types";
import { HTTP_STATUS } from "@worker/http/http.constants";

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
