import { createWorkerApp } from "@worker/app";
import type { AuthenticationConfiguration } from "@worker/auth/auth.types";
import { resolveWorkerMirrorServices } from "@worker/composition";
import type { WorkerAuthenticationEnvironment } from "@worker/env/env.types";
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
 * Resolves the sole registry authentication authority from request bindings.
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

/** Fully assembled Worker application exported to the Cloudflare runtime. */
export default worker;
