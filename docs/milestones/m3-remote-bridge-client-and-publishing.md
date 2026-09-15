# M3 — Automatic eligible-Markdown remote mirror

**Status: NEXT — Slices 0–4 implemented; Slice 5 is next. No connected
user-visible M3 mirror.**

The maintainer's clarification replaces the selected-note/manual-publishing proposal
at `e35bd90`. M2 is COMPLETE at merged `b300726` (PR #7); M3 is the single NEXT
milestone. Historical filenames remain as stable links, not product terminology.
[Roadmap](../roadmap.md) owns scope/order; [AGENTS.md](../../AGENTS.md) owns engineering
rules; [decisions/evidence](../plans/m3-design-decisions.md) and the
[sequential plan](../plans/m3-remote-bridge-client-and-publishing.md) are companions.
Implementation readiness means product/design choices are resolved and testable.
The narrow [Slice 0 qualification](../qualification/m3-slice-0-platform-primitives.md)
proves the pinned local workerd storage predicates and records declaration-only host
availability. Slice 1 raises the plugin minimum to 1.13.0 and provides typed core/
protocol contracts. Worker Slice 2A–2C adds private conditional-storage adapters, tested application
current/recovery transitions, and authenticated v2 HTTP/OpenAPI/CORS with v1 mutation
retirement. Slice 3 adds uncomposed strict plugin configuration/host-local state
adapters, a serialized core state owner, explicit writer activation and staged
content-free handoff validation. Slice 4 adds an uncomposed typed bounded Fetch v2
`RemoteBridge` adapter. Autosync/settings UI/Vault event wiring and real-host checks
have not passed.

## Objective and authority

After whole-mirror opt-in on one designated supported device, automatically mirror
**all eligible saved Markdown notes** to a private Worker/R2 namespace. Bootstrap
and subsequent local create/modify/delete/rename events drive bounded one-way
synchronization. iCloud remains device-to-device working-vault synchronization.
R2 is a remote mirror/API persistence layer, not the sole authoritative store or a
complete backup. Local saved Obsidian state is the normal M3 mutation source;
independent remote changes cause divergence, never silent overwrite or local import.

Mirror scope is **not** REST/MCP authorization. Retain valid literal NotePath,
lowercase .md, dot/config exclusions and 1 MiB UTF-8 limit. There is no selected
state, per-note upload permission, folder/tag/frontmatter rule or additional
exclusion feature. The user authorizes the mirror as a whole. M2's independent
local inspections neither enable mirroring nor grant remote-client permissions.
Future MCP reuses authorized Worker/application operations, never direct R2 access.
Future NAS replication/stronger remote authority are possibilities, not M3 features.

## Accepted decisions and architecture

D1-D full eligible scope, D2 SecretStorage/modern baseline, D3 HTTPS/exact loopback,
D4 revision-envelope CAS and D6 Fetch are approved. The maintainer additionally
approved runtime deletion authority (including possible iCloud/external activity),
30-day recovery and one designated writer. No material product choice remains.
Accepted ADRs describe the complete design; Worker Slice 2A–2C is implemented,
while plugin/state/autosync work remains:

- [0002](../decisions/0002-conditional-remote-note-mutation.md): conditional current
  generations, receipts, v2 and retirement of unsafe v1 PUT/DELETE.
- [0003](../decisions/0003-publishing-association-and-local-state.md): per-path state,
  runtime ownership, device designation, pause/reset/handoff.
- [0004](../decisions/0004-recoverable-mirror-deletions.md): event authority,
  recovery preparation/tombstone/sealing/purge and local rename workflow.

```text
Obsidian lifecycle events / settings / metadata-only health UI
    ↓
Core MirrorSynchronizer / reconciliation planner / state owner
    ↓
ReadOnlyLocalVault + local event port + RemoteBridge + MirrorStateStore
    ↓
Obsidian saved-file/events adapter + Fetch adapter + host-local state adapter
    ↓
Worker handlers → core conditional note/recovery services → R2 adapters
```

Core owns typed path/revision/hash/intent/desired-state/outcome contracts, scheduling
policy, reconciliation and persistence orchestration. It imports no Obsidian,
Fetch/HTTP/Hono, R2 or storage JSON implementation. It uses opaque connection
identity, not parsed URLs or tokens. Separate existing local read-only port from
mutation-capable remote storage and the remote-client port. Local events carry
validated primitive evidence, not TFile/App references.

Plugin adapters own official host subscriptions/saved reads/local storage and
transport. UI is thin; no command/event callback calls fetch, handles Worker DTOs
or accesses repository implementations. Protocol owns shared wire schemas/constants
and validates NotePath through public core exports, with no core→protocol cycle.
Worker handlers parse/format HTTP; application services implement conditional state
transitions; R2 adapter owns envelopes, metadata, predicates and recovery snapshots.
No database, DO, queue service, election, Node/Electron runtime or new UI framework.

## Minimum version, configuration and user experience

**M3 minimum Obsidian 1.13.0**, non-desktop-only. Use native SecretStorage (since
1.11.4), modern declarative settings (1.13.0) and official vault-local storage APIs
(since 1.8.7). No deprecated display() fallback or historical-version accommodation.
Implementation slice 1 changes the manifest, artifact expectations and install docs
together. Slice 1 sets the current manifest to 1.13.0; this is a declared host
baseline, not evidence that the future M3 runtime behavior works in a real host.

Settings expose endpoint, secret reference via native SecretComponent, device ID,
server association/designation status, device-local **Enable mirror** and **Pause**.
First activation explains full eligible scope, iCloud/external delete authority,
30-day recovery and plaintext trust at host/Worker. No per-note or per-delete
confirmation. A non-writer defaults disabled and cannot activate on server mismatch.
Enabling a new unconfigured plugin only loads settings/registers UI. A previously
activated designated writer resumes automatically after validation/layout readiness.

Native secret contents are not plugin settings: persist only their reference;
retrieve through SecretStorage immediately before dispatch. Never prefill/reveal,
copy, log or echo values/errors containing a token. The native store is vault-local
host storage shared by plugin references, not a documented OS keychain or isolation
from the trusted host/other privileged plugins. Disconnect/removing our reference
pauses this plugin, not a server revocation or deletion of a shared secret. Worker
secret rotation is an explicit operator action; shared-secret deletion happens in
host management, not an invented deleteSecret API. No automatic retries triggered
just by rotating/re-entering a token. Official APIs provide no documented secret
change event to assume: validate each dispatch; UI refresh/resume also rechecks.

Primary UX is automatic synchronization. Operational commands:

| Command | Behavior |
| --- | --- |
| Show mirror status | Metadata-only phase, last completed work, pending/blocked counts and per-path sanitized outcomes; no note bodies |
| Check mirror now | Bounded positive rescan/current-state inspection; never remote-minus-local deletion |
| Retry mirror failures | Explicitly resume a finite budget for retryable original intents; no force overwrite or baseline refresh |
| Pause / resume mirror | Stop admission and request cancellation; show actual draining/unknown state; resume reconciles automatically |
| Prepare writer handoff | Drain, refuse unresolved work, export validated content-free ledger for explicit transfer |

Keep M2's two inspection commands and metadata-only behavior. Recovery is discoverable
through an authenticated recovery API and documented operator retrieval, not plugin
local-note writes. UI paths render as text; excluded destinations and raw errors are
not diagnostic output. Health distinguishes disabled/non-writer, initializing,
bootstrapping, catching-up, observing, retry-wait, draining, blocked/diverged and
state-unavailable. “Observing” means no pending local work, not continuous proof that
an external remote client has made no edit. Events continue to be observed while
individual paths are blocked; unrelated paths can progress.

## Endpoint, authentication and transport

Accept an absolute origin only (optional trailing slash); reject userinfo, query,
fragment, non-root path and non-HTTP(S) schemes. Use URL parsing after explicit input
checks, never path repair. HTTPS is default. HTTP requires a separate opt-in tied to
exact literal localhost, 127.0.0.1 or [::1] and origin/port. Reject alternate numeric
IPv4 spellings before URL canonicalization; no DNS-derived loopback/LAN/suffix rule.
Use disposable development tokens; phone loopback means that phone. TLS does not
make an incorrectly chosen server trustworthy.

Use Fetch with redirect:error, credentials:omit, AbortController, 30-second deadline
including streamed response consumption and bounded actual bytes regardless of
Content-Length. No requestUrl/Node/Electron fallback. A missing required browser API
pauses sync with a typed unsupported-runtime outcome; tests/real-host qualification
must check WebView behavior, not infer it from the manifest. Abort cancels client
transport, not a committed/in-flight R2 operation.

Worker authenticates `/api/v2` and descendants (including unknown routes). V2 CORS
applies only to registered routes/methods: GET, PUT, DELETE and POST where declared;
OPTIONS validates requested method/headers without storage. Allow Origin `*` with
no credential cookies, allow Authorization/Content-Type/If-Match/If-None-Match and
Bridge-Operation-Id/Bridge-Association-Id/Bridge-Writer-Id headers; expose ETag and
Bridge-Note-Format. Put CORS on v2 errors too. Bearer auth remains the authorization
boundary; CORS and writer identity are not scoped access control. V1 remains protected.
MCP permissions are separate future work; do not call full mirroring public exposure.

## Bootstrap and event-driven synchronization

1. Load/validate preferences and host-local ledger; no unchecked merge/defaulting
   on corruption. Verify local activation, required runtime capabilities, token,
   Worker association/writer identity and protocol before mutation.
2. Wait for onLayoutReady. Check enable-lifetime identity in this deferred callback.
   Attach create/modify/delete/rename listeners using registerEvent **before** taking
   the initial metadata enumeration; retain immutable pre-event path/index data.
3. Mark bootstrapping. Enumerate eligible metadata using the existing policy, merge
   coalesced positive events received during enumeration, then mark metadata
   bootstrap complete. A failed/incomplete enumeration never enables deletion
   authority. This marker does not claim iCloud download completion.
4. Queue bounded saved reads/state checks for eligible paths. Create unassociated
   paths with absence-only mutation. For acknowledged paths, compare saved SHA-256
   and inspect current remote state on bootstrap; unchanged content/revision means
   no write. Different remote generation or missing associated state is divergence.
   Inspect paginated remote paths to report unassociated entries, not adopt/delete.
5. Delete/rename observations before the bootstrap boundary remain non-destructive;
   observed absence is missing-unconfirmed. No algorithm subtracts local scan paths
   from remote paths to decide removal. A later create/modify notification from
   iCloud can supply positive work normally.

Use Vault create/modify, not editor-change. No network per keystroke, editor save,
filesystem polling, cached editor buffer or exact autosave-interval assumption.
Coalesce a path's latest desired state after 750 ms quiet time, with 5 s maximum
coalescing wait. Read saved content with M2's pre/post identity/path/mtime/size and
measured UTF-8 checks, plus the local event-generation counter around the await.
If changed, discard and leave dirty. Same-size/indistinguishable-mtime changes can
still escape host evidence: no atomic/latest-editor snapshot claim.

A hash equal to acknowledged sent content avoids a needless write unless there is
an unresolved operation or known remote divergence. A modify during PUT marks a
new desired generation; never overwrite the old intent/body. Record its actual ACK,
then read latest saved state for the next update using that ACK. Stable queued
paths are served fairly; a hot path cannot starve unrelated ready work.

## Bounded work, retry and lifecycle

- At most **two active path jobs globally**, one per path, and one client request
  at a time per job. Each job holds at most one local note snapshot. Bootstrap/list/
  evidence/maintenance requests share the same two-request limit; no hidden fanout.
- Rename reserves both paths atomically in lexical order before awaiting, counts
  as one job and does not deadlock with a job already owning either path. Folder
  events expand metadata, not concurrent body reads/network calls.
- A job keeps its slot/reservations through actual host/network/state settlement,
  even after a UI timeout. Registry/coordinator ownership survives Plugin replacement
  in the same runtime; presentation identity does not. No release in unload just
  because an AbortSignal was sent. Late callbacks cannot register watchers, dispatch
  new work, resurrect activation or show stale UI.
- Deadline/control timers are bounded coalescing/retry timers, not perpetual polling.
  On unload stop timers/admission, detach listeners, abort Fetch, keep in-flight
  accounting and settle exact ledger intents. On restart read the ledger first.
- Per intent: **three mutation attempts total** (initial + retries after 2 s and
  10 s), and **three state-evidence requests total**. Persist consumed counters
  before calls; re-enable/new modify events do not reset them. Evidence matching
  our exact receipt resolves; other generations diverge. A still-original state is
  not proof no old request is pending, but an exact original-condition retry is
  safe under permanent heads. All counts are named/tested policy constants.
- Standalone bootstrap/health/list reads have no automatic retry loop: a failed
  required handshake pauses, and an incomplete inventory is reported. Explicit
  Check/resume starts a fresh bounded read pass, never resets mutation budgets.
- Transient network/timeout/5xx/429 may use that budget after actual settlement;
  Retry-After is never an unbounded scheduler. Authentication/designation/config/
  local-state errors pause globally. Invalid contracts and genuine precondition
  divergence block the affected path, not retry with a newer remote revision.
  Exhaustion is visible blocked state; explicit Retry grants a new finite budget
  only for the same safely reconstructible intent, never permission to overwrite.
- After process restart, first inspect unresolved receipts. Retry content only if
  a fresh saved read hashes to the original request hash. If not, keep latest state
  dirty and the old intent unresolved; do not store/reconstruct an old plaintext
  body merely to keep a queue moving. Deletes have no local body to reconstruct.
- A local operation that fails before dispatch is not sent. Any failure after
  dispatch without valid ACK/evidence is unknown, not assumed failure or success.
  A 412 following an earlier ambiguous attempt is not proof the earlier one failed.
- Work before unload can have committed remotely. The owner records a known outcome
  without stale UI; a failed ACK save pauses new mutations globally and retains the
  original intent. Re-enable waits for that persistence owner, not a fresh empty flag.

## State and persistence

Initial schema version 1; M2 has no persisted state to migrate. The prior PR's
selected-note settings were never implemented. Known DTO versions are validated
at the adapter boundary; malformed/future versions fail closed and are not silently
rewritten. Unknown fields, invalid paths/revisions/IDs/digests, duplicate paths and
invalid counters/times are rejected. All path states share one typed source.

| Persisted value/location | Purpose/authority | Lifecycle/reset/migration | Sensitivity/content |
| --- | --- | --- | --- |
| data.json: schema, origin, exact canonical `loopbackHttpOrigin` permission, SecretStorage reference | User preferences, not writer election or per-path mutation authority | Explicit edits; the permission must equal the current HTTP loopback origin including port; external origin changes fail closed and require fresh consent; no default merge on corruption | Private config/reference; no token or note body |
| Native SecretStorage value | Host-managed bearer; privileged in current single-token model | Host rotation/deletion; disconnect only removes plugin reference; never invented secure erase | Secret; no plugin plaintext persistence |
| Host vault-local storage: schema/device UUID/activation/association+origin binding | Device-local whole-mirror opt-in and static designation match | Disabled default; explicit activate/pause/handoff; loss cannot auto-reassociate | IDs/config, not a secret or cryptographic device identity |
| Host-local per-path ACK | Last confirmed live revision+sent hash or tombstone revision+recovery ID | Only valid ACK/exact own receipt; retained across restart, local deletion and recreation; no arbitrary GET promotion | Sensitive paths/hashes, no note body |
| Host-local unresolved intent per path | Original action/ID/precondition/hash, phase and retry/evidence budgets | Durable before dispatch; settle own intent only; never silently drop on unload/reset | Sensitive metadata, no request body |
| Host-local desired/destructive/rename state | Latest dirty observation plus persisted post-bootstrap delete evidence and rename prerequisites/deferred cleanup | Positive scans reconstruct work; destructive absence never does; collapse edit events | Sensitive paths/event metadata, no body history |
| Worker association/writer configuration | One explicitly designated cooperating writer for one namespace | Operator setup/handoff; missing config refuses mutations; never auto-elected | Non-secret IDs; separate bearer secret |
| R2 current live/tombstone envelope+format marker | Authoritative current remote generation/receipt | Conditional mutations only; current keys never expire through application/lifecycle | Live note text or tombstone metadata; trusted operator plaintext |
| R2 prepared/sealed recovery snapshot | Copy-before-tombstone, explicit 30-day window | Seal only from proven deletion timestamp; unsealed over-retains; survives current recreation | Remote recovery text and sensitive path metadata |
| R2 purged recovery marker | Prevent expired content recreation by delayed duplicate preparations | CAS purge only after expiry; retain small marker, no physical delete in M3 | No body; identity/expiry metadata |
| Explicit handoff export | Validated content-free ACK transfer within same association | Only after clean drain; excludes activation/device ID/secrets; import is explicit and verified | Sensitive path/hash ledger, not note text |

Ephemeral only: saved snapshots, event counters/index, runtime coordinator registry,
UI, signals/timers and current transport token reference. No note body in logs,
UI, local storage, handoff record or data.json. Host local storage is outside the
vault-file/iCloud mechanism, not guaranteed durable/transactional across processes.
Quota/save/load failure pauses mutations. Do not silently move the ledger into a
synced vault file or add a database to evade the failure.

The single state owner serializes read-current/apply/persist transitions across
all jobs/settings actions; queued stale whole-state writes are forbidden. A token
reference removal pauses admission immediately; pending remote effects remain
observable. A data.json update never overwrites the host-local ACK ledger.

## Association, deletion, recreation and rename

No acknowledged state: create only if remote path absent. Existing live/legacy/
tombstone state is divergence, even if content equals local. Established live state:
use last ACK revision; missing/changed remote state is not an invitation to create
or adopt. Whole-mirror scope does not eliminate initial collision protection.

**Deletion authority is event-based**, not human-origin proof: approved post-bootstrap
runtime delete of an already-acknowledged eligible path, including iCloud/external
activity. Apply grace and exact-path absence checks, persist evidence, then use the
recovery/CAS flow in ADR 0004. If a previous own update is pending, wait; only its
verified ACK may advance the queued delete condition. Startup absence, unassociated
paths and pending-first-create deletion never gain retroactive delete authority.

Recovery snapshot must be durable **before** the current head becomes a tombstone.
Seal 30 days from that stored tombstone's uploaded timestamp, not an earlier prepare
clock. A sealing failure retains readable unsealed content; it does not undo an
already confirmed tombstone. Normal note routes omit tombstones; recovery routes
remain separate. Purge after expiry CAS-replaces recovery content with a marker,
never current-head hard DELETE. No native trash/version history or exact physical
cleanup promise. No blanket lifecycle policy on current/recovery keys.

A local recreation before an unsent delete cancels that removal. After dispatch,
settle the original intent first. A confirmed tombstone plus eligible local creation
uses If-Match of the acknowledged tombstone; stale deletes cannot affect the fresh
live generation. Remote delete/recreate changes revisions even with identical text.
Unresolved tombstones never become absence-based creates.

A runtime rename is create-destination → record ACK → recheck prerequisites →
recoverably tombstone-source. Unknown destination commit/collision/newer event/
remote conflict/failed ACK persistence prevents cleanup, with visible duplicate/
deferred state. Rename out of eligibility removes only the previously associated
eligible source, without reading/uploading the excluded destination. Compound or
folder renames use the bounded, conservative ADR 0004 rules; no atomic two-key or
full chain reconciliation claim. Missing/oversized/temporarily ineligible reads on
modify do not silently delete previous remote content: report retained-stale/
out-of-scope state until an eligible read or authorized lifecycle removal occurs.

## Writer designation and handoff

[ADR 0003](../decisions/0003-publishing-association-and-local-state.md) is normative.
Device ID/activation/ledger live in host-local storage, not iCloud-synced data.json.
Worker static association/writer identity mismatch disables non-writer autosync;
the bearer remains privileged and IDs are not authorization secrets. One writer
host/process per vault is the supported operating constraint, on any supported OS.

Handoff: pausing the old device durably enters `handoff-draining`; resolve every
intent, blocker and rename dependency, then persist a separate quiescence-checked
`handoff-drained` transition before content-free ACK export. Pause, abort, timeout or
an old-state read never marks drained. The operator then disables the old writer, changes designation
and rotates bearer; new device imports/verifies same-association baselines and
bootstraps. Imported ACKs are staged, not active write baselines: before activation,
apply one complete indexed evidence batch proving each live path's saved local SHA-256
equals the transferred sent hash, each tombstoned path is locally absent, and every
remote revision still matches. The serialized owner persists the resulting ledger once,
not once per path. Missing/different local data pauses handoff with a typed mismatch; it might be stale
or partially hydrated iCloud state, not a new edit/recreation. Never refresh the
baseline to bypass this gate. Observe events during verification and invalidate
changed observations in collapsed batches. After activation, normal saved events govern later changes.
Abort, a timeout or “remote still looks old” is not quiescence. A completed
conditional generation with matching receipt can make a delayed duplicate harmless.
If clean handoff is impossible, block takeover. Safe reset provisions a separately
authorized empty bucket/association without redirecting old requests into it;
preserve old state for operator/M4 recovery. No leases/election/automatic takeover.
A pause interval can miss local delete events; the new scan reports absence without
inventing intent. Tell operators that such removals require later reconciliation.

## Typed application ports and remote protocol

Semantic port contracts (names may follow repository conventions):

- Local read-only list/read plus event subscription adapter emitting primitive
  created/modified/deleted/renamed observations with bootstrap/session evidence.
- RemoteBridge: describe association, paged list, content read, current-state read,
  conditional put, conditional tombstone; returns domain revisions/receipts and
  typed effect certainty. Recovery inspection/seal/purge uses a separate recovery port,
  not added local mutation methods.
- MirrorStateStore: load/store validated snapshots or typed failure; synchronous
  host-local storage is wrapped at the adapter, not leaked into core. One application
  state owner holds the canonical current state through complete transitions.
- Operation control/clock/fingerprint seams support deterministic deadlines,
  cancellation intent, actual settlement and SHA-256 of exact UTF-8 bytes. Framework
  signal/request/response/host objects remain in adapters. Never unchecked-cast JSON.

| Outcome | Meaning |
| --- | --- |
| success / confirmed-stored / confirmed-tombstone | Valid ACK or exact own receipt; persistence success is reported separately |
| unauthenticated / forbidden-writer | 401 / 403; pause globally, no token/error echo |
| network-unavailable / timed-out / cancelled | Local classification; after dispatch remote effect may be unknown |
| missing / tombstoned / legacy | Distinct state observations; ordinary content read hides tombstones; none grants overwrite authority |
| precondition-conflict / divergence | 412 or differing established state; preserve remote generation, no refresh-and-overwrite |
| incompatible-protocol / unsupported-runtime | Old v2 absence/wrong capabilities/missing browser primitives; no fallback |
| malformed-response / contract-violation | Bad schema/UTF-8/media/path/revision/receipt/status or request/response bound; never partial success |
| server-failed / rate-limited | 5xx / 429; finite budget, effect may be unknown |
| local-unavailable / unstable / excluded / oversized | Existing local policy/read evidence; no alternative file or destructive fallback |
| state-unavailable / invalid-state | Pause mutations, retain evidence; no silent settings reset |
| recovery-pending / expired / purged | Explicit retention lifecycle, not active-note status |
| incomplete-inventory / handoff-local-mismatch | Bounded scan exhausted/failed, or new writer has not observed the transferred live/tombstone state; never adoption authority |

Keep expected outcomes closed/exhaustive and semantic constants authoritative.
Effects are not-dispatched, definitely-refused, confirmed or unknown; a later
refusal does not negate an earlier ambiguous attempt. Validate known error schemas
when available, but classify 401/403/5xx even when an intermediary body is malformed;
never display remote error messages or stack traces.

### V2 contract surface

All requests are bearer-authenticated except registered CORS preflight. Mutation
requests also carry Bridge-Association-Id, Bridge-Writer-Id and Bridge-Operation-Id;
server computes content hashes and new revisions. The strong ETag is
`"m3-<uuid>"`. Keep canonical base64url NotePath item addressing and no-store.

| Route | Contract |
| --- | --- |
| GET /api/v2/mirror | Protocol identifier, association/designated writer IDs, note limit and retention policy; no mutation |
| GET /api/v2/notes?cursor=… | Live/legacy paths only, at most 50 scanned objects/page, opaque nextCursor or null; no implicit adoption |
| GET /api/v2/notes/:path | Raw Markdown <=1 MiB; revisioned ETag/format or explicit legacy format; 404 for absent/tombstone |
| GET /api/v2/notes/:path/state | Validated absent/legacy/live/tombstone metadata, path, revision/receipt/hash where applicable; no content; 200 for each recognized state |
| PUT /api/v2/notes/:path | Absent create or matching live update/tombstone recreation; 201 or 200 JSON ACK with exact path/revision/receipt and ETag |
| DELETE /api/v2/notes/:path | Matching live generation only; empty body; 200 JSON tombstone ACK and recovery status, 412 on stale/wrong/missing state; no hard delete |
| GET /api/v2/recovery?cursor=… | Bounded metadata pages, including unsealed/expired/purged status; not proof every prepared copy became an authoritative deletion |
| GET /api/v2/recovery/:id | Validated metadata only for prepared/sealed/purged recovery; 404 unknown; no local restoration |
| GET /api/v2/recovery/:id/content | Text for prepared/unexpired sealed recovery; 410 after sealed expiry/purge; 404 unknown |
| POST /api/v2/recovery/:id/seal | Explicit maintenance of an unsealed snapshot, matching recovery revision; verify the still-current matching tombstone's uploaded time, then CAS seal; 200, or 409 if proof is unavailable, 412 stale |
| POST /api/v2/recovery/:id/purge | Explicit maintenance; matching recovery revision and expiry required; CAS to content-free marker; 200 ACK or 412/409 refusal; already-purged identity idempotent |
| V1 PUT and DELETE on upgraded Worker | Authenticated 410 mutation_api_retired; no body/storage mutation |

All GETs are read-only. Recovery seal/purge carry the same identity/operation
headers and designation check as note mutations; their application ETag identifies
the fresh recovery generation. Seal is a no-op success for an already sealed
matching snapshot, never permission to extend its deadline or restore purged text.
A purge replay of the same operation against its purged receipt is a read-only idempotent ACK; a different stale predicate
is refused. Missing recovery ID is 404, never automatic proof of a prior valid purge.

Resolve M1/OpenAPI permissiveness: v2 PUT requires explicit nonempty supported
Content-Type (text/markdown or text/plain, case-insensitive, parameters accepted).
Missing/empty/unsupported = 415. Zero bytes/no request stream with supported type
is valid empty text; OpenAPI requestBody is optional and documents that meaning.
Enforce streamed incoming UTF-8 and 1 MiB independent of Content-Length. Missing
precondition = 428; invalid/both/list/weak/date/wildcard-update = 400; stale = 412.
V1 OpenAPI documents retirement, not old permissive mutation. OpenAPI paths/schemas
use actual shared NotePath validation and explain byte bounds, not false maxLength
claims. The old reserved protocol envelope is not silently repurposed.

Client streaming limits: raw note 1 MiB; metadata/ACK/list JSON 512 KiB;
recovery-with-text JSON `6 * MAX_NOTE_SIZE_BYTES + 16384`. Validate decoded recovery
content <=1 MiB too. Reject wrong success media type/status/path, malformed JSON,
unknown closed format, ETag/body revision mismatch, bad cursor or receipt, invalid
UTF-8, and actual bytes over bounds before accepting results. Cursors are bounded
opaque strings of at most 4096 characters; the server never accepts a client
storage prefix. Each inventory pass permits **1000 pages total**, including empty
pages; duplicate/cyclic continuation is a protocol failure. Exhaustion with a
remaining cursor returns incomplete-inventory and stops, never an automatic
recursive restart or a complete/empty success. This inventory cap does not exclude
local notes: positive per-path synchronization remains independent and CAS-protected.
Full multi-page listing is observational, not an atomic vault snapshot.

## Required deterministic tests

All tests use dedicated tests/unit or tests/integration trees and injected host,
network, storage, clocks and persistence. No real vault/tokens/deployment. Reproduce
harmful orderings using deferred promises/barriers; resolving competitors before
the tested race is not evidence. Assert actual winning bytes/revisions, ledger and
forbidden side effects, not just mock method names.

### Scope, bootstrap and saved events

- Whole activation mirrors every eligible Markdown file; no selected state or
  allow-list machinery; non-writer/unconfigured device sends nothing automatically.
- Existing exclusions, lowercase extension, literal percent/Unicode/path contract,
  actual byte limits; M2 local inspection neither activates nor changes scope.
- onLayoutReady startup create events coalesce; event registration precedes metadata
  scan; events during scan are merged; failed enumeration does not enable deletes.
- Remote-minus-local/bootstrap/iCloud-transient absence causes no delete. A delete
  observed before the boundary is not promoted later. Post-bootstrap associated
  runtime delete is accepted without inventing a human-origin flag/confirmation.
- Rapid repeated modify events produce one latest stable update; modify during read
  invalidates that read; modify during PUT remains dirty and uses its actual ACK
  for the next update. No per-editor-change request or forced save.

### Conditional updates and ambiguous operations

- Two absent creates paused at storage commit: one wins. New local path versus
  existing live/legacy/tombstone refuses without adoption even for equal text.
- Two updates read A before either commits; exactly one CAS wins. Remote B committed
  between publisher GET and R2 put survives, including B with the same text as A.
- ACK derives from stored B even if C commits before response formatting.
- Timeout/abort before dispatch versus after actual commit; lost ACK is unknown
  until exact own receipt; wrong action/hash/parent/path/association/ID is not proof.
- Keep aborted original server operation pending while exact retry runs: at most
  one generation wins. Three-attempt/evidence budgets persist across restart/events;
  unchanged prior state is not proof of cancellation. No latest-revision overwrite.
- Restart with changed local bytes cannot substitute them for a pending original
  intent; unchanged matching bytes may retry conditionally; other paths still run.
- Remote success + ACK-store failure pauses new mutations, retains intent and does
  not erase the already stored note or report fully recorded success.

### Delete/recovery and rename

- Delete X held before CAS; remote update Y commits; deletion refuses and Y survives.
  Archive prepare failure/ambiguous save means no tombstone; CAS failure may leave
  a labeled orphan; no compensating hard delete.
- Commit tombstone then lose ACK or fail sealing; exact receipt resolves effect;
  unsealed snapshot remains readable/unpurgeable. Seal uses actual tombstone upload
  time so a delayed head CAS does not shorten the 30-day recovery guarantee.
  All GETs are read-only; explicit seal authenticates/designates, requires a matching
  recovery revision and proves the same current tombstone; missing proof refuses.
- Delete→tombstone→local recreation retains recovery content, uses tombstone If-Match
  and fresh revision. Stale delete/create retries cannot delete/resurrect a new head.
- Runtime delete during own update waits for its evidence; arbitrary changed remote
  revision blocks. Delete during first unacknowledged create cannot retroactively
  gain authority; potentially committed orphan is visible.
- Purge at deadline boundaries; unsealed/unexpired rejects; expired CAS purge leaves
  marker; pending duplicate prepare/seal and two purgers cannot recreate content or
  remove another generation. Current heads never enter cleanup/lifecycle expiry.
- Rename while source PUT is pending reserves dependencies; lost destination ACK,
  collision, failed persistence or remote source edit prevents source tombstone.
  Source recreation, chained/overlapping/folder rename and excluded destination
  exercise actual pending windows and safe visible deferred cleanup.

### Lifecycle, identity, transport and negatives

- Two job slots/one per path including bootstrap/evidence; overlapping rename path
  reservations are deadlock-free; hot-path events don't starve others.
- Keep local read/Fetch/state write pending, unload, create a **new Plugin instance**
  and re-enable before settlement: no bypass of registry slots; no stale UI, late
  watcher registration, activation or old-origin state overwrite. Test bundle reload
  in the same realm, incompatible registry and actual process-restart ledger path.
- Non-cooperative aborting transport retains slots until settled; no cancellation
  claim for saved-file reads or in-flight Worker commits.
- Invalid endpoint/dev lookalikes, missing/shared-secret removal/rotation, external
  data.json modification, quota/corrupt state, designation mismatch and endpoint
  changes pause appropriately; no raw secret in settings, notices, logs or errors.
- Handoff refuses unresolved intents/rename dependencies; merely seeing old remote
  state or timing out is insufficient. Clean exported ACKs exclude IDs/activation/
  secrets; wrong association/import/remote mismatch refuses. New writer alone
  activates; lost old device cannot silently take over the same namespace. Hold
  iCloud hydration pending: old local live text cannot overwrite a transferred
  newer ACK, nor a stale local file recreate a transferred tombstone; local matches
  must be observed before activation, and changes during verification invalidate it.
- 401/403/404/409/410/412/428/429/5xx, malformed JSON/schema/UTF-8/media/path/revision/
  receipt/cursor, redirect denial, lying size, hanging stream and absent capabilities;
  exact v2 CORS method/header/auth/no-store behavior; no v1/requestUrl fallback.
  Endless distinct/empty cursors stop at the page budget without hiding incomplete
  inventory or stalling positive per-path work; failed read passes don't self-restart.
- No plugin local create/write/delete/rename, remote-to-local import, merge, agent
  execution, note-body UI/logging, token diagnostics, physical R2 head deletion,
  native-trash claims, scheduler polling or future NAS/sole-authority behavior.

## Validation and acceptance

Canonical `mise install`, `mise run install`, `mise run check` plus focused plan tasks.
Keep V8 production inclusion (including unimported source) and thresholds:
lines/statements 95%, functions 94%, branches 90%. Review risk-sensitive coverage.
The completed Slice 0 local Miniflare/workerd task verifies actual conditional
Headers wildcard/ETag/null, distinct revision-bearing validators and stored upload
timestamps for representative current/recovery keys. Future barrier doubles must
prove exact interleavings through handler→service→R2 adapter. Neither constitutes
a deployed Cloudflare test.

Proportional generated CommonJS tests exercise actual bundle modern settings/secret
reference storage, no Node dependencies, bootstrap/event-driven conditional mutation,
replacement-instance/bundle-reload ownership, text-only UI and token/body negatives.
Do not mechanically duplicate every policy unit test. Feature-detect standards
APIs; record actual desktop/mobile qualification or its absence, not invented host
support. No old-version fallback. Inspect compiler/lint/Biome assists/deprecations
and configured editor diagnostics; do manual code-review skill review after green
checks. Planning also receives that review before readiness is declared.

- [ ] A1: whole eligible scope and opt-in, no per-note state; auth scope separate.
- [ ] A2: modern SecretStorage/configuration/writer activation and privacy.
- [ ] A3: bootstrap/event coalescing/stable reads, finite fair bounded autosync.
- [ ] A4: conditional generations/receipts/legacy safety and v1 retirement proven.
- [ ] A5: per-path ledger/partial saves/restart/finite uncertainty recovery.
- [ ] A6: event-authorized tombstones, 30-day recovery and safe purge markers.
- [ ] A7: bounded safe rename/recreation including harmful interleavings.
- [ ] A8: runtime-owner lifecycle, designation and clean explicit handoff.
- [ ] A9: typed validated v2/OpenAPI/transport/CORS/failures and negative capabilities.
- [ ] A10: canonical/coverage/generated/runtime/diagnostics and semantic review pass;
  docs/operational instructions match actual implementation and limitations.
- [ ] A11: M3 completion evidence and implementation PR; only then M4 NEXT with its
  planning spec, no M4 code or deployment. M3 is not COMPLETE in this planning PR.

## Non-goals and residual risks

No remote-to-local mutation, conflict merge/adoption UI, arbitrary historic edit
recovery, bidirectional sync, multi-writer/election/leases, replayable plaintext
queue, attachments, search, MCP, NAS replication or new storage authority. Event/
debounce/retry scheduling is explicitly in M3; unbounded background polling is not.

Trusted host/other plugins/Worker operator can access plaintext; one bearer remains
privileged. Runtime iCloud/external delete events can temporarily hide notes, as
approved. Bootstrap incompleteness cannot authorize deletion. Saved reads and local
storage are not atomic/fsync guarantees; writer absence limits freshness; lost state,
ambiguous receipts, compound renames and unsealed recovery can require attention.
Recovery provides a 30-day window, not exact physical erasure or full backup. Small
current/purged markers persist. Operator removal/old-code rollback/stale bucket
restore violate active-association assumptions. No live resources, credentials,
real-host testing or production readiness is inferred from configuration.
