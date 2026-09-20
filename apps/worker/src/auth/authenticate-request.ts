import { MIRROR_HTTP_HEADER } from "@obsidian-ai-bridge/protocol";
import {
  AUTHENTICATION_CONFIGURATION_MODE,
  AUTHENTICATION_RESULT_KIND,
  BEARER_CREDENTIALS_RESULT_KIND,
  CLIENT_PERMISSION,
} from "@worker/auth/auth.constants";
import type {
  AuthenticationConfiguration,
  AuthenticationResult,
  ClientPrincipal,
} from "@worker/auth/auth.types";
import { parseAuthorizationHeader } from "@worker/auth/authorization-header";
import { parseBearerCredentials } from "@worker/auth/bearer-credentials";
import {
  decodeCredentialRegistry,
  resolveCredentialPrincipal,
} from "@worker/auth/credential-registry";
import { hasMatchingToken } from "@worker/auth/token-comparison";

/** Fixed full-authority identity used only by the named singleton migration mode. */
const SINGLETON_MIGRATION_PRINCIPAL: ClientPrincipal = {
  clientId: "00000000-0000-4000-8000-000000000000",
  name: "singleton-migration",
  permissions: [
    CLIENT_PERMISSION.read,
    CLIENT_PERMISSION.write,
    CLIENT_PERMISSION.delete,
  ],
};

/**
 * Authenticates a request header through exactly one explicitly selected authority path.
 *
 * @param headers - Request headers containing an optional Authorization value.
 * @param configuration - Mutually exclusive registry or temporary singleton authority.
 * @returns A typed principal or a sanitized unauthenticated result.
 */
export async function authenticateRequest(
  headers: Headers,
  configuration: AuthenticationConfiguration,
): Promise<AuthenticationResult> {
  const parsedHeader = parseBearerCredentials(
    parseAuthorizationHeader(headers.get(MIRROR_HTTP_HEADER.authorization)),
  );
  if (parsedHeader.kind !== BEARER_CREDENTIALS_RESULT_KIND.bearer) {
    return { kind: AUTHENTICATION_RESULT_KIND.unauthenticated };
  }

  try {
    switch (configuration.mode) {
      case AUTHENTICATION_CONFIGURATION_MODE.credentialRegistry:
        return authenticateCredentialRegistry(
          parsedHeader.token,
          configuration.serializedRegistry,
        );
      case AUTHENTICATION_CONFIGURATION_MODE.singletonMigration:
        return authenticateSingletonMigration(
          parsedHeader.token,
          configuration.token,
        );
      case AUTHENTICATION_CONFIGURATION_MODE.invalid:
        return { kind: AUTHENTICATION_RESULT_KIND.unauthenticated };
    }
  } catch {
    return { kind: AUTHENTICATION_RESULT_KIND.unauthenticated };
  }
}

/**
 * Resolves a bearer against one complete strict registry configuration.
 *
 * @param token - Supplied bearer retained only within authentication.
 * @param serializedRegistry - Untrusted secret registry configuration.
 * @returns A typed registry principal or sanitized authentication failure.
 */
async function authenticateCredentialRegistry(
  token: string,
  serializedRegistry: string | undefined,
): Promise<AuthenticationResult> {
  const decoded = decodeCredentialRegistry(serializedRegistry);
  if (decoded.kind !== "valid") {
    return { kind: AUTHENTICATION_RESULT_KIND.unauthenticated };
  }

  const principal = await resolveCredentialPrincipal(token, decoded.registry);
  return principal === null
    ? { kind: AUTHENTICATION_RESULT_KIND.unauthenticated }
    : { kind: AUTHENTICATION_RESULT_KIND.authenticated, principal };
}

/**
 * Preserves current authority only inside the explicit bounded migration mode.
 *
 * @param token - Supplied bearer retained only within authentication.
 * @param expectedToken - Existing singleton secret, ignored by registry mode.
 * @returns The migration principal only for an exact configured-token match.
 */
async function authenticateSingletonMigration(
  token: string,
  expectedToken: string | undefined,
): Promise<AuthenticationResult> {
  if (expectedToken === undefined || expectedToken === "") {
    return { kind: AUTHENTICATION_RESULT_KIND.unauthenticated };
  }

  return (await hasMatchingToken(token, expectedToken))
    ? {
        kind: AUTHENTICATION_RESULT_KIND.authenticated,
        principal: SINGLETON_MIGRATION_PRINCIPAL,
      }
    : { kind: AUTHENTICATION_RESULT_KIND.unauthenticated };
}
