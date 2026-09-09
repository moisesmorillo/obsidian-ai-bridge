# Architecture

## Current architecture

The repository is a Bun workspace monorepo with two application adapters and two shared packages:

```text
apps/worker            Cloudflare Worker adapter and infrastructure integration
apps/obsidian-plugin   Obsidian client integration and local vault adapter
packages/core          Platform-independent domain and application logic
packages/protocol      Shared protocol contracts and serialization definitions
```

The current implementation contains only scaffold code and a small core utility test. No network, vault, storage, authentication, or synchronization behavior is implemented.

## Package boundaries

Dependencies should flow from application adapters toward shared packages:

```text
apps/*
   ↓
packages/protocol
packages/core
```

`packages/core` remains platform-independent. It must not depend on Cloudflare APIs, Obsidian APIs, HTTP frameworks, or filesystem implementations. Transport and platform concerns belong in the application adapters.

## Planned platform roles

### Cloudflare Worker

The Worker will eventually be the remote HTTP/API boundary. It is expected to validate requests, coordinate application logic, and connect platform bindings to the shared packages. Its adapter has no product behavior yet.

### Cloudflare R2

R2 is planned for durable object storage associated with the bridge. Bindings, data models, retention, and access rules are intentionally deferred.

### Obsidian plugin

The plugin will eventually use official Obsidian APIs to connect local vault operations to the bridge. Vault access and plugin behavior are intentionally deferred.

### Future MCP adapter

MCP is planned as a future adapter for agent clients. It is not implemented, and no MCP-specific dependency or contract is included in this scaffold.

## Explicitly deferred

- Authentication and authorization.
- REST endpoints and request handling.
- R2 persistence and migrations.
- Vault reads, writes, and path handling.
- Synchronization, conflict detection, and conflict resolution.
- MCP transport and tool definitions.
