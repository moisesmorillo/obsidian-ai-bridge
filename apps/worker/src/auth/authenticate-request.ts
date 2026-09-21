import { MIRROR_HTTP_HEADER } from "@obsidian-ai-bridge/protocol";
import {
  AUTHENTICATION_RESULT_KIND,
  BEARER_CREDENTIALS_RESULT_KIND,
} from "@worker/auth/auth.constants";
import type {
  AuthenticationConfiguration,
  AuthenticationResult,
} from "@worker/auth/auth.types";
import { parseAuthorizationHeader } from "@worker/auth/authorization-header";
import { parseBearerCredentials } from "@worker/auth/bearer-credentials";
import {
  decodeCredentialRegistry,
  resolveCredentialPrincipal,
} from "@worker/auth/credential-registry";
/**
 * Authenticates a request bearer exclusively through the digest credential registry.
 *
 * @param headers - Request headers containing an optional Authorization value.
 * @param configuration - Registry-only confidential verifier configuration.
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
    return authenticateCredentialRegistry(
      parsedHeader.token,
      configuration.serializedRegistry,
    );
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
