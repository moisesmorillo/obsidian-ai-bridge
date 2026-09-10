# Architecture

## Current architecture

The repository is a Bun workspace monorepo with two application adapters and two shared packages:

```text
apps/worker            Cloudflare Worker adapter and infrastructure integration
apps/obsidian-plugin   Obsidian client integration and local vault adapter
packages/core          Platform-independent domain and application logic
packages/protocol      Shared protocol contracts and serialization definitions
```

Milestone 1 implements an authenticated HTTP Worker API backed by Cloudflare R2. The Obsidian plugin remains a scaffold.

## Package boundaries

Dependencies should flow from application adapters toward shared packages:

```text
apps/*
   ↓
packages/protocol
packages/core
```

`packages/core` remains platform-independent. It must not depend on Cloudflare APIs, Obsidian APIs, HTTP frameworks, or filesystem implementations. Transport and platform concerns belong in the application adapters.

## M1 request flow

```text
Worker HTTP adapter
    |
packages/core note operations and path validation
    |
VaultRepository contract
    |
R2VaultRepository in apps/worker
    |
Cloudflare R2 binding
```

The Worker validates the bearer token, request media type, body size, and note identifier before invoking core operations. Core decodes and validates the base64url identifier into a normalized note path. R2 objects use the `vault/<normalized-path>` layout. Listing follows R2 cursors and returns only safe Markdown paths without the internal prefix.

## Platform roles

### Cloudflare Worker

The Worker is the remote HTTP/API boundary for M1. It validates requests, coordinates core operations, and connects the `VAULT_BUCKET` binding to the shared repository contract. It does not contain vault business rules.

### Cloudflare R2

R2 stores Markdown notes under `vault/<normalized-path>`. The configured development bucket is `obsidian-ai-bridge-dev`; it must be created with `bunx wrangler r2 bucket create obsidian-ai-bridge-dev` before remote use. The Worker accesses it only through its binding and does not use S3 credentials.

### Obsidian plugin

The plugin will eventually use official Obsidian APIs to connect local vault operations to the bridge. Vault access and plugin behavior are intentionally deferred.

### Future MCP adapter

MCP is planned as a future adapter for agent clients. It is not implemented, and no MCP-specific dependency or contract is included in M1.

## Explicitly deferred

- Obsidian vault access and plugin behavior.
- Synchronization, conflict detection, and conflict resolution.
- MCP transport and tool definitions.
- Search, D1, Durable Objects, Workers AI, and Vectorize.
