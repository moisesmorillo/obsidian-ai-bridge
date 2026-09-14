# ADR 0002 — Conditional current-generation remote mutation

## Status

**Accepted — maintainer-approved M3 design; not implemented.** The maintainer
approved versioned envelopes, fresh server revisions, R2 CAS and a safe v2 contract,
then approved automatic mirroring and recoverable deletion. This revision incorporates
those requirements and the [recovery contract](0004-recoverable-mirror-deletions.md).
Acceptance is not a claim that M1 already implements conditional writes.

## Context

M1 uses existence-check → unconditional PUT and destructive DELETE. Strongly
consistent storage does not make that sequence atomic. R2 offers conditional PUT,
not conditional DELETE on the Worker binding. Its upload version is unique but not
an available predicate; a raw-body ETag may repeat across same-text replacements.
Keeping the old mutation route available would undermine autosync and tombstones.

## Decision

### One authoritative current object

Keep adapter-private `vault/<NotePath>` addressing, one current object per path.
New objects have customMetadata `bridgeFormat: "2"` and an exact versioned JSON
body, one of:

- **Live:** format=2, kind=live, fresh server UUID-v4 revision, last-operation receipt,
  and UTF-8 note content.
- **Tombstone:** format=2, kind=tombstone, fresh server UUID-v4 revision,
  last-operation receipt, deleted live revision and recovery snapshot ID.

Every accepted mutation attempt generates a new revision **inside the stored body**;
custom metadata alone is not the predicate. All ordinary mutations preserve the
current object key, including removal/recreation. A tombstone is never expired by
lifecycle or physically deleted by an application note endpoint. Recovery snapshots
are separate objects; they are not competing authoritative note heads.

A last-operation receipt contains the validated operation UUID, association UUID,
action (create/update/recreate/tombstone), original parent revision or absent,
and content SHA-256 for content mutations. The server computes the hash from bytes;
a caller does not choose the new revision. UUIDs are opaque operation identities,
not permissions. Receipts allow evidence-based recovery of **our own persisted
intent**, not arbitrary adoption of a path with equal content.

Untagged pre-M3 raw objects remain legacy Markdown: read/list under M1's size
policy, never recognize JSON-looking raw text as an envelope. Unknown markers,
invalid schema/UTF-8/metadata and oversized objects fail as storage errors, not
absence. M3 does not convert or automatically adopt legacy paths. There are no
deployed format-1 M3 envelopes to migrate from the prior unimplemented proposal.

Envelope bytes are bounded by `6 * MAX_NOTE_SIZE_BYTES + 4096`; decoded content
remains <=1 MiB. The factor covers JSON escaping; fixed metadata schemas bound
IDs/receipts. Tombstone metadata has a 4096-byte bound. Validate stored and actual
read bytes as well as declared size. Normal HTTP note content remains raw Markdown;
storage JSON never leaks as a note. V2 lists page over at most 50 storage entries
per request, decode sequentially, omit tombstones, and may return an empty page with
a continuation. Core/transport do not see R2 cursors/metadata implementation details.

### Conditional protocol

Use authenticated `/api/v2` routes; old Workers do not implement them. There is
**no fallback to v1** after missing capability, 404, timeout or malformed response.
Upgraded Worker v1 PUT and DELETE return authenticated 410 `mutation_api_retired`,
without mutation. V1 raw reads/listing remain, decoding live envelopes and hiding
tombstones. No destructive v1 bypass or mixed old/new writer rollout is supported.

Every v2 note mutation carries operation/association/writer IDs, validated against
the [designation contract](0003-publishing-association-and-local-state.md), plus:

| Operation | Required condition | Storage action | Success |
| --- | --- | --- | --- |
| First create | If-None-Match: * | R2 put with a constructed Headers containing If-None-Match: * | 201 live |
| Update | One strong If-Match: "m3-<revision>" | GET/validate expected live revision, then put onlyIf.etagMatches = exact observed storage ETag | 200 live |
| Recreate after acknowledged tombstone | One strong If-Match of that tombstone | Same observed-object CAS, producing fresh live revision | 200 live |
| Delete live generation | One strong If-Match of expected live revision | Prepare recovery, then same observed-object CAS to tombstone; **not bucket.delete** | 200 tombstone |

Core uses absent/matching typed requirements; HTTP parsing and R2 conditions stay
in adapters. Missing precondition = 428, unsupported/both/weak/list/date/wildcard
update conditions = 400, stale/missing/legacy or wrong-state target = 412. R2 null
conditional result = 412 and no current-object write. No replace-any option.

