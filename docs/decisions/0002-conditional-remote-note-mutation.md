# ADR 0002 — Conditional remote note mutation

## Status

**Proposed.** Requires maintainer approval of D4 in the
[M3 decision brief](../plans/m3-design-decisions.md). Not implemented and not an
accepted replacement of the M1 behavior recorded in ADR 0001. This proposal
changes storage representation and external writer compatibility deliberately.

## Context

M1's existence check followed by unconditional R2 PUT loses concurrent edits.
R2 supports atomic conditional PUT using an object's ETag or HTTP conditions,
returning null without a write on failed conditions. R2 upload `version` is unique
but cannot be a write predicate. SHA-256 checksums validate incoming bytes, not
the object being replaced. A separate application metadata object is not atomic
with the note body. A raw-body ETag can repeat on same-text replacement or
remove/recreate; that is insufficient as a distinct publishing generation.

Old M1 servers ignore conditional headers. Checking capabilities and then sending
to their existing PUT route is not sufficient against a server downgrade between
requests. No prior M1 writer is known to be deployed; configuration is not evidence
that it is safe to break an actual installation without an upgrade procedure.

## Decision

Subject to approval, implement these M3 safety prerequisites:

1. Add authenticated `/api/v2/notes` list/read and conditional PUT item routes,
   retaining canonical base64url path addressing. All versions share the existing
   `vault/<NotePath>` keys. The upgraded Worker rejects **every v1 PUT with 410**,
   never writing. V1 read/list remain compatible. No v2 delete is introduced;
   existing v1 DELETE is still explicitly destructive external-client behavior.
   An old Worker has no v2 mutation route and cannot silently honor an unsafe PUT.
2. Persist each new successful write as a single adapter-private UTF-8 JSON object
   with exactly `format: 1`, `revision` (fresh server-generated UUID v4), and
   `content` (note text). Set customMetadata `bridgeFormat: "1"` to identify the
   codec. The marker is a format discriminator, **not** the revision predicate.
   Fresh server randomness is generated for every storage write attempt and kept
   inside the stored body, not just custom metadata. No caller-supplied revision.
3. Validate marker, exact envelope schema, revision syntax and decoded content
   byte length. Envelope read bound is `6 * MAX_NOTE_SIZE_BYTES + 256` bytes, then
   the actual decoded UTF-8 content must still be at most 1 MiB. The factor covers
   JSON escaping of control bytes; validate encoded bytes before storing as well.
   Incoming HTTP bodies retain the original 1 MiB limit. Private R2 HTTP metadata
   describes JSON envelopes; API responses still return raw Markdown, not JSON
   envelope bytes. List eligibility for envelopes uses decoded content size, not
   a naive 1 MiB physical-object filter. This adds bounded per-object reads to
   listing; whole-list scale remains an explicit limitation, not a free operation.
4. Untagged existing objects are **legacy raw Markdown**, never inferred to be
   envelopes from their content. Keep them readable/listable under the original
   size bound. Unknown markers, malformed envelopes or oversized storage yield
   sanitized storage failure, not absence or a writable empty note. M3 does not
   convert/adopt legacy objects automatically and offers no legacy replacement
   through v2. A legacy path blocks first publishing even if text matches exactly.
5. V2 GET returns raw content plus a strong application ETag
   `"m3-<revision-uuid>"` for a revisioned object, from the same retrieved object
   as the content. Legacy reads are explicitly marked legacy and have no writable
   revision. This ETag identifies application representation generation; it is
   not an advertised body checksum or the R2 upload version.
6. V2 PUT accepts exactly one supported precondition:
   - `If-None-Match: *`: create only. Execute R2 put with a freshly constructed
     `Headers` containing `If-None-Match: *`. Success is 201, null is 412.
   - `If-Match: "m3-<revision-uuid>"`: update only. Retrieve/validate the object,
     require its application revision to equal the supplied revision, then R2 put
     with `onlyIf: { etagMatches: observedObject.etag }`. Success is 200, null is
     412. Missing or legacy object and revision mismatch are 412, never create.
   Missing precondition is 428; both headers, weak validators, lists, wildcard
   If-Match, unsupported syntax/date conditions are rejected as 400. No bypass
   option. Construct adapter-owned conditions, never forward arbitrary headers.
7. Success returns validated path, stored=true, revision, and the same ETag as the
   stored envelope. Do not HEAD again to derive success revision or created status:
   another writer may already have advanced it. GET is observational; it never
   grants the plugin a new replacement baseline by itself.
