import type { WorkerMiddleware } from "@worker/http/hono.types";
import type { Logger } from "@worker/logging/logger.types";
import { UNMATCHED_ROUTE_LABEL } from "@worker/logging/logging.constants";
import { routePath } from "hono/route";

/** Logs request metadata only after the complete HTTP response has been produced. */
export function createRequestLoggingMiddleware(
  logger: Logger,
): WorkerMiddleware {
  return async (context, next) => {
    const startedAt = performance.now();
    await next();
    logger.info({
      operation: "http_request",
      method: context.req.method,
      route: routePath(context) ?? UNMATCHED_ROUTE_LABEL,
      status: context.res.status,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    });
  };
}
