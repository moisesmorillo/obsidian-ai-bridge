---
id: OAB-11.8
title: Exclude plugin-applied remote renames from coexistence confirmations
status: Done
assignee: []
created_date: '2026-11-06T18:23:00Z'
updated_date: '2026-11-06T21:40:00Z'
labels: []
dependencies: []
parent_task_id: OAB-11
type: bug
ordinal: 68000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A remote create, rename, and put sequence enters a false local rename confirmation. The effect fence then blocks the put and cursor.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A feed rename applied by the plugin never enters the confirmation queue and never blocks the effect fence.
- [x] #2 A genuine local rename still needs confirmation.
- [x] #3 A regression test covers remote create, rename, and put with coexistence enabled. The put applies and the cursor advances.
- [x] #4 bun run check and reviews pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Reproduce remote create, rename, and put with real controllers and asynchronous host reads. 2. Correct exact rename origin proof without weakening local capture. 3. Test uncertain, duplicate, failed, and later local events. 4. Bump plugin metadata to 0.1.2. 5. Run bun run check, task review, whole-branch review, and human branch review. 6. Publish one PR and remove the worktree.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner authorization dated 2026-11-06 covers F5 copy-vault work through the supervisor. This task uses tests only. No personal vault, live service, or device access. Release metadata changes to 0.1.2. The supervisor creates the tag after merge.

Owner decision: extend write scope to apps/plugin/src/infrastructure/vault-events.ts for the exact rename proof fix if the regression confirms the timing defect. No other infrastructure file enters scope.

RED: `cd apps/plugin && bun run test -- test/vault-events.test.ts -t 'accepts an exact rename proof when its destination read settles late'` failed before source edits because exact bytes read after settlement returned false. Root cause: `verifyMutationTarget` sampled `marker.settled` after the read and rejected late exact evidence. The fix retains exact source identity, destination path, bytes, ambiguity/claim checks, and accepted settlement. Create/modify still require an active read. Focused suites passed: 3 files, 44 tests. `bun run docs:check` passed. `bun run check` passed with all tests/builds. Full create/rename/put plus cursor integration remains unproven: an attempted gated test timed out before reaching the read. Host fakes do not prove real Obsidian timing. Release metadata is 0.1.2. Parent review remains pending.

Commit: ef081d4. OAB-11.8 remains In Progress because the exact create/rename/put cursor regression and independent reviews remain open.

Follow-up regression passed. A real replay test now uses ReconciliationController, TextApplyEngine, CoexistenceController, DesktopSyncController, and VaultEventAdapter for create Sin título.md, rename to iphone-test-1.md, then put revision 2. It asserts source tombstone and destination revisions, cursor 3, applied content, empty pending apply, zero confirmations, and open fence. A wrapped negative control against the original production vault-events.ts failed at the expected confirmation assertion. The earlier timeout came from gating a post-rename apply read because the fake indexed the renamed file after emitting the event. The corrected gate holds the first exact destination read. bun run check passed after the follow-up. Prior commit ef081d4 was amended to fa10f43 before this follow-up.

Follow-up regression and CLI evidence committed as a855c1d. The prior timeout is resolved. Acceptance criterion 3 now has exact feed replay and cursor evidence. Reviews remain pending.

Final acceptance at 99da904: task review accepts exact rename proof, local fallback, and feed replay evidence. Its stale settlement comment finding is fixed in 99da904. Whole-branch review approves all seven changed files with no actionable finding. Review covers semantic TSDoc, origin tracker state ownership, exact path/source/content evidence, single claims, failed settlement, frozen revision authority, and effect admission. Human branch review pn-522c19 approves with no changes. Full check at the source/test revision passed: tooling 91, protocol 307, plugin 724 with 1 skipped, Worker 702/122/115. The later comment-only correction passes docs:check and diff checks. Fresh fetch shows no missing origin/main commits. Host fakes do not prove real device timing. No personal vault, live service, or deployment access occurred.

Live proof 2026-11-06 after the owner merged PR #76 and the supervisor released ai-bridge-v0.1.2: an iPhone create, rename and edit sequence reached the Mac real vault at cursor 186 to 191 with zero coexistence confirmations and the effect fence open. The earlier blocked sequence at cursor 184 did not repeat.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Correct exact rename origin proof when the destination read finishes after host settlement. Preserve source identity, exact paths and bytes, accepted effects, single claims, and genuine local confirmation. The full create/rename/put regression proves applied content, cursor advancement, empty confirmations, and open effect fence. Plugin metadata is 0.1.2 with Obsidian compatibility 1.13.0. Full check and independent and human reviews pass. Real-host timing remains outside test evidence.
<!-- SECTION:FINAL_SUMMARY:END -->
