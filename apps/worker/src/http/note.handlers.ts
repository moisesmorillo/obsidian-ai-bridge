import { decodeNotePath, type NotePath } from "@obsidian-ai-bridge/core";
import { API_ROUTE_PARAMETER } from "@obsidian-ai-bridge/protocol";
import type { WorkerContext } from "@worker/http/hono.types";

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
