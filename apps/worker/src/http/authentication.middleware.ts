import type { AuthenticationTokenResolver } from "@worker/app.types";
import { AUTHENTICATION_RESULT_KIND } from "@worker/auth/auth.constants";
import { authenticateRequest } from "@worker/auth/authenticate-request";
import { createUnauthorizedResponse } from "@worker/http/api-responses";
import type { WorkerMiddleware } from "@worker/http/hono.types";

/**
 * Enforces the configured bearer token for all API routes.
 *
 * @param resolveToken - Resolver for the secret expected by the active environment.
 * @returns Middleware that returns a sanitized 401 challenge for failed authentication.
 */
export function createAuthenticationMiddleware(
  resolveToken: AuthenticationTokenResolver,
): WorkerMiddleware {
  return async (context, next) => {
    const authentication = await authenticateRequest(
      context.req.raw.headers,
      resolveToken(context.env),
    );
    if (authentication.kind === AUTHENTICATION_RESULT_KIND.unauthenticated) {
      return createUnauthorizedResponse(context);
    }

    await next();
  };
}
