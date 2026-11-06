---
id: OAB-10.8
title: Remove backup telemetry from the status panel and show retry timing
status: Done
assignee:
  - '@pi'
created_date: '2026-11-05T23:18:00Z'
updated_date: '2026-11-06T02:37:00Z'
labels: []
dependencies: []
documentation:
  - docs/spec.md
parent_task_id: OAB-10
ordinal: 63000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The F4 owner needs clear reasons when sync waits. Backup export does not exist in v1 after PR #55. The panel still shows unknown backup telemetry and lacks one count summary.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The status projection has no backup field. The panel omits Backup and keeps unknown and measured capacity.
- [x] #2 A safe failure with Retry-After shows retry in N s beside its failure class. Failures without retry metadata show no retry text.
- [x] #3 One summary line shows coexistence confirmation and unavailable-path counts when either count is non-zero. Both zero hides the line.
- [x] #4 Real controller tests cover each changed projection and panel output without sync policy changes. bun run check and task and branch reviews pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Use the reviewed P5-plan.md from the owner brief directory. Add failing real-controller projection and panel tests. Remove the backup field and line, keep capacity, show retry in N s, and show one conditional confirmation/unavailable count line. Preserve all sync policy and actions. Run focused tests, docs:check, and bun run check. Complete task review, whole-branch review, human branch review, and one pull request.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
P5 owner brief authorizes parallel execution despite gate dependency order. Write scope covers status-panel.ts, sync/sync-status.ts, settings.ts, their tests, and this task. No personal vault, test vault service writes, deployment, or Cloudflare changes. No new dependency.

Owner approved P5-plan.md in Plannotator pn-35be2b. Baseline focused tests passed: 3 files, 21 tests, exit 0. Worker owns implementation, RED/GREEN, docs:check, bun run check, and commit. Parent owns reviews and publication.

Implementation evidence on branch bugfix/p5-panel-cleanup at reviewed base 091b2b1d82723c03fe78fbfffaf6df5f797ff18d. Focused baseline passed: 3 files, 21 tests, exit 0. TDD RED after test edits: 3 assertions failed and 23 passed across 3 files, exit 1. Focused GREEN: 3 files, 26 tests passed, exit 0. `bun run docs:check` passed. `bun run check` passed lint, docs check, typecheck, tests, and builds. Self-review found no blockers. Controller regressions use DeviceJournal, CoexistenceController, DesktopSyncController, and SyncTransportError. Test evidence does not cover live service timing or a real vault trial. Full report: .superpowers/sdd/P5-plan/task-1-report.md. Task remains In Progress. Do not close acceptance criteria or mark Done.

Commit: 088115c (fix(plugin): clean sync status panel). Final reviewed source revision: 088115c. The worktree has no staged files. The task remains In Progress, with acceptance criteria unchecked.

F1 review correction: Added an integration regression in test/status-panel.test.ts. It reads status from AIBridgePlugin.syncStatus and drives AIBridgePlugin.startSync through the real DesktopSyncController and SyncTransport using synthetic vault, session, timers, and document. It proves no backup property, unknown capacity before sync, measured capacity after a validated summary, a real 429 admission_limited Retry-After 30 failure, panel retry copy, and cleared failure after successful recovery. Focused tests passed: 3 files, 27 tests. `bun run docs:check` passed. Post-merge `bun run check` passed lint, docs check, typecheck, tests, and builds. Task remains In Progress. Acceptance criteria remain unchecked.

Review closure: task review accepted production behavior but found F1, a gap in real plugin projection coverage. Correction acf3d2f adds a real AIBridgePlugin, DesktopSyncController, and SyncTransport composition test. Scoped corrective review closed F1. Session-model complete branch review approved acf3d2f against origin/main 54ad88e. No actionable finding remains. Documentation scope covers all changed declarations and test helpers. Structural candidates status-panel.ts and sync-status.ts remain cohesive presentation and projection owners. Parent merged PR #69 through origin/main at 790dd00 and ran bun run check with exit 0. Worker final correction check also passed. Synthetic boundaries do not prove native Obsidian rendering, live service timing, or real-vault behavior.

Final acceptance: human branch review pn-06739f approved without annotations at bd1cfb5. All four criteria now pass. The real plugin composition regression proves backup omission, capacity, retry metadata and recovery. Real coexistence controller regressions prove both counts and summary removal. Full checks passed after the main merge and after the correction. Earlier In Progress statements describe those historical checkpoints. No actionable finding remains. origin/main 54ad88e is an ancestor of this branch.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Removed obsolete backup telemetry while preserving capacity. The panel shows retry in N s and both wait counts when either count is non-zero. Real plugin and controller tests cover projections and rendering. Focused tests passed 27 tests. Documentation and full project checks passed. Task, corrective, whole-branch, and human reviews passed. No sync policy, vault, service, or cloud change occurred.
<!-- SECTION:FINAL_SUMMARY:END -->
