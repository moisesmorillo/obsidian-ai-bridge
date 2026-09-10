/** HTTP header containing request authentication credentials. */
export const AUTHORIZATION_HEADER = "Authorization";

/** Authentication challenge header required for unauthenticated requests. */
export const WWW_AUTHENTICATE_HEADER = "WWW-Authenticate";

/** Supported HTTP authentication schemes. */
export const AUTHENTICATION_SCHEME = { bearer: "Bearer" } as const;
