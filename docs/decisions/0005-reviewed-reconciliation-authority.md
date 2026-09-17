# ADR 0005 — Reviewed reconciliation authority

## Status

**Accepted; Slice 1 closed authority/state contracts implemented.** No review engine,
operator UI, or reconciliation effect is implemented yet. This record does not
authorize deployment or personal-vault installation.

## Context

M3 deliberately has one outward authority direction: saved local events from one
designated writer may conditionally mutate the remote mirror. Independent remote
changes block that path. M4 must let an operator inspect and resolve those blocks
without turning a remote read, equal text, startup absence, or a stale UI into local
or remote mutation authority.

The alternatives were:

- reviewed/manual remote-to-local reconciliation only;
- bounded automatic bidirectional synchronization; or
- a hybrid that automatically imports only apparently simple remote changes and
  reviews conflicts.

Automatic and hybrid import both need a trustworthy remote event stream, durable
cross-device ordering, automatic deletion authority, and a policy for stale iCloud
state. The existing Worker exposes current generations, not an ordered change log,
and M3 intentionally supports one designated writer rather than a distributed sync
coordinator. Calling a remote-only change “safe” would still silently choose remote
authority and make restart/audit behavior harder to explain.

## Decision

M4 uses **reviewed reconciliation only** for every remote-to-local mutation and every
adoption of a remote generation. Remote divergence creates or refreshes a review item;
it does not itself mutate the vault or advance a baseline. M3 local saved events
remain the normal outward source when the path is not blocked by unresolved M3 work
or an M4 review/resolution.

Every permitted mutation has one explicit typed authority source:

- `m3-saved-event` for existing M3 outward creates, updates, recoverable removals,
  and renames;
- `operator-reconciliation-decision` for a reviewed live/live resolution;
- `operator-adoption-decision` for adopting an exact revisioned remote generation;
- `operator-tombstone-decision` for accepting or rejecting an exact remote tombstone;
- `operator-recovery-restore-decision` for restoring one exact recoverable snapshot;
- `operator-history-decision` for bounded cleanup of a deferred rename/history state;
- the existing explicit handoff authority for M3 writer transfer.

No generic “remote changed” or “latest state” authority exists. UI commands carry a
review operation identity, not free-form permission. Before the serialized decision-admission commit, application policy revalidates the
exact local observation, acknowledged baseline, remote state/revision, path identity,
lifecycle, association/origin, and review identity. Any mismatch makes the decision
stale, preserves existing copies, and requires a new review. Later effects revalidate
the evidence they consume at their own local atomic or remote CAS boundary; a change
committed after that boundary is a new divergence because no cross-system transaction
exists.

Read-only review snapshots do not survive as executable decisions. One immutable,
content-free snapshot binds runtime-owner version, configuration generation, listener
epoch, device/designated writer, complete lifecycle, every involved path, stable local
hash/size/generation, ACK and M3 work, exact remote receipt/state, and selected
recovery metadata. Review and admitted operation use the same typed snapshot and must
match exactly. A process restart, listener epoch change, configuration generation
change, or plugin runtime-owner version change invalidates open UI decisions. Once the
operator confirms an action, its content-free intent and phase are persisted before
the first mutation so restart can reconcile partial completion without replaying a
stale UI click.

M4 retains one designated writer. Reviewed remote-to-local work does not require
multiple active writers, elections, leases, or a shared transactional ledger.
Unrelated paths may progress while one review is blocked, subject to the existing
global persistence, configuration, and lifecycle fences.

## Consequences

The model is simple to audit: remote changes remain visible until a person chooses a
bounded action. It avoids silent last-writer-wins and does not mistake stale iCloud
content for deliberate local intent. It also means remote changes are not applied
until the designated writer is available and an operator reviews them; M4 is
reconciliation, not continuous bidirectional synchronization.

M5 can improve operating readiness and permissions without changing this authority
model. M6 can expose authorized review/read operations through MCP, but note content
never grants authority and agents do not receive an implicit local-mutation path.
A future automatic bidirectional design would require a successor ADR and a concrete
ordering/authority model.

## Alternatives

Bounded automatic bidirectionality was rejected because “no local change since the
last ACK” is not enough to prove iCloud freshness or operator intent, especially
across restart and listener gaps. A hybrid was rejected because its “simple” cases
still include destructive or identity-sensitive choices and would create two policy
paths for the same divergence. Silent last-writer-wins is prohibited.

## Evidence / related documents

[M4 specification](../milestones/m4-remote-to-local-reconciliation-and-conflict-resolution.md),
[M4 implementation plan](../plans/m4-remote-to-local-reconciliation-and-conflict-resolution.md),
[ADR 0003](0003-publishing-association-and-local-state.md), and
[ADR 0006](0006-conflict-preservation-and-local-mutation.md).
