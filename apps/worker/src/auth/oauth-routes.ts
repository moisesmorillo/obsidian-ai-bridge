import { API_V2_PREFIX } from "@worker/http/http.constants";
import { MCP_ENDPOINT_PATH } from "@worker/mcp/mcp.constants";

/** Authorization and owner route paths shared by dispatch, provider, and UI. */
export const OAUTH_ROUTE_PATH = {
  authorize: "/authorize",
  grants: "/auth/grants",
  token: "/oauth/token",
  register: "/oauth/register",
  authorizationMetadata: "/.well-known/oauth-authorization-server",
  restResourceMetadata: `/.well-known/oauth-protected-resource${API_V2_PREFIX}`,
  mcpResourceMetadata: `/.well-known/oauth-protected-resource${MCP_ENDPOINT_PATH}`,
} as const;

/**
 * Admit only provider-owned protocol paths, never the owner UI or note API.
 * @param path - Request URL pathname.
 * @returns Whether the provider should handle this exact path.
 */
export function isOAuthProtocolPath(path: string): boolean {
  return (
    path === OAUTH_ROUTE_PATH.token ||
    path === OAUTH_ROUTE_PATH.register ||
    path === OAUTH_ROUTE_PATH.authorizationMetadata ||
    path === OAUTH_ROUTE_PATH.restResourceMetadata ||
    path === OAUTH_ROUTE_PATH.mcpResourceMetadata
  );
}
