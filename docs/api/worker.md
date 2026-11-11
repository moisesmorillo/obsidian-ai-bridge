# Worker API

This guide describes the current Worker API and its repository configuration. The product contract lives in [`docs/spec.md`](../spec.md).

## Service entry points

The Worker exposes the versioned vault API under `/v1`, the MCP server at `/mcp`, OAuth discovery and consent routes, and Access-protected owner pages. `apps/worker/src/index.ts` composes the routes. The protocol schemas in `packages/protocol` define request and response shapes.

The plugin uses `obsidian://vaultwire/callback` for device authorization. The Worker accepts that private redirect URI for public-client registration.

## Authorization

OAuth uses authorization code with PKCE and rotating refresh tokens. The supported scopes are `vault:read`, `vault:write`, and `vault:delete`. Read is mandatory at consent. Owners can clear either optional scope. Write does not grant delete. Device enrollment requests all three scopes.

The Worker validates selected scopes against the authenticated stored consent request before it creates a durable grant. The durable registry remains the authority for current client grants and revocation.

## MCP Base tools

The MCP server exposes six native Base tools. Each tool uses the existing vault authority and returns the current `epoch`.

| Tool | Scope | Request | Result |
| --- | --- | --- | --- |
| `list_bases` | `vault:read` | `prefix?`, `include_large?` | Bounded Base metadata only |
| `read_base` | `vault:read` | `path`, `etag?`, `offset?`, `length?` | Raw text or a revision-pinned fragment |
| `create_base` | `vault:write` | `path`, `content`, `epoch`, `idempotency_key?` | New ETag from a create-only mutation |
| `update_base` | `vault:write` | `path`, `content`, `etag`, `idempotency_key?` | New ETag from exact-revision replacement |
| `delete_base` | `vault:delete` | `path`, `etag` | Exact-revision tombstone |
| `validate_base` | `vault:read` | `content` | Structural-only validity and bounded diagnostics |

Every path follows the canonical vault path schema and must end in `.base` as its final extension. The suffix check is ASCII case-insensitive. Create, update, and validation accept at most 65,536 UTF-8 content bytes. Reads use the existing bounded UTF-16 fragment offsets and can read large Base blobs. Create and update first check write scope, revocation, and the current epoch. They then validate bounded Base structure before the existing conditional text mutation. Writes pass the exact input text without serializing parsed YAML, so comments, view data, unknown settings, and whitespace remain intact. Mutations require the current epoch or exact observed ETag. Create never replaces an existing path. Update and delete never replace a newer revision.

`validate_base` first checks read authority, current epoch, and revocation. It then checks cancellation before and after bounded parsing. The validator checks YAML structure only. It does not evaluate filters or formulas, return parsed data, read storage, or change file properties. Its parser bounds are 65,536 UTF-8 bytes, 16,384 tokens, parser stack 34, 32 indicators per line, depth 32, 16,384 syntax nodes, and 8 diagnostics of at most 256 characters. Validation uses the MCP read slot and request-envelope reservation, but no durable read admission. It retains those Worker reservations until response EOF or cancellation. `list_bases` and `read_base` transfer durable read ownership and cancel and join their source before admission completion. Base mutations keep response admissions through EOF or cancellation. Uncertain operation work retains its existing deadline.

Example requests:

```json
{"name":"list_bases","arguments":{"prefix":"Freelance/Career Ops/Opportunities/"}}
{"name":"read_base","arguments":{"path":"Freelance/Career Ops/Opportunities/pipeline.base"}}
{"name":"create_base","arguments":{"path":"Freelance/Career Ops/Opportunities/pipeline.base","content":"views:\n  - type: table\n    name: Pipeline\n","epoch":"0123456789abcdef0123456789abcdef"}}
{"name":"update_base","arguments":{"path":"Freelance/Career Ops/Opportunities/pipeline.base","content":"views: []\n","etag":"\"0123456789abcdef0123456789abcdef.1\""}}
{"name":"delete_base","arguments":{"path":"Freelance/Career Ops/Opportunities/pipeline.base","etag":"\"0123456789abcdef0123456789abcdef.2\""}}
{"name":"validate_base","arguments":{"content":"views:\n  - type: table\n"}}
```

There is no `query_base` tool or query engine. Base validation proves bounded structural validity only. It does not prove Obsidian UI behavior.

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
