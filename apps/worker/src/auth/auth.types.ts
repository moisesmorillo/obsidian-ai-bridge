import type {
  AUTHENTICATION_RESULT_KIND,
  AUTHORIZATION_PARSE_RESULT_KIND,
  BEARER_CREDENTIALS_RESULT_KIND,
  CLIENT_PERMISSION,
  CREDENTIAL_REGISTRY_VERSION,
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
  | {
      readonly kind: typeof BEARER_CREDENTIALS_RESULT_KIND.unsupportedScheme;
    }
  | {
      readonly kind: typeof BEARER_CREDENTIALS_RESULT_KIND.bearer;
      readonly token: string;
    };

/** One independently granted client capability retained exactly on a principal. */
export type ClientPermission =
  (typeof CLIENT_PERMISSION)[keyof typeof CLIENT_PERMISSION];

/** Strict digest-only metadata for one active client credential. */
export interface CredentialRegistryEntry {
  /** Immutable canonical lowercase UUID-v4 client identity. */
  readonly clientId: string;
  /** Unique operator-facing label; never authentication input. */
  readonly name: string;
  /** Nonempty exact capability set, without implied permissions. */
  readonly permissions: readonly ClientPermission[];
  /** Canonical lowercase SHA-256 digest verifier, never a raw token. */
  readonly tokenDigest: string;
}

/** Complete bounded authentication registry accepted atomically by the Worker. */
export interface CredentialRegistry {
  /** Strict schema version governing every registry entry. */
  readonly version: typeof CREDENTIAL_REGISTRY_VERSION;
  /** Active digest-only credentials, bounded by configuration validation. */
  readonly credentials: readonly CredentialRegistryEntry[];
}

/** Authenticated client identity made available without token or digest material. */
export interface ClientPrincipal {
  /** Immutable canonical lowercase UUID-v4 client identity. */
  readonly clientId: string;
  /** Operator-facing client label. */
  readonly name: string;
  /** Exact configured capabilities enforced independently without implication. */
  readonly permissions: readonly ClientPermission[];
}

/** Registry-only authentication configuration resolved for one request. */
export interface AuthenticationConfiguration {
  /** Untrusted serialized digest registry; unavailable or invalid input fails closed. */
  readonly serializedRegistry: string | undefined;
}

/** Request-level authentication outcome without exposing credential details. */
export type AuthenticationResult =
  | {
      readonly kind: typeof AUTHENTICATION_RESULT_KIND.authenticated;
      readonly principal: ClientPrincipal;
    }
  | { readonly kind: typeof AUTHENTICATION_RESULT_KIND.unauthenticated };
