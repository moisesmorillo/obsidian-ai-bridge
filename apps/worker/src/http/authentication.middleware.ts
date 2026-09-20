import type { AuthenticationConfigurationResolver } from "@worker/app.types";
import { AUTHENTICATION_RESULT_KIND } from "@worker/auth/auth.constants";
import { authenticateRequest } from "@worker/auth/authenticate-request";
import { createUnauthorizedResponse } from "@worker/http/api-responses";
import type { WorkerMiddleware } from "@worker/http/hono.types";

/**
 * Enforces the configured bearer authority for every protected API route.
 *
 * @param resolveAuthentication - Resolver for the exclusive authority selected by the active environment.
 * @returns Middleware that returns a sanitized 401 or publishes a secret-free typed principal.
 */
export function createAuthenticationMiddleware(
  resolveAuthentication: AuthenticationConfigurationResolver,
): WorkerMiddleware {
  return async (context, next) => {
    const authentication = await authenticateRequest(
      context.req.raw.headers,
      resolveAuthentication(context.env),
    );
    if (authentication.kind === AUTHENTICATION_RESULT_KIND.unauthenticated) {
      return createUnauthorizedResponse(context);
    }

    context.set("clientPrincipal", authentication.principal);
    await next();
  };
}
