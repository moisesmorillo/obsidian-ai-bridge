import { API_ERROR_CODE } from "@obsidian-ai-bridge/protocol";
import { createErrorResponse } from "@worker/http/api-responses";
import type { WorkerMiddleware } from "@worker/http/hono.types";
import {
  API_V2_PREFIX,
  CACHE_CONTROL_HEADER,
  CACHE_CONTROL_NO_STORE,
  HTTP_HEADER,
  HTTP_STATUS,
  MIRROR_ROUTE,
  RECOVERY_ROUTE,
  V2_CORS_ALLOWED_HEADERS,
  V2_CORS_EXPOSED_HEADERS,
  V2_NOTES_ROUTE,
} from "@worker/http/http.constants";

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
 * Resolves registered methods for one exact v2 route shape.
 *
 * @param pathname - URL pathname without query data.
 * @returns Exact allowed methods, or `undefined` for an unknown route.
 */
function registeredMethods(pathname: string): readonly string[] | undefined {
  if (pathname === MIRROR_ROUTE || pathname === V2_NOTES_ROUTE) return ["GET"];
  if (pathname === RECOVERY_ROUTE) return ["GET"];
  if (/^\/api\/v2\/notes\/[^/]+\/state$/.test(pathname)) return ["GET"];
  if (/^\/api\/v2\/notes\/[^/]+$/.test(pathname)) {
    return ["GET", "PUT", "DELETE"];
  }
  if (/^\/api\/v2\/recovery\/[^/]+\/content$/.test(pathname)) {
    return ["GET"];
  }
  if (/^\/api\/v2\/recovery\/[^/]+\/(seal|purge)$/.test(pathname)) {
    return ["POST"];
  }
  if (/^\/api\/v2\/recovery\/[^/]+$/.test(pathname)) return ["GET"];
  return undefined;
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

    const methods = registeredMethods(pathname);
    if (context.req.method === "OPTIONS" && methods !== undefined) {
      const origin = context.req.header(HTTP_HEADER.origin);
      const requestedMethod = context.req.header(
        HTTP_HEADER.accessControlRequestMethod,
      );
      const requestedHeaders = context.req.header(
        HTTP_HEADER.accessControlRequestHeaders,
      );
      if (
        origin === undefined ||
        origin.trim() === "" ||
        requestedMethod === undefined ||
        !methods.includes(requestedMethod.toUpperCase()) ||
        !requestedHeadersAreAllowed(requestedHeaders ?? null)
      ) {
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
    if (methods === undefined || !methods.includes(context.req.method)) {
      return context.res;
    }
    return applyCorsHeaders(context.res);
  };
}
