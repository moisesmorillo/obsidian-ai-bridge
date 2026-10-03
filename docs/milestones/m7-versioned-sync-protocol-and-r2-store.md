# M7 — Versioned sync protocol and isolated R2 store

## Status

**NEXT — M7.1/M7.2 are complete; M7.3's isolated R2 primitives merged in
PR #95. M7.4's private implementation is locally validated in this unmerged
feature PR; remote Workers Free/account qualification and maximal real-head
profiling remain pending.** This milestone
establishes a versioned, storage-independent sync contract and its isolated R2
implementation. It does not enable synchronization, change the current writer,
migrate data, or authorize a personal-vault cutover. Branch evidence becomes a
canonical milestone transition only when its PR merges.

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

M7.1 began with protocol contracts and tests; M7.2 added the core port. The owner
explicitly authorized one M7.3 PR despite the usual change-size limits: nine
production files and 2,457 net production lines, reviewed as separate work-unit
commits. This exception does not extend to M7.4 or unrelated changes. Dependencies
and acceptance evidence are listed below.

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
  request returns `operation_id_reused`. The initial `unallocated` pending journal
  binds its exact request and path-derived lane but has **no** sequence, predecessor
  clock, feed position, or authority to write a version, head, or event. Pending
  journals are a strict discriminated union: `unallocated` holds the exact current
  lane-head key, observed generation ETag, complete canonical prior bytes and
  `uploaded` timestamp (or verified absence before initial lane-head creation),
  plus the known retry floor; `allocated` alone holds the won sequence, predecessor
  clock, and subsequent step evidence. A missing lane-head ETag cannot authorize
  reservation. If the lane-head key is initially absent, create/read back the
  zero-sequence unreserved head first; its original ETag must be persisted in the
  unallocated journal before attempting reservation. This initialization is not
  a claim of sequence one. Before a journal is admitted, the adapter revalidates its
  exact lane observation. If journal creation is definitely refused and exact journal
  read-back proves the operation key absent, return `mutation_not_admitted` with the
  stable operation ID. This guarantees no journal, reservation, sequence, current-head,
  or feed-event effect for that request; zero-lane initialization may have occurred.
  It has no `retryAfterEpochMs` or implied wait floor. The caller must resubmit the
  identical full mutation request and operation ID through `mutate` once lane state
  permits; `resumeOperation` cannot apply without a journal. Do not retry automatically
  or loop within the invocation. If read-back is unavailable or divergent, retain
  `effect_unknown`; if the exact journal appears, join it, and reject a different
  request bound to that operation ID. The owner chose this immediate result over a
  bounded automatic attempt to avoid additional R2 reads and CPU at the cost of an
  extra caller round trip. The lane head contains the committed sequence and either no
  pending reservation or exactly one pending operation with its reserved next sequence. A successful exact-head CAS against the precondition durably
  recorded in the unallocated journal creates that operation-owned lane
  reservation; its candidate next sequence and predecessor clock are derived
  only from those exact observed prior bytes. Only exact read-back of a pending
  marker matching this operation ID, candidate lane/sequence, and predecessor
  clock authorizes the one-way exact-CAS journal transition from `unallocated`
  to `allocated`. Concurrent same-ID callers may join the already allocated
  journal only after its complete typed body and pending marker agree; an older
  unallocated observation cannot overwrite a newer journal generation.
  This transition may be delayed by the journal's same-key cooldown. If it is
  interrupted, the lane head's exact pending operation ID, lane, next sequence,
  and predecessor committed clock reconstruct the allocation for the same exact
  journal request; conflicting or unavailable evidence remains `effect_unknown`
  and retains the lane blocker. A journal cannot claim another operation's pending
  marker or invent a sequence from an absent/failed lane read.
  A concurrent different-operation reservation that definitively loses its lane
  CAS remains `unallocated`: it publishes **no** abort event at the winner's
  sequence and performs no current-head effect. While another operation owns the
  lane, return `operation_pending` with the loser's stable operation ID. After the
  winner commits/releases its lane and exact read-back proves the loser's previous
  CAS did not reserve it, a fresh unreserved lane-head observation may replace
  only that loser's still-unallocated prior observation by exact journal CAS
  (respecting journal cooldown), then start a **new** reservation attempt at the
  then-current next sequence. An uncertain old CAS with unchanged prior bytes/ETag
  may be retried only with that original condition after the cooldown; a missing,
  conflicting, or unavailable read-back cannot rebase the journal observation.
  A refused/changed lane predicate is not a refreshed CAS retry of the same step:
  the proven losing attempt ends before the next observation is durably recorded.
  This does not refresh a stale current-head mutation predicate; those remain
  fenced. A same-ID duplicate joins its exact journal and may adopt only its own
  verified pending lane marker. Sequence exhaustion before allocation returns
  `sequence_exhausted` without inventing a feed event; the journal remains bound to
  its exact request. No local lock or R2 LIST decides allocation. The write order
  is: create unallocated journal, reserve the next lane sequence with exact-head
  CAS, durably bind that allocation to the journal, create and verify immutable version/content
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
  `mutation_not_admitted`, `cursor_expired`, `invalid_cursor`, `inventory_incomplete`,
  `inventory_limit_exceeded`, `inventory_expired`, `inventory_id_reused`,
  `sequence_exhausted`, `storage_throttled`, `operation_pending`, `effect_unknown`,
  and `storage_unavailable`. `mutation_not_admitted` includes the original operation
  ID, has no retry floor, and requires resending the complete identical mutation
  request through `mutate`; it is not resumable by operation ID alone.
  `inventory_in_progress` is a progress result, not an
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
- The historical schema-v1 R2-only scan manifest is capped at
  `MAX_INVENTORY_MANIFEST_BYTES = 8,192`; new scans require strict schema v2 and
  its 9,216-byte cap under the corrective contract below. The manifest records
  schema, vault/scan IDs, phase, start lane vector, exact opaque R2 cursor
  (maximum `MAX_INVENTORY_CURSOR_BYTES = 4,096` UTF-8 bytes, stored as unpadded
  base64url), last lexicographic key, empty-page count, next step number, logical
  page/head counts, actual R2 LIST/head-GET attempt counts, unique/read body-byte totals,
  evidence-byte total, immutable chunk count/hash chain, current step's reserved attempt
  number, and a server-time expiry 24 hours after start. Its encoded cursor is at most
  5,462 bytes. The historical claim that all other v1 fields necessarily fit
  the remaining 2,730 bytes is false at simultaneous maxima (measured 8,528
  bytes overall); the strict v2 cap and maximal-field regression fix this
  discrepancy without relaxing historical v1 decoding. An R2 cursor above the cap fails with `inventory_limit_exceeded` before progress
  advances. The manifest uses exact ETag CAS. Each immutable evidence chunk contains
  exactly one complete R2 list-page result, at most one validated head summary, and at
  most `MAX_INVENTORY_CHUNK_BYTES = 12 KiB` serialized evidence; it is create-only and
  keyed by the monotonically increasing step number. A chunk records its step number,
  previous chunk hash, input/output cursor digests, `truncated`, and the validated head
  summary. It stores the exact output cursor bytes as unpadded base64url (or `null` for a
  terminal page) so recovery can advance without repeating R2 reads. Each page transcript
  has a canonical serialized limit of 256 bytes; cursor digests are SHA-256 hex, never raw
  cursor values. Evidence-byte accounting includes each unique transcript, summary,
  envelope, and hash-chain field exactly once. The serialized chunk envelope (fixed
  metadata, hash fields, and encoded output cursor, excluding transcript and summary) is
  capped at `MAX_INVENTORY_CHUNK_ENVELOPE_BYTES = 8,192`: at most 5,462 bytes for unpadded
  base64url encoding of the 4,096-byte cursor plus 2,730 bytes for all other fields and
  canonical JSON syntax. The ≤256-byte transcript is strict canonical JSON with
  `objectCount` (zero or one), `keySha256` (null for empty, otherwise SHA-256 of the
  entire canonical listed head key), `headBodyBytes` (zero for empty, otherwise the
  exact validated head response byte length), and `truncated`. Replay reconstructs
  the key from the linked head summary's canonical `pathKey`, verifies its digest
  and ordering against the manifest, and verifies the transcript against the chunk's
  head and cursor evidence; no untrusted R2 list metadata supplies a revision.
  Hash each chunk as SHA-256 over its exact strict-canonical UTF-8
  JSON bytes; the manifest CAS advances the rolling hash only after the chunk is read
  back and validated. The manifest is the authoritative continuation cursor; the chunk's
  cursor is private recovery evidence. Neither cursor enters core, note data, feed events,
  or client sync checkpoints.
