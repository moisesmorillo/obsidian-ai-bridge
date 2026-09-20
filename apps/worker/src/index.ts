import { createWorkerApp } from "@worker/app";
import { AUTHENTICATION_CONFIGURATION_MODE } from "@worker/auth/auth.constants";
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
 * Selects exactly one authentication authority from untrusted environment bindings.
 *
 * Registry mode ignores any not-yet-removed singleton secret, while migration mode
 * ignores any staged registry. Missing or unknown mode values fail closed.
 *
 * @param environment - Active request bindings.
 * @returns One explicit authentication configuration without fallback behavior.
 */
export function resolveWorkerAuthentication(
  environment: WorkerAuthenticationEnvironment,
): AuthenticationConfiguration {
  if (
    environment.OBSIDIAN_BRIDGE_AUTH_MODE ===
    AUTHENTICATION_CONFIGURATION_MODE.credentialRegistry
  ) {
    return {
      mode: AUTHENTICATION_CONFIGURATION_MODE.credentialRegistry,
      serializedRegistry: environment.OBSIDIAN_BRIDGE_CREDENTIAL_REGISTRY,
    };
  }
  if (
    environment.OBSIDIAN_BRIDGE_AUTH_MODE ===
    AUTHENTICATION_CONFIGURATION_MODE.singletonMigration
  ) {
    return {
      mode: AUTHENTICATION_CONFIGURATION_MODE.singletonMigration,
      token: environment.OBSIDIAN_BRIDGE_TOKEN,
    };
  }

  return { mode: AUTHENTICATION_CONFIGURATION_MODE.invalid };
}

/** Fully assembled Worker application exported to the Cloudflare runtime. */
export default worker;
