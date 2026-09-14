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
| [0002 — Conditional remote note mutation](0002-conditional-remote-note-mutation.md) | Proposed (M3; approval pending) | Single-object revision envelope/R2 CAS, v2 write contract and unsafe v1 writer retirement |
| [0003 — Publishing association and conservative local state](0003-publishing-association-and-local-state.md) | Proposed (M3; approval pending) | Exact-path consent/baselines, no automatic adoption, non-content uncertainty interlock |

ADR 0001 records implemented facts. The M3 proposals are not accepted decisions
or implementation authorization; see the [maintainer decision brief](../plans/m3-design-decisions.md).
