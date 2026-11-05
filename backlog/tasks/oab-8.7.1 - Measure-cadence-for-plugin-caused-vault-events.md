---
id: OAB-8.7.1
title: Measure cadence for plugin-caused vault events
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-03T00:36:00Z'
updated_date: '2026-11-05T21:28:00Z'
labels: []
dependencies: []
parent_task_id: OAB-8.7
type: task
ordinal: 55000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Trigger: F4 measurement. Plugin-caused vault events reach the lifecycle controller, set activeSince, and can force the 15-second cadence before publication consumes echoes. Measure this effect and distinguish plugin-generated events from genuine user edits. Preserve echo suppression and durable local intent. Owner deferred this policy during OAB-8.7 branch review.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Genuine user edits update recent activity and select the 15-second foreground polling cadence.
- [ ] #2 Plugin-generated events retain echo suppression and do not lose or duplicate durable local intent.
- [ ] #3 Tests measure event origin, queue admission, echo suppression, and selected cadence.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Plan review: /tmp/oab-8-7-1/cadence-plan.md. Measure real-controller origins, queue admission, echoes, and cadence. Record plugin origins at the approved text-vault boundary. Use origin only for activity selection. Preserve capture-before-debounce, fence semantics, and durable publication intent. Add failing regressions, implement through one worker, run bun run check, complete task and branch reviews, receive human branch review, then publish one PR.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The owner F4 brief activates the measurement trigger. Parallel execution is authorized. P3 owns cadence, vault events, publication, their tests, and this task only. No live vault or service actions are planned.

Supervisor approved scope expansion through the P3 scope question: text-vault.ts and its tests can record plugin event origins at the mutation boundary. The real-controller probe measured an exact expected-write echo at 15000 ms with zero pending operations and its marker consumed. A user edit selected 15000 ms with one pending operation. No vault or network access occurred.

RED: `set +e; bun run --cwd apps/plugin test test/desktop-sync.test.ts; code=$?; printf ...; test "$code" -ne 0` exited 0 and recorded test exit 1. The new cadence assertion failed as expected: plugin event selected 15000 ms instead of 60000 ms.
GREEN: `bun run --cwd apps/plugin test test/desktop-sync.test.ts test/vault-events.test.ts test/text-vault.test.ts test/publication.test.ts` passed 4 files and 95 tests.
Checks: `bun run docs:check` passed. `bun run check` passed lint (263 files), docs, all 4 workspace typechecks, tests (tooling 91, protocol 307, plugin 606 passed plus 1 skipped, Worker 925 across 3 runs), and builds. Worker tests print expected injected network, stream, and SQLite failure diagnostics.
Limits: No real host timing or vault was tested. Delayed host events after mutation settlement classify as local; event admission, capture order, queue intent, and expected-write ownership remain unchanged.

Exact RED command: `set +e; bun run --cwd apps/plugin test test/desktop-sync.test.ts; code=$?; printf 'observed exit code=%s\\n' "$code"; test "$code" -ne 0`. Shell exit was 0 and Vitest exit was 1 on the expected 15000 ms versus 60000 ms assertion. The focused GREEN command passed 4 files and 95 tests after integration coverage.

Follow-up review fix RED: `set +e; bun run --cwd apps/plugin test test/vault-events.test.ts; code=$?; printf 'observed exit code=%s\\n' "$code"; test "$code" -ne 0` exited 0 and recorded Vitest exit 1. The expired same-path user event still selected 60000 ms.\nFollow-up GREEN: the same-path test passes after one exact host event is attributed to a mutation. Other matching events default to local. Shared adapters receive one event classification by source identity and listener count. Overlapping same-key mutations remain ambiguous and local.\nValidation after fix: focused plugin suite passed 4 files and 95 tests. `bun run docs:check` passed. `bun run check` passed lint (263 files), docs, four workspace typechecks, tests (tooling 91, protocol 307, plugin 606 and 1 skipped, Worker runs 688, 122, and 115), and builds. No host or network action occurred.
<!-- SECTION:NOTES:END -->
