# ADR 0004 — Recoverable runtime removals and local renames

## Status

**Accepted — Worker storage/application/REST subset implemented through Slice 2C.**
Recovery-first tombstone orchestration, 30-day sealing, conditional purge markers,
and separate recovery metadata/content plus explicit maintenance routes exist.
Runtime Obsidian delete/rename authority remains later M3 work. This record selects
the minimum technical mechanism under
[ADR 0002](0002-conditional-remote-note-mutation.md), not a general backup system.

## Context

A startup scan is not evidence of deletion. Obsidian's public delete callback has
no actor/provenance flag and layout-ready is not proof of complete iCloud hydration.
The maintainer accepts post-bootstrap runtime events as mirror-removal authority
without calling them proof of human intent. R2 Worker DELETE is not conditional;
native bucket versioning/trash is not available for this design. Lifecycle expiration
removes whole objects asynchronously; locks prevent overwrite as well as deletion.

## Decision

### Authority and local state

Accept a runtime deletion only after the initial metadata bootstrap has completed,
for a path that was eligible and had an acknowledged live association **when the
event was observed**. Persist the event's exact old path, original association,
local event generation and expected acknowledged revision before scheduling a
remote mutation. Coalesce duplicates; wait the 5-second deletion grace and recheck
that the exact path is absent. A create/rename returning a file before dispatch
cancels the unsent removal; it is not automatically a new identity to delete.

A folder delete can supply evidence for its previously indexed, acknowledged
eligible descendants, using directory boundaries and the pre-event index. Do not
invent children from a remote-minus-local scan. Duplicate child events coalesce.
No events received before bootstrap become destructive authority afterward.
Unknown paths, pending-first-create paths and startup absence are not deletion
authority. Cancel an unsent first create if possible; a potentially committed
first create whose local file disappeared is visible divergence, not a retroactively
authorized delete. Lost event persistence also becomes missing-unconfirmed on
restart, never an inferred removal.

If an associated path has an earlier local mutation in flight, keep its delete
intent but wait for that operation's actual settlement/evidence. A verified ACK for
that **own predecessor** may advance the delete condition; arbitrary remote GET
revisions may not. If the predecessor is unresolved/diverged, deletion stays blocked.
Local absence by itself never advances or resets a revision.

### Recovery snapshot before tombstone

Use adapter-private `recovery/<deletion-operation-uuid>` objects, separate from
`vault/` current keys. Their bounded format contains original NotePath, association,
operation ID, source live revision/content hash, saved text and retention state.
No plugin-local content copy. The original path has the real shared path contract;
encoded envelope limit is `6 * MAX_NOTE_SIZE_BYTES + 8192` bytes.

1. GET/validate current live generation and require the supplied If-Match revision.
2. **Prepare** the recovery snapshot with create-only R2 PUT, recording exact
   source bytes and metadata. Its initial retention state is unsealed (no expiry).
   On duplicate operation ID, validate the complete existing snapshot matches;
   never overwrite another snapshot or silently reuse mismatching data. If preparation
   fails/has uncertain durability, do not tombstone. The single authoritative head
   is still live; a prepared snapshot is not proof deletion happened.
3. CAS that observed current object's R2 ETag to a fresh tombstone referencing the
   snapshot. A conflict leaves the winner unchanged; a prepared orphan may remain.
4. **Seal** the snapshot's deadline once, by conditional PUT of the exact prepared
   object, preserving content. Use the successful tombstone's R2 uploaded timestamp
   plus 30 days (2,592,000 seconds). The timestamp comes from the stored generation,
   not a clock captured before a potentially delayed CAS. A duplicate seal must
   match the same source/tombstone generation; once sealed, content/deadline are
   immutable except for the conditional content-purge transition below. Every
   recovery state also has a fresh server revision inside its body.

The head CAS is the deletion linearization point, not recovery preparation or
sealing. Its response returns the actual tombstone revision/receipt. If sealing
fails after head commit, deletion remains effective and recovery material stays
unsealed, readable and ineligible for purge. Return confirmed tombstone plus a
retention-pending warning when the commit is known, not a fabricated failed delete.
If the response is lost, normal receipt-based recovery applies. Never undo the
head or hard-delete recovery material as compensation.

All GETs remain read-only. An explicit authenticated/designated
`POST /api/v2/recovery/:id/seal` may retry sealing, with the expected recovery
revision and proof from the **still-current matching tombstone** and its uploaded
timestamp. It uses the same writer/association/operation headers and conditional
adapter as other mutations; no metadata write bypass through a read endpoint.
Already sealed is a no-op success, never an extension/reset. If the head has
advanced and that deletion timestamp cannot be proved, retain the unsealed snapshot
and refuse repair with a typed proof-unavailable outcome. Do not guess expiry from
preparation time. A head change after obtaining that proof does not invalidate the
observed deletion timestamp; no multi-object transaction is claimed.
Recreating/updating the current path never overwrites recovery objects; recovery
survives later head changes without an ever-growing history array in the current head.

### Recovery and cleanup semantics

