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
| [0005 — Reviewed reconciliation authority](0005-reviewed-reconciliation-authority.md) | Accepted (Slices 1–5 core contracts/actions implemented) | Reviewed-only remote-to-local authority, stale decisions, and retained one-writer model |
| [0006 — Conflict preservation and bounded local mutation](0006-conflict-preservation-and-local-mutation.md) | Superseded only for root location by ADR 0012; remaining M4 contract accepted | Excluded local conflict archive, narrow local mutation port, and cross-boundary ordering |
| [0007 — Explicit adoption, tombstone handling, and restore](0007-explicit-adoption-tombstone-and-restore.md) | Accepted (Slices 1–5 core actions implemented) | Exact revisioned adoption, safe legacy fork, reviewed tombstones, and local-first restore |
| [0008 — M4 device-state migration and downgrade fence](0008-m4-device-state-migration.md) | Accepted (implemented Slice 1 v2→v3 history) | Deterministic schema v2→v3 migration, partial-operation state, restart, and downgrade refusal |
| [0009 — Bounded history resolution, runtime authority, and device-state v4](0009-m4-history-runtime-and-device-state-v4.md) | Accepted (Slices 6–7 implemented) | Parent-owned history steps, step-scoped preservation, shared runtime authority, and strict v3→v4 migration |
| [0010 — Scoped client credentials, permissions, and lifecycle](0010-scoped-client-credentials-and-permissions.md) | Accepted (Slice 2 lifecycle and Slice 4 authorization/retirement implemented) | Bounded digest-only bearer clients, typed principals, read/write/delete semantics, revocation, and rotation |
| [0011 — M5 operational envelope and support policy](0011-m5-operational-envelope.md) | Accepted for M5 planning (not yet qualified) | 10,000-note qualification target, no application quotas/limiter, desktop-writer intent, manual recovery, latest-only releases, zero-day logs, and v1 retirement |
| [0012 — Host-visible conflict-preservation namespace](0012-host-visible-conflict-preservation-namespace.md) | Accepted (corrective M4 production change implemented) | Official-index-visible current archive root, exact mirror exclusions, and frozen legacy receipt compatibility |
| [0013 — Listener-ready effect authority and observation-gap recovery](0013-listener-ready-effect-authority-and-observation-gap-recovery.md) | Accepted and implemented in corrective M4 change; merge pending | Orthogonal durable v5 gap fence, dispatch lease, review transfer and strict compatibility transition |

ADR 0001 records the implemented M1 baseline. ADRs 0002–0004 record the implemented
M3 design without claiming deployment. ADRs 0005–0008 are accepted M4 decisions and
ADRs 0005–0007 have core implementation through Slice 5. ADR 0008 remains the
historically accurate implemented v2→v3 fence. ADR 0009's additive Slice 6–7 contracts
and v3→v4 fence are implemented without rewriting v3 history or authorizing deployment
or production claims. ADR 0010's registry, principal, lifecycle tooling, and historical singleton migration
checkpoint are implemented by M5 Slice 2; Slice 4 enforces the route-operation
permissions and retires singleton/v1 authority. ADR 0011 closes the Slice 1 operating-policy choices without
claiming current support or changing runtime behavior. ADR 0012 corrects only the M4
preservation namespace after real-host evidence while retaining frozen legacy receipt
identity and every preserve-first safety rule. ADR 0013 supersedes only ADR 0009's
listener-gap sufficiency assumption; its corrective implementation advances the
current state/runtime to v5 without changing the Worker API. Bounded disposable-host
evidence does not complete M5 qualification. See the M3 [decision brief](../plans/m3-design-decisions.md),
the M4 [implementation-ready specification](../milestones/m4-remote-to-local-reconciliation-and-conflict-resolution.md),
and the M5 [planning specification](../milestones/m5-operational-and-security-readiness.md).
