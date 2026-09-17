import { API_ERROR_CODE } from "@obsidian-ai-bridge/protocol";
import { createErrorResponse } from "@worker/http/api-responses";
import type { WorkerMiddleware } from "@worker/http/hono.types";
import {
  API_V2_PREFIX,
  CACHE_CONTROL_HEADER,
  CACHE_CONTROL_NO_STORE,
  HTTP_HEADER,
  HTTP_STATUS,
  V2_CORS_ALLOWED_HEADERS,
  V2_CORS_EXPOSED_HEADERS,
} from "@worker/http/http.constants";
import {
  resolveV2RouteMethods,
  type V2RouteMethod,
} from "@worker/http/v2-route-policy";

/** Case-insensitive preflight lookup derived from the canonical browser request-header policy. */
const ALLOWED_HEADER_NAMES = new Set(
  V2_CORS_ALLOWED_HEADERS.map((header) => header.toLowerCase()),
);

/**
 * Adds v2 CORS response metadata without enabling credential cookies.
 *
 * @param response - Response produced by a v2 route or error boundary.
 * @returns The same response with narrow browser-readable headers.
 */
function applyCorsHeaders(response: Response): Response {
  response.headers.set(HTTP_HEADER.accessControlAllowOrigin, "*");
  response.headers.set(
    HTTP_HEADER.accessControlExposeHeaders,
    V2_CORS_EXPOSED_HEADERS.join(", "),
  );
  return response;
}

/**
 * Validates comma-separated requested browser header names.
 *
 * @param value - Access-Control-Request-Headers value.
 * @returns Whether every unique requested header is explicitly allowed.
 */
function requestedHeadersAreAllowed(value: string | null): boolean {
  if (value === null || value.trim() === "") return true;
  const names = value.split(",").map((name) => name.trim().toLowerCase());
  return (
    names.every((name) => name !== "" && ALLOWED_HEADER_NAMES.has(name)) &&
    new Set(names).size === names.length
  );
}

/**
 * Validates the complete metadata required by one registered preflight.
 *
 * @param headers - Untrusted request headers.
 * @param methods - Exact methods allowed for the matched public route shape.
 * @returns Whether origin, method, and requested-header metadata are accepted.
 */
function isValidPreflightRequest(
  headers: Headers,
  methods: readonly V2RouteMethod[],
): boolean {
  const origin = headers.get(HTTP_HEADER.origin);
  if (origin === null || origin.trim() === "") return false;

  const requestedMethod = headers.get(HTTP_HEADER.accessControlRequestMethod);
  if (requestedMethod === null) return false;
  if (!methods.some((method) => method === requestedMethod.toUpperCase())) {
    return false;
  }

  return requestedHeadersAreAllowed(
    headers.get(HTTP_HEADER.accessControlRequestHeaders),
  );
}

/**
 * Applies narrow route-aware CORS and handles registered preflight without storage.
 *
 * Unknown v2 OPTIONS requests continue to bearer authentication. Registered
 * preflights validate the requested method/header set and never invoke downstream
 * service-composition or route handlers.
 *
 * @returns Middleware adding CORS only to registered v2 method responses.
 */
export function createV2CorsMiddleware(): WorkerMiddleware {
  return async (context, next) => {
    const pathname = new URL(context.req.url).pathname;
    if (!pathname.startsWith(API_V2_PREFIX)) {
      await next();
      return;
    }

    const methods = resolveV2RouteMethods(pathname);
    if (context.req.method === "OPTIONS" && methods !== undefined) {
      if (!isValidPreflightRequest(context.req.raw.headers, methods)) {
        return applyCorsHeaders(
          createErrorResponse(API_ERROR_CODE.invalidRequest),
        );
      }

      return new Response(null, {
        status: HTTP_STATUS.noContent,
        headers: {
          [HTTP_HEADER.accessControlAllowOrigin]: "*",
          [HTTP_HEADER.accessControlAllowMethods]: methods.join(", "),
          [HTTP_HEADER.accessControlAllowHeaders]:
            V2_CORS_ALLOWED_HEADERS.join(", "),
          [HTTP_HEADER.accessControlExposeHeaders]:
            V2_CORS_EXPOSED_HEADERS.join(", "),
          [CACHE_CONTROL_HEADER]: CACHE_CONTROL_NO_STORE,
        },
      });
    }

    await next();
    if (
      methods === undefined ||
      !methods.some((method) => method === context.req.method)
    ) {
      return context.res;
    }
    return applyCorsHeaders(context.res);
  };
}
