import type { AuthenticationTokenResolver } from "@worker/app.types";
import { authenticateRequest } from "@worker/auth/authenticate-request";
import { createUnauthorizedResponse } from "@worker/http/api-responses";
import type { WorkerMiddleware } from "@worker/http/hono.types";

/** Enforces the configured bearer token for all API routes. */
export function createAuthenticationMiddleware(
  resolveToken: AuthenticationTokenResolver,
): WorkerMiddleware {
  return async (context, next) => {
    const authentication = await authenticateRequest(
      context.req.raw.headers,
      resolveToken(context.env),
    );
    if (authentication.kind === "unauthenticated") {
      return createUnauthorizedResponse(context);
    }

    await next();
  };
}
