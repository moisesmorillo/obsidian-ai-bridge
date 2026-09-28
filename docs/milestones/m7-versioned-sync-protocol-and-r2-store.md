# M7 — Versioned sync protocol and isolated R2 store

## Status

**NEXT — implementation authorized only after the documentation transition PR
merges.** This milestone establishes a versioned, storage-independent sync
contract and its isolated R2 implementation. It does not enable synchronization,
change the current writer, migrate data, or authorize a personal-vault cutover.

M1–M6 remain complete and historically accurate. M3's designated-writer mirror,
the current v2 REST/MCP behavior, M4's reviewed-only local authority, and M5's
qualification envelope remain unchanged throughout M7. Implement M7 only on
disposable synthetic data. A merged M7 implementation is still not permission to
activate sync or disable iCloud.

## Outcome

Provide the first versioned shared-state foundation for later bidirectional sync:

- protocol-owned vault identity, revision, current/tombstone, recovery, inventory,
  change-feed, operation, and checkpoint contracts;
- strict protocol-major-1 schemas/types/constants in `packages/protocol` and a
  platform-independent domain `SyncStore` port in `packages/core`;
- an R2 adapter in `apps/worker` using a namespace that cannot collide with M1–M6
  objects;
- deterministic inventory, feed replay, and interrupted-operation recovery;
- conformance and R2-runtime tests proving the contract without adding active HTTP,
  MCP, OAuth, or plugin sync behavior.

The first M7 implementation PR must start with protocol contracts and tests. Follow-on
PRs may add the port, the isolated R2 key codec, and adapter/feed/recovery behavior as
separate reviewable work units. Keep each production PR within the repository's
change-size limits; dependencies and acceptance evidence are listed below.

## Preserved invariants

1. M1–M6 completion, accepted ADRs, existing API contracts, the current plugin
   writer, current `vault/<path>` and `recovery/<operation-uuid>` objects, and the
   M5 support claim are unchanged.
2. The new store is not composed into current v2 REST/MCP handlers or the plugin.
   No sync endpoint, grant, setting, background task, or writer admission is enabled
   by this milestone.
3. No existing object is scanned, copied, re-encoded, adopted, deleted, or migrated
   by M7. Tests use synthetic keys in an isolated local R2/workerd binding.
4. A failed, incomplete, stale, or uncertain observation cannot establish absence,
   authorize deletion, or return a successful mutation result.
5. No value from R2, including its ETag, bucket key, or pagination cursor, enters
   `packages/core` contracts or a future plugin checkpoint.

## Decided M7 contract

### Version and identity

- Define an explicit protocol major `1` for the new sync-store contract. Its wire
  and persisted forms are closed, validated schemas; unknown major versions and
  unknown authority-bearing fields fail closed. Do not repurpose the reserved
  protocol `0.1` envelope.
- A `VaultId` is a server-issued immutable UUIDv4. A `DeviceId` is a separate
  installation identity and is never authorization, a lock, or a writer election.
  The M7 adapter accepts a `VaultId` only after boundary validation; M7 does not
  create or authorize identities through a public route.
- `SyncRevision` and operation IDs are application-owned immutable UUIDv4 values.
  A version record binds vault ID, exact canonical path, revision, parent revision or
  explicit never-seen absence, SHA-256 of exact UTF-8 content bytes, byte size, media
  type, operation ID, and origin. A tombstone is a revisioned head with its exact
  parent; it is distinct from a path that has never existed. R2 ETags are private
  adapter preconditions only and never become domain revisions.
- M7 stores the currently supported Markdown payload only, at the existing 1 MiB
  UTF-8 limit and existing canonical `NotePath` rules. It does not claim Canvas,
  attachment, configuration, or whole-vault support. Path bytes and display spelling
  are preserved; cross-host path-equivalence policy remains a later qualification
  gate and cannot be guessed by the store. For the R2 key encoding below, M7 also
  rejects a `NotePath` longer than 720 UTF-8 bytes; it does not truncate or normalize
  an over-limit path. This M7 bound keeps a full
  `sync/v1/vaults/<vault-id>/heads/<base64url>.json` key at or below 1,023 bytes:
  52-byte vault prefix, 6-byte `heads/` segment, 960-byte encoded path, and 5-byte
  suffix, under R2's 1,024-byte object-key limit.

### Namespace and v2 coexistence

