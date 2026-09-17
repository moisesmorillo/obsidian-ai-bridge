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
handoff model, Slice 4's typed bounded Fetch `RemoteBridge` adapter, Slice 5's
core-only bootstrap/reconciliation scheduler, Slice 6's runtime deletion,
recreation and rename orchestration, and Slice 7's official host/runtime/settings
composition. Slice 8's generated-artifact qualification and operational documentation
are implemented. The independent final review found three MINOR issues, corrective
head `e97af36` resolved all three, and the corrective review returned APPROVE with no
open findings. M3 is COMPLETE; PR #27 merged at `63b0599` and made the transition
canonical. M4 is NEXT with an implementation-ready reviewed-reconciliation design,
but no M4 production behavior exists. The connected outward mirror remains
experimental and undeployed, with no real Obsidian desktop/mobile or iCloud runtime
qualification.
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

`AiBridgePlugin` is a default-exported `Plugin` subclass. Enabling synchronously
registers the two M2 inspection commands, then loads strict preferences/device state
and attaches one presentation/event/timer session to the versioned same-App-realm M3
owner. Unconfigured, disabled and non-writer states remain passive. A configured
active designated writer registers official saved Vault events before layout-ready
bootstrap and automatically mirrors all eligible Markdown through the core scheduler
and bounded Fetch adapter. The M2 in-flight exclusion remains independent. Session
identity suppresses stale UI, and unload detaches callbacks, UI and timers while the
owner retains admission reservations and durable settlement. Results show metadata
as text, never note content or raw exceptions.

