# M7.4 private SyncStore: local evidence

**Status: isolated implementation locally validated and independently approved; unmerged and unactivated.** M7 remains NEXT. This report does not qualify Workers Free CPU, account sustainability or a production vault.

## Candidate and boundary

- Branch: `feat/m7-complete-sync-store`; HEAD: `59bd2f5`; review base: `2a885a5`.
- The initial approved candidate included the complete tracked and untracked implementation overlay at `59bd2f5`. The owner subsequently authorized coherent forward-only commits, pushing this feature branch and opening an unmerged PR. Existing shared history is not rewritten; deployment and activation remain prohibited.
- Private nine-method composition implements conditional mutation publication/recovery, committed feed paging, v2 inventory cursor witnesses/chunk replay, complete-handle evidence paging and scoped expired-scratch cleanup.
- Original conditional-write authority, permanent manifest no-reuse tombstones and conservative unresolved effects remain intact. The current writer, HTTP/MCP surface and plugin are unchanged.

## Verified local checks

| Check | Evidence |
| --- | --- |
| Installation | `mise install` completed. |
| Canonical gate | `mise run check && git diff --check` passed after R2, task `b45e01da2`, exit 0. Includes Biome diagnostics/assists, semantic lint/TSDoc, typecheck, tests/coverage, build and local native-runtime checks. |
| Statements | **12,272/12,917 (95%)**; unchanged configured threshold. |
| Branches | **10,613/11,604 (91.45%)**. |
| Functions | **2,410/2,443 (98.64%)**. |
| Lines | **11,659/12,042 (96.81%)**. |
| Corrective regressions | R1 policy/recovery group **17/17**; R2 lane/target/admission group **9/9**. Genuine failing behavior preceded each production correction. |
| Independent semantic/design review | Final retained review `34cd43e4-65d3-458d-b576-5a3d6a67ff7f`: **APPROVE — isolated private SyncStore implementation only**. No open actionable finding. |

The native composed-store fixture covers an empty synthetic scan and preservation of a legacy object. Native conditional primitives and counted-call/fault/interleaving tests provide separate local evidence; they are not a maximal 10,000-head runtime profile or remote account measurement.

## Review findings closed

- **R1:** an invalid target-write response floor was hidden by a valid later observation. Each supplied response floor is now independently classified before aggregation; negative/fractional evidence remains uncertainty, without retry-journal CAS or new write authority.
- **R2:** equivalent lane reservation/release paths forwarded or masked unsafe floors. They now validate response/observation evidence before response-driven floor updates. Exact confirmed completion remains independently admissible. Tests retain the journal generation prepared before the attempted lane PUT and verify later same-ID recovery; legitimate pre-dispatch floor preparation is not confused with a prohibited post-response CAS.

Whole-branch review covered mutation/publication/schema ownership and state/effect/predicate/clock conjunctions, inventory/feed/cleanup authority, security and aggregate design budgets. The source/test evidence and detailed English report are retained with the execution ledger under `.superpowers/sdd/2026-09-29-m7-complete-sync-store/`.

## Remaining gates

1. Separately authorize and measure remote Workers Free CPU/account and storage-admission qualification. No real R2, account or vault was accessed.
2. Run the explicit maximal real-head operational profile; local arithmetic and counted calls are not measured Free-tier feasibility or retry-inclusive billing guarantees.
3. Complete the normal merge/documentation transition only when justified. This local approval does not mark M7 complete or move another milestone to NEXT.
4. Specify and authorize activation independently; do not provision markers, migrate data or alter the current writer from this report.

See the [M7 specification](../milestones/m7-versioned-sync-protocol-and-r2-store.md) and [implementation plan](../superpowers/plans/2026-09-29-m7-complete-sync-store.md) for accepted limits and execution boundaries.
