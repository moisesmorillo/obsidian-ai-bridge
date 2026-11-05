---
id: OAB-8.7.1
title: Measure cadence for plugin-caused vault events
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-03T00:36:00Z'
updated_date: '2026-11-05T22:22:00Z'
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

Correct branch-review findings F1 and F2 together. Add failing regressions for refused conditional process origin, delayed reads after mutation settlement, and deferred proofs across ordered admission, debounce, pause/resume, close, status, and waitForIdle. Then implement conservative effect proof and cadence-only async completion. Preserve capture, publication, markers, and fences.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The owner F4 brief activates this measurement task. P3 owns cadence, vault events, publication, their tests, and this task. No live host or service actions belong to this branch.

The initial probe used real DesktopSyncController, PublicationController, DeviceJournal, and TextApplyEngine with in-memory ports. An exact echo selected 15000 ms with zero pending operations. A different user edit selected 15000 ms with one pending operation. No host or network action occurred.

Earlier RED: The initial regression recorded plugin activity selecting 15000 ms instead of 60000 ms. Earlier GREEN: Four focused plugin files passed, first 95 and then 96 tests. Review round 1 found first-event attribution unsafe. Commit 2fc4b889 bounded attribution but still relied on event order. Review round 2 found a same-path user event could arrive before plugin output and incorrectly select 60000 ms.

Correction to earlier notes: `Vault.read` and `Vault.readBinary` return asynchronous current content. They do not provide immutable event-time snapshots. A proof is local if its content read finishes after mutation settlement. Successful mutation settlement and the conditional process acceptance flag also gate plugin origin. A refused process callback cannot prove plugin activity.

Whole-branch review F1 and F2 RED: `bun run --cwd apps/plugin test test/desktop-sync.test.ts test/vault-events.test.ts test/text-vault.test.ts test/publication.test.ts` exited 1 before implementation. Four test files reported seven new failures and 96 passing existing tests. Regressions cover an active refused process callback with user bytes equal to target, a delayed read across a later plugin write, immediate event retention and debounce, ordered publication admission, pause/resume, close before proof, `isBusy`, and `waitForIdle`.

F1 GREEN: The tracker accepts origin only after matching content was read before mutation settlement and the effect settled successfully. `ObsidianTextVault.process` passes its callback acceptance flag. Later reads, refused callbacks, overlapping effects, missing targets, and read failures remain local.

F2 GREEN: Capture still runs before event retention and debounce. After capture, the controller records local activity and retains or schedules the event without waiting for origin proof. Detached proof can revise only cadence when activity and lifecycle revisions still match. Pause, resume, close, and newer activity fence stale proof. Cadence-only completion does not change `isBusy`, queue state, admission order, or `waitForIdle` settlement.

Focused GREEN: The four required plugin test files passed 103 tests. `bun run docs:check` passed. The branch merged `origin/main` at bd3fc7a in merge commit 3eb3596 before the final full check. The merge had no conflicts and preserved upstream files.

Deferred coexistence follow-up: OAB-10.6, `Keep plugin remote destructive events out of coexistence confirmations`, is Deferred under OAB-10. It records a relayed and unverified report from origin/main bd3fc7a at cursor 180 on 2026-11-05 about 22:05Z. Trigger: the next F4 coexistence correction after OAB-8.7.1 merges. No real vault was accessed.

Final validation and commit details are recorded in the implementation report. No live vault, browser, service, or network action occurred.
<!-- SECTION:NOTES:END -->
