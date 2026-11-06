---
id: OAB-12.1
title: Bound read slot hold time and expose isolate read capacity
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-06T22:04:00Z'
updated_date: '2026-11-06T22:31:00Z'
labels: []
dependencies: []
parent_task_id: OAB-12
priority: high
type: bug
ordinal: 70000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner W3 brief reports persistent read admission denial on one isolate during iPad VPN hydration. Source work or cancellation can retain all four slots without a deadline. The exact production stall point is unknown.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A fixed hold deadline releases a read slot despite unresolved source work or cancellation. A stalled response fails without successful EOF.
- [ ] #2 Owner measurements show the isolate deadline count and read capacity with the limit explicit, not per-client totals.
- [ ] #3 Regression tests cover unresolved source work, unresolved cancellation, and a consumer that never drains. Each case releases capacity at the deadline.
- [ ] #4 bun run check and task, branch, and owner reviews pass.
- [ ] #5 No Cloudflare resource change or manual deployment occurs.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Plan gate: /tmp/W3-slot-deadline-plan.md. Add a 60000 ms isolate lease deadline from acquisition. Fail stalled bodies without successful EOF and free local slots without waiting for unknown source or cancellation work. Preserve durable uncertainty. Add regression tests first, expose responding-isolate capacity and expiry counts through protected owner measurements, run checks and semantic reviews, complete the owner branch review, then publish one PR and remove the worktree.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The W3 brief authorizes this task under OAB-12 despite gate dependencies. Parallel execution is authorized with write isolation. No personal-vault access. CI deployment after merge recycles the isolates and clears the current stuck isolate. The exact production stall point remains unknown.

Baseline: cd apps/worker && bun run vitest run --config vitest.config.ts test/read-response.test.ts passed (19 tests). RED: the new source, cancellation, and undrained-consumer cases failed in the unmodified implementation; wrapped command recorded observed exit=1. GREEN: focused read-response suite passed (26 tests), owner f2 suite passed (3 tests), and transport-measurements suite passed (3 tests). bun run docs:check passed. bun run check passed lint, docs:check, typecheck, all test projects, and dry-run builds. Biome check and git diff --check passed. Self-review found no open code issue. Read slot expiry is isolate-local and does not prove native source work stopped. No Cloudflare resource change or deployment occurred. CI after merge recycles isolates and clears the current stuck isolate.

Command record. RED ran the focused read-response command with an exit recorder and observed exit 1. GREEN ran cd apps/worker && bun run vitest run --config vitest.config.ts test/read-response.test.ts and passed 26 tests. Owner tests ran cd apps/worker && bun run vitest run --config vitest.f2.config.ts test/f2/owner.test.ts and passed 3 tests. Measurement tests ran cd apps/worker && bun run vitest run --config vitest.config.ts test/transport-measurements.test.ts and passed 3 tests. bun run docs:check, changed-file biome check, git diff --check, and bun run check all passed.
<!-- SECTION:NOTES:END -->