- Use the existing `VAULT_BUCKET` with the immutable, versioned prefix
  `sync/v1/vaults/<vault-id>/`. Keep current v2 objects at `vault/<path>` and
  `recovery/<operation-uuid>` exactly where they are. Do not fall back between
  prefixes, share listings, or infer that matching paths are the same revision.
- Within the new prefix, separate live/tombstone current heads, immutable versions,
  recovery bodies/markers, operation journals, and change-feed lanes under fixed
  documented sub-prefixes. Key components use canonical,
  validated identifiers and opaque path encoding; they never concatenate an
  unvalidated user path into an R2 key.
- Use these exact key forms below the vault prefix; all UUIDs are lowercase canonical
  UUIDv4 and all sequence values are zero-padded 20-digit decimal strings:

  | Data | Key below `sync/v1/vaults/<vault-id>/` |
  | --- | --- |
  | Vault marker | `vault.json` |
  | Current live/tombstone head | `heads/<base64url-no-pad(UTF-8 NotePath)>.json` |
  | Immutable version metadata | `versions/<revision>.json` |
  | Immutable content body | `content/<revision>.md` |
  | Recovery evidence | `recovery/<operation-id>.json` and `recovery/<operation-id>.md` |
  | Durable operation journal | `operations/<operation-id>.json` |
  | Feed lane head | `feed/<lane-hex>/head.json` (`lane-hex` is `00`–`3f`) |
  | Immutable feed event | `feed/<lane-hex>/events/<sequence>.json` |

  Sequences are unsigned 20-digit decimal strings, start at
  `00000000000000000001`, and compare lexicographically. They are not JSON numbers,
  avoiding loss of integer precision in JavaScript. Exhausting
  `99999999999999999999` returns `sequence_exhausted`; a sequence must never wrap or
  be reused.

  The vault marker uses create-only semantics and contains only its schema version,
  protocol major, and matching `VaultId`. M7 has no production vault-provisioning
  entry point; isolated tests seed the marker through a test fixture. Inventory
  evidence is returned to the caller and is not persisted. Listing is restricted to
  `heads/`; feed and immutable bodies are never mixed into current-state inventory.
  Base64url path keys decode to one canonical `NotePath` and are re-encoded to prove
  canonicality before use. Encoding the path as ASCII also avoids R2's default NFC
  normalization of Unicode object-key names.
- Vault markers, initial journals, immutable version/content/recovery/event records
  use create-only writes. Current heads and lane heads use exact-observed R2 ETag CAS;
  journal transitions also use exact-observed CAS. A missing ETag on an object that
  must be conditionally replaced is `effect_unknown`, never an unconditional write.
- R2 limits writes to the same object key to one per second. Every repeated write
  attempt to a key—including create-only replay and mutable lane-head
  reservation/commit/abort, journal transition, or current-head update—must be spaced
  at least 1,100 ms after the prior successful write to that key, using its
  server-reported R2 `uploaded` timestamp as the lower bound. Before each write, the
  adapter reads the exact object and timestamp. If R2 returns a rate-limit response,
  the next attempt must also wait at least 1,100 ms after that response; after an
  uncertain timeout, wait at least 1,100 ms after the request's timeout/observation
  before resuming. Compute `retryAfterEpochMs` as the
  latest of the applicable `uploaded + 1,100 ms`, rate-limit-response time plus
  1,100 ms, and uncertain-request timeout time plus 1,100 ms. Local in-memory
  serialization may reduce contention but is not a correctness mechanism. Exact ETag
  CAS remains mandatory across concurrent Worker instances. Do not introduce
  last-writer-wins writes, unconditional retries, or a second coordination service.
- M7 performs no v2 import and does not accept a v2 ETag or format-2 receipt as a
  sync precondition. There is no read-through or implicit legacy adoption. In a
  later explicit import, a valid format-2 ETag/receipt may be retained as migration
  provenance only; it is not equal to a `SyncRevision`. An untagged legacy object
  has no conditionable revision and must be rejected for automatic import until an
  owner-reviewed create establishes a new sync revision.
