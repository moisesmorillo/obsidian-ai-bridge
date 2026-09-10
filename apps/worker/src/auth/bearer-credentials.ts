import {
  AUTHENTICATION_SCHEME,
  AUTHORIZATION_PARSE_RESULT_KIND,
} from "@worker/auth/auth.constants";
import type {
  AuthorizationHeaderParseResult,
  BearerCredentialsResult,
} from "@worker/auth/auth.types";

/**
 * Applies the Bearer scheme policy to a generic Authorization-header parse result.
 *
 * @param result - Generic parsed Authorization-header result.
 * @returns Bearer credentials or an explicit failure state.
 */
export function parseBearerCredentials(
  result: AuthorizationHeaderParseResult,
): BearerCredentialsResult {
  if (result.kind !== AUTHORIZATION_PARSE_RESULT_KIND.credentials) {
    return result;
  }
  if (
    result.scheme.toLowerCase() !== AUTHENTICATION_SCHEME.bearer.toLowerCase()
  ) {
    return { kind: "unsupported_scheme" };
  }

  return { kind: "bearer", token: result.credentials };
}