- `startInventory` first creates an exact-request `starting` manifest, then claims
  `inventories/active.json` with exact CAS. It captures the 64 lane heads and pending
  markers and changes the manifest to `scanning` with the start vector only if no lane
  is pending. A retry with the same ID resumes the recorded phase; a different active
  scan cannot be adopted. If start-vector capture finds a pending lane, mark this scan
  failed and replace only its own active-slot value with `empty` by exact CAS. An
  interruption retains the manifest/slot for the same-ID retry. Each continuation
  step processes exactly one complete R2 listing page under `heads/`, using
  `MAX_INVENTORY_LIST_PAGES_PER_STEP = 1` and `MAX_INVENTORY_LIST_LIMIT = 1`, and performs
  at most one bounded GET for its head body. No step commits a partial page. R2 may
  return fewer objects than requested, including zero; page length is never a completion
  signal.
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
  `effect_unknown` until exact read-back resolves it. Persist the data-read attempt
  reservation by exact CAS before issuing the page's LIST or head GET. Each step allows
  at most two such attempts, counting interruptions and failed reads. Preflight
  subrequest/CPU deferral occurs before reservation and spends none. If execution stops
  after an attempt reservation, resume the same step and input cursor by first reading
  its deterministic chunk key. That recovery read is not a data-read attempt but counts
  against the invocation subrequest budget. If a chunk exists, it is the sole
  authoritative replay evidence: do not repeat LIST/head GET. Read and validate the
  exact chunk bytes, canonical hash, prior root, step, input-cursor digest against the
  manifest, page transcript, `truncated` flag, strict key order, head schema, counts and
  bytes, and output-cursor digest against the exact cursor stored in that chunk. Then
  advance the manifest by exact CAS from that stored cursor. A terminal transcript must
  have `truncated: false` and a `null` output cursor; a truncated transcript must have
  an advancing cursor. An unavailable read-back after a possible chunk write returns
  `effect_unknown` and retains the scan for same-ID recovery; do not issue another
  LIST/head GET or release the active slot until the write is resolved. A present but
  altered, conflicting, or invalid chunk fails as `inventory_incomplete`. Neither case advances
  the manifest. If the chunk is absent and only attempt one was reserved, reserve
  attempt two by exact CAS after the cooldown, then issue the same LIST/head reads from
  the saved input cursor. If attempt two ends and an exact chunk-key read proves no
  verifiable chunk exists, fail the scan with `inventory_limit_exceeded`; never issue a
  third data-read attempt for that step. A divergent manifest or uncertain progress write
  returns `effect_unknown`; the scan cannot complete. A deterministic post-reservation
  LIST/head failure first writes a strict **schema-v2 failure latch** create-only at
  that step's existing canonical chunk key. It contains only scan identity, step,
  preceding root and closed `inventory_incomplete`/`inventory_limit_exceeded` reason;
  it is not a v1 page transcript and never authorizes cursor, counter or complete
  evidence advancement. The failed manifest CAS uses an exact reread matching the
  entire just-reserved manifest bytes, not the stale pre-reservation ETag or an
  adopted peer generation. If the manifest cooldown defers failure, same-ID replay
  reads the latch and retries only the failure CAS, never the LIST/head GET. A lost
  latch write/read-back or competing manifest retains `effect_unknown`; no slot is
  released from uncertain failure evidence. Historical v1 page decoding remains
  unchanged. The latch shares the existing chunk count, key and 12-KiB body ceiling;
  cleanup already recognizes that canonical scratch key, so no new namespace or
  account admission claim is introduced. A terminal `inventory_incomplete` marks
  the scan failed and attempts to replace only its own
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
  request. A listing step uses one LIST and at most one head GET; reserve the remaining
  398 for manifest/active-slot/chunk operations and bounded recovery reads.
  Start/final-vector steps use at most 128 lane-head and pending-marker reads, with all
  manifest/active-slot calls inside
  the same 400 total. Before each call, reserve budget for its worst-case required
  persistence/read-back; defer work rather than crossing the cap. If the invocation
  cannot reserve subrequest and CPU budget for a full one-page step (including one
  possible head GET and its persistence/read-back), return `inventory_in_progress`
  before reserving a read attempt. Do not commit a partial page. If runtime termination
  occurs after reservation, the attempt is charged and the bounded replay rule applies.
  This leaves at least 600 of Workers Free's 1,000 internal-service subrequests for
  unrelated work. M7 is uncomposed; a later caller must include its own calls in the
  platform's 1,000 limit
  and not invoke an inventory step unless the combined request fits. Evidence paging
  reads at most 16 chunks and returns at most 16 head summaries in one invocation;
  if the chunk bound is reached first, it returns a continuation cursor without
  advancing the scan. A step deferred for budget returns `inventory_in_progress`
  without advancing the saved cursor.
