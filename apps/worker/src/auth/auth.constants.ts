/** HTTP header containing request authentication credentials. */
export const AUTHORIZATION_HEADER = "Authorization";

/** Authentication challenge header required for unauthenticated requests. */
export const WWW_AUTHENTICATE_HEADER = "WWW-Authenticate";

/** Supported HTTP authentication schemes, preserving their header spelling. */
export const AUTHENTICATION_SCHEME = { bearer: "Bearer" } as const;

/**
 * Fixed-length Web Crypto digest used before comparing bearer-token values.
 *
 * SHA-256 makes comparisons independent of secret length while preserving the
 * current fixed-length digest comparison behavior.
 */
export const TOKEN_DIGEST_ALGORITHM = "SHA-256";

/** Closed set of Bearer-policy parsing outcomes. */
export const BEARER_CREDENTIALS_RESULT_KIND = {
  bearer: "bearer",
  unsupportedScheme: "unsupported_scheme",
} as const;

/** Closed set of generic Authorization-header parsing outcomes. */
export const AUTHORIZATION_PARSE_RESULT_KIND = {
  credentials: "credentials",
  malformed: "malformed",
  missing: "missing",
} as const;

/** Closed set of request authentication outcomes exposed to middleware. */
export const AUTHENTICATION_RESULT_KIND = {
  authenticated: "authenticated",
  unauthenticated: "unauthenticated",
} as const;
