---
id: OAB-30
title: Use a valid timestamp for hydration conflict copy names
status: Done
assignee:
  - '@pi'
created_date: '2026-10-29T12:16:00Z'
updated_date: '2026-11-05T03:06:00Z'
labels:
  - deferred
dependencies: []
references:
  - apps/plugin/src/sync/reconciliation.ts
  - apps/plugin/src/sync/text-apply.ts
documentation:
  - docs/spec.md
type: bug
ordinal: 48000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner deferred this OAB-8.4 review item. Trigger: conflict names become user visible. Manifest application currently uses at: 0, so hydration conflict copies contain a 1970 date. Preserve stable names across restart and keep every visible copy.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Hydration conflict copy names use a meaningful timestamp instead of the Unix epoch
- [x] #2 Restart retains the same persisted conflict name and does not create duplicate copies
- [x] #3 Tests cover hydration conflict naming and interrupted copy recovery
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Follow approved plan pn-fcb085 Task 2. Add fixed-clock hydration and interrupted-recovery tests before code changes. Set meaningful synthetic observation times and preserve persisted copy identities after restart. Run docs:check and bun run check, then independent review.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
RED: Added fixed-clock hydration recovery and current-authority regressions. Both tests failed because synthetic change.at was 0. The first current-authority run exposed a test setup issue because the test did not set the journal epoch. After the test set the epoch, the expected change.at failure remained. Both RED commands wrapped Vitest, printed observed exit code 1, and exited 0.

Commands: (cd apps/plugin && bun run test -- reconciliation.test.ts -t "uses one durable observation time for a hydration conflict across restart"); (cd apps/plugin && bun run test -- text-apply.test.ts -t "timestamps synthetic current authority before naming a conflict").

GREEN: Both focused tests passed. The full reconciliation test file passed 95 tests. The full text-apply test file passed 84 tests. bun run docs:check passed. bun run check passed lint, docs, typechecks, tests, and builds. Test output showed 56 tooling, 304 protocol, 490 plugin, and Worker groups of 657, 122, and 103 passing tests. Worker tests printed injected network and SQLite errors, but all test groups passed. bunx biome check --write formatted four changed code files. Self-review found no actionable findings.

Limits: These synthetic tests do not measure native Obsidian storage or live-vault behavior. No live vault or service was used.

Independent task review 99dde2ca approved f21dce60b8e53183c6905f13bdc4727ceb7564c0 with no actionable findings. Review covered synthetic versus feed time authority, persisted copy identity, reopened-journal recovery, declaration documentation, and existing revision guards. Focused tests and bun run check passed under worker validation. Synthetic local evidence only. Closure waits for branch reviews.

Final branch closure: whole-branch review 1bacac3f covered the complete branch against current main. Corrective review 88a7015d approved 0dced7590c6484ed1ed28edac87ea78f85906fee and closed R1, R2 and R3. R1 separates epoch mismatch from cursor expiry. R2 covers repeated-plan restart fallback to blob, inline text and tombstone. R3 enforces the UTF-8 recovery-name budget. Reviewers assessed state-policy ownership, contracts, changed named declarations and semantic documentation. Autosquash and current-main integration preserved task source. Human review pn-09d26f approved 3364af028bd726dfdcf5b17aca816455ec21c39d with no annotations. The supervisor separately accepted measured local cost and retained 30,000 ms. Fresh parent docs:check and bun run check passed on that source: 1,776 tests passed, one opt-in measurement skipped. Lint, type checks and builds passed. Active LSP probes found no errors in the principal changed source files. No native desktop or current hosted performance proof ran. Only task closure records change after human approval.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Synthetic hydration and current-authority observations use the configured clock. Restart keeps the persisted timestamp and conflict copy identity. Independent task, whole-branch, corrective, and human reviews passed. Final checks passed 1,776 tests with one opt-in skip. No live vault or service action ran.
<!-- SECTION:FINAL_SUMMARY:END -->