- On the first attempt, validate the complete R2 LIST response and any listed head body,
  then write the create-only step chunk. The single replay procedure above governs every
  retry: an existing chunk is validated and advances the manifest without repeating R2
  reads. Both paths advance the rolling root/cursor only by exact CAS after the complete
  page/chunk is validated. Once `truncated: false` is durably
  recorded (`cursor: null` with at least one committed chunk/page; a starting scan
  has zero pages), a separate bounded finalization step reads all 64 lane heads and
  pending markers again. A scan is complete only when no lane is pending and the final vector
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
  at most 16 head summaries per call; if the 16-chunk bound is reached first, it
  returns the opaque continuation cursor rather than implying completion. The cursor
  contains the scan ID, snapshot root, next chunk/entry offset, and prior chunk hash.
  Pages are contiguous and strictly ordered; each is bound to the handle's vault, scan
  ID, vector, and root. An empty page with a continuation cursor is progress, not an
  empty inventory. Only an explicit final marker after consuming every contiguous page
  and verifying total count/root proves the complete snapshot. A missing/changed chunk
  or invalid page cursor returns typed failure and no absence evidence. M7 inventory
  remains reporting/recovery evidence and never grants deletion authority.
- An expired scan's manifest is a permanent no-reuse tombstone, **not** a cleanup
  target. Its existing scan ID remains expired even after all chunks are removed.
  After exact expiry and active-slot evidence, an isolated cleanup capability may
  delete only canonical chunks of a historical v1 scan; v2 additionally admits
  only the canonical same-scan journal/witness scratch keys specified below.
  Delete at most one bounded object plus read-back per invocation; uncertain
  effects do not establish cleanup. When no eligible scratch remains, report
  retained-manifest status, never complete storage reclamation. R2 DELETE
  has no ETag predicate: deleting the manifest could delete a newly admitted
  same-ID generation after stale expiry proof. At most 8,192 × N1 historical
  v1 manifest body bytes plus 9,216 × N2 new v2 manifest body bytes, and R2
  key/metadata overhead, remain for N1 and N2 admitted scans; there is no
  global quota or tombstone reaper in M7. A future retention/retirement policy
  needs a separate decision and qualification before activation. See
  [ADR 0018](../decisions/0018-retain-expired-sync-inventory-manifests.md).
- The logical listing-page ceiling is `MAX_INVENTORY_LIST_PAGES = 20,001` (at most
  10,000 non-empty pages, 10,000 empty truncated pages, and one terminal page), with
  at most two persisted read attempts per step. Thus `MAX_INVENTORY_LIST_CALLS =
  40,002` counts actual R2 LIST subrequests including the single replay allowance.
  `MAX_INVENTORY_HEADS = 10,000` counts unique validated heads, while
  `MAX_INVENTORY_HEAD_GET_CALLS = 20,000` counts actual head-body GETs including one
  replay per head. Thus listing plus head-body data reads are at most 60,002 R2
  subrequests across the scan, excluding other per-invocation control/persistence calls.
  A no-interruption scan uses one LIST and at most one head GET per page/key;
  interruption replay consumes the additional fixed allowance. The manifest
  attempt reservation is durable before those calls, so repeated interruption cannot
  evade the ceilings. Exceeding them fails closed with `inventory_limit_exceeded`.
  Also cap `MAX_INVENTORY_HEAD_BODY_BYTES = 20 MiB` of unique validated head bodies,
  `MAX_INVENTORY_HEAD_READ_BYTES = 40 MiB` across actual GET responses, and
  `MAX_INVENTORY_EVIDENCE_BYTES = 192 MiB` of serialized unique evidence.
  `MAX_INVENTORY_STEP_CHUNKS = MAX_INVENTORY_LIST_PAGES = 20,001`: each complete list
  page is one step and one chunk, including short and empty truncated pages. Preflight
  CPU or subrequest deferral happens before reserving an attempt and creates no chunk;
  therefore it cannot increase the chunk bound. At all maxima, 10,000 summaries use
  15,360,000 bytes, 20,001 page transcripts use 5,120,256 bytes, and chunk envelopes
  use at most 163,848,192 bytes. The total, 184,328,448 bytes, is below 192 MiB. The
  1,536-byte summary cap and 2,048-byte body cap permit 10,000 maximum-sized heads
  within their cumulative bounds. `MAX_INVENTORY_EVIDENCE_CHUNKS_PER_CALL = 16`, so a
  single successful evidence traversal requires at most
  `MAX_INVENTORY_EVIDENCE_PAGE_CALLS = ceil(20,001 / 16) = 1,251` calls; every call,
  including an idempotent retry, remains subject to the 400-subrequest invocation cap.
  This permits a 10,000-head scan when each nonterminal page returns only one new key
  and up to one empty truncated page per head; it is a bound, not a guarantee that R2
  will return a particular number of objects per call. This is a contract bound, not a
  runtime qualification: M7 cannot exit until the Workers Free CPU gate below passes.
  Exceeding any total ceiling before `truncated: false` returns
  `inventory_limit_exceeded`, with no complete handle or
  absence conclusions. This is terminal: mark the manifest failed and replace only its
  own active-slot value with `empty` by exact CAS. If that write is throttled or
  uncertain, retain the slot until recovery proves its state. A scan past its 24-hour
  expiry returns
  `inventory_expired`; restart uses a new `InventoryId`. Typed `storage_throttled`,
  `storage_unavailable`, `inventory_incomplete`, and `effect_unknown` outcomes preserve
  no false completion.
  Expired scratch manifests/chunks are reaped only within the inventory prefix by a
  cleanup pass capped at 400 internal-service subrequests per invocation, including
  replacing only an expired or terminally failed scan's active-slot value with `empty`
  by exact CAS; feed, current heads, versions, and recovery objects are never cleanup
  targets.
### M7.4 inventory cursor-history correction (accepted for isolated local TDD)

