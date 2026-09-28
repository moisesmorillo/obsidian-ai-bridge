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
- An `InventoryId` is an immutable UUIDv4 generated once per scan and reused for
  retries/resumption. It identifies durable progress only; it is not authorization,
  a revision, or deletion authority. Reuse with a different vault/scan request fails.
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
  | Active inventory scan or empty slot | `inventories/active.json` |
  | Inventory scan manifest | `inventories/scans/<inventory-id>/manifest.json` |
  | Immutable inventory evidence chunk | `inventories/scans/<inventory-id>/chunks/<step>.json` |

  Sequences are unsigned 20-digit decimal strings, start at
  `00000000000000000001`, and compare lexicographically. They are not JSON numbers,
  avoiding loss of integer precision in JavaScript. Exhausting
  `99999999999999999999` returns `sequence_exhausted`; a sequence must never wrap or
  be reused.

  The vault marker uses create-only semantics and contains only its schema version,
  protocol major, and matching `VaultId`. M7 has no production vault-provisioning
  entry point; isolated tests seed the marker through a test fixture. Resumable
  inventory checkpoints and evidence chunks are persisted only below the inventory
  prefix and expire after 24 hours. Listing is restricted to `heads/`; feed and
  immutable bodies are never mixed into current-state inventory.
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
  conditional tombstone, immutable-version/recovery reads, bounded inventory start,
  continuation and evidence paging, incremental changes, and resuming an operation by
  its stable operation ID. It
  does not expose generic bucket access or permanent object deletion.
- The port has one typed method per operation: `readCurrent`, `mutate`,
  `readVersion`, `readRecovery`, `readChanges`, `startInventory`,
  `continueInventory`, `readInventoryPage`, and `resumeOperation`.
  Every input carries a validated `VaultId`; path-bearing inputs use `NotePath`;
  `mutate` takes the closed create/update/tombstone union and returns the exact
  resulting `SyncRevision`, operation ID, and committed feed position. Read methods
  distinguish never-seen absence, live head, and tombstone. `readChanges` returns one
  bounded feed page. Each inventory call performs one bounded scan step and returns
  either a typed `inventory_in_progress` state with an `InventoryId` and optional
  `retryAfterEpochMs`, a complete snapshot handle, or a typed failure.
  `readInventoryPage` is available only for a complete snapshot; a partial scan is
  never exposed as a complete inventory. Neither method exposes R2 cursors or adapter
  metadata. The port
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
  `inventory_limit_exceeded`, `inventory_expired`, `inventory_id_reused`,
  `sequence_exhausted`, `storage_throttled`, `operation_pending`, `effect_unknown`,
  and `storage_unavailable`. `inventory_in_progress` is a progress result, not an
  error; it carries the stable scan ID and optional `retryAfterEpochMs`; when present,
  that is the earliest safe resume time for a known R2 cooldown. Budget deferral without
  a known delay omits the time. `storage_throttled` means a known R2 rate-limit refusal
  when no durable operation/scan can be resumed; it includes
  `retryAfterEpochMs`. Once a mutation journal exists, an incomplete mutation returns
  `operation_pending` with its operation ID and the same field. A resumable inventory
  preserves its manifest and returns `inventory_in_progress`; an unavailable R2
  list/head read after the manifest was read returns `storage_unavailable` with the
  same `InventoryId` and preserves the saved cursor for same-ID retry. If the
  manifest cannot be read, return `storage_unavailable` with the requested scan ID;
  never create a replacement scan or infer absence. An uncertain progress write
  returns `effect_unknown` until exact read-back resolves it. Terminal scan failures
  return the relevant inventory error and never expose a complete handle.
  `retryAfterEpochMs` is the earliest safe time to retry or resume in Unix epoch
  milliseconds. `effect_unknown` means exact read-back could not establish whether a
  durable step occurred; it includes the earliest safe `retryAfterEpochMs` when a
  write outcome is uncertain. Malformed input is rejected at the protocol/core
  boundary before adapter calls. These are domain results, not HTTP status codes;
  later transport adapters define their own mapping without changing M7 storage
  semantics.
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
- Inventory is a resumable scan identified by a stable protocol `InventoryId`, scoped
  to one `VaultId`. `startInventory` creates or resumes that exact scan;
  `continueInventory` performs exactly one bounded Worker step. Only one non-expired
  scan may be active per vault, fenced by exact-CAS `inventories/active.json`. A
  competing start returns `inventory_in_progress` with the active scan ID; it cannot
  replace or adopt another scan. The active-slot record is a mutable `empty` or
  `active(InventoryId)` value. Claim and release it only with create-only or exact-ETag
  conditional writes; release replaces the matching active value with `empty` and never
  deletes the slot object. An expired slot can be replaced only after exact-read
  validation of the referenced manifest's expiry and exact CAS against the slot ETag.
  The core sees the `InventoryId` and typed progress, never the R2 cursor.
