---
id: OAB-8.7.1
title: Measure cadence for plugin-caused vault events
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-03T00:36:00Z'
updated_date: '2026-11-05T21:46:00Z'
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
The owner F4 brief activates the measurement trigger. P3 owns cadence, vault events, publication, their tests, and this task only. No live host or service actions are planned.

Supervisor approval included text-vault.ts and its tests. The initial probe measured an exact echo at 15000 ms with zero pending operations, and a user edit at 15000 ms with one pending operation.

Initial RED: The wrapped desktop-sync test command recorded Vitest exit 1. Plugin activity incorrectly selected 15000 ms instead of 60000 ms.
Initial GREEN: The focused plugin command passed four files and 95 tests.

Review round 1 found that the first matching same-path event could be a user event. Commit 2fc4b889 bounded attribution to one event but still relied on event order.

Review round 2 RED: The wrapped text-vault test command recorded Vitest exit 1. A same-path user event arrived before plugin output after the activity window expired and selected 60000 ms instead of 15000 ms.
Review round 2 GREEN: The focused plugin command passed four files and 96 tests. A real ObsidianTextVault mutation emitted different user bytes first, then the exact plugin target. The user event selected 15000 ms and remained admitted. The later exact plugin event retained the idle cadence.

Origin proof now compares event-time text or binary bytes with the intended mutation target. Unknown reads, deletes, renames, repeated events, and overlapping same-key effects default to local origin. Adapter listeners share one proof for one dispatch. Capture still runs before DesktopSyncController awaits the proof. Queue admission and publication echo ownership remain unchanged.

Validation: bun run docs:check passed. bun run check passed lint on 263 files, docs, all four workspace typechecks, tests, and builds. Test totals were tooling 91, protocol 307, plugin 607 passed with one skipped, and Worker runs 688, 122, and 115 passed. Worker tests printed simulated network, stream, and SQLite failure diagnostics. No live host, vault, browser, service, or network action occurred.
<!-- SECTION:NOTES:END -->