The v1 manifest limit above is currently an **unresolved feasibility defect** for
simultaneous accepted maxima: measured maximal JSON with a 4,096-byte R2 cursor,
720-byte Markdown path and 64 maximum-width sequences is 8,528 bytes. Existing
v1 replay does not reject non-adjacent cursor cycles. The [corrective design](../plans/2026-10-02-m7-inventory-cursor-history-design.md)
and [ADR 0019](../decisions/0019-resumable-r2-inventory-cursor-witnesses.md)
were independently cleared for **isolated local TDD only** by
investigate-5eb505b68c8fa1e53b3ca98d11123244; they do not authorize
activation, deployment, remote Free qualification or M7 completion. The
version-2 manifest is strict, caps at 9,216 bytes
with a maximal fixture, and leaves historical v1 decoded only as a ≤8,192-byte
expired no-reuse tombstone: no v1 continuation, complete handle/page or inferred
upgrade. The v2 writer needs one digest-indexed immutable witness (≤384 bytes)
and exact-CAS per-step retryable journal (≤512 bytes) for every **truncated** output
cursor. An initial null input is not visited; every later truncated output must
be nonempty and never equal *any* earlier output (including non-adjacent empty
pages). Only original-generation manifest CAS after exact chunk+journal+witness
proof can advance; both fresh and replay paths must enforce it. The terminal
chunk has no new witness but completion, handle, page and slot-release paths
must inherit the fenced chain. A lost attempt-journal CAS grants no PUT authority;
only a confirmed own-UUID `attempting` generation with fresh manifest/slot/expiry
checks may dispatch one atomic create-only target PUT in that invocation. An
absent witness after a prior claim enters persisted `retry_wait`, then a fresh
UUID claim after the journal's own cooldown and a conservative target floor;
no bounded lifetime count of physical PUTs is asserted. Each dispatcher must
honor its own known response floor and every floor durably observed before its
next attempt; the transitioning journal CAS records all floors then available
to that invocation. A floor first reported after a different isolate already
dispatched cannot retroactively prohibit that PUT, and an unpersisted floor
cannot be known to a separate isolate. Uncertain CAS outcomes require exact
reconciliation; atomic create-only bytes and matching witness evidence, not
cooldown timing, prevent false completion. This clarification affects only the
inventory-witness journal, not mutation attempt floors. Late PUTs
can create only cleanup-eligible orphans under a retained expired manifest,
not a complete handle. Cleanup would additionally allow canonical expired
journal/witness keys, still **never** the manifest, with at most one DELETE and
absence read-back per invocation. Expected scratch maxima: ≤60,001 objects,
≤17,920,000 journal/witness body bytes plus key/metadata, and ≤9,216 bytes per
new permanent v2 tombstone. An analytical 32-R2-call page-step preflight and
136-start/134-final/18-evidence/8-cleanup credits must be verified against
actual adapter traces; Workers Free CPU, daily requests, R2 billing and account
retention remain separately unqualified. Implement with red/green tests for the exact transition table, byte fixtures,
crash/race paths and worst-branch counted calls. The analytically reserved
credits do **not** establish these tests, Free CPU or operational quotas; do
not claim the isolated implementation complete until they pass and receive
independent semantic review.

- Treat an expired/missing/ambiguous feed cursor as a recovery transition: keep the
  client checkpoint unchanged, start or resume inventory by `InventoryId`, and publish
  the recovered checkpoint only after the complete handle and all evidence pages have
  been consumed. Any failed/expired scan restarts from the beginning; partial chunks
  never become an empty vault or deletion signal.
- Stage 1 uses 10,000 synthetic current objects as the initial inventory ceiling.
  Each continuation requests one object per list page and performs at most one head GET;
  evidence paging reads at most 16 chunks. The implementation measures total elapsed
  time, CPU, and memory across resumptions in local workerd, but local checks do not
  establish Cloudflare CPU compliance. Workers Free allows 10 ms CPU per request.
  Before M7 can be marked complete, an explicitly authorized isolated Workers Free
  qualification must show every inventory invocation profile stays within that limit.
  If any profile exceeds it, reduce per-invocation work and recalculate page, chunk,
  evidence, and expiry bounds; do not assume Paid CPU limits or raise the quota.
  The existing 1 MiB object limit remains in force for mutation/content reads, not
  inventory head reads. No deployed or mobile performance claim follows from this
  synthetic ceiling; documentation checks and local workerd measurements alone do not
  satisfy the Free CPU qualification gate.

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
  ID and the exact CAS ETag recorded for the unfinished mutation step, and may not run
  before `retryAfterEpochMs`. It must not refresh an ETag for that step. Journal-only
  transitions are the narrow exception: the exact typed journal body and monotonic
  phase are the durable prior-state evidence. A fresh exact read of that same
  operation-bound journal may supply its current ETag only for the pending
  `commit_journal` to terminal transition or the explicitly bounded `commit_lane`
  attempt-state transitions below; it never supplies a refreshed external-step ETag.
  After an uncertain journal write, exact target read-back means done; exact prior-state
  read-back defers the invocation using its known safe floor or observation time plus
  1,100 ms, with the new floor persisted before a later write; divergent or unavailable
  evidence remains `effect_unknown`. This does not refresh lane, current-head, or
  immutable-write preconditions, whose original ETag and exact prior bytes remain
  durably recorded. Do not sleep inside a Worker request; if the lower bound has not
  passed, return the typed pending result. Another typed pending result is returned if
  R2 throttles again. Do not clear a pending lane reservation merely because it is
  throttled.
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
  record before continuing. If the initial journal create times out, exact read-back
  cannot prove a journal, and the adapter returns `effect_unknown` with the safe
  `retryAfterEpochMs` floor. The caller owns that pre-journal floor and must retain it
  across caller/isolate restarts, wait until it passes, then resubmit only the identical
  complete mutation request and operation ID through `mutate`. `resumeOperation` cannot
  recover an absent journal. No separate durable pre-journal key is created to store
  this floor: a fresh isolate cannot establish the original create's timing from absent
  R2 state. M7 does not claim enforcement against a caller that ignores the returned
  floor. The exact journal must still be read and validated before any mutation can be
  resumed. An R2 precondition refusal is resolved by read-back, never by an unconditional
  retry. R2's strong consistency supports read-back of completed writes but is not a
  multi-key transaction or proof that a still-in-flight request has been canceled.
- For throttling or uncertain effects after the lane reservation, do not report the
  mutation as successful until current-head state, immutable feed event, committed
  journal, and committed lane head are all durably verified and the feed event is
  readable. A known incomplete operation returns `operation_pending`; unresolved
  effect certainty returns `effect_unknown`. Read/list throttling during a persisted
  inventory returns `inventory_in_progress` with `retryAfterEpochMs`; without durable
  progress it returns `storage_throttled`. Neither outcome advances a cursor or returns
  partial inventory evidence.

#### Post-journal attempt authority

Every allocated journal step that can dispatch an external write—`immutable_create`,
`write_head`, `create_event`, or terminal `commit_lane`—carries a strict attempt state
inside its step evidence. A new step starts `ready` at generation zero. The first
write is authorized only after an exact journal CAS to
`attempting(claimId, generation=1, claimedAtEpochMs)`. `claimId` is a fresh UUID
created for that attempt; a retry from `retry_wait` increments the generation and
uses a fresh claim ID. Generation is scoped to the exact journaled `(step, key,
precondition)` tuple: a verified transition to the next target key starts a new tuple
at generation zero, while retries of one tuple increment its generation. Generations
are nonnegative safe integers and never wrap; if the generation cannot be safely
incremented, fail closed without a target write. The original external-step key,
target bytes, and precondition remain fixed across every attempt of that tuple.
`retryAfterEpochMs` remains the one authoritative safe floor for that key. On entry
to `create_event`, the journal fixes the monotonic `committedAtEpochMs` and closed
`outcomeIntent` (`changed` or `aborted`) before any claim or event PUT; both are
immutable for the exact step/key/precondition tuple and every retry uses the same
event bytes. The ready `immutable_create` → `create_event` shortcut is abort-only.
A changed intent requires the exact operation-owned head and linked immutable
version/body; an aborted intent requires stale-parent rejection against a
non-operation-owned head. Recovery never infers or flips intent from a re-read head,
and an observed event must match the persisted intent and timestamp.

