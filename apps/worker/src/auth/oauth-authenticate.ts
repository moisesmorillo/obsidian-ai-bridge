import { isUuidV4 } from "@obsidian-ai-bridge/core";
import {
  AUTHENTICATION_RESULT_KIND,
  CLIENT_PERMISSION,
} from "@worker/auth/auth.constants";
import type {
  AuthenticationResult,
  ClientPermission,
} from "@worker/auth/auth.types";
import { parseAuthorizationHeader } from "@worker/auth/authorization-header";
import { parseBearerCredentials } from "@worker/auth/bearer-credentials";
import { CREDENTIAL_NAME_PATTERN } from "@worker/auth/credential-registry";
import { GRANT_REVOCATION_STATUS } from "@worker/auth/grant-revocation.constants";
import type {
  GrantRevocationId,
  GrantRevocationStatus,
} from "@worker/auth/grant-revocation.types";
import { parseGrantRevocationId } from "@worker/auth/grant-revocation-id";
import { API_V2_PREFIX, HTTP_HEADER } from "@worker/http/http.constants";
import {
  type GrantRevocationBucketPort,
  R2GrantRevocationRepository,
} from "@worker/infrastructure/r2-grant-revocation.repository";
import { MCP_ENDPOINT_PATH } from "@worker/mcp/mcp.constants";
import { z } from "zod";

/** Canonical protected-resource paths; tokens issued for one cannot access the other. */
export type OAuthResourcePath = typeof API_V2_PREFIX | typeof MCP_ENDPOINT_PATH;

/** Request bindings required by OAuth validation and grant revocation only. */
export interface OAuthAuthenticationEnvironment {
  /** Provider token and grant records. */
  readonly OAUTH_KV: KVNamespace;
  /** Private create-only grant marker capability. */
  readonly VAULT_BUCKET: GrantRevocationBucketPort;
  /** Canonical HTTPS authorization-server origin, absent when OAuth is disabled. */
  readonly OAUTH_ISSUER?: string;
}

/** Audience-checked provider result before application props are validated. */
export interface OAuthValidatedToken {
  readonly props: unknown;
  readonly audience: string;
  readonly scope: readonly string[];
}

/** Token validation seam for the provider's KV-backed, audience-bound records. */
export type OAuthTokenValidator = (
  resource: string,
  token: string,
) => Promise<OAuthValidatedToken | null>;

/** Authoritative revocation check performed after provider validation. */
export interface OAuthGrantRevocationChecker {
  /** Checks the permanent deny marker; storage failures remain unavailable. */
  check(id: GrantRevocationId): Promise<GrantRevocationStatus>;
}

/** Strict grant props created only by the future owner consent flow. */
const oauthGrantPropsSchema = z
  .object({
    principalId: z.string().refine(isUuidV4),
    name: z.string().regex(CREDENTIAL_NAME_PATTERN),
    revocationId: z.string(),
    permissions: z
      .array(
        z.enum([
          CLIENT_PERMISSION.read,
          CLIENT_PERMISSION.write,
          CLIENT_PERMISSION.delete,
        ]),
      )
      .min(1)
      .max(Object.keys(CLIENT_PERMISSION).length)
      .refine(
        (permissions) => new Set(permissions).size === permissions.length,
      ),
  })
  .strict();

/**
 * Converts one validated OAuth token into the existing least-privilege principal.
 *
 * Token scopes can only narrow the grant's stored permissions. A missing, revoked,
 * or unreadable R2 marker never authenticates the request.
 *
 * @param token - Bearer credential retained only during authentication.
 * @param resource - Exact REST or MCP audience configured by the Worker.
 * @param validateToken - Provider-backed validator for that resource.
 * @param revocations - Strongly consistent grant-denial lookup.
 * @returns A secret-free principal, generic rejection, or unavailable result.
 */