```text
M2 inspection commands                 M3 settings / saved Vault events / timers
    |                                      |
LocalInspectionService                 same-realm MirrorRuntimeOwner
    |                                      |
ReadOnlyLocalVault                 core MirrorSynchronizer + state owner
    |                                      |
ObsidianLocalVault              Obsidian saved-read/state + bounded Fetch adapters
    \______________________________________/
                official Obsidian host APIs
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
The inspection service discards transient content before returning metadata. M3
settings use modern declarative definitions and native SecretStorage references;
only dispatch-time adapter code reads the bearer. The plugin uses no editor events,
raw filesystem APIs or local mutation capability.

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

Slice 7 composes explicit whole-mirror consent with the implemented state,
synchronization and lifecycle policy. A failed operation, stale read or missing scan
entry still cannot trigger silent replacement or deletion; only post-bootstrap host
events can admit deletion authority. Worker v2 provides the conditional/recovery
server contract and v1 mutations remain retired. Core Slice 6 owns recovery-first
deletion, exact tombstone recreation, destination-first rename and bounded observed-
descendant folder expansion; the plugin invokes it only through primitive eligible
saved-event evidence. Full remote-to-local reconciliation remains M4.

## M3 implemented outward-mirror architecture

The [decisions/evidence](plans/m3-design-decisions.md),
[specification](milestones/m3-remote-bridge-client-and-publishing.md),
[sequential plan](plans/m3-remote-bridge-client-and-publishing.md), and
[operator guide](operations.md) define the implemented automatic **all-eligible
Markdown mirror**, with whole opt-in rather than per-note selection. iCloud remains
device-to-device vault sync; R2 is mirror/API persistence, not the sole authority or
guaranteed backup. Mirror scope is independent of REST/MCP authorization. Slice 8
qualifies the built CommonJS composition and documents operations; it does not change
this architecture or add M4 authority.

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

This is now a connected experimental outward mirror when one designated writer is
explicitly configured and activated; M2 commands remain independent local-only
inspection. Slice 1 raises the manifest to 1.13.0 and adds core/protocol contracts.
Worker Slice 2A–2C implements private format-2 codecs,
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
Slice 5 adds `MirrorSynchronizer`, a FIFO two-slot/one-path scheduler, bounded
inventory traversal, positive-observation generations, quiet/max-wait coalescing,
and finite durable mutation/evidence recovery. Slice 6 extends that core facade with
post-bootstrap event admission and delegates deletion authority/grace, tombstone
execution, destination-first rename prerequisites, deferred cleanup and bounded
folder expansion to focused lifecycle owners. The synchronizer is the public phase/
scheduler facade: `MirrorBootstrapCoordinator` owns handshake, indexed durable batch
admission and reporting-inventory coordination; `MirrorPathRuntime` owns ephemeral
coalescing/retry deadlines; `MirrorPositiveReconciler` owns stable positive reads and
new intent creation; and `MirrorIntentExecutor` applies the exhaustive typed intent/
evidence/effect decisions in `mirror-intent-policy.ts`. Durable autosync ledger
transformations and acknowledgement matching have focused semantic owners rather than
living in the facade. These collaborators use `ReadOnlyLocalVault`, `RemoteBridge`,
`MirrorStateOwner`, and injected time/hash/operation-ID seams without host callbacks
or platform timers. Synchronization starts inactive and only a current successful
handshake plus durable indexed bootstrap admission enables positive work; local,
capacity, stale-state, or persistence failure remains explicitly inactive. Reporting
inventory shares the two slots but does not hold the positive-work admission gate while
pagination remains pending. Mutation policy persists intents and consumed budgets before
calls, applies exact ACK/receipt evidence through the latest serialized owner state,
keeps newer desired generations dirty, and suppresses wake deadlines while lifecycle/
global/persistence admission is closed. Inventory is reporting-only and cannot
authorize deletion. Runtime deletion evidence is durable before dispatch, waits five
seconds and requires exact local absence; a fresh process conservatively rearms the
full grace because process-local monotonic timestamps are not cross-restart clocks.
Own pending updates settle before a fresh
recovery-first tombstone intent. Tombstone recreation verifies the exact acknowledged
generation. Renames reserve both paths lexically, persist the destination ACK before
source cleanup, and retain invalidated/deferred plans rather than claiming atomicity.
Folder expansion uses only pre-event tracked descendants under path boundaries and
the global ledger bound. Slice 7 adds host composition behind a Promise-backed,
versioned `globalThis`/`Symbol` owner registry per App realm. `MirrorRuntimeOwner`
remains the facade while focused coordinators own observation attachment epochs,
configuration/connection admission, non-destructive reconciliation progress and
staged-handoff verification. Every listener gap receives a fresh layout-ready positive
scan without replacing scheduler reservations or deriving delete authority from
absence. Bootstrap positive admission notifies the current session before reporting
inventory settles, allowing the free scheduler slot to run local work without polling.
Staged handoff events advance durable positive generations and invalidate sampled
metadata; alignment plus activation is one serialized transition, and events arriving
while it commits are sequenced after that transition rather than discarded. Native
secret-reference settings expose non-secret local/server designation and require the
accepted whole-mirror/plaintext/deletion disclosure before activation. Request
cancellation retains permits through settlement; one-shot timers stop after explicit
runtime fencing, and Web Crypto capability/provider failure closes durable mutation
admission while preserving dirty work for explicit recovery. Replacement sessions
never replace owner state; incompatible registry versions fail closed. No M4
remote-to-local behavior exists. Slice 0 remains the
pinned local workerd qualification task and declaration-only host check; no slice
establishes real-host behavior.

## Explicitly deferred

- M4 (NEXT, implementation-ready planning only): reviewed/manual reconciliation,
  exact revisioned adoption, archive-first conflicts, a separate bounded local
  mutation port, reviewed tombstones, local-first restore, deferred-history choices,
  deterministic state-v2→v3 migration, existing v2 API, and the retained one-writer
  model. Planned dependency flow is thin commands/modal → focused core review/action
  policy owners → `ReadOnlyLocalVault` + a separate `LocalReconciliationWriter` +
  existing `RemoteBridge`/state owner → Obsidian/Fetch adapters. Remote divergence
  remains a review item; no automatic import or cross-system atomicity is claimed.
- M5: Broader operational readiness, abuse limits and scoped authentication evolution.
- M6: Authorized MCP transport/tool definitions, never direct R2 access.
- Outside this roadmap: search, attachments and AI inference. NAS replication or
  stronger remote authority are possibilities, not selected infrastructure. D1,
  Durable Objects, queues, Workers AI, Vectorize and external databases are not
  selected dependencies.

Future product choices remain visible in the [roadmap decision register](roadmap.md#unresolved-product-decisions).
Use [ADRs](decisions/README.md) when resolving consequential choices; do not add
services or silently reopen accepted boundaries as incidental implementation work.
