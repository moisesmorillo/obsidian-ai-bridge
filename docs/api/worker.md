# Worker API

This guide describes the current Worker API and its repository configuration. The product contract lives in [`docs/spec.md`](../spec.md).

## Service entry points

The Worker exposes the versioned vault API under `/v1`, the MCP server at `/mcp`, OAuth discovery and consent routes, and Access-protected owner pages. `apps/worker/src/index.ts` composes the routes. The protocol schemas in `packages/protocol` define request and response shapes.

The plugin uses `obsidian://vaultwire/callback` for device authorization. The Worker accepts that private redirect URI for public-client registration.

## Authorization

OAuth uses authorization code with PKCE and rotating refresh tokens. The supported scopes are `vault:read`, `vault:write`, and `vault:delete`. Read is mandatory at consent. Owners can clear either optional scope. Write does not grant delete. Device enrollment requests all three scopes.

The Worker validates selected scopes against the authenticated stored consent request before it creates a durable grant. The durable registry remains the authority for current client grants and revocation.

## Production configuration

`apps/worker/wrangler.production.jsonc` sets the Worker name and `VAULT_OBJECT_NAME` to `vaultwire`. It binds the `Vault` Durable Object, OAuth KV, blob storage, and backup storage. Its released `vaultwire-transfer-v1` migration remains in the configuration history. This migration records the prior namespace transfer. The `vaultwire` object key selects a new, empty registry. Old revision history and export lists remain in the old object.

The deployment workflow keeps its repository-owner actor checks, Worker preflight, deployment-token check, owner-subject check, and public resource-metadata check. It does not use a cutover-secret guard.

## Local checks

Run the Worker tests and package checks from the repository root:

```sh
bun run --filter '@vaultwire/worker' test
bun run --filter '@vaultwire/worker' typecheck
bun run docs:check
```

These commands use local and synthetic fixtures. They do not deploy the Worker or access a real vault.
