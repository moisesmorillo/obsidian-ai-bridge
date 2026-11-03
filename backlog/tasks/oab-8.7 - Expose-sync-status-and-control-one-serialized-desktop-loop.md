---
id: OAB-8.7
title: Expose sync status and control one serialized desktop loop
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-28T19:31:00Z'
updated_date: '2026-11-03T00:53:00Z'
labels: []
dependencies:
  - OAB-8.6
  - OAB-8.9
documentation:
  - docs/spec.md
parent_task_id: OAB-8
ordinal: 45000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make the complete synchronizer usable from Obsidian without falsely claiming settled state. One focused PR. decision-1 adds the device revocation obligation. Owner-interactive proof remains in OAB-8.8.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 One serialized loop uses 15, 60, and 300 second polling, two-second event debounce, immediate load/resume/Sync now, and at most four network requests.
- [ ] #2 Status panel shows section 7.9 states and per-path reasons with labelled keyboard controls. Settled needs empty queues, confirmed cursor/head equality, and persisted state.
- [ ] #3 AC-08 device tests show revoked, stop publishing and applying, preserve files and queued work, and offer Reconnect. Pause preserves queues and stops effects.
- [ ] #4 Panel reports unsupported files, storage failures, operation failures, and server backup/capacity state without treating absent telemetry as success. Unload releases host resources.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Approved plan: .pi/plans/oab-8.7-desktop-loop.md. One worker implements the serialized lifecycle controller and truthful status panel. Preserve shared effect owners and exact revision authority. Run RED/GREEN tests, docs:check, and bun run check. Independent task review, whole-branch review, and owner branch review precede publication.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner decision 2026-11-02: close the OAB-8.9 journal successor fix before the status panel. OAB-8.9 is now a direct dependency so the launcher takes it first.

Owner approved plan pn-b379a1. Retain Rebuild local index only through full spec 7.3 reconciliation: absence never deletes and dirty paths receive conflict copies. Add one Deferred backup telemetry task with F3b export delivery as its trigger. Baseline bun run check passed exit 0 at 83f6048. No live service or vault access.

Added lifecycle and status tests before implementation. Source checks first found missing controller and status modules, but the focused test runner did not record a behavioral red before implementation. Focused tests passed: 33 plugin tests. bun run docs:check passed. bun run check passed with 93 test files and 1607 tests. Self-review confirmed one lifecycle queue, shared apply engine, validated revocation classification, full manifest rebuild, and unknown backup telemetry. Real service and vault checks remain reserved for OAB-8.8. Unsupported and excluded path lists render only on request.

Review correction evidence (2026-11-03): The reviewer requested lifecycle interleaving tests, promise rejection handling, and removal of duplicate TSDoc. Before production edits, the settings-boundary test failed because Sync now and Rebuild attached no rejection handlers. The assertion found zero calls to Promise.catch. Real createPublication, DeviceJournal, and DesktopSyncController tests now hold delayed feed, pinned-file, and mutation responses across pause, revocation, unload, and session replacement. The tests verify that no later request or vault write starts, sent queue records and payloads remain intact, and replacement composition waits for old work. Main host boundaries now consume rejected startup, Sync now, Rebuild, resume, visibility, event, and revocation actions. Controller tests cover failed cycles and rebuilds. Removed duplicate SyncStatusInput TSDoc. Review correction checks: bunx biome check --write passed; bun run docs:check passed; focused tests passed, 3 files and 19 tests; bun run check passed, 94 test files and 1,615 tests. Acceptance criteria and task status remain unchanged. Live vault and service tests remain for OAB-8.8. Independent corrective review remains pending.

Whole-branch correction evidence (2026-11-03): Closed every major and minor finding at reviewed commit 4fe7695. F1: resume reinstalls polling before it processes empty or retained queues; controller tests cover both. F2: a fresh journal enrolls before local scan or publication; the real plugin startup test uploads local content, sets the remote epoch and base, clears operations, and creates no old-epoch attention. F3: DesktopSyncController drops paths that canonical enrollment policy excludes before retry admission; a path above 512 bytes cannot block a valid event or immediate cycle. Transient event errors still requeue. F4: final cycle notification runs after busy ownership clears; the test checks the final emitted snapshot. F5: removed Rebuild from the panel, settings actions, DesktopSyncOptions, DesktopSyncController, and its tests. Added a panel test that confirms no Rebuild button. Updated the main class TSDoc.

Owner findings: settled status now stays pending after a cycle failure, even if a prior feed head matched the cursor. A projection test covers the stale head case. DOM tests verify focus restoration and aria-expanded changes. Publication records revocation attention only for 401 with code revoked. A generic 401 test confirms no revoked label. Main teardown shares releaseSyncOwners across unload, replacement, and revocation. sync-status.ts documents persistence, activity, failure, storage, counts, and capacity warning semantics.

RED evidence: controller tests failed for missing resume intervals, invalid-path blocking, and final busy status. A fresh-start test failed with false old-epoch attention when enrollment was disabled. Projection, generic 401, focus, and disclosure tests failed before their fixes. GREEN evidence: targeted tests passed, 6 files and 79 tests. bun run docs:check passed. bun run check passed with 96 test files and 1,625 tests. Formatting, typecheck, and builds passed. Expected Worker injected-failure diagnostics remained and the check exited 0.

Created Deferred task OAB-8.7.1 for the F4 event-cadence measurement. It will distinguish plugin-generated effects from genuine user edits without losing echo suppression or local intent. This cadence change is deferred and not implemented here. OAB-8.7 remains In Progress and every acceptance criterion remains unchecked.

Keyboard-focus correction (2026-11-03): The reviewer found focus loss when the Pause label changes to Resume. A new test focuses Pause, renders paused status, and checks focus on Resume. The test failed before the panel change. Panel actions now use stable focus IDs for refresh restoration. Visible labels and aria-expanded behavior remain unchanged. Focused panel tests passed, 1 file and 4 tests. bun run docs:check passed. bun run check passed with 96 files and 1,626 tests. Formatting, typecheck, and builds passed. OAB-8.7 remains In Progress and acceptance checks remain unchecked. No live service or vault test ran.

Review closure at source 999ddb7027eb4aa539139bb8e549cb66f61b5a60: task review and bounded corrective reviews close all findings from the whole-branch review and owner feedback. F1 restores polls after pause. F2 enrolls before publication. F3 excludes invalid paths before retry admission. F4 clears busy ownership before final refresh. F5 removes Rebuild under owner approval. Failure blocks stale-head settled status. Stable action identities preserve Pause-to-Resume focus. DOM tests cover focus and aria-expanded. Generic 401 does not claim revoked. Shared releaseSyncOwners owns teardown. Class and status TSDoc now match effects and evidence. Structural audit covers desktop lifecycle, main host wiring, shared composition, pure status policy, and panel rendering. No competing mutation or protocol owner exists. Full worker check passes 96 files and 1626 tests. Reviewers inspect worker evidence without rerunning checks. Real-host, two-vault, and deployed-service proof remain in OAB-8.8. OAB-34 backup telemetry and OAB-8.7.1 F4 cadence measurement remain Deferred. Original behavioral RED exception remains recorded. Owner branch diff review remains pending.
<!-- SECTION:NOTES:END -->