Normal v1/v2 note reads/listing (and future MCP note resources) hide tombstones.
A separate authenticated recovery list/metadata surface plus distinct read-only
content endpoint makes snapshots discoverable and retrievable without placing text
in metadata responses. Sealed content is recoverable for 30 days from the tombstone's
stored upload time; return its explicit recoverUntil timestamp. No exact physical
erasure time is promised. Unsealed material over-retains until safe proof/operator
maintenance; this is visible, not a claim of a strict 30-day maximum retention.

M3 provides retrieval/export of recovery text through REST, **not** automatic local
restore or a plugin vault-write API. The owner may deliberately restore/export via
external tools or Obsidian; a subsequent local recreation uses its acknowledged
tombstone revision, not absence. M4 owns richer restoration/adoption UX and any
remote-to-local mutation. A remote operator's restore changing a generation causes
normal CAS divergence rather than being silently overwritten by autosync.

Cleanup removes **only sealed, expired recovery content**. An explicit authenticated
maintenance action supplies the recovery revision; the Worker validates the deadline
and CAS-replaces that exact recovery envelope with a small fresh-revision **purged
marker** containing no note body. It does not call unconditional bucket.delete.
Unsealed/unexpired/unknown material is refused; an already purged matching identity
is idempotent. Missing is reported missing, never evidence of a prior valid purge.

Core recovery services own prepare/commit/seal/expiry orchestration and the 30-day
policy through conditional current-note/recovery ports. Adapters expose validated
revisions and stored upload timestamps, not R2 objects/ETags in core; they own
private key/codec and atomic predicate translation. Handlers never call R2 directly.

Retaining the content-free recovery key prevents a delayed duplicate prepare from
recreating a purged snapshot. Concurrent purge/seal/retry is protected by recovery
object CAS, just like current-note CAS. No operation may extend a sealed deadline,
reset it to prepared or reuse its ID for another tuple. This avoids a read-expired→
unconditional-delete race and does not require a database or a global operation log.

There is no physical-delete API for current heads or recovery markers, no scheduled
garbage collector and no blanket R2 lifecycle policy in M3. Native lifecycle removal
is asynchronous, not an implementation of safe application purge; do not configure
it on these namespaces. Payloads can be removed after 30 days while small safety
markers remain. Unsealed/orphan material over-retains for explicit maintenance.
Future safe marker compaction is outside M3. Bucket operators remain trusted not to
delete recovery early or restore stale generations into an active association.

### Rename/move

A post-bootstrap rename supplies oldPath and the new host path. Capture immutable
path/index data; never retain a mutable TFile.path as the old identity. Reserve both
paths in deterministic order, serialize with their in-flight jobs and persist the
rename prerequisite before dispatch.

- Eligible→eligible: safely create the destination (absence only unless this exact
  workflow already has its own acknowledged destination generation), confirm/save
  its ACK, recheck the rename's current local generation and destination existence,
  then tombstone the source using its acknowledged revision and recovery pipeline.
- Destination collision/unknown ACK/persistence failure, changed remote source or
  another lifecycle event on either path: **do not clean up the source**. Expose
  rename-cleanup-deferred/diverged, preserving available versions. A source is not
  removed simply because the destination now exists.
- Rename to an excluded/invalid/non-Markdown destination: do not read or upload it.
  The explicit runtime move authorizes recoverable removal of an associated old
  eligible path after absence/grace checks. Retain privacy of excluded destinations.
- Rename into eligibility: normal create-only discovery; no assumption about the
  unassociated old remote path. Startup path differences never infer rename.
- Folder rename expands only the pre-event observed paths, then applies the same
  per-note workflow and bounds. Duplicate child events are coalesced.
- Compound/overlapping renames during an unfinished workflow supersede its cleanup
  permission. Admit new eligible destinations through normal bounded discovery;
  preserve materialized old/intermediate remote paths as visible deferred cleanup.
  Do not create an unbounded rename history or delete a reused source path. M4 may
  provide richer chain reconciliation; simple local rename works automatically.

A recreated source before cleanup cancels unsent cleanup. After tombstone dispatch,
its outcome must settle before deciding whether a new local file needs conditional
recreation. Revision CAS prevents stale cleanup from deleting a later remote head;
there is no atomic two-path rename claim, compensating hard DELETE or merge.

## Consequences

Thirty-day recoverability requires extra remote content storage only for deletion
snapshots, not a second local vault copy or every-edit history. False-positive
external runtime deletions can temporarily hide a note, as explicitly accepted;
recovery and fresh local recreation protect content. Missed/bootstrap deletions,
compound renames, unsealed/orphan snapshots and lost local state can require visible
operator attention. This is not a complete backup or an iCloud correctness claim.

## Alternatives

Hard DELETE and get-then-delete are unsafe. Inline-only trash loses its content on
recreation. Native versioning cannot be assumed; lifecycle is expiration, not trash;
locks on heads obstruct normal mirroring. Full immutable history/coordinator storage
is unnecessary. Per-delete confirmations/plugin-specific delete commands were
explicitly rejected by the maintainer. Longer/indefinite normal retention was
considered; 30 days was approved instead, with honest asynchronous cleanup limits.

## Evidence / related documents

[Platform evidence and maintainer choices](../plans/m3-design-decisions.md),
[conditional mutation ADR](0002-conditional-remote-note-mutation.md),
[state/writer ADR](0003-publishing-association-and-local-state.md),
[M3 spec and race tests](../milestones/m3-remote-bridge-client-and-publishing.md).