- Existing v2 clients and MCP calls continue to address only their existing v2
  contract while M7 remains uncomposed. Before any later sync API is exposed for a
  migrated vault, an immutable migration binding must associate its legacy mirror
  identity and authorized client grants with the new `VaultId`. Every v2 read or
  mutation for that migrated binding must then fail with a stable
  `protocol_upgrade_required` response **before** resolving a service or touching
  R2. Unmigrated legacy identities retain v2 behavior. No stale successful v2
  mutation may write data invisible to the sync engine. New grants are never
  upgraded implicitly.
- A future import must be explicit, owner-authorized, and create-only in the new
  namespace. It must inventory and verify source bytes and supported metadata,
  write and read back the complete new version graph, then commit the migration
  binding/fence before any sync client can mutate. Preserve old v2 keys unchanged;
  they become non-authoritative evidence for the migrated binding. Any partial or
  ambiguous import remains unavailable for sync and is resumed or reviewed by
  migration tooling; it is never treated as an empty vault. Import tooling and
  v2-route fencing are not M7 implementation scope.

### Conditional current state and recovery

- `SyncStore` exposes typed operations for read-current, conditional create/update,
  conditional tombstone, immutable-version/recovery reads, bounded inventory,
  incremental changes, and resuming an operation by its stable operation ID. It
  does not expose generic bucket access or permanent object deletion.
- The port has one typed method per operation: `readCurrent`, `mutate`,
  `readVersion`, `readRecovery`, `readChanges`, `inventory`, and `resumeOperation`.
  Every input carries a validated `VaultId`; path-bearing inputs use `NotePath`;
  `mutate` takes the closed create/update/tombstone union and returns the exact
  resulting `SyncRevision`, operation ID, and committed feed position. Read methods
  distinguish never-seen absence, live head, and tombstone. `readChanges` returns one
  bounded feed page. `inventory` performs one complete bounded scan internally and
  returns either complete evidence or a typed `inventory_incomplete`,
  `inventory_limit_exceeded`, `storage_throttled`, or `storage_unavailable` failure;
  it never returns partial entries as a successful page. Neither method exposes R2
  cursors or adapter metadata. The port
  and its result unions live in `packages/core`; protocol schemas and stable
  protocol constants live in `packages/protocol`.
- Every mutation identifies the exact observed `SyncRevision` (or explicit
  never-seen absence), operation ID, expected content digest, and target state.
  R2 uses create-only or exact-observed-generation conditional writes. A stale
  condition returns a typed conflict; the adapter must never refresh and retry
  against a newer head.
- Preserve immutable versions and recovery bodies before publishing a tombstone.
  Tombstones remain current heads; M7 adds no purge or lifecycle expiration policy.
  Recovery references identify exact immutable versions and are not inferred from
  R2 object metadata.
- The storage adapter uses a durable operation journal and a pending/committed
  publication state. The journal is create-only and binds the full normalized
  mutation request; same operation ID and same request resumes, while a different
  request returns `operation_id_reused`. The lane head contains the committed
  sequence and either no pending reservation or exactly one pending operation with
  its reserved next sequence. The write order is: create journal, reserve the next
  lane sequence with exact-head CAS, create and verify immutable version/content
  (and recovery body for a tombstone), conditionally replace the exact current head,
  create the immutable feed event, mark the journal committed, then commit the lane
  head last. An operation aborted before changing current state publishes an aborted
  event at its reserved sequence before releasing the lane, so committed sequences
  never have gaps. A feed event is a strict union of `changed` (resulting live or
  tombstone revision) and `aborted` (operation ID and typed reason, with no revision).
  Replays with the same operation ID are idempotent. A pending
  operation blocks later writes in that feed lane until recovery inspects exact
  stored revisions and either publishes its committed or aborted result. If evidence
  cannot establish either result, retain the blocker, return typed `effect_unknown`,
  and require later recovery/review. Never report success before the committed feed
  record is readable.
- The closed M7 store error set is `invalid_input`, `unsupported_protocol_version`,
  `vault_not_found`, `stale_revision`, `operation_id_reused`,
  `cursor_expired`, `invalid_cursor`, `inventory_incomplete`,
  `inventory_limit_exceeded`, `sequence_exhausted`, `storage_throttled`,
  `operation_pending`, `effect_unknown`, and `storage_unavailable`. `storage_throttled`
  means a known R2 rate-limit refusal when no operation remains durably incomplete
  (including reads/inventory and mutation before its journal is created); it includes
  `retryAfterEpochMs`. Once the journal exists, a known throttled but incomplete
  operation returns `operation_pending` with its operation ID and the same field.
  `retryAfterEpochMs` is the earliest safe time to retry or resume in Unix epoch
  milliseconds. `effect_unknown` means exact read-back could not establish whether a
  durable step occurred; it includes the earliest safe `retryAfterEpochMs` when a
  write outcome is uncertain. Malformed input is rejected at the protocol/core
  boundary before adapter calls. These are domain
  results, not HTTP status codes; later transport adapters define their own mapping
  without changing M7 storage semantics.
