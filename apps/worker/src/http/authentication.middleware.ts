import type { AuthenticationConfigurationResolver } from "@worker/app.types";
import { AUTHENTICATION_RESULT_KIND } from "@worker/auth/auth.constants";
import { authenticateRequest } from "@worker/auth/authenticate-request";
import {
  authenticateOAuthRequest,
  type OAuthResourcePath,
} from "@worker/auth/oauth-authenticate";
import { createUnauthorizedResponse } from "@worker/http/api-responses";
import type { WorkerMiddleware } from "@worker/http/hono.types";
import { CACHE_CONTROL_NO_STORE } from "@worker/http/http.constants";

/**
 * Enforces M5 registry or resource-bound OAuth bearer authentication.
 *
 * @param resolveAuthentication - M5 registry verifier configuration resolver.
 * @param resourcePath - Exact REST or MCP audience selected by the route.
 * @returns Middleware that denies invalid or unavailable credentials before publishing a secret-free principal.
 */
export function createAuthenticationMiddleware(
  resolveAuthentication: AuthenticationConfigurationResolver,
  resourcePath: OAuthResourcePath,
): WorkerMiddleware {
  return async (context, next) => {
    const registryAuthentication = await authenticateRequest(
      context.req.raw.headers,
      resolveAuthentication(context.env),
    );
    const authentication =
      registryAuthentication.kind === AUTHENTICATION_RESULT_KIND.authenticated
        ? registryAuthentication
        : await authenticateOAuthRequest(
            context.req.raw.headers,
            context.env,
            resourcePath,
          );
    if (authentication.kind === AUTHENTICATION_RESULT_KIND.unavailable) {
      return new Response(null, {
        status: 503,
        headers: { "Cache-Control": CACHE_CONTROL_NO_STORE },
      });
    }
    if (authentication.kind === AUTHENTICATION_RESULT_KIND.unauthenticated) {
      return createUnauthorizedResponse(context);
    }

    context.set("clientPrincipal", authentication.principal);
    await next();
  };
}
