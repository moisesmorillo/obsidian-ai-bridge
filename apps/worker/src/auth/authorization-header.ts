import { AUTHORIZATION_PARSE_RESULT_KIND } from "@worker/auth/auth.constants";
import type { AuthorizationHeaderParseResult } from "@worker/auth/auth.types";

/**
 * Parses the HTTP Authorization header without assigning meaning to its scheme.
 *
 * @param authorization - Raw header value, or `null` when the header is absent.
 * @returns A typed structural result containing the scheme and credentials when valid.
 */
export function parseAuthorizationHeader(
  authorization: string | null,
): AuthorizationHeaderParseResult {
  if (authorization === null) {
    return { kind: AUTHORIZATION_PARSE_RESULT_KIND.missing };
  }

  const parts = authorization.trim().split(/\s+/);
  const scheme = parts[0];
  const credentials = parts[1];
  if (
    parts.length !== 2 ||
    scheme === undefined ||
    credentials === undefined ||
    credentials === ""
  ) {
    return { kind: AUTHORIZATION_PARSE_RESULT_KIND.malformed };
  }

  return {
    kind: AUTHORIZATION_PARSE_RESULT_KIND.credentials,
    scheme,
    credentials,
  };
}
