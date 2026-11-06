---
id: OAB-11.8
title: Exclude plugin-applied remote renames from coexistence confirmations
status: In Progress
assignee: []
created_date: '2026-11-06T18:23:00Z'
updated_date: '2026-11-06T18:52:00Z'
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
- [ ] #1 A feed rename applied by the plugin never enters the confirmation queue and never blocks the effect fence.
- [ ] #2 A genuine local rename still needs confirmation.
- [ ] #3 A regression test covers remote create, rename, and put with coexistence enabled. The put applies and the cursor advances.
- [ ] #4 bun run check and reviews pass.
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
<!-- SECTION:NOTES:END -->
