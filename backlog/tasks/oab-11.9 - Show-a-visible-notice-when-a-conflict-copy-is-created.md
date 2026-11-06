---
id: OAB-11.9
title: Show a visible notice when a conflict copy is created
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-06T21:40:00Z'
updated_date: '2026-11-06T23:06:00Z'
labels: []
dependencies: []
parent_task_id: OAB-11
ordinal: 69000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner feedback 2026-11-06 from the iPhone offline conflict run: the owner read the result as a lost edit because the path showed the remote revision and the conflict copy appeared only as a separate file. Add a visible, dismissible notice on desktop and mobile when the plugin writes a conflict copy, with the copy path. No change to conflict semantics.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A notice appears on each device when the plugin writes a conflict copy, with the copy path.
- [x] #2 The notice does not block sync and does not change conflict naming or bytes.
- [x] #3 Tests cover the notice on text and blob conflict copies.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add failing notice assertions for text and blob conflict copies and platform default settings tests. 2. Add the optional apply callback, approved composition pass-through, and Notice host wiring. 3. Select platform defaults only without a valid saved name. 4. Run focused tests, docs:check, and bun run check. 5. Complete task and whole-branch semantic reviews and human branch review. 6. Publish one PR without a version change, remove the worktree, and report. Detailed owner review plan: /private/tmp/M7-conflict-copy-notice-plan.md. Device proof stays open.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner authorization dated 2026-11-06 covers F5 copy-vault work through the supervisor. The M7 brief also authorizes minimal main.ts and status-panel.ts edits and the mobile default name. Tests only. No personal vault, live service, release, or device access.

Owner decision: extend write scope to apps/plugin/src/sync/create-publication.ts for the optional notice callback and its pass-through only.

Implementation evidence (2026-11-06):
- RED: `bun --filter @obsidian-ai-bridge/plugin test -- test/settings.test.ts test/text-apply.test.ts` failed 4 assertions before source edits. Failures covered the missing default helper, missing text/blob notices, and throwing callback behavior.
- GREEN: the same focused command passed 120 tests.
- `bunx biome check --write apps/plugin/src/sync/text-apply.ts apps/plugin/src/sync/create-publication.ts apps/plugin/src/main.ts apps/plugin/src/settings.ts apps/plugin/test/text-apply.test.ts apps/plugin/test/settings.test.ts apps/plugin/test/lifecycle.test.ts` passed.
- `bun run docs:check` passed.
- `bun run check` passed. Lint and docs passed, all workspace typechecks passed, tests passed (plugin 727 passed and 1 skipped, protocol 307 passed, tooling 91 passed, worker 702 passed plus 122 and 115 isolated checks), and all builds passed. Worker tests print expected disconnected-stream and injected rollback errors while reporting success.
- Regression evidence covers text and blob path notices, failed copy creation, copy reuse after a named-step restart, hidden pre-apply recovery, throwing notice callback, mobile and desktop defaults, and exact saved-name preservation.
- Limits: no device, personal vault, live service, or deployment test. Keep device criterion open until device available and BRAT release plugin-v0.1.0 published. The task remains In Progress.

Final validation refresh: after adding the exact Notice text wiring test and the dirty-blob notice assertion, `bun --filter @obsidian-ai-bridge/plugin test -- test/lifecycle.test.ts test/settings.test.ts test/text-apply.test.ts` passed (3 files, 153 tests). The latest `bun run docs:check`, `bun run check`, and `git diff --check` all passed. Latest full counts: plugin 728 passed and 1 skipped, protocol 307 passed, tooling 91 passed, worker 702 passed plus isolated groups of 122 and 115 passed. The lifecycle host mock confirmed `AI Bridge kept your version as <path>`.

Review-note follow-up: added exact notice-path and byte-preservation assertions for dirty text rename (two visible copies) and dirty blob rename (one visible copy). The dirty blob test also asserts that no pre-apply path appears in notices. Clarified resolveDeviceName validation and default behavior in TSDoc. Removed redundant TextApplyOptions assertions from focused tests.
- Initial focused run with new assertions failed because the expected rename paths did not match the existing revision identity. Corrected expectations to match the actual conflict names.
- Final `bun --filter @obsidian-ai-bridge/plugin test -- test/text-apply.test.ts test/settings.test.ts` passed: 2 files and 120 tests.
- The first `bun run docs:check && bun run check && git diff --check` shell command timed out at 120 seconds during the full check. `ps` found no active check process. Retried `bun run check && git diff --check` with a 300-second timeout. It passed, including lint, docs, typechecks, tests, and builds. A separate `bun run docs:check` also returned exit 0. Device criterion 1 remains open.

Branch-review finding closure: fixed MINOR finding “Correct the notice helper documentation” in `apps/plugin/src/main.ts`. The helper documentation now allows fixed message templates with approved conflict-copy paths. It still excludes raw provider errors and host error details. This changes no behavior. `bun run docs:check` and `git diff --check` passed. Keep device criterion 1 open and the task In Progress.

Review closure at d961ebd: task review found no blocking defect. Rename notice coverage and exact default-name documentation notes were fixed in 3f27c34 and accepted by scoped review. Whole-branch review covered all eight files at 3f27c34 and found one MINOR stale notice-helper comment. d961ebd fixes that comment, and scoped review approves the correction. Review includes semantic TSDoc, callback ownership, copy creation and verification paths, recovery exclusion, and revision authority. Full check passed at the final executable revision. Comment-only correction passes docs:check and diff checks. Criteria 2 and 3 have test evidence. Criterion 1 stays open for device proof. Human branch review remains pending.

Human branch review pn-f2bbe5 approved the complete branch without changes. The task stays In Progress because real-device notice visibility remains unproven. No version bump occurred.
<!-- SECTION:NOTES:END -->
