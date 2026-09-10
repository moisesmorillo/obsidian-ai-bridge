# Architecture

## Current architecture

The repository is a Bun workspace monorepo with two application adapters and two shared packages:

```text
apps/worker            Cloudflare Worker adapter and infrastructure integration
apps/obsidian-plugin   Obsidian client integration and local vault adapter
packages/core          Platform-independent domain and application logic
packages/protocol      Shared protocol contracts and serialization definitions
```

M1 is complete: an authenticated HTTP Worker API backed by Cloudflare R2 plus the
engineering-quality foundation. M2 is complete: a local-only read-only Obsidian
inspection plugin with source tests, artifact checks and semantic review. M3 is
[planning only](milestones/m3-remote-bridge-client-and-publishing.md); there is no
connection between the plugin and Worker yet.
See the [verified current state](current-state.md) for source/configuration evidence,
[roadmap](roadmap.md) for execution order and open decisions, and
[ADR 0001](decisions/0001-worker-r2-foundation.md) for the durable foundation.

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

`packages/core` contains the repository port, note application service, path invariants, and domain errors. Note-path validation and base64url conversion are separated under `packages/core/src/note-path/`; identifier validation has its own typed/constants/implementation modules. `packages/protocol` contains shared Zod-backed API response and error-code contracts. Hono, Cloudflare bindings, R2, Scalar, and HTTP status mapping remain in `apps/worker`.

## Platform roles

### Cloudflare Worker

The Worker is the remote HTTP/API boundary for M1. `index.ts` constructs the Hono app and long-lived LogTape dependency once per isolate. Request middleware resolves environment-specific authentication and creates application services from the active R2 binding; `app.ts` composes typed Hono middleware, controllers, OpenAPI, and Scalar. HTTP controllers validate transport input and delegate vault operations to `packages/core`. They do not contain vault business rules.

### Cloudflare R2

R2 stores Markdown notes under `vault/<normalized-path>` through `VAULT_BUCKET`,
without client S3 credentials. Configuration names a development bucket but does
not prove a remote resource exists; setup instructions are in the
[README](../README.md#local-worker-development). All pages are aggregated on list;
unsafe/non-Markdown/oversized entries are filtered. Writes are unconditional,
with a separate existence check for the response status; deletes are immediate
and idempotent. Neither operation supplies sync conflict protection or recovery.

### Obsidian plugin

`AiBridgePlugin` is a default-exported `Plugin` subclass. Enabling composes the
local service/adapter and registers two host-owned palette commands, with no scan,
read, network or persistence. Both commands share an ephemeral busy state; unload
invalidates in-flight UI and closes owned modals/notices. Host reads are not
cancellable. Results show metadata as text, never note content or raw exceptions.

```text
Plugin commands / metadata-only modal and notices
    |
LocalInspectionService in packages/core
    |
ReadOnlyLocalVault port + shared local eligibility policy
    |
ObsidianLocalVault / official saved-file host bridge
    |
Vault.getFiles / getAbstractFileByPath + TFile / Vault.read
```

Core owns closed typed results, literal path/size policy and lexical sorting. The
local port is separate from mutation-capable M1 `VaultRepository`. The adapter
supplies the exact host configuration directory, enumerates metadata without
reading bodies, and resolves/reads the active captured saved path once. Shared
policy rejects unsupported, excluded, invalid and oversized files in order;
1 MiB bounds both metadata and measured UTF-8 text. Dot-prefixed segments and the
configuration subtree are private regardless of M1 remote path acceptance.

Pre/post object identity, path, size and mtime checks reject observed changes.
They are best-effort evidence, not an atomic snapshot or future write revision.
The service discards transient content before returning metadata. No editor save,
raw filesystem, settings, logging, mutation or Worker integration is present.

Bun stages browser-target CommonJS `main.js` plus the unchanged manifest. The
bundle exposes `module.exports.default` with only `obsidian` external; no Node
runtime shim is needed. A separate Vitest artifact suite evaluates this generated
bundle against an isolated host double in canonical `build`/`check`. Source
unit/integration tests remain covered independently. See
[development instructions and official API/version evidence](plugin-development.md)
for install/removal and the explicit absence of real desktop/mobile host tests.

### Future MCP adapter

MCP is planned as a future adapter for agent clients. It is not implemented, and no MCP-specific dependency or contract is included in M1.

## Security and data-safety boundaries

The Worker authenticates `/api/v1` and descendants with one bearer token; public
health/OpenAPI/Scalar do not grant note access. The token grants every remote
note operation in a single namespace, not scoped or per-device permissions.
R2 holds readable note text: the Worker/cloud operator is trusted, and no
application-level end-to-end encryption is implemented. Never infer production
readiness, installed resources or credentials from repository configuration.

Preserve canonical base64url addressing, validated relative lowercase `.md`
paths, the 1 MiB UTF-8 bound, sanitized errors and content-free structured
LogTape request logs. Do not log concrete note paths or raw failures. JSON API
and Markdown content responses are uncached via `no-store`.

Future local writes require explicit consent and conflict/recovery semantics;
a failed operation, stale read or missing file must never trigger a silent
replacement or deletion. M1's unconditional remote CRUD is not safe automatic
synchronization. The roadmap requires a safe mutation contract before M3 publishes
and defers full reconciliation/import/deletions to M4.

## Explicitly deferred

- M3 (NEXT, planning only): Remote client, opt-in selection/settings and safe
  explicit publishing; product and conditional-mutation decisions remain open.
- M4: Synchronization direction, conflicts, remote-to-local writes, deletion/
  tombstones, reconciliation and offline state.
- M5: Operational readiness, resource limits and authentication evolution.
- M6: MCP transport and tool definitions.
- Outside this roadmap: search, attachments and AI inference. D1, Durable Objects,
  queues, Workers AI, Vectorize and external databases are not selected dependencies.

Future product choices remain visible in the [roadmap decision register](roadmap.md#unresolved-product-decisions).
Use [ADRs](decisions/README.md) when resolving consequential choices; do not add
services or silently reopen accepted boundaries as incidental implementation work.
