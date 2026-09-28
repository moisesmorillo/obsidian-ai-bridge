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
  returns either complete evidence or a typed `inventory_incomplete` /
  `inventory_limit_exceeded` failure; it never returns partial entries as a
  successful page. Neither method exposes R2 cursors or adapter metadata. The port
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
  `inventory_limit_exceeded`, `sequence_exhausted`, `effect_unknown`, and
  `storage_unavailable`. Malformed
  input is rejected at the protocol/core boundary before adapter calls. These are
  domain results, not HTTP status codes; later transport adapters define their own
  mapping without changing M7 storage semantics.
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
  version and vault identity. It is opaque to plugin persistence code except for
  schema validation and equality. Incremental reads capture committed high-water
  marks, return at most 100 records per call ordered by `(lane, sequence)` up to
  those marks, and advance only the lanes whose returned entries were fully consumed.
  The lane number is the first digest byte masked with `0x3f`; hexadecimal lane names
  are two lowercase digits. Feed records
  include exact path, resulting revision/tombstone, operation ID, and origin, not
  content.
- Keep change records physically available; M7 does not purge them. A cursor is
  expired when its first unconsumed event in any lane is older than 30 days, measured
  against server time. A cursor at a lane's current high-water mark does not expire
  merely due to age. A cursor from another vault/protocol version, malformed, or
  ahead of its committed head returns `invalid_cursor`; an expired cursor returns
  `cursor_expired`. Neither error returns an empty-success page. Expiry requires a
  complete inventory before incremental sync resumes.
- Bound each R2 listing request to 50 objects. One `inventory` call makes at most one
  complete attempt: it first reads all
  64 lane heads and their pending-operation markers, then pages only through `heads/`,
  then reads all 64 lane heads and pending-operation markers again. The returned
  start/end vectors and current-head entries form its inventory evidence. The
  listing is not an atomic snapshot; matching vectors prove no committed mutation
  crossed the listing interval and therefore bound the listing to an unchanged
  current-state generation.
  It is complete only when every lane is committed (no pending operation) and the
  start and end vectors are identical. If any lane changes, becomes pending, or
  listing fails, return `inventory_incomplete` with no entries and discard absence
  conclusions. A later explicit recovery call starts a new attempt; no automatic
  retry is made.
  An inventory is reporting/recovery evidence only in M7: it never grants deletion
  authority.
- Treat an expired/missing/ambiguous feed cursor as a recovery transition: stop
  advancing that cursor, obtain a complete inventory under the vector rule, rebuild
  positive current-state evidence, and resume from the inventory's matching vector.
  If the inventory cannot complete within its page/request/byte/time budget, leave
  the client checkpoint unchanged and return a typed incomplete result. Never
  convert an empty or partial listing into an empty vault or delete event.
- One complete attempt may issue at most 200 list calls (the 10,000-object ceiling
  at 50 results per page) and returns at most 10,000 head entries or 16 MiB of UTF-8
  serialized inventory evidence, whichever limit is reached first. Exceeding either
  bound returns `inventory_limit_exceeded` with no entries or absence conclusions.
- Stage 1 uses 10,000 synthetic current objects as the initial inventory ceiling,
  with streaming metadata pages and no content-body or whole-object buffering.
  Exceeding the ceiling returns `inventory_limit_exceeded`; it does not truncate
  silently. The adapter streams listing metadata and never reads or buffers content bodies. The
  existing 1 MiB object limit remains in force. Worker runtime limits bound elapsed
  work; exact CPU and duration must be measured in local workerd before implementation
  completion. No deployed or mobile performance claim follows from this synthetic
  ceiling.

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
   bounded pagination, no skipped committed record across cursor continuation,
   explicit cursor expiry, and no success page for invalid/future/expired cursors.
5. Inventory tests prove the 50-object page bound, the 10,000-object ceiling,
   the 16 MiB result limit, streaming behavior, start/end vector equality,
   invalidation on concurrent writes or pending operations, one-attempt bounds,
   and that incomplete scans never produce absence/deletion evidence.
6. Recovery tests inject failure after every journal/current/event/head persistence
   boundary; retry either commits the exact same operation, records a safe abort, or
   remains blocked as `effect_unknown`. No failure path loses both recovery and
   current evidence.
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