- A failure between any two durable steps is recoverable without overwriting a
  competing revision. Tests must exercise every crash boundary, duplicate replay,
  stale condition, and persistence failure. Application policy remains in core;
  handlers, when a later milestone adds them, must remain thin.

### Bounded incremental feed and complete inventory

- Partition feed records into 64 lanes, selected by the low six bits of the first
  SHA-256 digest byte over the canonical UTF-8 `NotePath`. Each lane has a monotonically
  increasing sequence, one conditional head object, and immutable sequenced event
  records with `committedAtEpochMs`. This avoids a single per-vault feed hot key
  while giving every path a stable lane. The lane count and hash rule are protocol-v1
  constants, not runtime configuration. `committedAtEpochMs` is monotonic within a
  lane: commit time is `max(serverNowEpochMs, previousCommittedAtEpochMs + 1)`.
- A checkpoint is a 64-entry vector of committed lane sequences plus protocol
  version and vault identity, plus a `nextLane` round-robin pointer from `0` through
  `63`. The opaque cursor is validated as one unit; it is not reduced to vector
  equality. Incremental reads capture committed high-water marks, then visit lanes
  cyclically starting at `nextLane`. Each round examines every lane once and emits at
  most its next consecutive event at or below that lane's captured high-water mark.
  A lane cannot contribute a second event in a round until every other lane with an
  eligible event has had its turn. Continue rounds until 100 events have been emitted
  or a full round emits none. Advance only the sequence entries for emitted records;
  after a non-empty page, set `nextLane` to the lane immediately after the last
  emitted event. An empty page preserves the input pointer. Thus a continuously busy
  lane cannot starve another lane: every lane with an eligible event at the captured
  high-water mark is served within one 64-lane round, regardless of lane number or
  continuing writes beyond that mark. A page performs at most 100 rounds (6,400 lane
  visits) and returns at most 100 events.
  The lane number is the first digest byte masked with `0x3f`; hexadecimal lane names
  are two lowercase digits. Feed records include exact path, resulting
  revision/tombstone, operation ID, and origin, not content.
- Keep change records physically available; M7 does not purge them. A cursor is
  expired when its first unconsumed event in any lane is older than 30 days, measured
  against server time. A cursor at a lane's current high-water mark does not expire
  merely due to age. A cursor from another vault/protocol version, malformed, or
  ahead of its committed head returns `invalid_cursor`; an expired cursor returns
  `cursor_expired`. Neither error returns an empty-success page. Expiry requires a
  complete inventory before incremental sync resumes.
- Bound each R2 listing request's requested limit to 50 objects. R2 can return fewer
  than requested while additional keys remain, so page length is never a completion
  signal. Follow the opaque R2 cursor exactly while `truncated` is true; stop only
  when `truncated` is false. A truncated result must include its cursor; a missing or
  malformed cursor is `inventory_incomplete`. Do not synthesize, decode, or compare
  cursors in core.
- Define the protocol constant `MAX_SYNC_HEAD_RECORD_BYTES = 4096`. Each current-head
  body read for inventory is capped at this value, and cumulative bytes read from
  head bodies are capped at 16 MiB per attempt. Decode only the strict head schema;
  reject oversized or malformed bodies without buffering beyond the cap.
