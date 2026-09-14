import type { MirrorServicesResolver } from "@worker/app.types";
import type { WorkerMiddleware } from "@worker/http/hono.types";

/**
 * Resolves request-scoped mirror services from the active Cloudflare bindings.
 *
 * @param resolveMirrorServices - Factory hiding R2 and composition from handlers.
 * @returns Middleware exposing the application services through typed context variables.
 */
export function createRequestDependenciesMiddleware(
  resolveMirrorServices: MirrorServicesResolver,
): WorkerMiddleware {
  return async (context, next) => {
    context.set("mirrorServices", resolveMirrorServices(context.env));
    await next();
  };
}
