---
id: OAB-11.10
title: Dismiss attention items from the status panel
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-07T02:34:00Z'
updated_date: '2026-11-07T03:08:00Z'
labels: []
dependencies: []
parent_task_id: OAB-11
type: feature
ordinal: 77000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Old informational entries keep Sync status at attention after conflict recovery. The owner requested dismissal from the plugin panel on 2026-11-06.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Each attention entry has Dismiss next to Open. Dismissal removes only that journal entry durably, without changes to files, operations, confirmations, or conflict copies.
- [x] #2 Dismiss all removes only conflict-copy-preserved, local-change-after-queued-publication, and local-text-met-newer-remote-content entries. Owner-action entries remain.
- [x] #3 Sync status returns to settled when no attention entry or pending queue remains.
- [x] #4 A dismissed entry returns only through a new event.
- [x] #5 Tests cover individual dismissal, the informational filter, reload persistence, and settled status.
- [x] #6 Open uses indexed TFile opening only. Config-directory, missing, and folder paths show a Notice without note creation. Desktop reveal uses only a supported API.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add failing journal, panel, settings, safe Open, and status tests. 2. Add schema-derived attention identity and exact informational policy. 3. Add serialized journal dismissal and wire controls with status refresh. 4. Replace link opening with indexed TFile opening and safe path Notices. 5. Bump plugin to 0.1.5. 6. Run focused tests, docs:check, and bun run check. 7. Complete task and branch semantic reviews, then human branch review. 8. Push one PR, remove the worktree, and report. Owner plan: /private/tmp/M8-attention-dismiss-plan.md.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner authorization dated 2026-11-06: F5 code-first work through the supervisor. This task uses unit tests and fakes only. No vault access or live service cases. Scope: plugin source, plugin tests, manifest, versions, and this task. Plugin release version: 0.1.5.

Supervisor scope extension: fix the attention Open action in main.ts in this PR. Link resolution can create a note for an unindexed .obsidian path and report Folder already exists. Use indexed TFile opening only. Never create missing paths. The installed public Obsidian declarations expose no system file-manager reveal API.

RED: `bun test apps/plugin/test/device-journal.test.ts apps/plugin/test/status-panel.test.ts apps/plugin/test/settings.test.ts` exited 1 before implementation. The new journal assertions failed because attention keys and dismissal operations did not exist. The same direct Bun command also loaded plugin tests outside Vitest and produced unrelated Obsidian module errors.
GREEN: `cd apps/plugin && bun run test -- test/device-journal.test.ts test/status-panel.test.ts test/settings.test.ts` passed 3 files and 87 tests.
Checks: `bunx biome check --write` passed for 11 changed source, test, and version files. `bun run docs:check` passed. `bun run check` passed lint, docs, typecheck, all tests, and builds.
Review: local review found no blocker. Unit tests use in-memory journal storage and host fakes only. No vault or live service was accessed.

Final focused run: `cd apps/plugin && bun run test -- test/device-journal.test.ts test/status-panel.test.ts test/settings.test.ts` passed 3 files and 88 tests. The full `bun run check` passed lint, documentation checks, TypeScript checks, all workspace tests, and all builds after final edits. The worker test runner printed expected injected transport and SQLite errors from negative-control tests, but all worker suites passed.

Branch-review fix: added lifecycle host-fake tests that use the real AIBridgePlugin onload wiring, captured sync actions, runSyncAction, and settings refresh callback. Tests cover individual and bulk dismissal success, durable journal state, preserved owner-action attention, and refresh plus storage warning after injected persistence failure.
New-test negative control: temporarily skipped the journal.dismissAttention call in the actual main.ts callback. `cd apps/plugin && bun run test -- test/lifecycle.test.ts` failed the direct-dismiss success test and the individual persistence-failure test. The wrapper recorded expected exit 1 and returned 0. I restored main.ts before GREEN.
GREEN: `cd apps/plugin && bun run test -- test/lifecycle.test.ts test/settings.test.ts test/status-panel.test.ts test/device-journal.test.ts` passed 4 files and 146 tests.
The original RED evidence used direct `bun test`, not project Vitest. It also reported unrelated Obsidian module errors. Do not treat it as clean RED evidence for those earlier tests. The targeted negative control above is valid evidence for these new host tests.
`bunx biome check --write apps/plugin/test/lifecycle.test.ts`, `bun run docs:check`, and `bun run check` passed after the fix. The full check passed all workspace type checks, tests, and builds. No vault or live service was run.

Semantic review closure: task review at ac5e262 found no functional defect and one MINOR host-wiring test gap. Whole-branch review at ac5e262 confirmed the same bounded gap. Commit 5749b4e adds direct lifecycle host tests for individual and bulk success and persistence failure. Scoped TypeScript corrective review approved the fix with no new finding. Review scope covers all changed implementation, tests, version files, TSDoc, and this task. DeviceJournal owns serialized state transitions. The panel owns presentation. main.ts owns host wiring and safe indexed-file opening. No competing protocol schema or bulk policy exists. Latest validation: focused Vitest 146 passed. Full check passed lint, docs, all workspace type checks, tests, and builds. Plugin: 828 passed, 1 skipped. No live-vault or device proof is claimed. Human branch review is next.
<!-- SECTION:NOTES:END -->
