import { OAuthAuthorizationServer } from "@cloudflare/workers-oauth-provider";
import { CLIENT_PERMISSION } from "@worker/auth/auth.constants";
import { OAUTH_ROUTE_PATH } from "@worker/auth/oauth-routes";
import { API_V2_PREFIX } from "@worker/http/http.constants";
import { MCP_ENDPOINT_PATH } from "@worker/mcp/mcp.constants";

/** Bindings needed by the authorization server and its KV-backed grants. */
export interface OAuthServerEnvironment {
  readonly OAUTH_KV: KVNamespace;
  readonly OAUTH_ISSUER?: string;
}

/**
 * Use one resource and scope registry for issuance and bearer validation.
 * Client registration remains behind whole-host Access until the staged cutover.
 * @param issuer - Canonical public authorization origin.
 * @returns Provider instance configured for the bridge's two exact audiences.
 */
export function createOAuthServer<Env extends OAuthServerEnvironment>(
  issuer: string,
) {
  return new OAuthAuthorizationServer<Env>({
    issuer,
    resources: [`${issuer}${API_V2_PREFIX}`, `${issuer}${MCP_ENDPOINT_PATH}`],
    authorizeEndpoint: OAUTH_ROUTE_PATH.authorize,
    tokenEndpoint: OAUTH_ROUTE_PATH.token,
    clientRegistrationEndpoint: OAUTH_ROUTE_PATH.register,
    scopesSupported: Object.values(CLIENT_PERMISSION),
  });
}
