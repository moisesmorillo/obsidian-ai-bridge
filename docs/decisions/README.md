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
- Status: `Proposed`, `Accepted`, `Superseded` or `Rejected`. Accepted proposals
  become repository decisions through review/merge; existing-code records must
  explicitly identify that they record an already implemented baseline.
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

Only one initial record is needed: it preserves consequential facts already in
code, not a retrospective ADR for every historical PR. Sync/auth evolution
records will be added when those decisions are actually made.
