import { createWorkerApp } from "@worker/app";
import {
  ACCESS_SESSION_PATH,
  resolveAccessSession,
} from "@worker/auth/access-session";
import type { AuthenticationConfiguration } from "@worker/auth/auth.types";
import { isCanonicalHttpsOrigin } from "@worker/auth/oauth-authenticate";
import {
  isOAuthProtocolPath,
  OAUTH_ROUTE_PATH,
} from "@worker/auth/oauth-routes";
import { resolveWorkerMirrorServices } from "@worker/composition";
import type {
  WorkerAuthenticationEnvironment,
  WorkerEnv,
} from "@worker/env/env.types";
import {
  configureWorkerLogging,
  createWorkerLogger,
} from "@worker/logging/logtape-logger";

await configureWorkerLogging();

/** Isolate-lifetime app composition; request bindings supply services and verifier configuration without capturing secrets here. */
const worker = createWorkerApp({
  logger: createWorkerLogger(),
  resolveMirrorServices: resolveWorkerMirrorServices,
  resolveAuthentication: resolveWorkerAuthentication,
});

/**
 * Resolves the M5 registry authentication authority from request bindings.
 *
 * Missing or malformed registry configuration is retained as untrusted input and
 * rejected by the strict registry decoder; no legacy secret can authenticate.
 *
 * @param environment - Active request bindings.
 * @returns Registry-only authentication configuration without fallback behavior.
 */
export function resolveWorkerAuthentication(
  environment: WorkerAuthenticationEnvironment,
): AuthenticationConfiguration {
  return {
    serializedRegistry: environment.OBSIDIAN_BRIDGE_CREDENTIAL_REGISTRY,
  };
}

/** Cloudflare entrypoint preserving the existing API while checking Access on one exact route. */
export default {
  async fetch(
    request: Request,
    environment: WorkerEnv,
    context: ExecutionContext,
  ) {
    const path = new URL(request.url).pathname;
    if (path === ACCESS_SESSION_PATH) {
      if (request.method !== "GET") {
        return new Response(null, {
          status: 404,
          headers: { "Cache-Control": "no-store" },
        });
      }
      return resolveAccessSession(context?.access);
    }
    if (
      path === OAUTH_ROUTE_PATH.authorize ||
      path === OAUTH_ROUTE_PATH.grants
    ) {
      const { handleOAuthOwnerRequest } = await import(
        "@worker/auth/oauth-owner"
      );
      return handleOAuthOwnerRequest(request, environment, context?.access);
    }
    if (isOAuthProtocolPath(path)) {
      const issuer = environment.OAUTH_ISSUER;
      if (!isCanonicalHttpsOrigin(issuer))
        return new Response(null, { status: 503 });
      const { createOAuthServer } = await import("@worker/auth/oauth-server");
      return createOAuthServer<WorkerEnv>(issuer).fetch(
        request,
        environment,
        context,
      );
    }
    return worker.fetch(request, environment, context);
  },
} satisfies ExportedHandler<WorkerEnv>;
