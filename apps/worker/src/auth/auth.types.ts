/** Parsed bearer-header states used to keep authentication failures explicit. */
export type BearerHeaderParseResult =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | { readonly kind: "unsupported_scheme" }
  | { readonly kind: "bearer"; readonly token: string };

/** Request-level authentication outcome without exposing credential details. */
export type AuthenticationResult =
  | { readonly kind: "authenticated" }
  | { readonly kind: "unauthenticated" };
