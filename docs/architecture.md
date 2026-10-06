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
canonical. M4 Slices 1–8 and M5 are COMPLETE. M6's stateless Worker MCP adapter is
COMPLETE and qualified in this transition. M7 — versioned sync protocol and isolated
R2 store — is COMPLETE as private isolated delivery on this documentation transition's
merge under [ADR 0020](decisions/0020-private-sync-store-delivery-and-activation-gate.md).
The [criterion report and G1–G6 gates](qualification/m7-delivery-and-activation-gate.md)
separate delivered code from undemonstrated safety and operational qualification. It does
not authorize sync activation, migration, or changes to the current writer. The current
M7.1 protocol contracts live in `packages/protocol`: protocol-major-one identity and
checkpoint schemas, canonical sync namespace keys, SHA-256 feed-lane selection, and
opaque cursor encoding. M7.2 adds the storage-independent `SyncStore` port and pure
conditional-mutation policy in `packages/core`; a test-only serialized in-memory fake
exercises exact-parent concurrency, operation replay, tombstone safety, and conservative
pending/unknown outcomes. The fake is not a production adapter or proof of durable
multi-key CAS, feed pagination, inventory persistence, or local workerd behavior. Core
production code remains independent of protocol, Worker, R2, HTTP, and plugin
composition. M7.3 adds private `apps/worker/src/infrastructure/sync/` persisted codecs,
canonical keys, one-key R2 create/CAS/read-back evidence, and separate marker-gated
current/version/recovery and inventory scratch facades. The one-key boundary owns
conditional effects and 1,100-ms per-key cooldown, with caller-carried retry floors
for later durable M7.4 recovery; the facades validate record/key/body linkages but
do not implement `SyncStore`, journal/feed sequencing or completed scans. Raw
Markdown is retained byte-for-byte and compared to separate hash/size metadata
before a complete read is returned. Live versions link their own content body;
tombstone versions instead verify their parent's retained recovery metadata and
body, without copying content under the tombstone revision. An unavailable
conditional read-back cannot
be promoted to either success or definite failure. No new private facade is
composed into Worker HTTP/MCP or the plugin; M1–M6 v2 objects and writer remain
unchanged. Canonical `mise run check` passed after the tombstone-evidence
correction with 1,565 source tests, 9 local workerd tests and 95.00%
statement coverage (no headroom). Local workerd
demonstrates conditional semantics, not production rate limiting or Workers Free
CPU qualification. [M7.3 evidence](milestones/m7-versioned-sync-protocol-and-r2-store.md#m73-isolated-r2-primitives-evidence)
records the historical primitive boundary. M7.4 now adds private durable
journal/feed and stable-vector inventory orchestration. `sync-r2-store.ts` composes
the nine-method core port: the mutation orchestrator owns publication transitions,
the attempt policy owns claim/floor decisions without granting a PUT, and terminal
handling verifies the exact outcome/evidence conjunction. The publication facade
admits identity-bound one-key transitions; the R2 adapter retains original
conditional predicates and conservative effect classification. Separate inventory
budget, cursor-witness, replay, page-evidence and cleanup owners enforce bounded
progress without relisting verified chunks or reusing expired manifest identities.
No HTTP/MCP/plugin bootstrap imports this composition. PR #97 merged it at
`62696b0`, including strict runtime LIST validation and an immutable schema-v2
terminal failure latch at the existing step chunk key. A latch never authorizes
page/cursor progress: same-ID recovery fails the exact reserved manifest without
relisting, retains uncertainty, and releases only the owned slot when safe. Frozen
v1 page decoding and namespace/storage ceilings are unchanged. See
[M7.4 local evidence](qualification/m7-private-sync-store-local.md) for checks and
independent review. Local maximum 5,000/10,000-head profiles are retained evidence, not isolate/remote
qualification. Real 24-hour expiry is incomplete. Workers Free CPU/memory/account,
real R2 and missing native safety matrices remain pending under the
[qualification plan](plans/m7-sync-store-qualification.md); G1–G6 block activation
and real-data use. No implementation limits or active composition changed.
The current
plugin boundary includes strict device state v5 with
frozen v2/v3/v4 migration, reviewed sampling/admission, narrow local writes and
preservation, live/adoption/tombstone/restore actions, bounded parent-owned history
steps, step-scoped archives, one shared M3/M4 scheduler, durable synthetic
local-effect/successor evidence, and runtime/session/command/modal/status composition.
ADR 0009 governs the historical v4 transition; ADR 0013 adds the atomic v5
observation-gap correction. The final M5 report records the narrow v1.0.2 support
claim, exact Obsidian/macOS host, synthetic active-writer qualification through 10,000
notes, current v5 migration/restart measurements, reproducible artifact evidence, and
remaining platform/deployment limits. This is software qualification, not security
certification or production-service approval; no production deployment or personal
vault was used. See the [verified current state](current-state.md) for
source/configuration evidence, [roadmap](roadmap.md) for execution order and open
decisions, and [ADR 0001](decisions/0001-worker-r2-foundation.md) for the durable
foundation.

## M8 experimental local composition

The [local lab](local-sync-demo.md) has a separate `apps/worker/src/demo/index.ts`
and `wrangler.demo.jsonc`, not imported by release composition. Strict transport
schemas bind requests to a server-configured vault/participant; registry read/write
permissions are independent. `SyncDemoService` admits only the synthetic path/byte
scope, then delegates exact-parent mutation/replay and current/version/feed evidence
to the existing SyncStore. Only admitted mutations may prepare the fresh marker;
reads never provision it. No inventory CPU override, OAuth, MCP, legacy read-through,
delete, migration or plugin activation is added. The client/experimental plugin are
later M8 deliveries; G1–G6 production/real-data gates remain open.

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
├── auth/                          Bearer parsing, strict registry validation, digest verification, typed principals
├── env/                           Cloudflare binding types
├── http/                          Controllers, HTTP errors, responses, OpenAPI routes
├── infrastructure/                R2 vault repository adapter and R2 port subset
├── logging/                       Structured LogTape adapter and request logging middleware
├── mcp/                           Stateless MCP protocol server and bounded HTTP transport adapter
└── index.ts                       One-time Worker application assembly and dependency construction
```

`packages/core` contains the repository port, note application service, path invariants, and domain errors. Note-path validation and base64url conversion are separated under `packages/core/src/note-path/`; identifier validation has its own typed/constants/implementation modules. `packages/protocol` contains shared Zod-backed API response and error-code contracts plus stable public HTTP methods/statuses and v2 route, segment, query, header and media-type constants consumed by Worker and plugin adapters. Hono route-parameter syntax, CORS policy, Cloudflare bindings, R2, Scalar, and Worker response construction remain in `apps/worker`.

## Platform roles

### Cloudflare Worker

The Worker is the remote HTTP/API boundary. `index.ts` constructs the Hono app and long-lived LogTape dependency once per isolate. Request middleware validates the digest-only M5 credential registry first. Post-M6 OAuth validation is an additional bearer path: the Cloudflare provider checks the exact REST or MCP resource against KV, strict grant props and token scopes narrow the existing typed client principal, and an R2 revocation-marker read must confirm the grant remains active before service resolution. Provider or marker failures deny OAuth access. Access-protected owner routes provide consent and grant revocation, while provider routes issue OAuth tokens and register clients. The same operation policies still enforce exact permissions before creating current-generation/recovery application services from the active R2 binding; composition then validates static non-secret association/writer UUIDs. Completed-request logging consumes the same route-operation policy to emit closed content-free authentication, operation, status, and stable-error outcomes without becoming an authorization owner. Singleton authentication is retired. `app.ts` composes typed Hono middleware, controllers, narrow v2 CORS, OpenAPI, Scalar, and the stateless MCP endpoint. The HTTP route-operation policy owns each API operation; an exhaustive MCP capability-to-permission table gates every MCP tool and content resource independently. MCP has no repository or R2 dependency and does not expose local-vault mutation or reviewed reconciliation. HTTP controllers and MCP callbacks validate transport input and delegate transition policy to `packages/core`; they do not call R2 or implement CAS/recovery policy.

### Cloudflare R2

R2 stores current objects under `vault/<normalized-path>` and recovery objects under
`recovery/<operation-uuid>` through `VAULT_BUCKET`, without client S3 credentials.
The committed configuration names the production `obsidian-ai-bridge` bucket;
the [operator guide](operations.md#worker-deployment) records the first manual
Worker deployment and custom-hostname check. Configuration alone does not prove
the currently deployed version, credentials, or any vault installation. Local
setup instructions remain in the [README](../README.md#local-worker-development).
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
active designated writer waits until workspace layout readiness before attaching
official saved Vault events. A bounded startup callback buffer and durable gap
classification precede ordinary scheduling/resume; while the buffer is being filled,
only positive paths admitted by the current bootstrap scan may use the scheduler. It
mirrors eligible Markdown through the core scheduler and
bounded Fetch adapter. The M2 in-flight exclusion remains independent. Session
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
reading bodies, and resolves/reads the active captured saved path once. Shared policy rejects unsupported, excluded, invalid and oversized files in order;
1 MiB bounds both metadata and measured UTF-8 text. Dot-prefixed segments, the
configuration subtree, and the exact current/historical preservation namespaces are
private regardless of M1 remote path acceptance; ordinary prefix-sharing names remain
eligible.

Pre/post object identity, path, size and mtime checks reject observed changes.
They are best-effort evidence, not an atomic snapshot or future write revision.
The inspection service discards transient content before returning metadata. M3
settings use modern declarative definitions and native SecretStorage references;
only dispatch-time adapter code reads the bearer. The composed plugin uses no editor
events or raw filesystem APIs. M4's narrow reviewed-write host wrapper uses only
official Vault lookup/create/createFolder/read/process operations and is reachable
solely through admitted reviewed operations; no generic local mutation capability,
local delete/move/rename, or automatic remote-to-local loop exists.

Bun stages browser-target CommonJS `main.js` plus the unchanged manifest. The
bundle exposes `module.exports.default` with only `obsidian` external; no Node
runtime shim is needed. A separate Vitest artifact suite evaluates this generated
bundle against an isolated host double in canonical `build`/`check`. Source
unit/integration tests remain covered independently. See
[development instructions and official API/version evidence](plugin-development.md)
for install/removal and the explicit absence of real desktop/mobile host tests.

### MCP adapter

The M6 adapter serves stateless Streamable HTTP at `POST /mcp` using the official
web-standard SDK. Its M6 baseline reuses the M5 registry bearer and typed principal as an
application-level authentication overlay. Post-M6 OAuth adds resource metadata,
consent, grant issuance, and resource-bound bearer validation; it does not
convert M5 registry tokens into OAuth tokens. Client interoperability must be
qualified separately rather than inferred from these routes. A separate
exhaustive permission table covers static discovery, each read tool/resource, each
conditional write and recovery maintenance operation. Permission checks precede
application-service resolution. The SDK adapter uses only `CurrentGenerationService`
and `RecoveryService`; it has no direct storage access, no session state, and no local
vault authority. Note/recovery plaintext is returned only through explicit bounded
resource reads as untrusted Markdown; tool failures include a stable typed error code
and static message, while resource errors and structured logs remain content-free.
Destructive annotations and static instructions ask clients to obtain user
confirmation; this is client-owned, not server proof of human approval. See the
[MCP/API contract](api.md#mcp-interface), [M6 specification](milestones/m6-mcp-adapter.md),
[qualification report](qualification/m6-final.md), and [ADR 0014](decisions/0014-stateless-mcp-adapter-and-existing-credentials.md).

## Security and data-safety boundaries

The Worker authenticates `/api` descendants and `/mcp` through the M5 registry of
at most 16 named opaque bearers or a resource-bound OAuth token that passes strict
grant-prop, scope, and R2 revocation checks. Access-protected `/authorize` and
`/auth/grants` provide owner consent and grant management; OAuth provider routes
issue tokens and register clients. The current plugin OAuth connection requests
only `read`, so issuance does not enable a sync writer.
The Worker has no `/health` route; OpenAPI and
Scalar are enabled only for local development and do not grant note access.
MCP capability discovery also requires an authenticated principal.
Configuration retains only domain-separated SHA-256 verifier material. Successful
authentication publishes client ID, name, and exact permission metadata, never a token
or digest. The exhaustive operation policy requires `read`, `write`, or independent
`delete` before service/storage dispatch; unknown API operations fail closed. Static
v2 association/writer IDs guard cooperating clients separately and remain application
preconditions rather than authentication or permission. The v1 HTTP API and singleton
bearer authority are retired.
R2 holds readable note text: the Worker/cloud operator is trusted, and no
application-level end-to-end encryption is implemented. Never infer production
readiness, installed resources or credentials from repository configuration.

Preserve canonical base64url addressing, validated relative lowercase `.md`
paths, the 1 MiB UTF-8 bound, sanitized errors and content-free structured
LogTape request logs. Authenticated events include only canonical client ID, never
client name, token, digest, or permission metadata. Closed operation categories derive
from registered route semantics; unknown routes remain bounded. Logs are platform-
managed live diagnostics with zero-day application retention, not a durable security
audit trail. Do not log concrete note/recovery identifiers, bodies, revisions, hashes,
receipts, headers, storage envelopes, or raw failures. JSON API
and Markdown content responses are uncached via `no-store`. MCP logs use only the
static `/mcp` route and closed request category; they omit tool names/arguments,
resource identifiers, RPC IDs, and content.

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
methods, accepted statuses, failures and dispatched effect certainty. At the Slice 4
boundary it was uncomposed; later M3 runtime slices added settings, autosync, and Vault
event wiring without adding a deployment claim.
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
staged-handoff verification. Listener registration now waits until layout readiness. A bounded startup callback
buffer captures events while persisted active operations receive durable v5 gap fences;
queued callbacks are drained durably before normal scheduling and reconciliation UI
become available. Positive bootstrap work may proceed before that event barrier, but
persisted M4 operations do not resume and every effect checks the current listener/
configuration lease immediately before host or Fetch dispatch. A fresh complete-group
review settles only aligned no-effect state or atomically transfers reservations to
reviewed successors. Scan absence never grants deletion authority. This is the ADR 0013
correction; bounded disposable-host evidence does not constitute full M5 qualification. Bootstrap positive admission notifies the current session before reporting
inventory settles, allowing the free scheduler slot to run only current-scan positive
paths without polling; persisted destructive or uncertain work remains held until the
startup event barrier completes.
Staged handoff events advance durable positive generations and invalidate sampled
metadata; alignment plus activation is one serialized transition, and events arriving
while it commits are sequenced after that transition rather than discarded. Native
secret-reference settings expose non-secret local/server designation and require the
accepted whole-mirror/plaintext/deletion disclosure before activation. Request
cancellation retains permits through settlement; one-shot timers stop after explicit
runtime fencing, and Web Crypto capability/provider failure closes durable mutation
admission while preserving dirty work for explicit recovery. Replacement sessions
never replace owner state; incompatible registry versions fail closed. M4 Slices 4–5
provide core action execution: exact local/remote/recovery reads feed archive-first
live resolution, exact revision adoption, safe legacy fork, explicit tombstone choices,
and local-first restore. The shared executor owns conditional remote dispatch,
receipt-based unknown-effect recovery, finite persistence fencing, and atomic baseline
completion. Restore keeps its path reserved in `restored-pending-review` until
serialized admission links and transfers ownership to a fresh reviewed successor.
Slices 6–7 compose these services behind reviewed commands, text-only modals, one
shared scheduler, and session-scoped authority. Before that authority is published, a
startup-only read/hash service resolves pending v3 local effects from durable expected
postconditions without a writer capability: exact bytes resume as `recovered-v3`,
changed/absent bytes remain permanently blocked, ambiguous evidence remains retryable,
and save failure aborts startup. Startup's positive bootstrap phase precedes draining
the bounded event queue; concurrent readiness paths join one captured-session drain, and
overflow or failed drain closes the lease and keeps ordinary scheduling/UI unavailable.
A rejected active event sink likewise stops delivery, synchronously revokes the lease,
and attempts durable gap fencing before a later epoch can resume. Slice 0 remains the pinned local workerd qualification task
and declaration-only host check; it does not establish broad real-host behavior.

## M4 core boundary

Core now owns closed authority, classification, action, lifecycle, evidence,
reservation, effect, and preservation-receipt contracts plus linear cross-field
validation. One immutable `ReconciliationReviewSnapshot` binds runtime/configuration/
listener identity, complete content-free per-path local/ACK/remote/M3 evidence, exact
remote receipts, and selected recovery metadata; the admitted operation copies that
same typed snapshot and strict validation requires exact equality. The preservation
policy derives the required side, revision, and content hash from this evidence rather
than trusting receipt claims. `MirrorDeviceState` version 5 retains every M3 field
and bounded sparse M4 review, operation, ordered-history, step-receipt, and local-effect
successor evidence, then adds operation-level observation coverage and predecessor-
linked complete gap-group reviews/successor links. The ledger cannot represent
note/recovery bodies or arbitrary payload records.

Active M4 reservations cannot overlap, unresolved M3 effects take precedence,
deferred rename state permits only an explicit history operation, and active
operations prevent both handoff drain/export and ordinary M3 scheduling for their
paths. A confirmed recovery restore enters the explicit active
`restored-pending-review` phase. It can become terminal only when a linked reviewed
successor operation atomically takes over the restored path; after that successor
completes, ordinary M3 ownership may resume.

The plugin adapter keeps explicit frozen version-2, version-3, and version-4 decoders
separate from the strict version-5 writer. Startup detects the stored version before
owner construction. Valid historical values project sequentially through the frozen
v2→v3→v4 contracts, then strict v4→v5 classification marks every nonterminal v4
operation `gap-review-required` while terminal records remain historical evidence.
The complete v5 projection is validated, written once to the same key, loaded once,
byte-compared to the canonical write, and strictly decoded before runtime publication.
Any decode, migration, encoding, save, quota, read-back, integrity, or version failure
remains unavailable/corrupt/unsupported and never publishes in-memory migrated state.
A committed v5 write is safely recognized on the next startup even when the prior
read-back failed. Runtime registry and owner structural versions are both 5, so older
owners refuse same-realm reuse.

Slice 2 adds a core-only `ReconciliationReviewService` behind read-only local and
remote ports. It forms a bounded union of tracked/local/visible-remote/recovery paths,
samples exact content-free local and remote identity while retaining target bodies only
in process memory, applies the classifier/action policy, and invalidates reviews on
refresh or observation changes. Admission revalidates runtime, baseline, M3, local,
remote, recovery, and reservation identity inside the serialized state-owner
transition, then persists only the content-free durable review/operation pair. The
service has no local writer or remote mutation dependency; Slices 6–7 compose it into
the plugin runtime/UI while effects remain in separate services.

Slice 3 keeps that review boundary intact and introduces a separate
`LocalReconciliationWriter` with only eligible create, exact compare-and-replace, and
generated create-only preservation. New artifacts use the official-index-visible
`ai-bridge-conflicts` root. One exact-boundary policy also excludes the frozen
historical `.ai-bridge-conflicts` namespace from scanning, events, review discovery and
remote propagation. Core services bind each dispatch to the active
operation/action/path/phase/reservation/evidence; durable prepared effects and pending
receipts precede host calls, while confirmed effects and verified receipts require an
exact reread/hash. Ambiguity stays `unknown`, persistence failure fences later effects,
and restart adoption is limited to exact same-operation bytes. The Obsidian adapter
receives only a minimal host interface and exposes no generic Vault, delete, rename,
move, trash, filesystem, network, or transport capability.

Slices 4–5 compose those core seams without changing adapter capabilities. Focused
action services select archive-first ordering while one mechanical executor owns exact
local/remote/recovery barriers, conditional remote effects, receipt-based ambiguity
recovery, and atomic baseline completion. Live resolution and revisioned adoption
preserve competitors before replacement; legacy data only forks to a different absent
path. Tombstone actions never remove local content. Restore persists its local-first
fence before writing and transfers ownership only to a fresh reviewed successor; an
alternate restored path requires an explicit absence-only publication decision even
across listener epochs. Slices 6–7 compose these services without moving policy into
the plugin presentation layer.

## Implemented M4 Slices 6–7 ownership

ADR 0009 fixes the implemented compatibility-transition boundaries:

```text
RenameHistoryGroupPolicy
  durable rename graph → complete bounded group + validated projected choices
        ↓
HistoryDecisionPolicy / ReconciliationReviewService
  exact choice + immutable group snapshot → one parent operation/full reservations
        ↓
RenameHistoryResolutionService
  ordered current step → preserve / exact remote cleanup / attention
        ↓
ReconciliationPreservationPolicy + ReconciliationEffectExecutor
  step-scoped create-only archive + existing v2 recovery-first tombstone
        ↓
MirrorStateOwner
  persist exact step settlement before advancing/clearing blockers

MirrorRuntimeOwner
  one FairMirrorScheduler (M3 + M4, two jobs)
        ↓
ReviewedReconciliationRuntime
  synthetic local-effect proof + all Vault events as successor evidence
        ↓
review/startup/recovery query owners → thin commands/modal/status
```

State v5 is required before history execution. The frozen v3 decoder migrates the
same key deterministically, preserving non-empty M3/M4 state and turning unrefined v3
history or unfenced started local effects into explicit attention blockers rather than
inferred decisions; frozen v4 then migrates to v5 with every nonterminal operation
gap-fenced. Each globally unique history step UUID is also its exact Worker v2
mutation/recovery operation ID; the parent ID is never reused across tombstones. New
history archives add that step UUID between operation and side; existing non-history
archive paths remain valid. History never uses the local writer. The shared scheduler
orders work only; durable operation
reservations and serialized state transitions remain authority.

Because official Vault events have no causal operation token, runtime code must not
claim that a path/timing match identifies an own event. Exact adapter postcondition
confirms a persisted synthetic effect identity, while every real host event advances
external observation state. Events observed while reserved are persisted as one
bounded successor range; a queue barrier drains earlier callbacks and a fresh reviewed
successor either settles exact alignment without an effect or transfers ownership to a
linked ordinary operation before release. The v5 `observationCoverage` fence is
orthogonal to phase/effect evidence: cold start and listener gaps fence active
operations, and exact receipt recovery does not clear the gap. A fresh complete group
review may settle only aligned no-effect state or atomically transfer changed paths to
reviewed successors; stale/incomplete/unknown evidence retains the entire reservation
group. This may conservatively create another review but cannot hide a same-text
external successor or deadlock an aligned path.

## Deferred and future scope

- M5 is complete with a narrow latest-only v1.0.2 software-support envelope; its exact
  platform, scale, release identity, and residual limits are in the [qualification
  report](qualification/m5-final.md). No application quota/limiter, recovery
  automation, durable log store, mobile writer, or multi-release support was selected.
  M4 remains reviewed-only: no automatic import, cross-system atomicity, production
  deployment, security certification, or complete-backup claim.
- M6 is complete: the authorized MCP adapter uses existing Worker services and never
  accesses R2 directly. M7 delivers an uncomposed,
  versioned sync contract and isolated R2 store without changing current v2 routes or
  the designated writer. Sync activation, migration, client enrollment, and cutover
  remain outside delivered M7 and require G1–G6 acceptance plus explicit later
  bounded specifications/roadmap authorization. Owner-accepted
  [ADR 0021](decisions/0021-isolated-local-markdown-sync-demo.md) adds only an isolated
  synthetic local-demo exception: [M8](milestones/m8-local-markdown-sync-demo.md)
  becomes NEXT on specification merge, with separate Worker/plugin entrypoints
  outside release/deployment composition. No M8 code exists in this transition;
  current runtime behavior and G1–G6 production/real-data blockers are unchanged.
- Outside this roadmap: search, attachments and AI inference. NAS replication or
  stronger remote authority are possibilities, not selected infrastructure. D1,
  Durable Objects, queues, Workers AI, Vectorize and external databases are not
  selected dependencies.

Future product choices remain visible in the [roadmap decision register](roadmap.md#unresolved-product-decisions).
Use [ADRs](decisions/README.md) when resolving consequential choices; do not add
services or silently reopen accepted boundaries as incidental implementation work.