Only the invocation that created a claim may issue that claim's one target PUT, and
only after the exact `attempting` journal bytes are confirmed. If the journal-CAS
response is uncertain, reread the exact operation journal: an exact body containing
that invocation's claim ID/generation may authorize its still-unsent target write;
exact prior state, another claim, divergent bytes, or an unavailable read does not.
A fresh invocation that finds `attempting` is a recovery reader, not the old claim
owner: it must inspect the target and must never replay the old claim directly. Before
dispatch, the owner rechecks that its exact claim remains current. No process-local
lock participates in authority.

| Persisted state / outcome | Required exact evidence | Durable transition and allowed work |
| --- | --- | --- |
| `ready` | Exact original target absence or exact original generation; both target and journal-key cooldowns have elapsed | CAS `ready` to a unique `attempting` claim, then perform at most one target PUT with the original create-only/ETag condition. If exact expected target bytes already exist without a prior attempt claim, treat the journal/target pair as divergent rather than adopting an unclaimed effect. |
| `ready` at `immutable_create` | Exact current-head evidence re-evaluates the original parent as stale; the immutable step remains at generation zero, proving no PUT was authorized for this exact target tuple | CAS directly to the canonical reserved `create_event` key with a fixed `committedAtEpochMs` strictly after the predecessor lane clock and `ready` generation zero. Do not claim or PUT the immutable target. A later event invocation re-evaluates the parent and may publish only the stale abort if it remains stale; otherwise fail closed. |
| `ready` at `write_head` | The exact journal is still `ready` at generation zero, the reserved lane still belongs to the operation, and the exact linked current head still rejects the original parent; no target claim or head PUT has occurred | A dedicated facade CAS revalidates the same journal generation, lane reservation, and exact current-head bytes before persisting only the canonical reserved `create_event` with a fixed monotonic timestamp and `ready` generation zero. Do not claim or PUT the head. A later event invocation rechecks the stale parent; changed, missing, or unavailable evidence stays blocked without publishing an event. Generic `replaceJournal` cannot take this edge. |
| `attempting` | Exact target bytes/record for nonterminal steps; for terminal `commit_lane`, exact O journal/event/current evidence and an O-or-later lane head under the visibility rule below; the attempt journal key's `uploaded + 1,100 ms` cooldown has elapsed | Persist the next journal step by exact journal CAS; for terminal `commit_lane`, return O's terminal result only after its exact terminal evidence validates with a lane clock consistent with O. Do not issue another target PUT. If the journal-key cooldown has not elapsed, return `operation_pending` and defer this transition. |
| `retry_wait` | Exact target bytes/record for nonterminal steps; for terminal `commit_lane`, exact O journal/event/current evidence and an O-or-later lane head under the visibility rule below; the attempt journal key's `uploaded + 1,100 ms` cooldown has elapsed | Persist the next journal step by exact journal CAS (or verify terminal `commit_lane` completion using O's exact journal, event, and current evidence plus a lane clock consistent with O); do not wait for the retry floor and do not issue another target PUT. If the journal-key cooldown has not elapsed, return `operation_pending` and defer this transition. |
| `attempting` | Exact original prior generation, or absence only for a step whose original precondition is create-only absence; the attempt journal key's `uploaded + 1,100 ms` cooldown has elapsed | CAS to `retry_wait`, recording this observation time and the fixed floor `max(observedAt + 1,100 ms, targetUploaded + 1,100 ms when present, known R2 response floor, prior persisted floor)`. Do not issue a target PUT in this invocation. If the journal-key cooldown has not elapsed, keep `attempting` and defer. |
| `retry_wait` | Exact original prior/valid absence; stored floor and current journal `uploaded + 1,100 ms` have elapsed | CAS to a new `attempting` generation/claim before one new target PUT. If either floor is in the future, return `operation_pending` with the earliest safe time and do not write or sleep. |
| Any state after `throttled`, `refused`, or `effect_unknown` | Exact target, exact original prior/valid absence, or unavailable/divergent read-back | Exact target advances; exact prior/absence persists `retry_wait`; unavailable/divergent evidence stays `effect_unknown`. Only the no-effect `ready` generation-zero `write_head` case above may use the dedicated stale-parent shortcut. A claimed head refusal needs the narrow private receipt exception below; other claimed-to-aborted shortcuts are refused. The event write always occurs in a later invocation. |

**Generation-one head-refusal receipt exception (isolated M7.4 only).** The
`write_head` claim owner may create one private immutable refusal receipt after
its exact first-generation claim has been confirmed and either (a) its head
preflight definitively rejects the original create-only/ETag predicate before
dispatch, or (b) its single conditional head PUT returns `null` from R2. A
later divergent read-back, lost response, 429 or exception does not qualify.
The private receipt is a *second external target PUT* allowed only on this
no-effect path; there is never a second head PUT or event PUT in that
invocation. The trusted Worker-only key family is canonical per
`(vaultId, operationId)` and create-only. Its strict versioned record (≤8,192
UTF-8 bytes) binds the exact claim ID/generation, request/journal identity,
reserved position, original head key, target digest, original absence or exact
ETag/bytes/uploaded-time precondition, typed no-dispatch or conditional-null
provenance and exact competing head observation. A visible claim ID alone does
not authenticate out-of-band forged R2 objects; deployment must restrict this
private key family to the trusted Worker binding. An existing receipt may be
adopted only on canonical byte equality; unavailable, malformed or divergent
bytes remain unknown, never absence or repair.

Receipt creation and a journal CAS are not atomic. Recovery may trust the
receipt only while the **current** pending `write_head` journal still carries
that identical generation-one `attempting` claim and immutable tuple, the lane
still reserves its sequence, and the present linked competing head exactly
matches the receipt and still makes the original parent stale. It CASes only
that observed journal generation/ETag to a fixed `create_event` aborted intent
and time after journal cooldown. A different/newer claim, `retry_wait`, a lost
CAS without exact read-back, an unavailable head or a changed competitor makes
the receipt inert; never refresh the journal ETag to adopt it. A persisted
aborted event is written in a **later** invocation after the event's own claim.
The receipt never proves that an earlier in-flight head PUT was canceled:
receipt-assisted abort is limited to generation one, with one claim owner and
one dispatched head call. A failed/uncertain receipt or storage exhaustion
retains `effect_unknown` and the lane blocker; no eventual abort guarantee is
claimed for those cases or for later generations.

