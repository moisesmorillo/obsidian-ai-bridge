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
inspection plugin with source tests, artifact checks and semantic review. M3 has completed [Slice 0 platform qualification](qualification/m3-slice-0-platform-primitives.md),
Slice 1's modern plugin baseline/shared typed contracts, Worker Slice 2A–2C's
conditional Worker boundary, Slice 3's device-local state/configuration owner and
handoff model, and Slice 4's typed bounded Fetch `RemoteBridge` adapter. The adapter
is not yet composed into plugin runtime behavior; no connected mirror exists.
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

`packages/core` contains the repository port, note application service, path invariants, and domain errors. Note-path validation and base64url conversion are separated under `packages/core/src/note-path/`; identifier validation has its own typed/constants/implementation modules. `packages/protocol` contains shared Zod-backed API response and error-code contracts plus stable public HTTP methods/statuses and v2 route, segment, query, header and media-type constants consumed by Worker and plugin adapters. Hono route-parameter syntax, CORS policy, Cloudflare bindings, R2, Scalar, and Worker response construction remain in `apps/worker`.

## Platform roles

### Cloudflare Worker

The Worker is the remote HTTP/API boundary. `index.ts` constructs the Hono app and long-lived LogTape dependency once per isolate. Request middleware resolves environment-specific authentication and creates current-generation/recovery application services from the active R2 binding; composition validates static non-secret association/writer UUIDs. `app.ts` composes typed Hono middleware, controllers, narrow v2 CORS, OpenAPI, and Scalar. One named v2 route-operation policy owns each public path and HTTP method; Hono registration, CORS capability resolution, and OpenAPI consume that policy instead of restating it. HTTP controllers validate transport input and delegate transition policy to `packages/core`. They do not call R2 or implement CAS/recovery policy.

### Cloudflare R2

