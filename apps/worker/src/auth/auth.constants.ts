/** Authentication challenge header required for unauthenticated requests. */
export const WWW_AUTHENTICATE_HEADER = "WWW-Authenticate";

/** Supported HTTP authentication schemes, preserving their header spelling. */
export const AUTHENTICATION_SCHEME = { bearer: "Bearer" } as const;

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

/** Explicit authentication authority selected for one Worker environment. */
export const AUTHENTICATION_CONFIGURATION_MODE = {
  credentialRegistry: "credential-registry",
  invalid: "invalid",
  singletonMigration: "singleton-migration",
} as const;

/** Closed client capabilities recorded now and enforced by Slice 4. */
export const CLIENT_PERMISSION = {
  read: "read",
  write: "write",
  delete: "delete",
} as const;

/** Current strict credential-registry schema version. */
export const CREDENTIAL_REGISTRY_VERSION = 1;

/** Maximum number of simultaneously active client credentials. */
export const MAX_ACTIVE_CREDENTIALS = 16;
