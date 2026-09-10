import type { WorkerMiddleware } from "@worker/http/hono.types";
import type { Logger } from "@worker/logging/logger.types";
import {
  LOG_OPERATION,
  UNMATCHED_ROUTE_LABEL,
} from "@worker/logging/logging.constants";
import { routePath } from "hono/route";

/**
 * Logs request metadata only after the complete HTTP response has been produced.
 *
 * @param logger - Structured logger that receives non-sensitive request metadata.
 * @returns Middleware that records the route template, status, and duration.
 */
export function createRequestLoggingMiddleware(
  logger: Logger,
): WorkerMiddleware {
  return async (context, next) => {
    const startedAt = performance.now();
    await next();
    logger.info({
      operation: LOG_OPERATION.httpRequest,
      method: context.req.method,
      route: routePath(context) ?? UNMATCHED_ROUTE_LABEL,
      status: context.res.status,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    });
  };
}
