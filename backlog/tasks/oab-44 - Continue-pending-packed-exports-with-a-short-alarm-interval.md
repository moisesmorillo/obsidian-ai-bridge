---
id: OAB-44
title: Continue pending packed exports with a short alarm interval
status: In Progress
assignee: []
created_date: '2026-11-07T15:17:00Z'
updated_date: '2026-11-07T15:25:00Z'
labels:
  - worker
  - F6
  - backup
dependencies: []
priority: medium
type: bug
ordinal: 80000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner order 2026-11-07: the hourly packed export advances 1 MiB per alarm step, but Vault.alarm() reschedules every pending export with RETENTION_CONTINUATION_MS (60 s). An 18 MB snapshot takes about 20 minutes and a vault above about 55 MB cannot finish inside one hour, so the next hourly export skips as busy. Observed on the first scheduled export (15:00:37 UTC, ongoing multipart for more than 15 minutes). Fix: when an export is pending, reschedule the alarm with a short interval (1 s, the same value the constructor path uses), and keep 60 s only for retention and GC continuation. Keep every step bounded as it is. No change to step budgets, buckets, or lifecycle. Worker only.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A pending export reschedules the alarm with a short interval (about 1 s), not 60 s. Retention and GC continuation keep 60 s.
- [ ] #2 A unit test proves the alarm interval selection for pending export, pending retention, pending GC, and idle.
- [ ] #3 docs/packed-export-restore.md or docs/spec.md states the expected snapshot duration for the current step budgets.
- [ ] #4 bun run check green and Worker preflight green before the PR.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
# Short export alarm interval

Goal: Continue pending packed exports after 1,000 ms without changes to bounded work or storage.
Architecture: Vault.alarm() selects export delay first, maintenance delay second, and nightly scheduling last.
Tech stack: TypeScript, Bun, existing Worker test fakes.
Spec: docs/spec.md section 16 and OAB-44.

Owner decisions
- Follow the unattended brief. No Plannotator gate and no live service calls.
- Use a 1,000 ms export delay. Keep retention and GC at 60,000 ms.
- Preserve the catch path and all export budgets. No new dependency.
- Change one duration line in docs/packed-export-restore.md. Explain that latency and source-range limits affect duration.

Task 1
- [ ] Read existing alarm tests and verify the local baseline.
- [ ] Add failing alarm tests for pending export, retention, GC, idle, and export precedence with maintenance.
- [ ] Record the expected failing interval assertion before the fix.
- [ ] Change only alarm interval selection in vault.ts and the documentation line.
- [ ] Run focused tests, bun run check, and Worker preflight with local fakes only.
- [ ] Commit the task changes and report commands, results, and risks.
- [ ] Complete task review and whole-branch review. Rebase on origin/main before publication.
- [ ] Push, open one PR against main, remove the worktree, report its URL, and stop.

Review focus
- Export delay takes precedence when retention or GC also has work.
- Idle keeps the next 03:00 UTC alarm.
- The catch path keeps its 60-second retry.
- Export budgets and storage behavior stay unchanged.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
RED before implementation: `cd apps/worker && bunx vitest run --config vitest.config.ts test/vault-retention-alarm.test.ts` failed as expected. The export-alone and export-with-retention-and-GC cases each scheduled 60,000 ms and failed the 1,000 ms upper bound. The other 9 tests passed. An initial malformed focused command and a wrong-root test path also failed before the valid RED command; neither ran test cases.

GREEN after implementation: `cd apps/worker && bunx vitest run --config vitest.config.ts test/vault-retention-alarm.test.ts` passed (1 file, 11 tests). `bun run docs:check` passed (exit 0). `bun run check` passed (exit 0): Biome, docs check, all package typechecks, tests (2,263 passed, 1 skipped), and builds. Expected local fake-driven Worker stream/rollback error diagnostics appeared during passing Worker tests. `bun run --filter '@obsidian-ai-bridge/worker' preflight` passed (exit 0). `git diff --check` passed (exit 0). Review found no blockers. Scope stayed in Vault alarm interval scheduling, tests, and one packed-export duration documentation line. No live service calls, vault access, Cloudflare resource changes, or deployment.
<!-- SECTION:NOTES:END -->