export async function authenticateOAuthBearer(
  token: string,
  resource: string,
  validateToken: OAuthTokenValidator,
  revocations: OAuthGrantRevocationChecker,
): Promise<AuthenticationResult> {
  let validated: OAuthValidatedToken | null;
  try {
    validated = await validateToken(resource, token);
  } catch {
    return { kind: AUTHENTICATION_RESULT_KIND.unavailable };
  }
  if (validated === null || validated.audience !== resource) {
    return { kind: AUTHENTICATION_RESULT_KIND.unauthenticated };
  }

  const props = oauthGrantPropsSchema.safeParse(validated.props);
  if (!props.success) {
    return { kind: AUTHENTICATION_RESULT_KIND.unauthenticated };
  }
  const revocationId = parseGrantRevocationId(props.data.revocationId);
  if (revocationId === undefined) {
    return { kind: AUTHENTICATION_RESULT_KIND.unauthenticated };
  }

  let revocation: GrantRevocationStatus;
  try {
    revocation = await revocations.check(revocationId);
  } catch {
    return { kind: AUTHENTICATION_RESULT_KIND.unavailable };
  }
  if (revocation === GRANT_REVOCATION_STATUS.unavailable) {
    return { kind: AUTHENTICATION_RESULT_KIND.unavailable };
  }
  if (revocation === GRANT_REVOCATION_STATUS.revoked) {
    return { kind: AUTHENTICATION_RESULT_KIND.unauthenticated };
  }

  const permissions: ClientPermission[] = props.data.permissions.filter(
    (permission) => validated.scope.includes(permission),
  );
  if (permissions.length === 0) {
    return { kind: AUTHENTICATION_RESULT_KIND.unauthenticated };
  }
  return {
    kind: AUTHENTICATION_RESULT_KIND.authenticated,
    principal: {
      clientId: props.data.principalId,
      name: props.data.name,
      permissions,
    },
  };
}

/**
 * Authenticates an OAuth bearer only when the deployment has a canonical issuer.
 *
 * The current release does not serve provider endpoints or issue grants. Only a
 * previously issued, resource-bound token with an active revocation marker can
 * reach the established REST/MCP permission policies.
 *
 * @param headers - Original request headers containing an optional Bearer token.
 * @param environment - Active KV, R2, and public-issuer bindings.
 * @param resourcePath - Protected resource selected by route, never client input.
 * @returns OAuth authentication outcome without exposing token or grant props.
 */
export async function authenticateOAuthRequest(
  headers: Headers,
  environment: OAuthAuthenticationEnvironment | undefined,
  resourcePath: OAuthResourcePath,
): Promise<AuthenticationResult> {
  const parsed = parseBearerCredentials(
    parseAuthorizationHeader(headers.get(HTTP_HEADER.authorization)),
  );
  if (parsed.kind !== "bearer") {
    return { kind: AUTHENTICATION_RESULT_KIND.unauthenticated };
  }
  if (environment === undefined) {
    return { kind: AUTHENTICATION_RESULT_KIND.unauthenticated };
  }
  const issuer = environment.OAUTH_ISSUER;
  if (!isCanonicalHttpsOrigin(issuer)) {
    return { kind: AUTHENTICATION_RESULT_KIND.unauthenticated };
  }

  try {
    const { OAuthAuthorizationServer } = await import(
      "@cloudflare/workers-oauth-provider"
    );
    const server = new OAuthAuthorizationServer<OAuthAuthenticationEnvironment>(
      {
        issuer,
        resources: [
          `${issuer}${API_V2_PREFIX}`,
          `${issuer}${MCP_ENDPOINT_PATH}`,
        ],
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/oauth/token",
        scopesSupported: Object.values(CLIENT_PERMISSION),
      },
    );
    const revocations = new R2GrantRevocationRepository(
      environment.VAULT_BUCKET,
    );
    return await authenticateOAuthBearer(
      parsed.token,
      `${issuer}${resourcePath}`,
      (resource, token) =>
        server.validateToken<unknown>(resource, token, environment),
      revocations,
    );
  } catch {
    return { kind: AUTHENTICATION_RESULT_KIND.unavailable };
  }
}

/**
 * @param value - Untrusted deployment issuer configuration.
 * @returns True only for a canonical HTTPS origin without path or credentials.
 */
function isCanonicalHttpsOrigin(value: string | undefined): value is string {
  if (value === undefined) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}