- The R2-only scan manifest is capped at `MAX_INVENTORY_MANIFEST_BYTES = 8,192` and
  records schema, vault/scan IDs, phase, start lane vector, exact opaque R2 cursor
  (maximum `MAX_INVENTORY_CURSOR_BYTES = 4,096` UTF-8 bytes), last lexicographic key,
  empty-page count, next step number, logical page/head counts, actual R2 LIST/head-GET
  attempt counts, unique/read body-byte totals, evidence-byte total, immutable chunk
  count/hash chain, the current step's reserved attempt number, and a server-time
  expiry 24 hours after start. If an R2 cursor exceeds its cap, fail
  with `inventory_limit_exceeded` before advancing progress. The manifest uses exact
  ETag CAS. Each immutable evidence chunk contains at most 300 validated head summaries
  and 2 MiB serialized
  evidence, is create-only, and is keyed by the monotonically increasing step number.
  A chunk records its step number, previous chunk hash, and for each list page ordered
  input/output cursor digests, the `truncated` result, and validated head summaries.
  Each page transcript has a canonical serialized limit of 256 bytes; its cursor
  digests are SHA-256 hex, never the raw cursor. The evidence-byte total includes each
  unique transcript, head summary, chunk envelope, and hash-chain field exactly once.
  The remaining serialized chunk envelope (including fixed metadata and hash fields,
  excluding transcripts and summaries) is capped at 1,024 bytes per chunk.
  Hash each chunk as SHA-256 over its exact strict-canonical UTF-8 JSON bytes; the
  manifest CAS advances the rolling hash only after the chunk is read back and
  validated. Only the manifest stores the opaque continuation cursor. Inventory
  metadata never enters note data, feed events, or client sync checkpoints.
- `startInventory` first creates an exact-request `starting` manifest, then claims
  `inventories/active.json` with exact CAS. It captures the 64 lane heads and pending
  markers and changes the manifest to `scanning` with the start vector only if no lane
  is pending. A retry with the same ID resumes the recorded phase; a different active
  scan cannot be adopted. If start-vector capture finds a pending lane, mark this scan
  failed and replace only its own active-slot value with `empty` by exact CAS. An
  interruption retains the manifest/slot for the same-ID retry. Each continuation step follows at
  most six R2 listing pages under `heads/`, requesting at most 50 objects per page,
  and performs one bounded GET for every listed head (at most 300 head GETs per step).
  R2 may return fewer objects than requested; page length is never a completion signal.
  Follow the exact opaque R2 cursor whenever `truncated` is true and stop listing
  only when it is false. Every truncated page must include a cursor different from its
  input cursor.
  Empty truncated pages are allowed but counted; cap them at 10,000 per scan. Require
  listed keys to be strictly increasing lexicographically across all pages (R2's
  documented order); a repeated key, out-of-order key, or missing/repeated cursor is
  `inventory_incomplete`. Exceeding the empty-page ceiling is
  `inventory_limit_exceeded`, preventing a no-progress scan from completing.
