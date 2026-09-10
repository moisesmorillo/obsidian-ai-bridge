import { authenticateRequest } from "@worker/auth/authenticate-request";
import { createUnauthorizedResponse } from "@worker/http/api-responses";
import type { MiddlewareHandler } from "hono";

/** Enforces the configured bearer token for all API routes. */
export function createAuthenticationMiddleware(
  expectedToken: string | undefined,
): MiddlewareHandler {
  return async (context, next) => {
    const authentication = await authenticateRequest(
      context.req.raw.headers,
      expectedToken,
    );
    if (authentication.kind === "unauthenticated") {
      return createUnauthorizedResponse(context);
    }

    await next();
  };
}
