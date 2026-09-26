# ADR 0015 — Browser-mediated client authorization

## Status

**Proposed for the post-M6 rollout.** This record authorizes no production
behavior until the maintainer accepts it. M5 credential and single-writer rules
remain the current implementation; ADRs 0010 and 0014 are not yet superseded.

## Context

The deployed Worker can verify a Cloudflare Access browser identity on an exact
session route while the note API continues to reject a browser-only session.
Each Obsidian installation needs a grant acquired through Connect, with no
operator-copied bearer. OAuth-only MCP clients need real authorization-server and
protected-resource discovery, PKCE, resource-bound tokens and consent. Each grant
must have independent permissions and revocation. The current whole-host Access
application intercepts public OAuth endpoints before they reach the Worker.

## Decision

- Keep Cloudflare Access as the owner sign-in gate for `/authorize` and the
  browser-based grant management UI. The Worker uses only verified Access
  identity for those routes; Access identity never grants note API access.
  Keep Cloudflare Managed OAuth disabled because its origin contract does not
  expose the stable grant authority needed for per-installation policy.
- Use Cloudflare's maintained Workers OAuth provider for the authorization
  server, consent helpers, client registration, codes and token lifecycle. Its
  required Workers KV namespace is a new deployment resource. Do not write a
  custom OAuth server or store token records in the note bucket. Provision the
  KV binding declaratively and verify how the release workflow handles the
  generated resource before a production deploy. Preserve the release identity
  gate.
- Serve REST and MCP as separate protected OAuth resources on the existing
  Worker. The MCP audience is its exact `/mcp` resource URI; REST has its own
  resource URI. The Worker converts a validated resource-bound token and grant
  scopes into the existing typed client principal before the existing operation
  policy. `read`, `write`, and `delete` stay independent. No grant confers local
  writer authority or bypasses revision/conflict checks.
- Obsidian Connect opens the system browser, obtains owner consent with PKCE,
  and returns to the initiating installation through a qualified native
  callback. Each installation gets a separately named grant; a shared
  application registration must not cause re-authorization on one installation
  to revoke another. Store client tokens in Obsidian's supported secret storage.
  MCP clients use supported CIMD or bounded dynamic registration and receive
  their own grants. Qualify each actual client before claiming compatibility.
- List and revoke grants only through an Access-protected owner UI. At consent,
  the bridge creates an opaque per-grant revocation ID in provider `props` and
  grant metadata; the provider's resource validator does not expose its own
  grant ID. Revocation writes a permanent, minimal tombstone keyed by this ID
  through the existing R2 Worker binding, then calls the provider's grant
  revocation helper. Every protected request checks the marker after OAuth
  validation and before services or storage. R2's strongly consistent Worker
  binding makes denial effective after the successful write even if a KV read
  is stale. A failed or unavailable tombstone check fails closed. Never restore
  an older grant snapshot or old registry authority over a revocation.
- Keep the whole-host Access gate until the Worker independently fails closed
  for every API/MCP route and synthetic OAuth flow tests pass. Then narrow
  Access to the owner routes, exposing only standards-required OAuth discovery,
  registration, token and protected resource endpoints. Check public metadata,
  unauthenticated denial, wrong audience, scope denial and revocation immediately
  after the Access change. Restore the whole-host Access gate if any check fails.

## Consequences

The deployment gains one KV namespace for OAuth state and uses the existing R2
bucket for irreversible grant revocation markers. A protected request adds an
R2 lookup. OAuth grants do not change M4's reviewed local authority or M5's
qualified one-writer operating envelope. The personal vault remains disconnected
until synthetic backend and disposable-vault qualification pass.

Split implementation into independently reviewable changes: (1) provider and
resource validation with public exposure still blocked by Access; (2) owner
consent, grants, management and revocation; (3) Access path cutover and live
synthetic qualification; (4) Obsidian Connect and disposable-vault qualification;
(5) individual MCP-client qualification. Each merged stage must preserve
unauthenticated denial, scope policy and existing storage safety. Multiwriter
reconciliation is a separate decision and change.

## Alternatives

- **Cloudflare Managed OAuth alone:** lacks a documented stable grant ID at the
  Worker, so it cannot supply independent client permissions and revocation.
- **The M5 registry with a browser login:** still requires out-of-band token
  delivery and is not a conforming MCP OAuth authorization server.
- **Provider KV deletion alone for revocation:** KV reads are eventually
  consistent across locations, so an old token may remain usable briefly.
- **A custom OAuth implementation solely on R2:** avoids KV but assumes
  responsibility for protocol security, client registration, PKCE, token
  rotation and discovery without a compelling benefit.

## Evidence / related documents

- [Client-scoped authorization boundary](../plans/client-scoped-authorization.md)
- [ADR 0010 — current credential policy](0010-scoped-client-credentials-and-permissions.md)
- [ADR 0014 — current MCP authentication limit](0014-stateless-mcp-adapter-and-existing-credentials.md)
- [Cloudflare Workers OAuth provider](https://github.com/cloudflare/workers-oauth-provider)
- [Provider resources and audiences](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/resource-servers.md)
- [Provider grants and registration](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/authorization-server.md)
- [Workers KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
- [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
- [Cloudflare Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