- For each listed key, the bounded GET body (maximum
  `MAX_SYNC_HEAD_RECORD_BYTES = 2,048`) supplies its validated `SyncRevision` and
  live/tombstone state. Store the canonical path in the strict head schema as its
  base64url `pathKey`, not an escaped display string, to keep the bound sufficient for
  every allowed 720-byte path. Listing metadata, timestamps, and list ETags are not
  revision evidence. Validate the vault prefix and canonical encoded `NotePath` against
  the strict body. Missing/malformed/key-mismatched heads return `inventory_incomplete`.
  Never fetch immutable version/content bodies. Each continuation writes an
  immutable chunk first, then advances the exact-CAS manifest to the returned R2
  cursor and new counts/hash chain. An R2 list/head-read throttle after the manifest is
  read returns `inventory_in_progress` with the same `InventoryId` and saved cursor;
  include `retryAfterEpochMs` when R2 supplies a cooldown. The caller resumes that ID
  without advancing the cursor. An unavailable list/head read returns
  `storage_unavailable` with that ID and the saved cursor; resume it when storage is
  available. Neither condition advances progress. If a progress write itself has
  uncertain effect, return
  `effect_unknown` until exact read-back resolves it. If interrupted after chunk
  creation but before manifest advance, resume the same input cursor and step: verify
  the existing chunk matches every page's cursor digests, `truncated` value, key order,
  and head evidence before advancing. Before any R2 LIST or head GET for a step, persist
  by exact-CAS reservation that this is attempt one or two for that step; charge it
  against the
  total attempt ceilings even if the invocation is interrupted. If attempt one ends
  before a verifiable chunk exists, resume may reserve attempt two after the same-key
  cooldown. A verified existing chunk is read and advanced without repeating its list
  or head requests. If attempt two ends without a verifiable chunk, fail the scan with
  `inventory_limit_exceeded`; never issue a third data-read attempt for that step. A
  different chunk, divergent manifest, or unprovable write returns
  `effect_unknown`/`inventory_incomplete` and the scan cannot complete. A terminal
  `inventory_incomplete` marks the scan failed and attempts to replace only its own
  active-slot value with `empty` by exact CAS; if either write is throttled or uncertain,
  retain the slot until recovery proves its state. Resolve a lost manifest-CAS response
  by rereading the manifest; never overwrite a newer step. R2 write pacing and cooldowns
  for scan manifests/chunks follow the same-key CAS rules above. In particular, every
  repeated write to the manifest or active slot—including `starting` to `scanning`,
  attempt reservation to progress, completion/failure, and slot release—must respect
  that object's 1,100 ms cooldown. If it has not elapsed, return
  `inventory_in_progress` with `retryAfterEpochMs` without sleeping or issuing the
  write; preserve the reserved attempt and any verified chunk so the same scan can
  resume without repeating data reads. A cooldown deferral does not consume another
  read attempt. Apply the same rule to create-only chunk retries; never replace a
  chunk whose prior create effect is uncertain.
- Every M7 inventory Worker invocation—including start, continuation, finalization,
  evidence paging, and scratch cleanup—counts each R2 LIST, GET, conditional/create-only
  write, and read-back as one internal-service subrequest. The protocol constant
  `MAX_INVENTORY_SUBREQUESTS_PER_INVOCATION = 400` includes all inventory reads,
  writes, recovery read-backs, and any other internal-service calls composed into that
  request. A listing step uses at most six
  LIST calls and 300 head GETs (306); reserve the remaining 94 for manifest/active-slot/
  chunk operations and bounded recovery reads. Start/final-vector steps use at most
  128 lane-head and pending-marker reads, with all manifest/active-slot calls inside
  the same 400 total. Before each call, reserve budget for its worst-case required
  persistence/read-back; defer work rather than crossing the cap. This leaves at least
  600 of Workers Free's 1,000 internal-service subrequests for unrelated work. M7 is
  uncomposed; a later caller must include its own calls in the platform's 1,000 limit
  and not invoke an inventory step unless the combined request fits. Evidence paging
  reads at most 300 chunks and returns at most 100 head summaries in one invocation;
  if the chunk bound is reached first, it returns a continuation cursor without
  advancing the scan. A step deferred for budget returns `inventory_in_progress`
  without advancing the saved cursor.
- Each listing step validates its complete R2 response, any listed head bodies, and
  its immutable evidence chunk before advancing the manifest's rolling chunk hash and
  progress with exact CAS. On resume, an existing step chunk is revalidated against
  the repeated list responses before that CAS. Once `truncated: false` is durably
  recorded, a separate bounded finalization step reads all 64 lane heads and pending
  markers again. A scan is complete only when no lane is pending and the final vector
  exactly equals the saved start vector. Because every mutation reserves and commits
  a monotonic lane sequence, equality proves no committed mutation crossed the entire
  multi-invocation listing interval. Persist the complete manifest by exact CAS, then
  replace this scan's active-slot value with `empty` by exact CAS. Return the complete
  handle only after both states are read-back verified; if slot release is deferred or
  uncertain, return progress or `effect_unknown` and resume the same scan ID. A retry
  that finds a complete manifest finishes only this exact slot release before exposing
  the handle. Immutable chunks are validated in sequence as evidence pages are read;
  each head summary is at most 1,536 canonical JSON bytes, and the page cursor carries
  the prior chunk hash and offset. The final page must reach
  the complete handle's root and count. Otherwise mark/fail the scan as
  `inventory_incomplete`; no partial chunks or intermediate progress can establish
  absence or authorize deletion.
