# Client-scoped authorization design boundary

## Scope

This public design note states the authorization boundary needed to replace
operator-copied credentials. It does not describe a particular deployment,
account policy, credential state, or vault installation.

## Required behavior before a vault connection

1. A user signs in through Cloudflare Access in a browser. Obsidian's Connect
   action completes authorization without an operator copying a bearer token.
2. Every Obsidian installation and MCP client has a distinct, stable grant that
   the owner can name, scope to independent `read`, `write`, and `delete`
   permissions, and revoke without affecting other clients.
3. The Worker derives the client principal from a validated grant before the
   existing HTTP/MCP operation policies or storage services run. Access user
   identity alone never grants mirror access.
4. OAuth-only MCP clients receive standards-compliant discovery, authorization,
   PKCE, token exchange, and resource audience validation. A browser login
   cookie or M5 registry bearer is not represented as an OAuth access token.
5. An unpaired request continues to fail closed. Revocation cannot be undone by
   deploying an older registry or restoring stale grant state.

## Architecture decision to settle before implementation

Cloudflare Access Managed OAuth authenticates a user and passes a signed user
assertion to the origin. Its published origin contract does not document a
stable OAuth client or grant identifier available to the Worker. Consequently,
the current evidence does not support using Managed OAuth alone to enforce
independent permissions and revocation for each installation or MCP client.
Managed OAuth must not be treated as a substitute for the bridge's client
authorization.

The proposed direction is to use Access for **owner login** and have the bridge
issue and validate its own client-scoped OAuth grants. [Proposed ADR 0015](../decisions/0015-browser-mediated-client-authorization.md)
specifies the intended provider, storage, resource audiences, revocation and
Access path cutover for maintainer review. A whole-host Access gate would
intercept public OAuth discovery and token endpoints; any path change must be
staged so the Worker still rejects unauthenticated API requests.

## Sequence and rollback boundaries

1. Document and review the OAuth/grant design, including an Obsidian native
   callback and the MCP clients to qualify. No production configuration change.
2. Verify Access identity on an exact Worker session route with a body-free,
   fail-closed response and synthetic tests. Existing API/MCP operations remain
   registry-protected until the new principal source and exhaustive permission
   policy are qualified.
3. Add client registration and owner-login flow; test with synthetic clients and
   data. Stage any Access application path change and verify OAuth metadata and
   denial of unauthenticated API requests. Roll back the path change if either
   check fails. Never roll back to a grant snapshot that re-enables a revoked
   client.
4. Add Obsidian Connect and qualify one disposable vault, then a second
   installation. Only after that consider the personal vault. MCP client
   qualification follows the Worker auth validation.

Writer selection and safe multiple-writer reconciliation remain separate from
this Access/login step. An authenticated client does not gain writer authority
or permission to override existing association, revision, preservation, and
conflict rules.

## Sources

- [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [Cloudflare Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
- [OpenAI MCP OAuth requirements](https://developers.openai.com/plugins/build/auth)
- [ADR 0010: existing client permissions](../decisions/0010-scoped-client-credentials-and-permissions.md)
- [ADR 0014: existing MCP authentication limit](../decisions/0014-stateless-mcp-adapter-and-existing-credentials.md)