- One `inventory` call makes at most one complete attempt: it first reads all 64 lane
  heads and their pending-operation markers, then follows the R2 cursor through only
  `heads/`. For each listed key, perform one bounded GET of that exact current-head
  object and decode the validated head body to obtain its `SyncRevision` and live or
  tombstone state. Listing metadata, object timestamps, and list ETags are not
  revision/tombstone evidence. Validate the key's vault prefix and canonical encoded
  `NotePath` against the body. A missing object, malformed body, or key/body mismatch
  invalidates the whole attempt; inventory never fetches version/content bodies. An
  R2 throttle or unavailable R2 read remains the corresponding typed storage failure,
  not a structural inventory failure. Then read all 64 lane heads and
  pending-operation markers again. The returned start/end vectors and validated head
  entries form its inventory evidence.
  The listing is not an atomic snapshot; matching vectors prove no committed mutation
  crossed the listing interval and therefore bound the listing to an unchanged
  current-state generation. It is complete only when every lane is committed (no
  pending operation), the start and end vectors are identical, and R2 reports
  `truncated: false`. A changed/pending lane, malformed or missing head, or other
  incomplete evidence returns `inventory_incomplete`; an R2 429 on a list, lane-head,
  or current-head read returns `storage_throttled` with `retryAfterEpochMs`, while an
  unavailable R2 read returns `storage_unavailable`. Each failure returns no entries
  or absence conclusions. A later explicit recovery call starts a new attempt; no
  automatic retry is made. An inventory is reporting/recovery evidence only in M7:
  it never grants deletion authority.
- Treat an expired/missing/ambiguous feed cursor as a recovery transition: stop
  advancing that cursor, obtain a complete inventory under the vector rule, rebuild
  positive current-state evidence, and resume from the inventory's matching vector.
  If the inventory cannot complete within its page/request/byte/time budget, leave
  the client checkpoint unchanged and return a typed incomplete result. Never
  convert an empty or partial listing into an empty vault or delete event.
- One complete attempt has independent hard budgets: at most 200 R2 LIST calls, at
  most 10,000 listed/current-head GETs, at most 10,000 returned head entries, at most
  16 MiB cumulative current-head body bytes, and at most 16 MiB of UTF-8 serialized
  inventory evidence, whichever relevant limit is reached first. These are ceilings,
  not a throughput guarantee: 200 LIST calls do
  not guarantee 10,000 entries because R2 may return fewer than 50 objects per call.
  If the LIST-call budget is reached while the last result still has `truncated: true`,
  return `inventory_limit_exceeded` with no entries or absence conclusions. Reaching
  an entry, head-GET, or evidence-byte ceiling before a complete scan returns the same
  typed failure; never return a partial inventory as complete. The 128 lane-head
  observations (64 at start and 64 at end) are separately bounded. No budget is
  replenished by an automatic retry.
- Stage 1 uses 10,000 synthetic current objects as the initial inventory ceiling,
  with streaming list metadata and one bounded head-body GET per listed key; do not
  buffer content bodies or the entire object set. The existing 1 MiB object limit
  remains in force for mutation/content reads, not inventory head reads. Worker
  runtime limits bound elapsed work; exact CPU and duration must be measured in local
  workerd before implementation completion. No deployed or mobile performance claim
  follows from this synthetic ceiling.

### R2 write throttling and uncertain effects

- The same-key R2 write limit applies to every repeated write attempt to a key,
  especially lane-head reservation/commit/abort transitions and create-only replays.
  Respect the 1,100 ms spacing and response/timeout cooldowns above. The R2 object's
  `uploaded` timestamp is the successful-write spacing reference; it is not a
  mutation revision or authority token. Local locks are only an optimization. CAS
  remains the cross-instance serialization fence, and a failed precondition never
  refreshes its ETag or retries against a different body.
- Do not hide throttling behind an unbounded retry. A known R2 429/rate-limit result
  causes no write attempt to be treated as complete. Before any durable operation
  journal exists, return `storage_throttled` with `retryAfterEpochMs`. Once the
  journal exists, preserve it and any lane reservation; return `operation_pending`
  with the same operation ID and updated `retryAfterEpochMs`. Each `resumeOperation`
  invocation performs at most one bounded recovery attempt, uses the same request/op
  ID and the exact CAS ETag recorded for the unfinished step, and may not run before
  `retryAfterEpochMs`. It must not refresh an ETag for that step. Do not sleep inside
  a Worker request; if the lower bound has not passed, return the typed pending
  result. Another typed pending result is returned if R2 throttles again. Do not
  clear a pending lane reservation merely because it is throttled.
