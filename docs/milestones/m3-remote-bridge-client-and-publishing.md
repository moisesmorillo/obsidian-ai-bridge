# M3 — Remote bridge client and explicit publishing

**Status: NEXT — design proposal; NOT implementation-ready pending maintainer decisions.**

M2 is COMPLETE and merged at `b300726` (PR #7). Repository inspection confirms
M3 is the single NEXT milestone. This planning-only change contains no production
implementation. The [decision brief](../plans/m3-design-decisions.md) gives viable
options, trade-offs, recommendations and platform evidence; the
[sequential plan](../plans/m3-remote-bridge-client-and-publishing.md) is gated by
those approvals. The [roadmap](../roadmap.md) owns order; [AGENTS.md](../../AGENTS.md)
owns engineering rules. M3 must not be marked COMPLETE by this planning PR.

## Readiness gate and decision authority

The requirements explicitly supplied by the roadmap/maintainer are authoritative:
explicit consent distinct from eligibility, outward publishing only, server-enforced
conditional safety, validated typed boundaries, bounded lifecycle behavior, privacy,
no silent adoption/overwrite and no M4 implementation.

**Everything labeled recommended below is conditional design, not an accepted
product decision.** Approve or replace D1–D6 in the decision brief before coding:

| Gate | Recommended decision | Why approval is needed |
| --- | --- | --- |
| D1 | Persistent individual selection; publish only the active selected note with a confirmation every time | Product granularity and persistence of consent |
| D2 | Session-only token; preserve 1.5.0 minimum; connection command/modal, not deprecated settings-tab API | Credential persistence convenience versus security/host compatibility |
| D3 | HTTPS origin, explicit exact-loopback HTTP development exception | Insecure-development policy and configuration UX |
| D4 | Versioned note envelopes with R2 CAS; new v2 routes and reject v1 writes | Consequential storage change and deliberate experimental writer compatibility break |
| D5 | Single configured namespace, per-path acknowledged baselines, no adoption; unresolved-attempt interlock | Association/reset semantics and conservative loss of retry convenience after crash |
| D6 | Fetch with redirect denial/abort and Worker CORS; platform qualification gate | New CORS surface and host/mobile transport support policy |

[ADR 0002](../decisions/0002-conditional-remote-note-mutation.md) and
[ADR 0003](../decisions/0003-publishing-association-and-local-state.md) are Proposed.
Their approval through review is not implied by this document. If a choice changes,
update dependent contracts/tests/slices before asserting readiness. The remaining
sections form one coherent recommended design, not a menu for implementers to mix.

## Objective and user-visible behavior

Connect explicit local publishing to the Worker while preserving both local notes
and unrecognized/concurrent remote content. A user configures a destination and
session token, selects an eligible saved note, confirms a single publish, and sees
a sanitized outcome. Remote inspection is deliberate and metadata-only in UI.
Neither enabling the plugin, selection, entering credentials nor inspecting local
notes sends any network request or authorizes another note.

### Recommended command and configuration surface

Keep M2's two local inspection commands and their saved-file/metadata-only behavior.
Add the following host-owned commands; UI callbacks delegate to application services:

| Command ID | Label / behavior |
| --- | --- |
| `configure-bridge` | Configure remote bridge: explicit modal to validate/set origin, development exception and session token; Set/Cancel, Remove token and Disconnect/reset actions. No automatic connection check. |
| `select-active-note` | Select active note for publishing: capture path, validate eligibility, confirm exact path and destination, persist one path. No note-body read or network. Already selected is an explicit no-op. |
| `manage-publishing-selection` | Show only explicitly selected paths as text, with individual Remove and explicit Remove all selections. This is not a vault picker or select-all action; missing paths remain removable. No body reads or network. |
| `publish-active-note` | Capture active path; require loaded valid state, token and explicit selection; confirm exact path/origin and saved-file semantics. Publish that one note, not an enumerated set. |
| `inspect-remote-notes` | Explicit authenticated list; validate every returned path; show text paths only, without changing selection/baselines. All-or-nothing validation, not a misleading partial list. |
| `inspect-active-remote-note` | Capture and validate local eligible path, read its remote counterpart explicitly, show path/bytes and legacy/known/diverged/missing metadata. Discard content before UI. Selection is not needed for this read, but it grants no publish authority. |

No token is displayed outside the transient masked input while the user enters it.
Never prefill, reveal, copy, toast or log its value. Clear input on submission/close;
retain only the active session credential provider reference. A mask is UX, not
protection from the trusted host. Set validates a nonempty bearer credential without
CR/LF/control characters and rejects rather than silently trimming token bytes.
Worker authentication remains the authority on whether it is valid. No credential
fingerprint, token prefix or raw response/error is exposed as a diagnostic.
Removing/replacing the session token does not revoke it at the Worker. Revocation
requires an explicitly authorized operator rotation of the Worker secret, after
which each client needs the new token; entering it never resumes a pending send.

A single-note progress dialog has preparing/reading/sending/recording/terminal
states and Cancel. A retryable ambiguous known-revision update may enter an
awaiting-retry-decision phase; it is not terminal and holds the original snapshot
and operation ownership until Retry, Close or unload. Terminal means content is
released. Ambiguous creates never offer replay. Show created, updated, refused
conflict, missing/unassociated,
failed-before-send, cancelled-before-send, unknown-remote-outcome or remote-stored /
local-state-unrecorded distinctly. Never say "synced", "rolled back" or "cancelled
remotely". Progress is phase-based, not invented byte-upload percentages.

### Consent and local safety

- Default empty selection; only explicit per-note selection creates consent.
  Reuse local exclusions (every dot-prefixed segment and the host configuration
  directory), literal path contract and metadata/actual UTF-8 size limit.
- Selection is not frontmatter, a folder rule, M2 eligibility or remote presence.
  No bulk expansion, directory recursion for publishing or automatic future files.
- Recheck selection and cancellation after every await before dispatch, and apply
  the existing read-only local adapter's pre/post checks. Revocation before send
  prevents it; revocation after dispatch cannot retract it and is reported honestly.
- Selection belongs to exact path, not an invented persistent TFile ID. It never
  follows renames. The per-publish confirmation remains necessary if a different
  file occupies the same path; M3 does not watch or reconcile replacements.
- Read saved text once after confirmation. No editor force-save, cached editor
  buffer or local create/write/delete/rename. Publish the returned snapshot; edits
  after the read may remain local. Same-size/same-mtime changes may escape M2's
  best-effort detection. No "latest local version" or atomic snapshot claim.
- No note-body previews/rendering/logging. UI paths use textContent/text APIs,
  not HTML/Markdown. Local and remote names remain sensitive metadata.

## Endpoint and transport policy

Recommended origin input accepts only an absolute HTTP(S) origin with optional
trailing slash; reject URL credentials, query, fragment, non-root paths and other
schemes. Do not concatenate unchecked URL strings. Normalize host case/default
port using the URL API, but do not silently repair malformed input or accept
alternate numeric IPv4 encodings as a loopback exception. Explicitly validate the
input host spelling before URL canonicalization for development exceptions.

HTTPS is default. HTTP is permitted only after explicit development opt-in bound
to exact `localhost`, `127.0.0.1` or `[::1]` and origin/port; never LAN ranges,
localhost suffixes, DNS resolution or a global insecure toggle. Tell the user to
use a disposable token. On a phone, loopback is that phone. Wrong destination can
receive content even over TLS: endpoint trust and confirmation remain necessary.

The HTTP adapter uses standard Fetch, `credentials: omit`, `redirect: error`, no
cookies and no token in URLs. No requestUrl/Node/Electron fallback. Reject redirects
rather than following a token/body-bearing request. A configured server/operator is
trusted with plaintext note contents; TLS is not end-to-end encryption.

Recommended Worker v2 CORS: public OPTIONS only for registered v2 list/item routes,
allow GET/PUT/OPTIONS and the Authorization, Content-Type, If-Match and If-None-Match
headers; `Access-Control-Allow-Origin: *` with **no** credentials support. Expose
ETag and `Bridge-Note-Format` on v2 responses, including error paths. Actual list,
read and write requests remain bearer-authenticated; do not exempt arbitrary v2
routes or methods. No CORS change to v1 mutation authorization. Bearer access, not
CORS/origin, is the security boundary; a hostile website without a token gains no
note access. This enables token-equipped browser clients too and is an explicit
D6 approval item. No origin is inferred from one untested desktop host.

Verify Fetch/AbortController/streaming/UTF-8 decode availability on the intended
minimum desktop/mobile hosts before claiming remote-client compatibility. Missing
capabilities fail unavailable with local M2 still usable; never downgrade transport
silently. Generated host-double tests prove packaging, not real-host CORS behavior.
If the host cannot support this contract, stop and revise D6 rather than leak
secrets through an unexamined requestUrl redirect policy.

## Architecture and typed boundaries

```text
Obsidian commands / text-only modals / session lifecycle
    ↓
Core publishing and remote inspection application services
    ↓
ReadOnlyLocalVault + RemoteBridge + PublishingStateStore ports
    ↓
Obsidian saved-file adapter + HTTP remote adapter + plugin-data adapter
    ↓
Worker v2 handlers → core note service → conditional repository port → R2 adapter
```

- `packages/core`: semantic state/result constants, validated path/revision types,
  consent policy, publishing orchestration and narrow remote/state ports. No fetch,
  Request/Response, HTTP statuses, Hono, R2, Obsidian, storage JSON codecs or tokens.
  Inject a credential-bound remote adapter at composition; don't pass credentials
  through domain objects. Core compares an opaque connection identity; parsing
  HTTP origins belongs to the configuration adapter. Keep M2 read-only port
  separate from remote storage CRUD.
- `packages/protocol`: authoritative wire routes/headers/error codes, request and
  response DTO schemas. Depend inward on public core path predicate/types where
  necessary; add an explicit workspace dependency rather than duplicate path
  validation or import private source. Core must not import protocol back.
- Plugin infrastructure: official saved-file reads; immediately validate weak
  loadData/JSON/host inputs and return strong types. HTTP adapter owns URL building,
  token injection, cancellation signal translation, media/byte/schema validation
  and sanitized status mappings. It has **no local mutation capability**.
- Plugin UI/lifecycle owns presentation identity, configuration entry, session
  credential provider and cancellation intent; application services own publishing
  decisions. Shared operation coordination owns the work exclusion. Neither UI
  nor handlers receive repositories or directly invoke fetch/R2.
- Worker handlers parse transport preconditions/body and format typed outcomes;
  core coordinates conditional note operations; R2 adapter owns envelope codec,
  conditional primitives and storage error translation. Replace unsafe write port
  usage rather than adding an unused safe method beside an accidentally reachable
  unconditional path. Preserve public exports/internal aliases and useful TSDoc.

### Port contracts (semantic shapes, not production declarations)

- `RemoteBridge.list(control)` → validated unique NotePath array or remote failure.
- `RemoteBridge.read(path, control)` → missing, legacy(content, sizeBytes),
  revisioned(content, sizeBytes, revision), or remote failure. Validate bytes before
  returning content; UI service removes it. Missing is not a delete instruction.
- `RemoteBridge.publish(path, content, absent | matching(revision), control)` →
  stored(path, created|updated, revision), precondition_failed, or remote failure.
  No unconditional write method and no delete/import capability. Successful path
  must equal the requested path; create/update status must match the precondition.
- `PublishingStateStore.load/save` → validated versioned snapshot or typed
  unavailable/invalid-state result. Application code receives domain state, not
  Obsidian's weak JSON type. One serialized persistence owner; failure never
  masquerades as successful defaults/erase.
- Operation control is a small platform-independent cancellation/deadline contract,
  mapped to AbortController by the adapter. It must expose actual settlement
  separately if UI deadline completion can precede underlying work. Never hide a
  pending host operation behind a fulfilled race promise.

### Closed failures and mappings

| Application outcome | Adapter evidence / required behavior |
| --- | --- |
| authentication_failed | 401, even if proxy error body is malformed; never expose returned message |
| authorization_failed | 403 from an intermediary/future server; M3 Worker has no scoped authorization distinction |
| network_unavailable | Fetch rejection not attributable to explicit abort/deadline; no raw exception |
| timed_out / cancelled | Explicit local deadline/intent; after dispatch outcome may also be remotely unknown |
| remote_missing | Valid GET 404; cannot authorize deletion or recreation of an associated note |
| precondition_failed | PUT 412; never refresh baseline and overwrite |
| protocol_incompatible | v2 unavailable (e.g. PUT 404), unsupported format/version/precondition protocol; no v1 fallback |
| malformed_response | Invalid JSON/schema/UTF-8, absent or mismatched success revision, wrong media type, invalid/mismatched returned path or unexpected success status |
| contract_violation | Invalid local path/payload, observed incoming/outgoing size bound, remote 400/413/415/428; distinguish programmer/protocol error from transient outage |
| server_failed | 5xx; writes may have committed before response failure |
| rate_limited | 429 from intermediary; no automatic retry or Retry-After scheduling |
| state_unavailable / invalid_state | Settings load/save failure, unknown schema or malformed persisted values; fail closed without overwriting the stored file |

Domain/application result discriminants have one typed source; HTTP mappings stay
in adapters. Track publish effect separately: not_dispatched, definitely_refused,
confirmed_stored or unknown. Malformed/failed transport after dispatch is never
proof of non-commit. Error JSON is validated when available, but status classification
of 401/403/5xx does not require echoing untrusted error strings. Unsupported status
and wrong success media type must not become success.

## Remote protocol and server-enforced mutation

The full storage predicate/safety proof is [ADR 0002](../decisions/0002-conditional-remote-note-mutation.md).
M3 explicitly includes this Worker/core/protocol work; it is not deferred to M4.

| Route | Recommended v2 contract |
| --- | --- |
| GET `/api/v2/notes` | 200 JSON `{notes: NotePath[]}`; shared runtime path predicate for every element; no revision/consent inferred from listing |
| GET `/api/v2/notes/:path` | 200 raw UTF-8 Markdown; `Bridge-Note-Format: revisioned` plus `ETag: "m3-<uuid>"`, or `Bridge-Note-Format: legacy` without writable ETag; 404 if absent |
| PUT `/api/v2/notes/:path` | Exactly one supported conditional header; explicit Markdown/plain-text content type; 201 create or 200 update; JSON `{path, stored:true, revision}` with matching ETag and revisioned format header |
| OPTIONS registered v2 routes | Bodyless CORS preflight; no storage/service invocation |
| PUT `/api/v1/notes/:path` on upgraded Worker | Authenticated 410 `write_api_retired`, no body/storage processing or mutation; no bypass header |

Other v1 read/list/DELETE behavior remains as documented except envelope decoding
behind raw note reads/listing; no v2 DELETE. Protect `/api/v2` and descendants as
well as v1. Preserve public health/Scalar/OpenAPI and sanitized content-free LogTape
logs. V2 success/error responses use no-store. New stable codes include
`precondition_failed` (412), `precondition_required` (428),
`invalid_precondition` (400), and `write_api_retired` (410).

Create uses `If-None-Match: *`; update uses exactly one strong
`If-Match: "m3-<uuid>"`. No weak/multiple/date/wildcard-update/both-header semantics.
Missing precondition is 428. Missing/changed/legacy update target returns 412, never
creates. A failed R2 conditional put is 412 without altering object bytes/metadata.
GET/HEAD before a write is not the safety mechanism; the R2 CAS is.

Resolve M1 runtime/OpenAPI permissiveness rather than carry it into v2: require an
explicit supported nonempty Content-Type for v2 PUT, case-insensitive with parameters;
missing/empty/unsupported is 415. Empty text and absent request stream are the same
zero-byte value with supported content type, both valid. OpenAPI requestBody is
optional and explicitly documents this empty-body interpretation. UTF-8 validation
and actual streamed 1 MiB bound remain mandatory regardless of Content-Length;
exactly 1 MiB is accepted. Retired v1 PUT advertises only its retirement behavior.
Schemas must document byte constraints without pretending maxLength is a UTF-8
byte limit; custom runtime NotePath validation must also have useful OpenAPI
constraint descriptions and invalid-path contract fixtures.

Client response limits: 1 MiB actual streamed bytes for a raw note; 2 MiB for any
JSON response, even if Content-Length lies or is absent. Abort/refuse over-limit
or invalid UTF-8 without parsing/showing a partial body. List remains an all-at-once
server operation: a valid larger list may be refused by this bounded client. This
is an explicit experimental scale limit, not public pagination or M5 hardening.
Validate schemas/paths, media types and matching revision/path/status combinations;
never trust generics on response.json(). All constants live in cohesive semantic
modules, not repeated strings in UI/tests/adapters.

### Association and harmful interleavings

Only a validated publish success followed by successful local state persistence
establishes a baseline. Remote inspection does not. First publish cannot adopt
existing or equal text. Known baseline + remote missing refuses; no resurrection.

The server creates a fresh revision in each stored envelope. Updates compare the
expected application revision and then CAS the exact observed R2 ETag. Two creates
or two updaters paused at the storage boundary compete atomically; at most one wins.
An edit committed after the publisher read but before its R2 put invalidates the
predicate, including a same-content write. Delete/recreate of identical text has
a fresh revision. See ADR 0002 for assumptions and the independently destructive
v1 DELETE boundary. No last-writer-wins retry loop exists.

## State and persistence

Recommended initial plugin schema is version 1; M2 has no prior data to migrate.
All state is validated on load. Missing file means configured=false/empty selection;
malformed or future schema means blocked, not silent reset/default merge or save.
Unknown fields are rejected in this version, with no automatic downgrade rewrite.

| Value / location | Purpose and authority | Lifecycle / removal / migration | Sensitivity / note content |
| --- | --- | --- | --- |
| schemaVersion in plugin data.json | Decode local metadata, not authorization from arbitrary JSON | Explicit known-version parser; future versions blocked; no migration from invented M2 state | Non-secret; no content |
| canonical origin + origin-bound dev permission in data.json | User-chosen destination, not proof of deployment/identity | Explicit setup; origin change requires disconnect/reset; no silent endpoint rebinding | Private configuration; no token/query/userinfo or content |
| selected NotePath array in data.json | User consent record, always rechecked with exclusions and per-send confirmation | Empty default; explicit select/remove; no rename propagation; disconnect/reset clears | Sensitive path metadata; no content |
| per-path acknowledged revision in data.json | Last confirmed publish baseline, never latest GET authority | Save only verified ACK; keep on deselection; reset clears locally with loss-of-association warning | Sensitive identity metadata; no content |
| one unresolved attempt in data.json | Safety interlock: path/origin/original precondition/attempted SHA-256, not a queue | Save before dispatch; clear only after certain refusal or recorded success; ambiguous/restart stays blocked; reset explicitly forgets without remote delete | Sensitive paths/content fingerprint; **no body** |
| token in session memory only | Bearer authorizes all remote operations; adapter alone attaches it | Explicit entry/replace/remove; unload/reset clears references; removal is not server revocation or secure memory erasure | Secret, never serialized/logged/displayed back |
| active snapshot/control/retry budget in memory | One foreground operation; original bytes for at most one manual retry | Discard at terminal/closed result or unload; no restart replay; unresolved metadata remains if needed | Transient note content, never diagnostic/UI/persisted content |
| R2 envelope format/revision/content | Authoritative current remote generation and body, one object atomic unit | Successful conditional writes only; no automatic legacy migration; v1 external deletion still possible | Remote note content readable by trusted operator; no credential |
| R2 bridgeFormat marker | Distinguish envelope codec from raw legacy text | Written with same object, validated before decode; unknown values fail closed | Non-secret format metadata, not CAS authority |

One application state owner serializes complete read-current/apply/persist
transitions, deriving each snapshot from the latest state when the transition
runs. Merely serializing disk writes of earlier captured snapshots is insufficient:
no independent UI save may overwrite a newly recorded baseline or revocation.
Gate new publishes until settings load and earlier in-flight work settle. A failed pre-send save prevents dispatch;
a failed post-ACK save is partial completion, not remote failure or success. No
claim of fsync, cross-process CAS or atomic backup synchronization. Persisted state
can be copied/tampered with by trusted host software; remote predicates remain
authoritative. Per-send confirmation prevents restored selection alone sending data.

## Lifecycle, cancellation and retry

Recommended limits: one foreground operation and one outstanding client request
per plugin instance; 30 seconds per request including response streaming; zero
automatic retries; at most one explicitly confirmed in-memory replay of an ambiguous
known-revision update with unchanged original bytes/matching precondition. No batch,
scheduler, watcher, queue, background health check, enabling scan or network on
settings changes.
Loading plugin metadata is permitted, not a vault scan or network side effect.

Operation ownership and UI enable-lifetime identity are separate. Retain the
operation guard through the **actual** saved-file/network/persistence settlement,
not just a notice timeout. Re-enable on that instance reports busy while previous
host work remains pending. Unload closes UI and clears credentials/content references
when possible, signals cancellation, suppresses every stale UI callback and prevents
further dispatch. It cannot cancel Vault.read or undo a submitted R2 write. Guarded
persistence already in flight must settle before re-enabled state loads/saves;
late success must not overwrite a new connection/selection snapshot.

Cancellation before dispatch means not sent. Cancellation/timeout after dispatch
means remote outcome unknown until a valid response establishes otherwise; an abort
is not a rollback. If a host/client test double ignores cancellation, show a deadline
outcome but retain exclusion until settlement, and do not start another request.
A hung host read can keep that instance busy indefinitely: safety over fabricated
cancellation. Real host plugin recreation/module reload is a qualification case,
not assumed to reuse the same instance. Persisted unresolved writes block new
publishing after restart/recreation; remote CAS protects competing processes even
where local-instance exclusion cannot. No process-global/device-global concurrency
or shared-settings transaction guarantee is claimed.

Definite single-attempt 401/403/400/412/413/415/428 refusal is not retryable without
addressing its cause; no automatic action. Network/timeout/5xx after dispatch may
be ambiguous. An ambiguous create is never replayed: create followed by independent
delete makes absence true again, and there is no M3 history proving that replay is
not resurrection. A permitted explicit update retry retains original bytes/precondition,
requires selection/session/destination unchanged and prior transport settled, and
never promotes an observed remote revision. A replay 412 after earlier uncertainty
is not proof of success or definite original refusal. After restart or snapshot
release, do not rebuild a payload or adopt remote content from a matching hash;
show unresolved previous publish and require explicit reset/operator recovery.
Missing token/removal/rotation never schedules a pending request.

There is no cross-note partial batch because one invocation sends one note. Remote
stored/local metadata failure is visible partial completion. Keep successful remote
data; never issue compensating DELETE. One unresolved attempt blocks more publishing
until resolved/reset; inspection remains possible once actual pending work settles
and any awaiting-retry-decision dialog is closed.
Full reconciliation/adoption/recovery is M4, not hidden behind Retry.

## Tests required before implementation

Use deterministic Vitest unit/integration tests, clocks, deferred promises and typed
host/transport/storage doubles; no credentials, live vault or deployment. Extend
existing dedicated tests trees, not production src. Tests must hold operations
inside the harmful window while triggering competitors, and assert actual stored
content/metadata and forbidden side effects, not only call counts.

### A — selection/consent

- Unselected eligible note cannot read-for-publish or send; M2 list/active inspection
  changes neither selection nor remote state. No select-all/enumeration upload path.
- Select one, explicitly confirm/publish one; other eligible/selected notes untouched.
- Revocation while saved read/confirmation/state save is pending prevents dispatch;
  after dispatch reports possible completion, never remote delete. Failed revocation
  persistence blocks publishing rather than reporting durable success.
- Hard excluded/private/invalid/oversized paths remain unread/unpublishable even in
  tampered selections; literal percent/Unicode/space names preserve exact identity.
- Rename, missing file and selected-path replacement never retarget an operation or
  auto-select a new path. Fresh confirmation is mandatory for path-based selection.

### B — configuration/persistence/secrets

- Invalid/insecure origin, credentials/query/fragment/base path, lookalike loopback,
  alternative numeric host spellings; exact dev opt-in bound to origin and reset.
- Missing/removed/rotated token and unload; no token in saved bytes, notices, logs,
  raw errors, URLs, response parsing failures or refilled UI. No note-body logging.
- Malformed/future settings, invalid path/revision/digest, interrupted saves,
  duplicate entries and load rejection; fail closed, preserve on-disk invalid data.
- Serialize selection/configuration/baseline writes. Pre-send save failure means
  zero PUT; post-ACK failure means stored/unrecorded and blocked. Reset never deletes
  remote data; new first create cannot overwrite it. Empty state never auto-sends.

### C — remote adapter/HTTP contracts

- Successful inspect/list/read and publish; legacy reads; matching path/revision/
  status/media metadata; no raw content returned to UI. Shared real path schema.
- Malformed JSON/schema/UTF-8, wrong content type, invalid or mismatched returned
  path, malformed/missing ETag/format, incorrect stored flag/status and response
  streaming above bounds with missing/lying Content-Length.
- 401, 403, GET 404, PUT 404 incompatibility, 412, 428, 429, 5xx, network failure,
  timeout, cancellation; malicious error strings discarded. No silent v1 fallback.
- Redirect refusal before forwarding credentials/body; CORS preflight exact methods/
  headers/routes, no credential cookies, actual requests authenticated, ETag exposed
  even with custom Origin, failure/no-store behavior and unknown v2 route protection.
- Generated OpenAPI and runtime agree on optional zero-byte stream plus required
  supported media type, preconditions, retired v1 PUT, new errors and path contract.

### D — exact conditional safety (mandatory)

1. Absent path → 201 and recorded new revision. No separate existence classification.
2. Pause **two absent creates immediately before R2 mutation**; release competing
   atomic calls; exactly one succeeds, other 412; winner bytes/metadata untouched.
3. Known A → successful update B; ACK returns B even if C commits before formatting
   the response. A post-write HEAD must not accidentally acknowledge C.
4. Pause publisher after reading A/ETag, commit remote editor B, resume publisher's
   R2 conditional put → 412, B preserved. Run through handler → service → actual
   R2 adapter with a barrier-controlled bucket double, not just a fake core port.
5. Both updaters read A while each is pending; atomic winner only. Repeat with B
   having identical note text to A; fresh envelope revision invalidates stale A.
6. Delete/recreate same text between read and CAS; stale update refuses. Delete
   without recreate also refuses, never upserts. Keep v1 deletion risk explicit.
7. Commit an update but drop response; explicit original-matching-revision replay
   refuses without altering the committed body. Separately drop before commit and
   allow update replay to win safely. Keep first server attempt pending during
   replay in the server test, despite client abort, and prove at most one succeeds.
   For create→dropped ACK→external delete, assert **no plugin replay**; absence
   becoming true again is not proof the earlier create never committed.
8. Malformed successful ACK/local save failure/unload leaves unresolved interlock;
   restart never sends/adopts automatically. After ambiguous attempt then 412, do
   not clear uncertainty or use latest GET ETag as authorization.
9. Existing legacy/equal/unrelated path before first publish refuses untouched;
   malformed storage is failure, never absent. V1 PUT on upgraded Worker never
   mutates; new plugin v2 against old Worker never invokes old unconditional write.
10. Focused local Miniflare/workerd R2 contract tests verify real conditional
    Headers wildcard, matching validators, null result and same-text envelopes.
    Deterministic barrier tests cover exact ordering; local runtime tests establish
    platform primitive behavior. Neither alone proves everything; no deployment.

### E — lifecycle and negative capabilities

- Only one operation/request per instance. Keep local read/network/save pending,
  unload then re-enable **before resolving it**; assert no second work starts,
  stale UI stays suppressed and normal work resumes only after actual settlement.
- Timeout/cancel with deliberately non-cooperative transport does not release work
  exclusion. Worker commit after client abort is an unknown outcome, not rollback.
- Credentials removed during read means no send; once in flight, removal cannot
  falsely report remote cancellation. State writes cannot resurrect old destination.
- Recreated-instance/restart with unresolved stored attempt blocks publishing;
  record real-host lifecycle qualification limits, not a fake cross-process lock.
- Assert no local create/write/delete/rename/save-editor, remote DELETE, watchers,
  scheduled/background requests, M4 import/merge, note-body UI/logging, token output,
  queue replay or automatic conflict handling. Keep M2 independent local commands.

## Validation and generated artifacts

Run canonical `mise install`, `mise run install`, `mise run check`; focused
`mise run test`, `mise run coverage`, `mise run typecheck`, `mise run lint`,
`mise run biome:check`, `mise run build`, `mise run plugin:smoke` per plan.
V8 continues to include all apps/packages production source, including unimported
new behavior; preserve global lines/statements 95%, functions 94%, branches 90%.
Review risk-sensitive branches, not only global percentages.

Extend existing generated CommonJS host-double suite proportionally: validate the
actual bundled schema/URL/credential/settings path, inert enable except settings
load, one confirmed conditional publish through injected web transport, no Node
runtime dependency, default export/manifest and unload/re-enable behavior. Do not
clone every source test in the artifact suite. New core/adapter policy remains
source-tested; Worker dry-run is packaging evidence, not R2 concurrency evidence.
Add local R2 runtime integration to canonical mise tasks/CI, not manual deployment.

Inspect diagnostics/deprecations and configured editor schema; no editor/mobile/
desktop claim without a real session. After full validation use the `code-review`
skill for manual semantic/security review of all changed code, contracts, races,
privacy, package boundaries, persistence and operational docs. Green CI alone is
not completion. The planning PR also requires this skill on its documentation.

## Acceptance checklist

### Planning gate

- [x] Establish actual M2/M3 state; inspect source/tests/configuration and official
  R2/Obsidian capability evidence, including limitations.
- [x] Provide alternatives and recommendations, architecture/state/protocol draft,
  exact race/negative tests and gated sequential slices.
- [ ] Maintainer resolves D1–D6; proposed ADRs accepted or replaced through review.
- [ ] Remove conditional design ambiguity, synchronize all dependent documents and
  record implementation-ready status only after the approval gate is satisfied.

### Implementation acceptance (all pending)

- [ ] A1: selection is explicit/empty-default/individual/revocable and separate from M2.
- [ ] A2: connection/token behavior matches approved trust, persistence and HTTPS policy.
- [ ] A3: existing/legacy/unrelated content is not adopted; baseline/reset semantics hold.
- [ ] A4: conditional server/R2 primitives pass exact races, including same-text ABA.
- [ ] A5: versioned API/old-server refusal and runtime/OpenAPI/path validation agree.
- [ ] A6: typed remote failures, bounded payloads/timeouts and safe retry effects hold.
- [ ] A7: serialized local state, partial saves and ambiguous/restart interlocks hold.
- [ ] A8: bounded lifecycle/unload/re-enable and cancellation guarantees are truthful.
- [ ] A9: no local mutation, delete propagation, secrets/content diagnostics or M4 scope.
- [ ] A10: source coverage, generated/runtime checks, diagnostics and semantic/security
  review pass; current-state/API/security/install/architecture docs synchronized.
- [ ] A11: completion evidence and focused implementation PR created, no deployment;
  only then transition M3 COMPLETE and M4 NEXT with planning handoff, never M4 code.

## Explicit non-goals and residual risks

No local note writes/import, conflict merging/resolution, automatic bidirectional
sync, delete propagation/tombstones, rename synchronization, durable offline queue,
watchers/schedulers, MCP, scoped identity/auth, search or new database. No content
cache, automatic legacy migration or adoption/recovery hidden in Retry.

Residuals: user-configured endpoint/host/other privileged plugins and cloud operator
are trusted; one bearer still grants destructive external v1 DELETE; no E2EE,
backup/history or production guarantee. Local saved reads are best-effort, settings
are not transactional across devices, and lost ACK/state may block publishing.
Whole-list server work is not paginated/bounded by client response limits. Per-write
nonce/ETag safety rests on documented storage predicates and validator/randomness
assumptions, not proof against malicious operators. Browser/host compatibility and
actual deployment behavior remain untested until explicit qualification; never
infer them from the manifest or configuration. An old Worker rollback over envelope
data is unsupported and dangerous; future deployment needs operator authorization.
