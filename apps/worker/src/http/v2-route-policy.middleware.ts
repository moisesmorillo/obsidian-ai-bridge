import { API_ERROR_CODE } from "@obsidian-ai-bridge/protocol";
import { createErrorResponse } from "@worker/http/api-responses";
import type { WorkerMiddleware } from "@worker/http/hono.types";
import { resolveV2RouteMethods } from "@worker/http/v2-route-policy";

/**
 * Enforces canonical v2 route shapes and exact methods after authentication.
 *
 * Hono routes `HEAD` through matching `GET` handlers and matches decoded static
 * segments. This guard prevents those implicit framework behaviors from widening
 * the explicitly declared API or running storage-backed handlers.
 *
 * @returns Middleware rejecting noncanonical aliases and undeclared methods.
 */
export function createV2RoutePolicyGuardMiddleware(): WorkerMiddleware {
  return async (context, next) => {
    const rawPathname = new URL(context.req.url).pathname;
    const rawMethods = resolveV2RouteMethods(rawPathname);
    const routedMethods = resolveV2RouteMethods(context.req.path);
    const isNoncanonicalAlias =
      routedMethods !== undefined && rawMethods === undefined;
    const isUndeclaredMethod =
      rawMethods !== undefined &&
      !rawMethods.some((method) => method === context.req.method);

    if (isNoncanonicalAlias || isUndeclaredMethod) {
      return createErrorResponse(API_ERROR_CODE.notFound);
    }

    await next();
  };
}
