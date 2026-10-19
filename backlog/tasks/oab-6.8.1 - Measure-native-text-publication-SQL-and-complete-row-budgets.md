---
id: OAB-6.8.1
title: Measure native text publication SQL and complete row budgets
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-19 02:25'
updated_date: '2026-10-19 16:23'
labels:
  - F1
dependencies:
  - OAB-6.3
documentation:
  - docs/spec.md
parent_task_id: OAB-6.8
type: task
ordinal: 34000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Trigger: before OAB-6.8 reports aggregate platform budgets or before publication changes SQL statement or row budgets.

OAB-6.3 measured native database growth and content size, but it did not measure SQL statement counts or complete row sizes. Independent Task 3 review found this bounded evidence gap. Existing publication and rollback tests remain valid, but they do not prove these storage budgets.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Native publication workloads report observed SQL execution counts and maximum bind-parameter counts for create, update, DELETE, replay, and rejection.
- [ ] #2 Tests measure complete file, revision, and receipt row sizes for 1,000,000-byte Markdown and Canvas content with worst-case bounded metadata.
- [ ] #3 Evidence separates content bytes, encoded row sizes, database growth, and whole-runtime memory without claiming unmeasured platform headroom.
- [ ] #4 All observations use the real pinned runtime without SDK shims or unchecked casts.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Owner-approved prerequisite in docs/superpowers/plans/2026-10-19-f1-history-mutations.md. Measure existing native publication SQL executions, bind counts, complete row encodings, and database growth before OAB-6.4 changes publication SQL. Use the pinned real runtime without SDK replacements or unchecked casts. Separate these observations from unmeasured whole-runtime memory. Plan approval remains pending.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implementation note: the initial observer test was added after observer wiring, so no earlier functional RED was recorded. The completed native logger coverage test exercises real publication dispatch and stored state; this is a TDD process exception.

Recovery round 4 completes Task 1 under approved plan pn-d60fcc. The original observer code stays intact. Its initial functional RED is absent, as the earlier note states. New native lifecycle tests characterize retained behavior. Record tests first exposed the missing payload-free integer-one encoding: 2 failed and 32 passed, observed exit 1. The wrapped RED command returned 0. The corrected encoder passes all cases. Native measurements cover create, update, DELETE, replay, and stale-precondition rejection in four maximum-size workloads. Each uses 1,000,000 content bytes, 512 path bytes, 2,048 client bytes, and a 128-code-point key with 512 bytes. Separate metadata cases exercise lowercase expansion and JSON escaping. Native rows, history, FTS, receipts, and rollback snapshots corroborate outcomes. Reservation, authorization, commit, and settlement counts remain separate. Maximum observed bindings: 13. Largest encoded file, revision, and receipt records: 1,003,440, 1,002,663, and 3,868 bytes. Largest receipt JSON: 1,223 bytes. Database growth: 3,399,680 Markdown bytes and 2,043,904 Canvas bytes per lifecycle. Setup writes stay outside growth intervals and dispatch spans. No application SQL bypasses Drizzle in these three owners. Counts exclude internal FTS SQL and implicit transaction control. Whole-runtime memory remains unmeasured. No aggregate headroom claim applies. Focused native tests: 48 passed, exit 0. docs:check: exit 0. Full bun run check: 598 tests passed, zero failed, exit 0. This total includes tooling 52, protocol 229, plugin 2, native Worker 299, and HTTP Worker 16. Builds use dry-run mode. No dependencies or publication SQL changed. Parent review and acceptance closure remain pending.
<!-- SECTION:NOTES:END -->