- `continueInventory` returns a typed `inventory_in_progress` status and optional
  retry time until complete, or a `CompleteInventory` handle containing the stable
  generation vector, final entry count, chunk count, and hash-chain root.
  `readInventoryPage` is permitted only after manifest state is complete. It returns
  at most 100 head summaries per call; if the 300-chunk bound is reached first, it
  returns the opaque continuation cursor rather than implying completion. The cursor
  contains the scan ID, snapshot root, next chunk/entry offset, and prior chunk hash.
  Pages are contiguous and strictly ordered; each is bound to the handle's vault, scan
  ID, vector, and root. An empty page with a continuation cursor is progress, not an
  empty inventory. Only an explicit final marker after consuming every contiguous page
  and verifying total count/root proves the complete snapshot. A missing/changed chunk
  or invalid page cursor returns typed failure and no absence evidence. M7 inventory
  remains reporting/recovery evidence and never grants deletion authority.
- The logical listing-page ceiling is `MAX_INVENTORY_LIST_PAGES = 20,001` (at most
  10,000 non-empty pages, 10,000 empty truncated pages, and one terminal page), with
  at most two persisted read attempts per step. Thus `MAX_INVENTORY_LIST_CALLS =
  40,002` counts actual R2 LIST subrequests including the single replay allowance.
  `MAX_INVENTORY_HEADS = 10,000` counts unique validated heads, while
  `MAX_INVENTORY_HEAD_GET_CALLS = 20,000` counts actual head-body GETs including one
  replay per head. A no-interruption scan uses at most one LIST and one head GET per
  page/key; interruption replay consumes the additional fixed allowance. The manifest
  attempt reservation is durable before those calls, so repeated interruption cannot
  evade the ceilings. Exceeding them fails closed with `inventory_limit_exceeded`.
  Also cap `MAX_INVENTORY_HEAD_BODY_BYTES = 20 MiB` of unique validated head bodies,
  `MAX_INVENTORY_HEAD_READ_BYTES = 40 MiB` across actual GET responses, and
  `MAX_INVENTORY_EVIDENCE_BYTES = 24 MiB` serialized unique evidence and
  `MAX_INVENTORY_STEP_CHUNKS = 3,334` (the ceiling of 20,001 logical pages divided by
  six).
  At all maxima, 10,000 summaries use 15,360,000 bytes, 20,001 page transcripts use
  5,120,256 bytes, and 3,334 chunk envelopes use at most 3,414,016 bytes: 23,894,272
  bytes total, below 24 MiB. The 1,536-byte per-head summary cap and 2,048-byte body cap
  permit all 10,000 maximum-sized heads within their cumulative byte ceilings.
  This permits a 10,000-head scan when each nonterminal page returns only one new key
  and up to one empty truncated page per head; it is a bound, not a guarantee that R2
  will return a particular number of objects per call. Exceeding any total ceiling before
  `truncated: false` returns `inventory_limit_exceeded`, with no complete handle or
  absence conclusions. This is terminal: mark the manifest failed and replace only its
  own active-slot value with `empty` by exact CAS. If that write is throttled or
  uncertain, retain the slot until recovery proves its state. A scan past its 24-hour expiry returns
  `inventory_expired`; restart uses a new `InventoryId`. Typed `storage_throttled`,
  `storage_unavailable`, `inventory_incomplete`, and `effect_unknown` outcomes preserve
  no false completion.
  Expired scratch manifests/chunks are reaped only within the inventory prefix by a
  cleanup pass capped at 400 internal-service subrequests per invocation, including
  replacing only an expired or terminally failed scan's active-slot value with `empty`
  by exact CAS; feed, current heads, versions, and recovery objects are never cleanup
  targets.
