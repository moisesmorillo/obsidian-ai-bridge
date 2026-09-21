import {
  API_ERROR_CODE,
  type ApiErrorCode,
  apiErrorResponseSchema,
  HTTP_METHOD,
} from "@obsidian-ai-bridge/protocol";
import type { WorkerContext, WorkerMiddleware } from "@worker/http/hono.types";
import {
  API_REFERENCE_ROUTE,
  HEALTH_ROUTE,
  HTTP_STATUS,
  NOTES_ROUTE,
  OPENAPI_ROUTE,
} from "@worker/http/http.constants";
import { resolveV2LogOperationCategory } from "@worker/http/v2-route-policy";
import type {
  Logger,
  LogOperationCategory,
  RequestAuthenticationAttribution,
} from "@worker/logging/logger.types";
import {
  LOG_AUTHENTICATION_RESULT,
  LOG_OPERATION,
  LOG_OPERATION_CATEGORY,
  UNMATCHED_ROUTE_LABEL,
} from "@worker/logging/logging.constants";
import { routePath } from "hono/route";

/** Hono method used for public CORS capability discovery. */
const CORS_PREFLIGHT_METHOD = "OPTIONS";

/** Hono catch-all template normalized to the bounded unknown route label. */
const HONO_NOT_FOUND_ROUTE = "/*";

/** Registered public routes that perform no client authentication. */
const PUBLIC_ROUTES = new Set([
  API_REFERENCE_ROUTE,
  HEALTH_ROUTE,
  OPENAPI_ROUTE,
]);

/** Registered v1 item route retained until Slice 4 compatibility removal. */
const V1_NOTE_ROUTE = `${NOTES_ROUTE}/:path`;

/**
 * Logs one content-free diagnostic projection after the complete response is produced.
 *
 * @param logger - Structured logger that receives non-sensitive request metadata.
 * @returns Middleware that records bounded route, principal, operation, and outcome data.
 */
export function createRequestLoggingMiddleware(
  logger: Logger,
): WorkerMiddleware {
  return async (context, next) => {
    const startedAt = performance.now();
    await next();
    const completedAt = performance.now();
    const resolvedRoute = routePath(context);
    const registeredRoute =
      resolvedRoute === undefined || resolvedRoute === HONO_NOT_FOUND_ROUTE
        ? UNMATCHED_ROUTE_LABEL
        : resolvedRoute;
    const errorCode = await resolveApiErrorCode(context.res);

    logger.info({
      operation: LOG_OPERATION.httpRequest,
      operationCategory: resolveLogOperationCategory(context, registeredRoute),
      method: context.req.method,
      route: registeredRoute,
      status: context.res.status,
      ...(errorCode === undefined ? {} : { errorCode }),
      durationMs: Math.round((completedAt - startedAt) * 100) / 100,
      ...resolveAuthenticationAttribution(context, errorCode),
    });
  };
}

/**
 * Projects only stable sanitized API error identity from an error response.
 *
 * Raw text and parse failures are deliberately discarded, so an unexpected response
 * can never add exception or body detail to the event.
 *
 * @param response - Completed Worker response.
 * @returns Stable protocol error code, or `undefined` for success/non-API responses.
 */
async function resolveApiErrorCode(
  response: Response,
): Promise<ApiErrorCode | undefined> {
  if (response.status < HTTP_STATUS.badRequest) return undefined;

  try {
    const parsed = apiErrorResponseSchema.safeParse(
      await response.clone().json(),
    );
    return parsed.success ? parsed.data.error.code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Projects authentication outcome from the published principal and sanitized status.
 *
 * Public and rejected requests never fabricate client identity. Authentication
 * parsing detail remains private to the authentication owner.
 *
 * @param context - Completed request context.
 * @param errorCode - Stable sanitized API outcome when one was returned.
 * @returns Closed attribution with client ID only for an authenticated principal.
 */
function resolveAuthenticationAttribution(
  context: WorkerContext,
  errorCode: ApiErrorCode | undefined,
): RequestAuthenticationAttribution {
  const principal = context.var.clientPrincipal;
  if (principal !== undefined) {
    return {
      authentication: LOG_AUTHENTICATION_RESULT.authenticated,
      clientId: principal.clientId,
    };
  }

  return {
    authentication:
      errorCode === API_ERROR_CODE.unauthorized
        ? LOG_AUTHENTICATION_RESULT.rejected
        : LOG_AUTHENTICATION_RESULT.public,
  };
}

/**
 * Resolves one bounded operation category from registered route semantics.
 *
 * V2 delegates to its existing route-policy owner. Retained v1 and public routes are
 * projected locally until Slice 4 removes v1; unknown methods/routes stay `unknown`.
 * This function observes routing only and grants no authority.
 *
 * @param context - Request carrying the raw pathname and method.
 * @param registeredRoute - Hono route template or the sanitized unknown label.
 * @returns Closed operation category without concrete path data.
 */
function resolveLogOperationCategory(
  context: WorkerContext,
  registeredRoute: string,
): LogOperationCategory {
  if (context.req.method === CORS_PREFLIGHT_METHOD) {
    return LOG_OPERATION_CATEGORY.public;
  }

  const v2Category = resolveV2LogOperationCategory(
    new URL(context.req.url).pathname,
    context.req.method,
  );
  if (v2Category !== undefined) return v2Category;

  if (PUBLIC_ROUTES.has(registeredRoute)) {
    return LOG_OPERATION_CATEGORY.public;
  }

  if (
    context.req.method === HTTP_METHOD.get &&
    (registeredRoute === NOTES_ROUTE || registeredRoute === V1_NOTE_ROUTE)
  ) {
    return LOG_OPERATION_CATEGORY.currentRead;
  }

  if (
    context.req.method === HTTP_METHOD.put &&
    registeredRoute === V1_NOTE_ROUTE
  ) {
    return LOG_OPERATION_CATEGORY.currentMutation;
  }

  if (
    context.req.method === HTTP_METHOD.delete &&
    registeredRoute === V1_NOTE_ROUTE
  ) {
    return LOG_OPERATION_CATEGORY.destructiveMutation;
  }

  return LOG_OPERATION_CATEGORY.unknown;
}
