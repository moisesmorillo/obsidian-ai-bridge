import type {
  AUTHENTICATION_RESULT_KIND,
  AUTHORIZATION_PARSE_RESULT_KIND,
} from "@worker/auth/auth.constants";

/** Generic result of parsing an HTTP Authorization header. */
export type AuthorizationHeaderParseResult =
  | { readonly kind: typeof AUTHORIZATION_PARSE_RESULT_KIND.missing }
  | { readonly kind: typeof AUTHORIZATION_PARSE_RESULT_KIND.malformed }
  | {
      readonly kind: typeof AUTHORIZATION_PARSE_RESULT_KIND.credentials;
      readonly scheme: string;
      readonly credentials: string;
    };

/** Result of applying the Worker Bearer-authentication scheme policy. */
export type BearerCredentialsResult =
  | { readonly kind: typeof AUTHORIZATION_PARSE_RESULT_KIND.missing }
  | { readonly kind: typeof AUTHORIZATION_PARSE_RESULT_KIND.malformed }
  | { readonly kind: "unsupported_scheme" }
  | { readonly kind: "bearer"; readonly token: string };

/** Request-level authentication outcome without exposing credential details. */
export type AuthenticationResult =
  | { readonly kind: typeof AUTHENTICATION_RESULT_KIND.authenticated }
  | { readonly kind: typeof AUTHENTICATION_RESULT_KIND.unauthenticated };
