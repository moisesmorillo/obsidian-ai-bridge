import {
  AUTHENTICATION_RESULT_KIND,
  AUTHORIZATION_HEADER,
} from "@worker/auth/auth.constants";
import type { AuthenticationResult } from "@worker/auth/auth.types";
import { parseAuthorizationHeader } from "@worker/auth/authorization-header";
import { parseBearerCredentials } from "@worker/auth/bearer-credentials";
import { hasMatchingToken } from "@worker/auth/token-comparison";

/** Authenticates a request header against the configured bearer token. */
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
  if (parsedHeader.kind !== "bearer") {
    return { kind: AUTHENTICATION_RESULT_KIND.unauthenticated };
  }

  return (await hasMatchingToken(parsedHeader.token, expectedToken))
    ? { kind: AUTHENTICATION_RESULT_KIND.authenticated }
    : { kind: AUTHENTICATION_RESULT_KIND.unauthenticated };
}