R2 stores current objects under `vault/<normalized-path>` and recovery objects under
`recovery/<operation-uuid>` through `VAULT_BUCKET`, without client S3 credentials.
Configuration names a development bucket but does not prove a remote resource exists;
setup instructions are in the [README](../README.md#local-worker-development).
Reachable mutations use create-only or exact-observed-generation conditional PUT;
application policy also refuses mutation when an established generation's receipt
belongs to another association. Current tombstones and purged recovery markers are
retained, and no reachable v1/v2 mutation calls native R2 DELETE. This continuity
check is not bucket adoption: ADR 0003's safe reset remains a separately provisioned
isolated empty bucket/namespace with a new association and credentials. V2 pages scan
at most 50 objects and keep cursors opaque. The old unconditional repository remains
historical test coverage but is no longer composed into HTTP mutation routes.

### Obsidian plugin

`AiBridgePlugin` is a default-exported `Plugin` subclass. Enabling composes the
local service/adapter and registers two host-owned palette commands, with no scan,
read, network or persistence. A plugin-instance in-flight exclusion serializes both
commands across unload/re-enable until the active operation settles. Enable-lifetime
session identity suppresses stale UI, and unload closes owned modals/notices without
claiming that host reads are cancellable. Results show metadata as text, never note
content or raw exceptions.

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

The Worker authenticates `/api/v1`, `/api/v2`, and descendants with one bearer
token; public health/OpenAPI/Scalar do not grant note access. The token grants every
remote note operation in a single namespace, not scoped or per-device permissions.
Static v2 association/writer IDs guard cooperating clients but are not authentication.
R2 holds readable note text: the Worker/cloud operator is trusted, and no
application-level end-to-end encryption is implemented. Never infer production
readiness, installed resources or credentials from repository configuration.

Preserve canonical base64url addressing, validated relative lowercase `.md`
paths, the 1 MiB UTF-8 bound, sanitized errors and content-free structured
LogTape request logs. Do not log concrete note paths or raw failures. JSON API
and Markdown content responses are uncached via `no-store`.

Future automatic local publishing still requires composing explicit whole-mirror
consent, the implemented local state ownership primitives, and conflict/recovery
orchestration; a failed operation, stale read or missing file must never trigger
silent replacement or deletion. Worker v2
now provides the required conditional/recovery server contract and v1 mutations are
retired, but no plugin client uses it yet. Automatic outward lifecycle/rename remains
later M3 work; full remote-to-local reconciliation remains M4.

## M3 accepted design and partial Worker foundation

The [decisions/evidence](plans/m3-design-decisions.md),
[specification](milestones/m3-remote-bridge-client-and-publishing.md) and
[sequential plan](plans/m3-remote-bridge-client-and-publishing.md) define an automatic
**all-eligible Markdown mirror**, with whole opt-in, not per-note selection. iCloud
remains device-to-device vault sync; R2 is mirror/API persistence, not the sole
authority or guaranteed backup. Mirror scope is independent of REST/MCP authorization.

```text
settings / official saved-vault events / health controls
    ↓
core synchronizer + reconciliation planner + serialized state owner
    ↓
read-only local / remote conditional / state / event ports
    ↓
Obsidian adapters + bounded Fetch adapter
    ↓
Worker handlers → core conditional services → R2 adapters
```

Bootstrap merges positive saved observations; post-bootstrap events drive bounded
coalescing/retry. A two-slot scheduler and per-path intent ledger retain ACK revision/
hash and unresolved/delete/rename metadata without another local text copy. One
runtime-owned coordinator survives Plugin replacement/re-enable, distinct from UI
sessions; process restart recovers persisted intent. Unknown effects do not refresh
remote baselines or permit latest-revision overwrite.

Accepted-design [ADR 0002](decisions/0002-conditional-remote-note-mutation.md) specifies
fresh body-embedded revisions/receipts, R2 CAS, safe v2 and retirement of **v1 PUT and
DELETE**. [ADR 0004](decisions/0004-recoverable-mirror-deletions.md) archives text before
conditional tombstone, seals a 30-day window, retains heads and conditionally purges
expired recovery bodies to small markers. No native trash/version history, unsafe
cleanup DELETE or tombstone lifecycle expiration. Rename creates/acknowledges the
destination before source cleanup; conflicts/ambiguity preserve versions.

[ADR 0003](decisions/0003-publishing-association-and-local-state.md) defines one
explicitly designated supported writer device. Activation/ledger live in official
vault-local host storage, not iCloud-synced data.json; that file stores preferences
and native SecretStorage reference only. Worker static IDs guard cooperating writers,
not privileged bearer impersonation. Clean handoff drains old requests and transfers
verified content-free ACKs; one indexed local/remote evidence batch must align all new
local hashes/tombstone absences through one state-owner save before activation, and
unresolved work blocks takeover. No election/leases or
shared-file coordinator. M3 targets Obsidian 1.13.0/modern settings, HTTPS with exact
loopback opt-in and bounded Fetch/CORS, without old-host/requestUrl fallbacks.

These remain the accepted end-to-end design rather than a connected user-visible
mirror; M2 commands remain local-only. Slice 1 raises the manifest to 1.13.0 and adds
core/protocol contracts. Worker Slice 2A–2C implements private format-2 codecs,
create-only and observed-generation CAS, metadata reads, prepared/unexpired recovery
content, bounded pagination, exact receipts, recoverable tombstone ordering,
tombstone-timestamp sealing, conditional purge, public authenticated v2 routes,
method-specific CORS, static writer designation checks, generated OpenAPI and
envelope-aware v1 reads. V1 PUT/DELETE are retired with 410. Slice 3 adds core-owned
closed device/per-path state, serialized compare-and-transition persistence, explicit
activation, durable handoff-draining/drained lifecycle states and staged import policy.
Alignment and invalidation consume indexed batches so bounded ledgers do not cause
per-path whole-state persistence. Obsidian adapters keep preferences/secret references
in data.json, the bearer in native SecretStorage, and device identity,
activation and the bounded content-free ledger in App local storage. A package Symbol
retains the owner only within one JavaScript host. Slice 4 adds a core `RemoteBridge`
capability contract and plugin standards-Fetch implementation. The operation adapter
owns request construction and response decoding, a dedicated dispatcher owns
coordinator admission/native bearer/deadline/late body settlement, a DTO mapper owns
protocol-to-domain validation, and one typed response-policy table owns operation
methods, accepted statuses, failures and dispatched effect certainty. It is uncomposed:
there is still no settings UI, autosync, Vault event wiring or deployment claim.
Slice 0 remains the pinned local workerd qualification task and declaration-only host
check; neither slice establishes real-host behavior.

## Explicitly deferred

- M3 (NEXT, design ready): implementation/qualification of the complete automatic
  outward mirror, including basic recovery and safe writer handoff.
- M4: Remote-to-local authority, conflict resolution, adoption and richer restore UX.
- M5: Broader operational readiness, abuse limits and scoped authentication evolution.
- M6: Authorized MCP transport/tool definitions, never direct R2 access.
- Outside this roadmap: search, attachments and AI inference. NAS replication or
  stronger remote authority are possibilities, not selected infrastructure. D1,
  Durable Objects, queues, Workers AI, Vectorize and external databases are not
  selected dependencies.

Future product choices remain visible in the [roadmap decision register](roadmap.md#unresolved-product-decisions).
Use [ADRs](decisions/README.md) when resolving consequential choices; do not add
services or silently reopen accepted boundaries as incidental implementation work.