For terminal operation O's `commit_lane` reconciliation, a lane head at a later
committed sequence can prove O's lane commit only after the exact typed terminal
journal for O still matches its immutable outcome, O's exact immutable event at its
reserved lane/sequence is readable and matches that outcome, and the current-head read
is available and consistent with the terminal outcome (a committed O cannot be
`never_seen`; an aborted O cannot appear as its rejected revision). The lane must be
for O's lane with `committedSequence >= O.sequence`; when equal, its committed clock
must equal O's commit time, and when greater, its committed clock must be strictly
later than O's commit time. This proves O completed before a later same-lane commit; it
does not authorize another lane PUT, refresh O's original lane ETag, or infer an absent
or unreadable event. Any failed evidence check remains `effect_unknown`.

An absent read-back is valid only when the step's persisted precondition is create-only
absence; it is not valid for terminal `commit_lane`, whose exact precondition is the
operation-owned pending lane-head generation. A failed attempt-state/floor CAS is
always exactly reread. If the prior `attempting` record remains, that invocation must
not issue the target PUT. If the journal now contains a different claim, or its bytes
are divergent/unavailable, return `effect_unknown` and preserve the lane blocker.
Never rebase a lane/current-head ETag from a later read. Target bytes for immutable
creates/events remain operation-bound and create-only.

A read of the exact prior target does not prove that an older R2 request was canceled.
A late in-flight request may still complete after `retry_wait`; every such request is
bound to the same target bytes and original ETag (or the same create-only absence), so
at most one can change that exact generation and a loser must reconcile by read-back.
The floor is a safe retry lower bound, not a cancellation lease or a claim that only
one physical request can remain in flight. A claimant paused after its final journal
check may still dispatch late after a newer resumer records `retry_wait` or a later
claim; R2 cannot atomically couple that journal check to the target-key CAS. Such a
late dispatch is safe only because every generation retains the identical target bytes
and original create-only/ETag condition, so at most one can change the target generation
and every loser reconciles by exact read-back. Rate limiting can extend the floor; no
wait-loop is permitted.

Terminal journal status is independent of lane-attempt progress. A `committed` or
`aborted` `commit_lane` record may change only its attempt substate and nondecreasing
retry floor under the transition table above. Request/payload identity, status,
revision or abort reason, position, commit time, reservation, step/key, and original
lane precondition (including exact bytes, ETag, and uploaded time) are immutable; a
terminal record can never return to `pending` or change outcome. The publication
facade must authorize these edges by rereading the same typed terminal journal and
CASing only that journal key. Exact target journal bytes mean already applied; exact
prior journal bytes may supply the current journal ETag; any other journal state is
not adoptable. This extends, but does not generalize, the existing terminal retry-floor
exception. It never refreshes the lane-head condition.

Operation journals use private `schemaVersion: 2` for this attempt-state representation;
private lane-head and event records remain at schema version 1, and all retain
`protocolMajor: 1`. A schema-v1 journal is not rehydrated with an invented `ready`
state: a legacy/unsupported journal decode is a typed unavailable/`effect_unknown`
result, never journal absence, never a new create, and never an automatic repair or
rewrite. M7's isolated store has no schema migration path; any future recovery or
cleanup of schema-v1 journals needs a separately approved transition.