8. Keep all storage details private to the Worker adapter. Core receives typed
   `absent | matching(revision)` requirements and `stored | precondition_failed`
   outcomes, not R2 types, HTTP headers or magic string errors.

### Safety argument and exact harmful interleavings

The linearization point is R2's conditional put, not the preliminary read.
Assume the documented conditional operation is atomic, storage validators
correctly distinguish changed envelope bytes, server nonces do not collide, and
all ordinary API writes go through the upgraded Worker. Storage/Worker operators
and malicious token holders are not adversaries excluded by this single-token
experimental trust model. The token still permits destructive external DELETE.

- **Create/create:** both requests reach R2 with absence conditions while absent.
  Only one can atomically insert; the other returns 412 and leaves the winner.
- **Known update / remote edit:** publisher reads envelope A and its storage ETag.
  Editor commits B before publisher's conditional put. B contains a fresh nonce,
  even if note text equals A. Publisher's storage predicate fails; B survives.
- **Concurrent updates both read A:** one CAS succeeds; the other's observed ETag
  fails. There is no get-then-unconditional fallback after null.
- **Remove/recreate:** an updater of A cannot create an absent object. A recreated
  envelope has another revision/ETag, including with identical text; stale A fails.
  If DELETE occurs after a successful publish, it can still delete the result.
  M3 does not claim protection from an independently authorized destructive API.
- **Ambiguous update failure:** repeat only the same original content and matching
  revision. If first attempt committed, its new revision prevents replay overwriting
  that or any later generation. Replay may return 412, not recoverable success.
  If neither committed, one may succeed. Never use a freshly read precondition.
  **Ambiguous create is not replayed by the plugin:** create→delete makes absence
  true again, so an absence predicate alone cannot prove historical non-commit.
  Generic concurrent-create safety does not imply durable create idempotency.
- **Old server:** plugin v2 requests receive a refusal on the old implementation;
  no fallback to v1 PUT, even after a 404 or malformed capability response.

This provides per-object safety, not transactions across notes, retained history,
exactly-once delivery or cryptographic protection against a malicious storage
operator. Random revision and R2 ETag assumptions are explicit; do not call a
hash/checksum collision impossible or claim database-grade global sequencing.

## Consequences

No new database, Durable Object, coordinator, queue or multi-object commit is
needed. M4 can build reconciliation on distinct generations, but history, merge,
tombstones and recovery are not implemented. Lost ACK/local metadata may leave a
note safely blocked; refusal is preferable to invented success/adoption.

This is a breaking experimental API writer change. Document upgrade to v2,
conditions, raw legacy read-only behavior and the 410 response. Existing v1 reader
payloads remain raw Markdown. Never run old Worker code against envelope data:
it would expose JSON bodies and allow unguarded replacement. Any future upgrade
must quiesce/drain all old writers and in-flight old Worker requests before enabling
envelope writes; mixed-version/zero-downtime rollout is not promised. No automated data
migration, deployment or rollback is authorized by planning. Operational docs must
require backup/operator approval before any future migration or deployment.

A local Miniflare/workerd integration check is required to validate wildcard and
matching-ETag behavior against the pinned runtime, in addition to deterministic
barrier-controlled adapter tests. A fake that itself implements the desired CAS
algorithm is insufficient platform evidence. Local emulator evidence is not a
claim about a tested deployed Cloudflare environment.

## Alternatives

- Raw Markdown ETag CAS is smaller and protects differing text, but needs explicit
  product acceptance of content-equivalence/ABA rather than generation identity.
- Unique ID only in custom metadata plus an ETag check does not close the ABA
  window. SHA-256 read/compare followed by unconditional put is still unsafe.
- R2 version comparisons are not exposed as atomic predicates by current APIs.
- Coordinator/database or immutable blobs plus a separate head introduce more
  persistence/commit states than a single envelope requires.
- Keeping v1 unconditional writes in the same namespace undermines the guarantee.
  A separate v2 namespace could retain them but creates a migration and two mirrors.

## Evidence / related documents

- [Platform sources and alternatives](../plans/m3-design-decisions.md#verified-platform-evidence).
- `apps/worker/src/infrastructure/{r2.types.ts,r2-vault.repository.ts}` and tests;
  `packages/core/src/vault/{note-service.ts,vault-repository.port.ts}`.
- [M3 specification](../milestones/m3-remote-bridge-client-and-publishing.md),
  [implementation plan](../plans/m3-remote-bridge-client-and-publishing.md),
  [ADR 0001](0001-worker-r2-foundation.md), [ADR 0003](0003-publishing-association-and-local-state.md).
