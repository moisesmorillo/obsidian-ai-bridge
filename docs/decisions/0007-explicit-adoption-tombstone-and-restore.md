# ADR 0007 — Explicit adoption, tombstone handling, and restore

## Status

**Accepted; Slice 1 closed action/state contracts implemented.** Adoption, tombstone,
restore, local mutation, and remote mutation behavior remain unimplemented. Existing
M3 remote contracts are unchanged.

## Context

M4 must handle revisioned remote notes unknown to the local ledger, unversioned legacy
Markdown, remote tombstones, and recovery snapshots. None may become authority merely
because it exists, has equal text, or is absent. The design should use the existing v2
API unless a new operation is required for correctness.

A format-2 live object has a fresh application revision and receipt. A legacy raw
object has content but no application generation. R2 raw-body validators may repeat
for same-text rewrites, and upload version is not a conditional predicate. Therefore
there is no exact client-visible legacy generation that can satisfy M4's stale-review
and same-text-ABA requirements.

## Decision

### Revisioned live adoption

An operator may adopt one exact format-2 live revision whose receipt belongs to the
current association. Adoption binds the reviewed local observation, path,
association/origin, remote revision/receipt/content hash,
and operation identity. If the local path is absent, M4 conditionally creates it from
the exact remote content. If local text is equal, the explicit gesture—not equality—
creates the association. Different local text uses the conflict-resolution workflow.
The baseline advances only after local state and the exact remote revision are both
revalidated and any local effect is proven.

### Legacy handling

M4 does **not** adopt or replace a legacy object in place. Safe same-path adoption
would require a unique conditionable legacy generation, which the current storage
contract cannot provide. Content equality, a content hash, or a repeated raw-body
ETag is insufficient, and adding a database/coordinator solely to manufacture legacy
history is disproportionate.

The supported legacy action is an explicit **forked import**:

1. read and size/hash-validate the legacy bytes as untrusted content;
2. create and verify a local preservation artifact;
3. require an operator-chosen different eligible destination that is locally and
   remotely absent;
4. create the local destination and let the same durable operation conditionally
   create a new format-2 remote generation at that destination;
5. leave the original legacy object untouched and visibly unassociated.

A same-path local import may be exported/preserved for manual use but cannot establish
a remote baseline. “Normalize” is never an overwrite action. This is an explicit
safety limitation, not a maintainer decision left open.

### Tombstones

A same-association remote tombstone creates a review item. A receipt from another
association is blocked as unsupported bucket lineage, not adopted. Permitted
decisions are:

- **Adopt tombstone while locally absent:** revalidate exact absence and tombstone
  revision, then record that baseline; no local mutation occurs.
- **Locally live tombstone conflict:** preserve the local bytes, then recreate the
  remote, copy the local version to a different eligible path and defer, or leave the
  conflict blocked. M4 cannot accept the tombstone by moving/deleting the live local
  path because the host has no atomic compare-and-delete/move predicate. The operator
  may deliberately remove/move the note in Obsidian, but that event is ordinary M3
  evidence and a later fresh M4 review must prove local absence before adopting the
  tombstone.
- **Reject deletion/recreate remote:** revalidate local bytes and exact tombstone,
  retain the existing recovery object, then use conditional v2 recreation. A remote
  change or unknown effect blocks for evidence.
- **Keep both/defer:** preserve local content or copy it to a chosen eligible path and
  leave the original tombstone unresolved until a later exact decision.

Unknown/unstable local reads and partial hydration permit only defer/refresh. Remote
physical absence is not a tombstone and cannot be adopted as deletion. No plugin
local-delete action exists in M4. An established
path that becomes physically absent is unsupported lineage loss and remains blocked;
M4 does not create over it from a refreshed GET.

### Recovery restore

Recovery GET remains read-only. An operator selects one exact prepared or unexpired
sealed snapshot and a destination. M4 validates metadata, revision, path, status,
expiry, content hash, UTF-8 and size before mutation. A purged, expired, missing,
changed, malformed, excluded, or oversized selection is refused.

Restore is **local-only first**. An absent eligible destination may be created. An
existing destination requires either a different path or prior verified preservation
and an atomic conditional replacement. The operation enters the durable active
`restored-pending-review` phase before the local write so its path reservation
survives restart/re-enable, blocks handoff, and
keeps the host event out of ordinary M3 scheduling. Restore never changes the remote
current head or baseline in the same operation. A later explicit review may recreate
a tombstoned original or publish an alternate path with normal v2 conditions. The
restore cannot become terminal without a linked reviewed successor operation taking
over the restored path atomically; that successor's reviewed completion is what may
release ordinary M3 ownership.

After restart, a persisted restore intent is reconciled from the exact destination
hash and preservation receipt. If the destination changed or the recovery bytes can
no longer be re-fetched, the workflow blocks without deleting either version.

### Wire API

Existing v2 mirror description, note list/content/state, conditional PUT, tombstone
DELETE, and recovery list/metadata/content/seal/purge operations are sufficient for
all accepted M4 behavior. No Worker route, DTO, CORS capability, OpenAPI operation,
server history, database, or new Cloudflare service is added for M4.

The inability to safely mutate a legacy object in place is intentionally preserved
rather than hidden behind a weaker new API. If future requirements demand same-path
legacy conversion, a successor ADR must define a unique conditionable legacy
identity and downgrade behavior first.

## Consequences

Revisioned adoption and tombstone decisions are exact and auditable. Legacy objects
remain visible until an operator migrates them by fork or an independently designed
future operation exists. Restore cannot unexpectedly recreate remote content; it may
leave an eligible local path visibly blocked pending a second decision.

The one designated writer and privileged bearer boundaries are unchanged.

## Alternatives

Automatic adoption, equal-text association, local delete on remote tombstone, and
GET-triggered restore were rejected. A new hash-conditioned legacy conversion route
was rejected because same-text ABA would still lack generation identity. A database,
Durable Object, or immutable server history was rejected as unnecessary for accepted
M4 behavior.

## Evidence / related documents

[M4 specification](../milestones/m4-remote-to-local-reconciliation-and-conflict-resolution.md),
[Worker API](../api.md), [ADR 0002](0002-conditional-remote-note-mutation.md),
[ADR 0004](0004-recoverable-mirror-deletions.md), and
[ADR 0006](0006-conflict-preservation-and-local-mutation.md).