The attempt protocol adds at most one external target PUT per invocation,
**except** the generation-one definite head-refusal receipt path above, which
may send one claimed head PUT and one private create-only receipt PUT but never
an event or second head PUT. A normal dispatch uses one attempt-claim journal
PUT plus that target PUT; it may use one additional journal PUT to persist a
verified next step or `retry_wait`, but does not start a second target write. Recovery of a persisted `attempting` state performs no
target PUT and at most one journal transition. With the current one-key facade,
a pending-journal CAS is estimated at up to five R2 GETs/one PUT, terminal
`commit_lane` journal CAS at up to seven GETs/one PUT, and one target write at up to
three GETs/one PUT, before operation-specific current/event/source reads. The
call-graph estimate for a worst one-step mutation invocation is about 37–41 GETs and
at most three PUTs including a proven stale-head abort-step transition; test-level
counters must confirm exact counts for live, tombstone, event, and terminal paths.
The receipt candidate adds a code-derived successful-path estimate of three
receipt-key GETs plus one PUT, and one additional journal/lane proof adds two
GETs: 42–46 GETs and no more than four PUTs when added to the earlier estimate.
This is **not a worst-case bound**. Mutation entry points must instead enforce
an invocation-scoped ceiling of **64 actual R2 internal-service calls** at the
one-key object boundary, counting marker/preflight/read-back and receipt proofs;
no call after the cap may dispatch, and exhaustion leaves the result unknown
and the lane reserved. Reserve capacity for the required write and read-back
before dispatch; never turn a truncated read-back into confirmation. Test-level
instrumentation must establish actual per-path counts and cap-exhaustion
behavior before Task 3B acceptance. Receipt storage is permanent while its
operation journal remains recoverable: at most one 8,192-byte body per
qualifying operation, adding ≤8,192 × N body bytes for N such operations
plus R2 key/metadata overhead. There is no receipt reaper or global storage
quota in isolated M7. At an account quota failure, leave the lane blocked
with `effect_unknown`; neither a cleanup claim nor eventual progress is
implicit. These are design limits, not measured runtime qualification. The accepted M7
spec has a 400-subrequest ceiling for inventory invocations and cites Workers Free's
1,000-subrequest limit; it does not define a 50-subrequest mutation limit. Do not claim
live Worker support from this arithmetic. CPU cost is unknown, and neither this
attempt path nor the 10 ms Workers Free CPU gate has been qualified by this design-only
change.

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
check`, and a semantic review before the next begins. The authorized single-PR
M7.3 size exception is recorded above; other oversized units must be subdivided
or separately approved without changing these contracts.

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
5. Inventory tests prove each step requests exactly one complete R2 list page with
   request limit one and commits one corresponding chunk, including short and empty
   pages; only `truncated: false` completes listing. Ten thousand maximum-sized valid
   heads and summaries remain within their aggregate byte ceilings. The worst-case
   10,000-head scan completes in at most 20,001 logical list pages/chunks, 40,002 LIST
   calls and 20,000 head GET calls including one replay allowance per page (60,002 data
   subrequests). One uninterrupted evidence traversal takes at most 1,251 successful
   responses at 16 chunks per call. Assert every inventory invocation, including control
   and recovery reads/writes, stays within 400 subrequests. Budget or CPU preflight
   deferral must occur before attempt reservation and consume neither an attempt nor a
   chunk. For an interrupted attempt with no verified chunk, allow exactly one
   same-step/same-cursor replay; a second interrupted attempt fails with
   `inventory_limit_exceeded` only after an exact chunk-key read proves no valid chunk
   exists. On resumption with a reserved attempt, probe that key before any data read; if
   the read is unavailable, retain `effect_unknown` without spending an attempt. If a
   chunk write remains uncertain, resolve it by read-back only; do not issue another
   LIST/head GET. If a create-only chunk exists, recovery MUST read and
   validate that exact chunk, transcript, output cursor, root, counts, and bytes, then
   CAS-advance from its persisted cursor without repeating LIST or head GET. A missing,
   corrupt, mismatched, or unprovable chunk never advances the manifest or yields a
   handle. Assert the 20,001-chunk ceiling, 20 MiB unique and 40 MiB replayed head-read
   bodies, and the 192 MiB evidence ceiling with its 184,328,448-byte calculation.
   Verify cursor/manifest/chunk caps and 24-hour expiry. Same-key manifest and active-slot
   cooldowns defer transitions across invocations without sleeping or consuming another
   data-read attempt, including chunk durability followed by deferred manifest advance.
   Inject interruption after initial manifest creation, active-slot claim, start-vector
   capture, LIST/head reads, chunk create, manifest CAS, final-vector read, completion,
   slot release, and cleanup. Resumption uses the same `InventoryId` without skipped or
   duplicate evidence or false completion; cleanup remains prefix-limited. A changed
   generation or pending lane invalidates the scan. `readInventoryPage` rejects
   pending/failed scans, reads at most 16 chunks and returns at most 16 heads per call,
   and treats an empty continuation as progress; only the terminal marker and verified
   root/count finish paging. No individual page or incomplete chunk chain establishes
   absence. Exhausted budgets, malformed/non-advancing cursors, missing/malformed heads,
   throttling, and unavailable storage produce their typed outcome without a complete
   handle; unavailable reads retain the scan ID and cursor. Cleanup affects only expired
   inventory chunks, retains every manifest as a no-reuse tombstone, and preserves
   note/feed/version data. Same-ID manifest-replacement races must not delete a new
   generation. Separately profile start,
   continuation, finalization, evidence-page, cleanup, and recovery invocation CPU on a
   separately authorized isolated Workers Free runtime. Every profile must stay within
   the current 10 ms CPU limit before M7 exits. `mise run check` and local workerd do not
   satisfy this runtime gate; if a profile exceeds the limit, reduce per-invocation work
   and recalculate all affected bounds.
6. Recovery tests inject failure after every journal/current/event/head persistence
   boundary; retry either commits the exact same operation, records a safe abort, or
   remains blocked as `operation_pending`/`effect_unknown`. For every allocated write
   step, tests cover `ready`/`attempting`/`retry_wait`, the unique claim CAS, the
   target PUT, exact target/prior/valid-absence/unavailable/divergent read-back, and
   the attempt-state/floor journal CAS across fresh facades. Race two same-ID resumers:
   only the exact claim owner may dispatch, and a lost claim/floor CAS whose exact
   reread still shows the old `attempting` state must issue no target PUT. Inject
   crashes before/after claim CAS, target PUT, and retry-floor CAS; verify journal-key
   cooldown and the late-in-flight same-target/original-ETag caveat. Schema tests reject
   schema-v1 journals without rehydration while schema-v1 lane/event records and v2
   API/data sentinels remain unchanged. In particular, race two different operation
   IDs hashing to one lane from the same observed committed
   head: only one owns its next sequence, the losing unallocated journal neither
   aborts that sequence nor mutates a head, and after verified release it claims
   the next available sequence. Interrupt after lane CAS but before journal
   allocation, then recover from the exact same-operation pending marker; missing,
   another-operation, or unavailable evidence cannot fabricate allocation. Race
   two same-ID callers as well: only the exact request may join its own journal and
   pending marker. Same-key tests cover
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

## M7.1 protocol contract evidence

M7.1 adds the isolated protocol-major-one identifiers, strict vault marker and
checkpoint schemas, fixed-width sequence and error contracts, canonical namespace
key builders, SHA-256 feed-lane selection, and canonical base64url checkpoint cursor
codec in `packages/protocol`. Focused unit coverage is in
`packages/protocol/tests/unit/sync.contracts.test.ts`.

This evidence covers the M7.1 unit only. The storage port, R2 adapter, feed replay,
inventory persistence, crash recovery, runtime qualification, and deployment remain
for their separately sequenced units. It does not alter protocol `0.1`, v2 prefixes,
M1–M6 behavior, or the milestone's activation exclusions.

| Verification | Result |
| --- | --- |
| `mise install` and `mise run install` | Passed; no dependency changes |
| Focused M7 contract tests | Passed: 11 tests |
| `mise run check` | Passed: formatting, lint, types, 1,459 tests, coverage, and builds |
| Semantic review | Passed: M7.1 only; no v2/M1–M6 behavior or activation surface changed |
| Review follow-up | Resolved: cross-vault cursor binding, canonical path-decoder reuse, exact closed-error-set assertion |

## M7.2 core port, mutation policy, and deterministic fake evidence

**M7.2 unit: COMPLETE for its core contract and test-fake scope. M7 remains NEXT; M7.3 is the next implementation unit.** The nine-method `SyncStore` port and pure `evaluateSyncMutation` policy remain in `packages/core`; no production storage adapter or activation surface was added. `packages/protocol/tests/unit/sync-store-fake.test.ts` adds a test-only in-memory fake with per-vault operation journals, per-path heads, a deterministic serialized critical section, validated UUID/path fixtures, exact UTF-8 SHA-256 hooks, a deterministic clock, and injected committed/pending/unknown effect outcomes. The test lives in protocol because that workspace already depends on core; neither the core manifest nor production core imports protocol. Mutations are decided by the Task 2 policy rather than a second copy of its transition rules.

The eleven fake cases cover per-vault operation identity (the same operation ID may independently exist in different vaults), concurrent create against never-seen and update against an exact revision, exact replay and same-vault changed-request rejection, stale-tombstone refusal, pending/unknown outcomes without success/feed advancement/never-seen claims, and preservation of exact recovery bytes. The fake's in-memory serialization is only a deterministic unit-test model: it does not prove durable or cross-key atomicity. Its `readChanges` returns a closed refusal and its inventory methods refuse completion; these methods do not implement feed pagination, inventory progress, M7.3 R2 persistence, or M7.4 crash recovery. This is not local workerd qualification.

| Verification | Result |
| --- | --- |
| `mise install` | Passed: all 44 configured tools were already installed. |
| `mise run install` | Passed: 207 installs checked across 333 packages; no reverse core-to-protocol workspace dependency is declared. |
| Focused fake (`packages/protocol/tests/unit/sync-store-fake.test.ts`) | Passed: 1 file / 11 tests. |
| Focused M7.1/M7.2 command (`sync-store-fake`, `sync-store-contract`, `sync-mutation-policy`, `sync.contracts`) | Passed: 4 files / 39 tests. |
| `mise run check` | Passed: 92 source test files / 1,487 tests; 8 local workerd storage tests; 12 plugin artifact smoke tests; typecheck, Biome, lint/TSDoc, Worker dry-run build, and plugin build/smoke passed. The Worker build exited with `--dry-run`; no deployment occurred. |
| Global coverage from `mise run check` | Passed: statements 95.05%, branches 90.72%, functions 98.45%, lines 96.96%. |
| Semantic/security review | Passed for M7.2 scope: core remains adapter-neutral; test fixtures cross the existing protocol validation boundary; exact request bytes and typed unresolved outcomes remain conservative; no production M1–M6, R2, Worker, HTTP, plugin, or activation changes. |

No personal vault or remote resource was used. M7.3 owns isolated R2 primitives; M7.4 owns durable feed/inventory/recovery algorithms and their workerd conformance. This evidence does not qualify those behaviors, change current writer behavior, or authorize sync activation. The M7 status above remains **NEXT** until every implementation unit and acceptance criterion is separately completed and merged.

## M7.3 isolated R2 primitives evidence

**Implementation verified in this branch; M7 remains NEXT.** The private Worker
`infrastructure/sync/` modules implement strict protocol-major-one persisted
records, canonical namespace keys, one-key conditional R2 operations and two
single-object facades. `sync-r2-records.ts` reads and writes marker-gated heads,
live version/content pairs and operation-bound tombstone version/recovery pairs;
it checks exact UTF-8 bytes against independent digest and size evidence, including
on a second live-content read. A tombstone's digest and size describe its retained
live parent; its version is accepted only when recovery metadata names that parent,
path, vault and deleting operation and its raw recovery body verifies. No content
object is created under the tombstone revision, and `readContent` cannot expose
one even if an unexpected object exists. `sync-r2-inventory.ts` exposes
bounded active-slot, manifest and chunk scratch operations without claiming a
complete inventory. The one-key
adapter uses create-only or the originally observed ETag, exact read-back after
successful, uncertain or conditionally refused writes, typed refusals versus
unknown effects, and a 1,100-ms same-key cooldown. A caller may carry its retry
floor across isolates; M7.4 must persist and restore it. An unavailable read-back
cannot prove a replacement failed, and no write is retried with a refreshed ETag.

| Verification | Result |
| --- | --- |
| Scope against `8870e06` | Nine Worker production files, 2,458 lines added / 1 removed (2,457 net); eight private sync modules plus the narrow existing R2 binding type adjustment. No core/protocol/plugin production or Worker app/route/composition changes. |
| Focused units and local R2 | Strict record, one-key, current/recovery and inventory tests plus 9 local workerd storage tests passed. Workerd validates conditional primitives and v2-prefix noninterference, not live Cloudflare throttling or CPU. |
| `mise install`, `mise run install` | Passed at branch baseline; no new dependency or production binding. |
| `mise run check` for this correction | Passed: formatting, Biome assists, typecheck, lint/TSDoc, 96 source test files / 1,565 tests, 9 local workerd tests, 12 plugin artifact smoke tests, Worker dry-run build and plugin build. |
| Global coverage | Statements **9,824/10,340 (95.00%)**, branches 90.76%, functions 98.5%, lines 97.07%. Statements have no headroom; recheck after any production change. |
| Semantic/security review | Task-level reviews and independent whole-branch review; conditional-null exact read-back and pre-dispatch invalid encoding findings corrected; a later CAS-unavailable certainty bug corrected and re-reviewed. Final code review found no issues. |

Two tests-only expansions cover adjacent existing R2 storage: focused recovery
repository safety cases and a current-note regression requiring a valid exact
generation larger than the live-object ceiling to be rejected before body decoding.
Neither changes M1–M6 production behavior. No sync route, public API, `SyncStore` adapter,
marker provisioning, operation journal, feed traversal, inventory completion,
scan cleanup, cross-object reconciliation, deployment or personal vault was added
or qualified. M7.4 must bind the durable journal/feed and scan state, validate
external chunk chains, preserve persisted retry floors and unresolved effects,
and measure aggregate Workers Free subrequests/CPU before any subsequent
activation proposal. Local workerd and API declarations do not prove production
rate limits or mobile/desktop behavior.

## M7.4 local branch evidence (unmerged; isolated implementation approved)

The isolated private nine-method `SyncStore` is implemented in `feat/m7-complete-sync-store`: conditional mutation publication/recovery, committed feed paging, bounded v2 inventory cursor witnesses and chunk replay, complete-handle evidence paging, and canonical expired-scratch cleanup with permanent manifest tombstones. The current M1–M6 writer, HTTP/MCP surface and plugin remain unchanged.

| Local evidence | Result and limit |
| --- | --- |
| `mise install` and `mise run check` | Passed before the first independent review, including Biome assists, lint/TSDoc, typecheck, coverage, builds and local native-runtime tests. |
| Unchanged coverage gate | After R2: statements **12,272/12,917 (95%)**, branches **91.45%**, functions **98.64%**, lines **96.81%**. Final canonical check and `git diff --check` passed. |
| First independent whole-branch pass | Retained continuation completed the mutation/publication/schema structural gate and accepted R1; its canonical rerun passed. R2 found unsafe floors in lane reservation/release. Five RED/GREEN lane cases now refuse response-floor forwarding/CAS and late invalid observation floors while preserving original predicates and same-ID recovery. Nine focused regressions passed; integrated rerun passed and corrective review approved the isolated implementation. R1/R2 are fixed; no open actionable findings remain. |
| Operational qualification | Synthetic R2/local Miniflare only. No deployment, real R2/account/vault, sync activation, maximal real-head profile or remote Workers Free CPU/account qualification. |

See [local evidence and outstanding qualification](../qualification/m7-private-sync-store-local.md). This evidence updates the locally validated and independently approved implementation state, not a merged completion claim. **M7.4's full exit remains open for qualification/merge; M7 remains NEXT.** Keep the separate qualification and activation gates open. The owner now authorizes forward-only commits, feature-branch push and an open PR for review, but not merge or deployment; no following milestone becomes NEXT from this branch-local evidence.

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
- [ADR 0017 — Durable R2 publication attempt claims](../decisions/0017-r2-publication-attempt-claims.md)
- [Bidirectional sync rollout plan](../plans/bidirectional-vault-sync-rollout.md)
- [API contract](../api.md)
- [Operations and release guidance](../operations.md)
- [Cloudflare Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Workers R2 API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Cloudflare R2 platform limits](https://developers.cloudflare.com/r2/platform/limits/)
- [Cloudflare R2 Unicode interoperability](https://developers.cloudflare.com/r2/reference/unicode-interoperability/)
