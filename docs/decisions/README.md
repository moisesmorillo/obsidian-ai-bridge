# Architecture decision records

Use lightweight ADRs for durable decisions that future agents should not repeatedly
reopen. [Architecture](../architecture.md) describes the current design;
[roadmap](../roadmap.md) owns sequencing and open product questions; milestone
specs own acceptance criteria. ADRs explain consequential choices and trade-offs.

## When to write one

Write an ADR for synchronization direction/authority, conflict policy,
deletion/tombstones/recovery, authentication evolution, persistence changes or a
major infrastructure dependency. Do not create ADRs for ordinary file naming,
small refactors, individual library calls or rules already covered by AGENTS.md.

Open questions stay in the roadmap until a decision is required. A proposed ADR
is not implementation authorization; surface material ambiguity to the maintainer
before committing production behavior. Use current code as evidence of existing
decisions, not an invented historical rationale.

## Convention

- Files: `NNNN-short-decision-title.md`, next unused sequential number. Never
  renumber records after merge.
- Status: `Proposed`, `Accepted`, `Superseded` or `Rejected`. Explicit maintainer
  approval may accept a design before implementation; identify that distinction.
  Repository transitions become canonical through review/merge. Existing-code
  records must explicitly identify an already implemented baseline.
- Sections: **Status**, **Context**, **Decision**, **Consequences**, **Alternatives**,
  **Evidence / related documents**. Keep them short. Dates are optional; no
  fabricated decision dates or claimed approvals.
- Include constraints, alternatives and material trade-offs, not speculative
  services. Link relevant milestone and source paths; use synthetic examples only.
- To change an accepted decision, create a successor describing why, link both
  records, mark the old one superseded, and synchronize architecture, roadmap,
  tests and affected contracts. Do not silently rewrite the decision's meaning.

## Index

| Record | Status | Scope |
| --- | --- | --- |
| [0001 — Worker/R2 foundation and inward boundaries](0001-worker-r2-foundation.md) | Accepted (implemented M1 baseline) | Minimal topology, trust boundary, transport/storage separation and canonical addressing |
| [0002 — Conditional current-generation remote mutation](0002-conditional-remote-note-mutation.md) | Accepted (Worker contract implemented) | Fresh envelope revisions/R2 CAS, exact receipts, safe v2 and v1 PUT/DELETE retirement |
| [0003 — Single-writer mirror association and per-path state](0003-publishing-association-and-local-state.md) | Accepted (Worker guard and Slice 3 local model implemented) | Whole opt-in, device-local ACK/uncertainty ledger, lifecycle ownership and explicit handoff |
| [0004 — Recoverable runtime removals and local renames](0004-recoverable-mirror-deletions.md) | Accepted (implemented M3 baseline) | Event deletion authority, separate 30-day recovery, permanent heads/purge markers, destination-first rename |
| [0005 — Reviewed reconciliation authority](0005-reviewed-reconciliation-authority.md) | Accepted (Slice 1 contracts only) | Reviewed-only remote-to-local authority, stale decisions, and retained one-writer model |
| [0006 — Conflict preservation and bounded local mutation](0006-conflict-preservation-and-local-mutation.md) | Accepted (Slice 1 metadata contracts only) | Excluded local conflict archive, narrow local mutation port, and cross-boundary ordering |
| [0007 — Explicit adoption, tombstone handling, and restore](0007-explicit-adoption-tombstone-and-restore.md) | Accepted (Slice 1 action contracts only) | Exact revisioned adoption, safe legacy fork, reviewed tombstones, and local-first restore |
| [0008 — M4 device-state migration and downgrade fence](0008-m4-device-state-migration.md) | Accepted (implemented Slice 1) | Deterministic schema v2→v3 migration, partial-operation state, restart, and downgrade refusal |

ADR 0001 records the implemented M1 baseline. ADRs 0002–0004 record the implemented
M3 design without claiming deployment. ADRs 0005–0008 resolve M4 design. Slice 1 implements their closed state contracts and
ADR 0008 migration fence only; it does not authorize or claim later reconciliation,
mutation, UI, deployment, or production behavior. See the M3
[decision brief](../plans/m3-design-decisions.md) and the M4
[implementation-ready specification](../milestones/m4-remote-to-local-reconciliation-and-conflict-resolution.md).
