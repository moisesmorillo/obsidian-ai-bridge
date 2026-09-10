import { AUTHORIZATION_HEADER } from "@worker/auth/auth.constants";
import type { AuthenticationResult } from "@worker/auth/auth.types";
import { parseBearerHeader } from "@worker/auth/bearer-header";
import { hasMatchingToken } from "@worker/auth/token-comparison";

/** Authenticates a request header against the configured bearer token. */
export async function authenticateRequest(
  headers: Headers,
  expectedToken: string | undefined,
): Promise<AuthenticationResult> {
  if (expectedToken === undefined || expectedToken === "") {
    return { kind: "unauthenticated" };
  }

  const parsedHeader = parseBearerHeader(headers.get(AUTHORIZATION_HEADER));
  if (parsedHeader.kind !== "bearer") {
    return { kind: "unauthenticated" };
  }

  return (await hasMatchingToken(parsedHeader.token, expectedToken))
    ? { kind: "authenticated" }
    : { kind: "unauthenticated" };
}