- Treat an expired/missing/ambiguous feed cursor as a recovery transition: keep the
  client checkpoint unchanged, start or resume inventory by `InventoryId`, and publish
  the recovered checkpoint only after the complete handle and all evidence pages have
  been consumed. Any failed/expired scan restarts from the beginning; partial chunks
  never become an empty vault or deletion signal.
- Stage 1 uses 10,000 synthetic current objects as the initial inventory ceiling.
  Each invocation stays under the Free-plan-safe subrequest budget; the implementation
  measures total elapsed time, CPU, and memory across resumptions in local workerd.
  The existing 1 MiB object limit remains in force for mutation/content reads, not
  inventory head reads. No deployed or mobile performance claim follows from this
  synthetic ceiling.

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
  effect certainty returns `effect_unknown`. Read/list throttling during a persisted
  inventory returns `inventory_in_progress` with `retryAfterEpochMs`; without durable
  progress it returns `storage_throttled`. Neither outcome advances a cursor or returns
  partial inventory evidence.

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
   inputs/results, resumable inventory/feed/recovery contracts, operation state
   transitions, deterministic in-memory fake, and state-matrix tests. Core has no
   R2/Worker/HTTP dependency.
3. **M7.3 — Isolated R2 primitives:** version/current/recovery key persistence,
   inventory manifest/chunk persistence, create-only/exact-generation CAS, strong
   read-back, and prefix-isolation tests against local workerd. Existing v2 objects
   remain untouched.
4. **M7.4 — Feed, inventory, and crash recovery:** lane sequencing, operation journal,
   committed cursor reads, 30-day minimum retention/expiry, resumable stable-vector
   inventory and evidence paging, pending-operation recovery, bounded replay, and
   every crash/race scenario against local workerd. This PR must not add or mount
   public routes.

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
   body's GET (not list metadata). Ten thousand maximum-sized valid head bodies and
   summaries remain within their aggregate byte ceilings. A worst-case 10,000-head
   scan with one new head per nonterminal list page and up to 10,000 cursor-advancing
   empty pages completes across persisted steps within 20,001 logical list pages,
   40,002 actual LIST calls including one replay per step, 10,000 unique heads, and
   20,000 head GET calls including replay. It does not exceed 400 internal-service
   subrequests in any invocation under the Workers Free limit. Assert each step's exact
   subrequest count, 24-hour expiry, per-step and total ceilings, and that no plan tier
   or raised quota is assumed. Verify same-key inventory-manifest and active-slot
   cooldowns defer transitions across invocations without sleeping or consuming another
   read attempt, including resumption after a chunk is durable but manifest advancement
   is deferred. Inject interruption after initial manifest creation, active-slot claim,
   start-vector capture, list/head reads, immutable chunk create, manifest CAS,
   final-vector read, completion, slot release, and cleanup. Scan interruptions resume
   the same `InventoryId` without skips, duplicate evidence, or false completion; cleanup
   interruption remains limited to eligible inventory artifacts. Prove a persisted
   per-step attempt budget permits one interrupted read attempt and rejects a second
   interrupted attempt without exceeding actual LIST/GET ceilings. Test the per-page
   transcript and per-chunk envelope byte caps, including the maximum aggregate-evidence
   arithmetic. A changed generation or pending lane invalidates the scan.
   Verify `readInventoryPage` rejects pending/failed scans, reads at most 300 chunks and
   returns at most 100 entries per call, and treats an empty continuation page as
   progress; only the terminal marker and verified root/count finish paging. No
   individual page or incomplete chunk chain can establish absence. Assert scan,
   evidence-page, and cleanup invocations remain within 400 internal-service
   subrequests, including recovery reads. Exhausting a total budget, malformed or
   non-advancing cursor, missing/malformed head, throttle, and unavailable storage each
   produce the specified typed outcome with no complete handle; unavailable list/head
   reads retain the same scan ID and cursor for retry. Cover cleanup restricted
   to expired inventory artifacts and preserve all note/feed/version data.
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
- [Cloudflare Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Workers R2 API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Cloudflare R2 platform limits](https://developers.cloudflare.com/r2/platform/limits/)
- [Cloudflare R2 Unicode interoperability](https://developers.cloudflare.com/r2/reference/unicode-interoperability/)