- After any timed-out/failed write whose effect is uncertain, read the same key and
  validate the complete stored record. Exact evidence bound to this operation proves
  that step and recovery may continue. Exact unchanged prior body plus its original
  ETag proves the attempted CAS is still eligible for a later retry with that same
  ETag and same bytes, if no lower-bound cooldown remains; it does not authorize
  refreshing the condition. Missing, divergent, malformed, or unavailable evidence
  returns `effect_unknown` and retains the operation blocker. For a create-only write,
  an exact expected record proves the step; an incompatible existing record is a
  conflict, never adoption. If the exact key is still absent after the cooldown,
  retry only the same create-only bytes; when the operation journal exists, derive
  those bytes from its bound request. If the original request completes concurrently,
  create-only prevents replacement and read-back must validate the exact expected
  record before continuing. If the initial
  journal create times out and remains absent after cooldown, return `effect_unknown`
  with its safe retry time; the caller may resubmit only the identical original
  mutation request and operation ID. This cannot establish success without the exact
  durable journal record. An R2 precondition refusal is resolved by read-back, never
  by an unconditional retry. R2's strong consistency supports read-back of completed
  writes but is not a multi-key transaction or proof that a still-in-flight request
  has been canceled.
- For throttling or uncertain effects after the lane reservation, do not report the
  mutation as successful until current-head state, immutable feed event, committed
  journal, and committed lane head are all durably verified and the feed event is
  readable. A known incomplete operation returns `operation_pending`; unresolved
  effect certainty returns `effect_unknown`. Read/list throttling returns a typed
  storage failure and never advances a cursor or returns partial inventory evidence.

### Rename and replay

- Rename is represented as two durable operations: create and verify the
  destination revision first, then conditionally tombstone the source at its exact
  observed revision. Persist destination evidence before source work. A crash can
  leave both paths live but cannot remove the sole copy. Replaying an operation ID
  cannot duplicate the destination or erase a subsequently edited source; changed
  evidence yields `effect_unknown`/review rather than refreshing the condition.
- M7 tests this storage/application transition with synthetic paths and does not
  compose local Obsidian writes or automatic reconciliation.

## M7 scope and exclusions

**In scope:** protocol schemas and typed identifiers; key/namespace encoding;
`SyncStore` port; R2 adapter; exact conditional semantics; operation journal;
immutable version and recovery storage; 64-lane feed; bounded paged inventory and
cursor recovery; local workerd conformance tests; documentation and API-contract
design sufficient for future adapters.

**Out of scope:** changing M1–M6 code or behavior; adding/exposing a v3 route or MCP
capability; connecting plugin OAuth grants; enabling a sync writer; v2 migration or
route fencing implementation; iCloud changes; local-vault mutation; automatic
reconciliation; mobile, real-host, or personal-vault qualification; Canvas,
attachments, configuration sync; production R2 access, data migration, deploy,
backup service, or NAS adapter. Later milestones must specify these before use.

## Test-first implementation units

Each implementation PR remains within the production change-size gate and keeps
tests with the behavior they verify:

1. **M7.1 — Protocol and key contracts:** schemas, stable result/error codes,
   immutable vault/revision identifiers, namespace key codec, feed lane/hash and
   cursor codec; exhaustive validation, hostile identifiers, unsupported versions,
   v2 prefix separation, and no weakly typed values.
2. **M7.2 — Core storage port and policy:** typed `SyncStore`, conditional mutation
   inputs/results, inventory/feed/recovery contracts, operation state transitions,
   deterministic in-memory fake, and state-matrix tests. Core has no R2/Worker/HTTP
   dependency.
3. **M7.3 — Isolated R2 primitives:** version/current/recovery key persistence,
   create-only/exact-generation CAS, strong read-back, and prefix-isolation tests
   against local workerd. Existing v2 objects remain untouched.
4. **M7.4 — Feed, inventory, and crash recovery:** lane sequencing, operation journal,
   committed cursor reads, 30-day minimum retention/expiry, stable-vector inventory,
   pending-operation recovery, bounded replay, and every crash/race scenario against
   local workerd. This PR must not add or mount public routes.

Dependencies are strictly sequential. Each PR must pass focused tests, `mise run
check`, and a semantic review before the next begins. If measured production scope
crosses repository thresholds, subdivide further without changing these contracts.

## Acceptance criteria

1. Protocol and persistence schemas reject malformed paths/IDs, wrong vaults,
   unsupported versions, unknown authority-bearing fields, invalid revisions, and
   invalid cursor vectors; sequences remain exact 20-digit strings beyond
   JavaScript's safe integer range; path-key tests prove 720 UTF-8 bytes fit and
   721 are rejected before R2 access; all public semantic constants have one
   source of truth.
