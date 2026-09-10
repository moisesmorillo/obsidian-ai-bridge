import {
  AUTHENTICATION_RESULT_KIND,
  AUTHORIZATION_HEADER,
  BEARER_CREDENTIALS_RESULT_KIND,
} from "@worker/auth/auth.constants";
import type { AuthenticationResult } from "@worker/auth/auth.types";
import { parseAuthorizationHeader } from "@worker/auth/authorization-header";
import { parseBearerCredentials } from "@worker/auth/bearer-credentials";
import { hasMatchingToken } from "@worker/auth/token-comparison";

/**
 * Authenticates a request header against the configured bearer token.
 *
 * @param headers - Request headers containing an optional Authorization value.
 * @param expectedToken - Secret configured for the active Worker environment.
 * @returns An authenticated or unauthenticated result without exposing credentials.
 */
export async function authenticateRequest(
  headers: Headers,
  expectedToken: string | undefined,
): Promise<AuthenticationResult> {
  if (expectedToken === undefined || expectedToken === "") {
    return { kind: AUTHENTICATION_RESULT_KIND.unauthenticated };
  }

  const parsedHeader = parseBearerCredentials(
    parseAuthorizationHeader(headers.get(AUTHORIZATION_HEADER)),
  );
  if (parsedHeader.kind !== BEARER_CREDENTIALS_RESULT_KIND.bearer) {
    return { kind: AUTHENTICATION_RESULT_KIND.unauthenticated };
  }

  return (await hasMatchingToken(parsedHeader.token, expectedToken))
    ? { kind: AUTHENTICATION_RESULT_KIND.authenticated }
    : { kind: AUTHENTICATION_RESULT_KIND.unauthenticated };
}