Read current content and revision from **one** R2 GET. A strong application ETag is
`"m3-<revision>"`, not the R2 upload version or a body checksum. Successful ACKs
return the generation actually stored, not a subsequent HEAD's possibly newer
revision. Normal GET returns 404 for missing/tombstoned notes. Authenticated state
inspection distinguishes absent/legacy/live/tombstone and exposes validated receipts
without content; normal listing and future MCP note resources exclude tombstones.

### Ambiguous operations and retries

A valid success ACK, or state response with receipt matching the **entire persisted
intent** (connection/association/path/action/operation ID/original condition/hash),
can advance a local baseline. Equal text, a different receipt or merely reading the
latest revision cannot. If another mutation has replaced the receipt, fail closed
as divergence; M3 does not reconstruct arbitrary history to adopt it.

Retries use the same operation ID, original precondition and exact bytes. The
server still returns 412 for an already-committed replay; the client checks receipts
instead of treating 412 as success. Create retries are now safe against ordinary
API create→delete because deletion leaves a permanent current tombstone: absence
never becomes true again. This deliberately replaces the earlier manual-publishing
proposal's hard-delete assumption. Physical operator removal/old Worker writes are
outside the supported contract and must not occur in an active association.

If a restart cannot reconstruct the exact attempted content from a saved local
file with matching hash, do not send a different body under the same operation.
Inspect for our receipt; otherwise leave that path blocked. The
[specification](../milestones/m3-remote-bridge-client-and-publishing.md) bounds
attempts/evidence requests and keeps other paths progressing.

### Safety argument

R2 conditional PUT is the linearization point. Assume its documented predicate
is atomic, validators distinguish changed envelope bytes, server UUIDs do not
collide, and current keys are mutated only through this contract. R2/Worker operators
and compromised privileged bearers are within the experimental trust boundary;
this is not cryptographic protection from a malicious operator.

- Two absent creates reach the storage boundary together: one inserts, one fails.
- Publisher observes A; independent editor commits B before publisher's put:
  B's new body revision changes the storage validator, so publisher's CAS fails.
- Same text A→B still changes generation; same-text ABA cannot reuse a baseline.
- A deletion of X races an update to Y: only one CAS of X wins; Y is never silently
  tombstoned using X. A stale tombstone retry cannot delete a recreated generation.
- Aborted request commits late while identical original-condition retry runs:
  at most one current generation can be installed. The stored receipt proves which
  intended mutation occurred. Client abort is not server rollback.
- New local path meets an existing live, legacy or tombstone object: absence fails;
  no silent association. A known path unexpectedly physically missing also blocks.
- Old v1 mutations are retired; new-client requests against old code cannot invoke
  its unsafe write/delete handlers by mistake.

Exact deferred/barrier tests must exercise these windows through handlers, core
and the real R2 adapter, with a controllable storage double. The completed
[Slice 0 qualification](../qualification/m3-slice-0-platform-primitives.md) verifies
actual wildcard/ETag/null behavior in pinned local Miniflare/workerd. Mocks alone
do not prove an upstream platform contract. No deployment is a test.

## Consequences

M3 gains safe one-way automatic mutation, not retained history for every edit,
remote-to-local authority or transactions across paths. Single-note current state
needs no database, Durable Object, queue service or leader election. Recovery-copy
preparation can leave retained orphans; it cannot make a failed head CAS succeed.

This is a breaking experimental writer API/storage transition. Future operator
upgrade must stop and safely drain old writers before enabling envelope mutations;
old Worker rollback over envelopes is unsupported. Unknown deployed resources are
not assumed. Restoring a stale bucket snapshot into an active association is also
unsupported: use a new association/reset procedure, never pretend restored UUIDs
are new generations. Planning/validation does not deploy, migrate or restore data.

## Alternatives

Raw-content ETags alone admit same-text ABA. A nonce only in custom metadata is not
conditionable. R2 version and SHA-256 options are not current-object CAS predicates.
Native delete/lifecycle cannot supply conditional recoverable note deletion. A DB,
coordinator or complete immutable edit history is disproportionate to these
single-head operations. Keeping v1 mutation access would invalidate the guarantee.

## Evidence / related documents

[Primary platform evidence](../plans/m3-design-decisions.md#primary-source-evidence-and-qualification-limits),
[ADR 0001](0001-worker-r2-foundation.md),
[ADR 0003](0003-publishing-association-and-local-state.md),
[ADR 0004](0004-recoverable-mirror-deletions.md),
[M3 spec](../milestones/m3-remote-bridge-client-and-publishing.md).
Current unsafe source: Worker `infrastructure/r2-vault.repository.ts`, core
`vault/note-service.ts`, Worker `http/note.handlers.ts` and their tests.
