---
id: OAB-39
title: Raise the timeouts of the slow MCP read tests on hosted CI
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-04T21:36:00Z'
updated_date: '2026-11-04T21:55:00Z'
labels: []
dependencies: []
references:
  - OAB-8.10
type: bug
ordinal: 59000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Main Check run 41910335564 failed on 5-second MCP read test timeouts. Run 41629281728 currently reports success. The owner brief also names the slow shared-slot case near line 1454. OAB-8.10 records the same hosted-CI limit for large plugin cases. Keep every assertion and runtime limit unchanged.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The five named slow MCP read tests use an explicit bounded timeout.
- [ ] #2 No assertion, fixture size, production limit, or global test timeout changes.
- [ ] #3 The focused MCP read tests and bun run check pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Use the shared S3 plan in the owner scratch directory. Set explicit 30,000 ms timeouts on the five heavy MCP read integration tests. Preserve every assertion, fixture, runtime limit, and global timeout. Use the existing failing hosted-CI evidence as RED. Run the focused suite, docs:check, and bun run check. Complete task and branch review, then human branch review. Publish PR 1 and stop.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Planning evidence: gh run view 41910335564 shows 5,000 ms timeouts for byte-heavy prefix and durable admission lifecycle tests. Run 41629281728 currently reports success, unlike the brief. No implementation change yet. Shared plan awaits approval.

Implemented the five named MCP read test timeout updates only. The two existing 15,000 ms limits now use 30,000 ms, and the three default limits now use explicit 30,000 ms arguments. Assertions, fixture sizes, production limits, and global timeout remain unchanged. Updated the explanatory bounds comments for all five tests.

Validation: hosted CI run 41910335564 provides existing RED evidence for the two 5,000 ms timeouts. Per the task brief, no local failure was manufactured. Unchanged baseline focused command `cd apps/worker && bunx vitest run --config vitest.f2.config.ts test/f2/mcp-reads.test.ts` passed 1 file and 17 tests. The same focused command after the edit passed 1 file and 17 tests. `bun run docs:check` passed. `bun run check` passed: lint, docs check, typecheck, all test groups, and build exited 0. Test groups reported 56 tooling, 304 protocol, 483 plugin, and 882 worker tests across three worker runs. Worker tests printed simulated network/SQLite exceptions, but all suites passed. Task remains In Progress for parent review.

Task review at 1c2642bc24aeb3b2c19b9e7f558736d87a002280: APPROVE WITH NOTES. Scope: timeout comments, five arguments, and task record. No structural or product finding. Closure for minor CI-result conflict: corrected the description to match the inspected run results. The description no longer claims run 41629281728 failed. Validation evidence comes from the worker report. Parent did not rerun worker checks.
<!-- SECTION:NOTES:END -->
