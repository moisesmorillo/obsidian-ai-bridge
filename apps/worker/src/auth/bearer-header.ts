import { AUTHENTICATION_SCHEME } from "@worker/auth/auth.constants";
import type { BearerHeaderParseResult } from "@worker/auth/auth.types";

/** Parses an Authorization header without comparing or retaining expected credentials. */
export function parseBearerHeader(
  authorization: string | null,
): BearerHeaderParseResult {
  if (authorization === null) {
    return { kind: "missing" };
  }

  const parts = authorization.trim().split(/\s+/);
  const scheme = parts[0];
  const token = parts[1];
  if (
    parts.length !== 2 ||
    scheme === undefined ||
    token === undefined ||
    token === ""
  ) {
    return { kind: "malformed" };
  }

  if (scheme.toLowerCase() !== AUTHENTICATION_SCHEME.bearer.toLowerCase()) {
    return { kind: "unsupported_scheme" };
  }

  return { kind: "bearer", token };
}
