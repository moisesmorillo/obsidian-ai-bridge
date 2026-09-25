import {
  API_ERROR_CODE,
  type ApiErrorCode,
  apiErrorResponseSchema,
} from "@obsidian-ai-bridge/protocol";
import type { WorkerContext, WorkerMiddleware } from "@worker/http/hono.types";
import { HTTP_STATUS } from "@worker/http/http.constants";
import { resolveRouteOperation } from "@worker/http/v2-route-policy";
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
import { MCP_ENDPOINT_PATH } from "@worker/mcp/mcp.constants";
import { routePath } from "hono/route";

/** Hono catch-all templates normalized to the bounded unknown route label. */
const HONO_NOT_FOUND_ROUTES = new Set(["/*", "/api/*"]);

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
      resolvedRoute === undefined || HONO_NOT_FOUND_ROUTES.has(resolvedRoute)
        ? UNMATCHED_ROUTE_LABEL
        : resolvedRoute;
    const errorCode = await resolveApiErrorCode(context.res);

    logger.info({
      operation: LOG_OPERATION.httpRequest,
      operationCategory: resolveLogOperationCategory(context),
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
 * Resolves one bounded category from the authoritative operation policy.
 *
 * Diagnostics consume the same route classification as authorization without gaining
 * authority to admit, deny, or reinterpret an operation.
 *
 * @param context - Request carrying the literal pathname and method.
 * @returns Closed operation category without concrete path data.
 */
function resolveLogOperationCategory(
  context: WorkerContext,
): LogOperationCategory {
  if (new URL(context.req.url).pathname === MCP_ENDPOINT_PATH) {
    return LOG_OPERATION_CATEGORY.mcpRequest;
  }
  return resolveRouteOperation(
    new URL(context.req.url).pathname,
    context.req.method,
  ).operationCategory;
}
