# ADR 0016 — Automatic multiwriter mirror admission

## Status

**Proposed.** This post-M6 rollout decision does not define M7 or change the
implemented single-writer contract. ADR 0003 and the M5 support envelope remain
in force until a separately reviewed, qualified cutover.

## Context

The deployed OAuth flow can authorize each Obsidian installation separately, but
the Worker still requires one operator-configured `MIRROR_WRITER_ID`. iCloud
delivers saved-file observations rather than an ordered transaction log. Another
installation may have old text, miss a deletion, or lack a local ACK ledger; an
MCP client may change a remote generation at any time. Removing only the static
writer guard would not establish a safe baseline for that installation.

The v2 API already uses create-only and exact revision conditions backed by R2
conditional writes. These protect a remote head, but cannot prove that a new
device's local text or observed absence should be published.

## Decision

- The Worker creates one immutable association control record in a reserved
  non-note R2 key, atomically and only after owner authorization. A client cannot
  choose or replace the association. A nonempty or ambiguous note namespace
  without a valid control record fails closed; no data is adopted or reset
  implicitly. OAuth revocation markers are outside that note namespace.
- Each installation retains its local opaque device ID and its own OAuth grant.
  `read`, `write`, and `delete` permissions remain the security authority. Device
  IDs identify cooperating writers and receipts; they are not secrets or leases.
  Connecting read-only does not depend on writer provisioning.
- Mirror activation requires explicit whole-scope/plaintext/deletion consent and
  a grant with `read`, `write`, and `delete`. A new installation first compares
  stable local bytes with validated remote generations without writing. Exact
  byte equivalence with a still-current live generation may establish a local
  ACK automatically; this changes no note content. A different live note,
  tombstone, legacy/invalid remote state, or uncertain observation remains
  blocked for reviewed resolution. This narrow exception to ADR 0005 records
  proven identical bytes only; it permits no automatic local or remote effect.
- A remote-only note is never deleted because it is absent locally. A local-only
  note on a joining device requires review before publication. The first device
  may bootstrap local notes only after the association and note namespace are
  proven empty and the existing whole-mirror consent is recorded. Once join
  completes, a note observed in a new saved-create event may use create-only
  publication when remote state proves absence without a tombstone.
- Every later update or deletion requires durable per-path ACK evidence and the
  exact remote generation precondition. A stale condition means divergence;
  it never authorizes retry against the newly observed head. Ambiguous writes
  retain their operation evidence and existing receipt-recovery rules.
- Only a post-bootstrap saved delete event for an acknowledged path can create a
  remote tombstone. Startup scans, joining absences, offline gaps, and delayed
  iCloud observations never grant deletion authority. MCP or another device's
  remote changes are divergence until exact equivalence or reviewed resolution
  establishes a new baseline. The Worker derives MCP authorship from the
  validated client principal rather than pretending MCP is an Obsidian device;
  MCP mutations retain the same exact remote preconditions.
- Add read-only protocol and association support before widening mutation
  admission. Migrate local v5 state with strict validation and exact read-back,
  preserving ACKs, operations, and reviews. The final cutover removes the global
  writer guard only after all paths enforce grant permission, association,
  conditional generation, and local evidence. Old clients and a rolled-back
  Worker must deny new-protocol writes.

## Consequences

The operator no longer copies a device UUID into Worker configuration. Any
authorized installation can become a writer after explicit consent and safe
joining. Some paths need review rather than a guessed resolution. Existing M5
qualification does not certify this model; two disposable installations, stale
iCloud observations, deletion/recreation, restart, revocation, MCP writes, and
rollback denial must pass before a personal vault is considered.

## Alternatives

- Automatic election of one writer needs lease/fencing and still makes device
  takeover an operational event.
- Removing only `MIRROR_WRITER_ID` leaves joining and deletion authority unsafe.
- Last writer wins can replace newer remote or MCP text with stale iCloud text.

## Evidence / related documents

- [ADR 0002 — conditional mutation](0002-conditional-remote-note-mutation.md)
- [ADR 0003 — current writer model](0003-publishing-association-and-local-state.md)
- [ADR 0004 — deletion authority](0004-recoverable-mirror-deletions.md)
- [ADR 0005 — reviewed reconciliation](0005-reviewed-reconciliation-authority.md)
- [ADR 0015 — client authorization](0015-browser-mediated-client-authorization.md)
- [Rollout sequence](../plans/automatic-multiwriter-rollout.md)
- [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
- [R2 conditional operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
