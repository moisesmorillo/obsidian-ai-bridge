---
id: OAB-6.8.1
title: Measure native text publication SQL and complete row budgets
status: Done
assignee:
  - '@pi'
created_date: '2026-10-19 02:25'
updated_date: '2026-10-19 16:30'
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
- [x] #1 Native publication workloads report observed SQL execution counts and maximum bind-parameter counts for create, update, DELETE, replay, and rejection.
- [x] #2 Tests measure complete file, revision, and receipt row sizes for 1,000,000-byte Markdown and Canvas content with worst-case bounded metadata.
- [x] #3 Evidence separates content bytes, encoded row sizes, database growth, and whole-runtime memory without claiming unmeasured platform headroom.
- [x] #4 All observations use the real pinned runtime without SDK shims or unchecked casts.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Owner approved pn-d60fcc and docs/superpowers/plans/2026-10-19-f1-history-mutations.md. Measure existing native publication query dispatch, bind counts, complete row encodings, and database growth before OAB-6.4 changes publication SQL. Corroborate dispatch counts with native outcomes. Exclude internal FTS SQL and implicit transaction control. Use the pinned real runtime without SDK replacements or unchecked casts. Keep whole-runtime memory unmeasured.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implementation note: the initial observer test was added after observer wiring, so no earlier functional RED was recorded. The completed native logger coverage test exercises real publication dispatch and stored state; this is a TDD process exception.

Recovery round 4 completes Task 1 under approved plan pn-d60fcc. The original observer code stays intact. Its initial functional RED is absent, as the earlier note states. New native lifecycle tests characterize retained behavior. Record tests first exposed the missing payload-free integer-one encoding: 2 failed and 32 passed, observed exit 1. The wrapped RED command returned 0. The corrected encoder passes all cases. Native measurements cover create, update, DELETE, replay, and stale-precondition rejection in four maximum-size workloads. Each uses 1,000,000 content bytes, 512 path bytes, 2,048 client bytes, and a 128-code-point key with 512 bytes. Separate metadata cases exercise lowercase expansion and JSON escaping. Native rows, history, FTS, receipts, and rollback snapshots corroborate outcomes. Reservation, authorization, commit, and settlement counts remain separate. Maximum observed bindings: 13. Largest encoded file, revision, and receipt records: 1,003,440, 1,002,663, and 3,868 bytes. Largest receipt JSON: 1,223 bytes. Database growth: 3,399,680 Markdown bytes and 2,043,904 Canvas bytes per lifecycle. Setup writes stay outside growth intervals and dispatch spans. No application SQL bypasses Drizzle in these three owners. Counts exclude internal FTS SQL and implicit transaction control. Whole-runtime memory remains unmeasured. No aggregate headroom claim applies. Focused native tests: 48 passed, exit 0. docs:check: exit 0. Full bun run check: 598 tests passed, zero failed, exit 0. This total includes tooling 52, protocol 229, plugin 2, native Worker 299, and HTTP Worker 16. Builds use dry-run mode. No dependencies or publication SQL changed. Parent review and acceptance closure remain pending.

Independent reviewer 99ed6680 approved spec compliance and task quality at c2661ff. All four criteria have native workload and record-encoding evidence. T1-R1 fixed: replaced the stale pending-approval sentence with approval pn-d60fcc. Also correct the same stale approval state in OAB-6.4. No source change applies to this correction. The parent inspected the saved report, review, and focused output without repeating worker tests. Measurements count application SQL dispatch with separate native outcomes. Internal FTS SQL, implicit transactions, aggregate capacity, and whole-runtime memory remain outside the evidence boundary.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Measured existing native publication before OAB-6.4 changes SQL. Four maximum-size Markdown/Canvas lifecycles cover create, update, DELETE, replay, and rejection. Maximum bindings: 13. Largest encoded file, revision, and receipt records: 1,003,440, 1,002,663, and 3,868 bytes. Focused tests: 48 passed. Full check: 598 passed, zero failed. Independent review approved at c2661ff. The early observer retains its recorded RED exception. Counts exclude internal FTS SQL and implicit transaction control. Runtime memory and aggregate headroom remain unmeasured.
<!-- SECTION:FINAL_SUMMARY:END -->