2. Property and focused unit tests prove two callers using the same expected
   revision cannot both commit; stale writes do not refresh/retry; operation replay
   is idempotent; effect uncertainty is never reported as success.
3. R2/workerd tests prove exact create/update/tombstone conditions, immutable
   version/recovery retention, namespace isolation, and byte-for-byte noninterference
   with synthetic `vault/` and `recovery/` v2 objects.
4. Feed tests prove stable lane assignment, monotonic committed sequences,
   bounded round-robin pagination, no skipped committed record across cursor
   continuation, explicit cursor expiry, and no success page for invalid/future/
   expired cursors. With one lane producing continuously and a later-numbered lane
   holding eligible events, each eligible lane is served within one 64-lane round;
   the hot lane cannot take a second event in a round before the other lane's turn.
5. Inventory tests prove requested page limit 50, short pages with `truncated: true`
   continue using the exact returned cursor, and only `truncated: false` completes
   listing. They verify revision/tombstone evidence comes from each validated head
   body's GET (not list metadata), enforce the 200 LIST-call maximum without claiming
   it guarantees 10,000 results, and prove `inventory_limit_exceeded` returns no
   entries when the budget expires while truncated. They also cover the 10,000-head
   and 16 MiB ceilings, streaming behavior, start/end vector equality, invalidation
   on concurrent writes/pending operations or missing heads, typed throttle and
   unavailable-storage failures with no partial entries, one-attempt bounds, and no
   absence/deletion evidence from incomplete scans.
6. Recovery tests inject failure after every journal/current/event/head persistence
   boundary; retry either commits the exact same operation, records a safe abort, or
   remains blocked as `operation_pending`/`effect_unknown`. Same-key tests cover
   create-only journal replay, journal transitions, lane-head reservation/commit,
   and current-head writes; they prove the minimum successful-write interval, exact
   CAS under concurrent workers, and no retry before the returned cooldown. Inject
   R2 429 before journal creation and after reservation/commit; verify known
   throttling remains typed and resumable by the same operation ID. Cover an initial
   journal-create timeout with absent read-back, exact-byte create-only replay after
   cooldown, and eventual exact-record confirmation. Uncertain writes require exact
   read-back; no incomplete mutation or unreadable feed event is reported as success.
   No failure path loses both recovery and current evidence.
7. Rename tests prove destination-first durable ordering, two-copy recovery after
   interruption, duplicate replay safety, and source preservation when it changes.
8. A test-level compatibility matrix proves M7 storage never falls back to v2,
   v2 codecs/keys are not reinterpreted, and the future migration contract requires
   a binding fence before sync exposure. No v2 routes are changed or sync routes
   mounted in M7; existing writer/API/MCP regression tests remain unchanged and
   pass.
9. All M7 code is isolated from production activation: no sync route registration,
   new OAuth permissions, plugin setting, automatic vault access, R2 deployment, or
   migration command. No personal vault is accessed.
10. Canonical `mise install`, `mise run install`, focused storage tests, and
    `mise run check` pass; relevant docs/current-state/architecture/API and the M7
    evidence report are synchronized. Final semantic/security review has no
    unexplained findings.

## Exit and next transition

M7 is complete only when all four implementation units and acceptance criteria are
merged and evidenced. M7 completion does not authorize protocol activation, data
migration, personal-vault use, disabling iCloud, or production deployment. The
following milestone must separately specify and qualify API/client enrollment,
legacy-v2 fencing/import behavior, and sync reconciliation before any protocol is
exposed. Do not mark a following milestone `NEXT` in the M7 implementation PR;
refine its specification in a separate roadmap transition.

## References

- [Canonical roadmap](../roadmap.md)
- [Architecture](../architecture.md)
- [Verified current state](../current-state.md)
- [ADR 0016 — Bidirectional vault synchronization](../decisions/0016-bidirectional-vault-sync.md)
- [Bidirectional sync rollout plan](../plans/bidirectional-vault-sync-rollout.md)
- [API contract](../api.md)
- [Operations and release guidance](../operations.md)
- [Cloudflare R2 platform limits](https://developers.cloudflare.com/r2/platform/limits/)
- [Cloudflare R2 Unicode interoperability](https://developers.cloudflare.com/r2/reference/unicode-interoperability/)
