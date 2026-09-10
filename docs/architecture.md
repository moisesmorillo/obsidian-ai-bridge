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
Hono routes and middleware
    |
HTTP handlers and response/error mapping
    |
packages/core note application services and path validation
    |
VaultRepository contract
    |
R2VaultRepository in apps/worker
    |
Cloudflare R2 binding
```

The Worker authenticates API requests, validates media type, payload size, UTF-8, and the canonical note identifier before invoking core operations. Core decodes and validates the base64url identifier into a normalized note path. R2 objects use the `vault/<normalized-path>` layout. Listing follows R2 cursors and returns only safe Markdown paths without the internal prefix.

## Worker structure

```text
apps/worker/src/
├── app.ts                         Hono assembly, middleware, and routes
├── app.types.ts                   Dependency contract for the transport adapter
├── auth/                          Bearer parsing, scheme validation, token comparison
├── env/                           Cloudflare binding types
├── http/                          Controllers, HTTP errors, responses, OpenAPI routes
├── infrastructure/                R2 vault repository adapter and R2 port subset
├── logging/                       Structured LogTape adapter and request logging middleware
└── index.ts                       One-time Worker application assembly and dependency construction
```

`packages/core` contains the repository port, note application services, path invariants, and domain errors. `packages/protocol` contains shared Zod-backed API response and error-code contracts. Hono, Cloudflare bindings, R2, Scalar, and HTTP status mapping remain in `apps/worker`.

## Platform roles

### Cloudflare Worker

The Worker is the remote HTTP/API boundary for M1. `index.ts` constructs the Hono app and long-lived LogTape dependency once per isolate. Request middleware resolves environment-specific authentication and creates application services from the active R2 binding; `app.ts` composes typed Hono middleware, controllers, OpenAPI, and Scalar. HTTP controllers validate transport input and delegate vault operations to `packages/core`. They do not contain vault business rules.

### Cloudflare R2

R2 stores Markdown notes under `vault/<normalized-path>`. The configured development bucket is `obsidian-ai-bridge-dev`; it must be created with `mise exec -- bunx wrangler r2 bucket create obsidian-ai-bridge-dev --config apps/worker/wrangler.jsonc` before remote use. The Worker accesses it only through its binding and does not use S3 credentials.

### Obsidian plugin

The plugin will eventually use official Obsidian APIs to connect local vault operations to the bridge. Vault access and plugin behavior are intentionally deferred.

### Future MCP adapter

MCP is planned as a future adapter for agent clients. It is not implemented, and no MCP-specific dependency or contract is included in M1.

## Explicitly deferred

- Obsidian vault access and plugin behavior.
- Synchronization, conflict detection, and conflict resolution.
- MCP transport and tool definitions.
- Search, D1, Durable Objects, Workers AI, and Vectorize.
