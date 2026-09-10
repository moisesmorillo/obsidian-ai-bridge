/** HTTP header containing request authentication credentials. */
export const AUTHORIZATION_HEADER = "Authorization";

/** Authentication challenge header required for unauthenticated requests. */
export const WWW_AUTHENTICATE_HEADER = "WWW-Authenticate";

/** Supported HTTP authentication schemes. */
export const AUTHENTICATION_SCHEME = { bearer: "Bearer" } as const;

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
