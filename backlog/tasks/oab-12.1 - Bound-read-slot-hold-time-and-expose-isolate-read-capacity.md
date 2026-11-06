---
id: OAB-12.1
title: Bound read slot hold time and expose isolate read capacity
status: Done
assignee:
  - '@pi'
created_date: '2026-11-06T22:04:00Z'
updated_date: '2026-11-06T23:08:00Z'
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
- [x] #1 A fixed hold deadline releases a read slot despite unresolved source work or cancellation. A stalled response fails without successful EOF.
- [x] #2 Owner measurements show the isolate deadline count and read capacity with the limit explicit, not per-client totals.
- [x] #3 Regression tests cover unresolved source work, unresolved cancellation, and a consumer that never drains. Each case releases capacity at the deadline.
- [x] #4 bun run check and task, branch, and owner reviews pass.
- [x] #5 No Cloudflare resource change or manual deployment occurs.
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

Review round 1 correction. RED added an early-release response expiry test. It failed with expected exit 1 because expired_count stayed at 0. GREEN: cd apps/worker && bun run vitest run --config vitest.config.ts test/read-response.test.ts passed 27 tests. The focused early-release regression passed. bun run docs:check passed. Changed-file Biome check passed. bun run check passed all lint, documentation, type, test, and dry-run build steps. The count now tracks every incomplete lease that reaches its deadline. A prior slot release remains idempotent.

Review round 1 RED command: cd apps/worker && bun run vitest run --config vitest.config.ts test/read-response.test.ts -t 'counts expiry after capacity release'. It recorded exit 1 because the expiry count stayed unchanged. GREEN command: cd apps/worker && bun run vitest run --config vitest.config.ts test/read-response.test.ts passed 27 tests. bun run docs:check and bun run check passed. The check passed 710 Worker tests, 122 HTTP tests, 115 f2 tests, all other workspace tests, type checks, lint, and dry-run builds.

Branch review correction wave from b398c223535aaf736792f182b5744bc1ad9400a8. Added a fixed-length response test that feeds 128 x 65,536-byte chunks to the real fixed-length writer without reading its body. The source calls settle below EOF and remain stable for three timer turns, proving the writer blocks on downstream backpressure. The real read lease then reaches 60,000 ms, releases capacity, increments the expiry count once, and makes a newly acquired slot available. Reading the body after expiry rejects, not EOF. The regression passed without changing read-response implementation code, so the already-green code stayed intact. ReadSlotCapacitySnapshot now derives from NonNullable<MeasurementResponse["worker_isolate"]> via the public protocol package type. RED was not applicable because the existing behavior passed the new regression. GREEN: cd apps/worker && bun run vitest run --config vitest.config.ts test/read-response.test.ts passed 28 tests. bun run biome check apps/worker/src/application/read-budget.ts apps/worker/test/read-response.test.ts and git diff --check passed. bun run docs:check passed. bun run check passed lint, docs, all workspace type checks, 711 Worker tests, 122 HTTP tests, 115 F2 tests, 307 protocol tests, 91 tooling tests, 724 plugin tests with 1 skipped, and dry-run builds. New revision awaits commit.

Final review correction code commit: 05a34cc7ed8cb2ed74e22bb7aed3b10f6cadd6bb. The fixed-writer deadline test and public protocol-derived snapshot type are committed. The task remains In Progress. Worktree was clean with no staged changes after the code commit.

Final review record: reviewed code revision 05a34cc and complete branch through 872e528 against main 17f2666. Independent task review found the early-release expiry counter gap. Commit b398c22 fixed it with RED/GREEN evidence, and scoped review approved closure. Whole-branch review found missing native fixed-writer backpressure proof and duplicate measurement contract ownership. Commit 05a34cc adds the passing runtime regression and derives the snapshot type from the protocol contract. Scoped review f8c4c684 approved both closures. Documentation scope covers lease helpers, response lifetime, route ownership, canonical schema, test helpers, and docs/api/measurements.md. Stateful candidates remain cohesive across lease capacity, response framing, MCP ownership, and protected owner presentation. No actionable finding remains. The owner approved plan pn-4e2c61 and complete branch review pn-6e2e63 without changes. Final worker bun run check passed, including 711 Worker tests, 122 HTTP tests, and 115 F2 tests. Main remains 17f2666 and rebase changed no code. Production stall cause, disconnect signals, and physical native cleanup remain unproven. No live-service, vault, manual deployment, or Cloudflare resource action occurred. CI deployment after merge recycles isolates and clears current stuck capacity.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Bound read ownership at 60000 ms without increasing the four-slot limit. Expiry frees local capacity and fails incomplete responses without successful EOF. Owner JSON and HTML show responding-isolate capacity and incomplete-lease expiry counts. Regression tests cover unresolved source work, cancellation, generic and native fixed-writer backpressure, late completion, early release, and normal completion. Full checks and task, branch, corrective, and owner reviews passed. Physical work can remain unresolved after capacity release. The owner merges and CI deploys.
<!-- SECTION:FINAL_SUMMARY:END -->
