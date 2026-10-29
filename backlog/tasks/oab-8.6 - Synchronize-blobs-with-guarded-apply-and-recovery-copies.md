---
id: OAB-8.6
title: Synchronize blobs with guarded apply and recovery copies
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-28T19:31:00Z'
updated_date: '2026-10-29T20:37:00Z'
labels: []
dependencies:
  - OAB-8.5
documentation:
  - docs/spec.md
parent_task_id: OAB-8
ordinal: 44000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Complete attachment and oversized text handling through the existing blob protocol. One focused PR. Preserve the approved binary residual window and use no Node or Electron APIs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 AC-31 changes mtime between hash verification and writing. Apply stops and preserves the current bytes as a conflict copy.
- [ ] #2 Binary apply uses double stat, durable pre-apply bytes, read-back verification, and seven-day recovery retention. Base advances only after confirmed bytes.
- [ ] #3 Scope matches section 7.8, including 25 MB limits and all exclusions. Binary and oversized text publication uses immutable journal payloads and the authorize/commit protocol.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Plan for owner review: .pi/plans/oab-8.6-blob-sync.md. Extend the existing shared apply engine, publication, reconciliation, journal, and transport with exact-byte support. Preserve atomic inline text and guarded binary effects. Test AC-31, seven-day recovery retention, size and scope limits, immutable retries, content-kind transitions, and restart authority. One worker owns implementation and checks after approval. Independent task review, whole-branch review, and owner diff review precede the pull request. No deployment or live-vault work.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner constraint: Keep TextApplyEngine named TextApplyEngine. Do not rename it in this task. OAB-8.9 in PR #37 records a DeviceJournal.resolve late-receipt defect. Do not depend on its queued successor rebase for blob successors. Keep OAB-8.5 regressions green.

Scope RED/GREEN evidence so far:
- RED: `(cd apps/plugin && bunx vitest run test/enrollment-scope.test.ts; code=$?; echo "observed exit=$code"; exit 0)` reported 2 failures and 14 passes, exit 1 observed. Both failures showed a 25,000,001-byte file classified as blob instead of unsupported.
- GREEN: `cd apps/plugin && bunx vitest run test/enrollment-scope.test.ts` passed 35 tests.
- Binary apply focused test passes AC-31 mtime race, visible conflict bytes, durable pre-apply bytes, and confirmed base. Its test was added after implementation.
- Blob transport and publication tests were added after initial implementation. Current focused plugin run passed 16 files and 257 tests before the latest apply test.

Implemented work is incomplete. Binary recovery retention cleanup, idempotent restart steps, blob hydration and fallback after revision pruning, oversized Markdown handling across reconciliation, rename-side bytes, and OAB-8.9 successor authority remain open. No Worker source, dependency, deployment, service call, or vault access occurred. No task acceptance criteria are checked. No commit is made.

Validation at the current worktree revision:
- `bunx biome check --write <11 changed TypeScript files>` passed. Final `bunx biome check <11 changed TypeScript files>` passed with no fixes.
- `cd apps/plugin && bunx vitest run test/text-apply.test.ts` passed 1 file and 44 tests.
- `cd apps/plugin && bunx vitest run` passed 16 files and 257 tests.
- `bunx tsc --noEmit -p apps/plugin/tsconfig.json` passed.
- `bun run docs:check` passed. Documentation audit scope: changed TypeScript declarations plus project mechanical doc gate.
- `bun run check` passed lint, docs, typecheck, tests, and build. Totals: 90 test files and 1,481 tests passed. Worker fault-injection tests printed expected network and SQLite errors. Worker build used dry-run mode.
- Structural self-review candidates: TextApplyEngine and its TextVault/PinnedTextProvider contracts, PublicationController and PublicationRemote, SyncTransport/OAuthTransportResponse, ObsidianTextVault, and enrollment scope. Shared apply remains TextApplyEngine. Composition reuses the same engine. No parallel blob controller was added.
- Self-review limits: no independent task reviewer or whole-branch reviewer ran. The implementation remains incomplete and no review disposition or approval is claimed.

Latest test-first boundary audit:
- RED: `(cd apps/plugin && bunx vitest run test/enrollment-scope.test.ts; code=$?; echo "observed exit=$code"; exit 0)` reported 2 failures and 35 passes, exit 1 observed. Oversized `.exe` and `.obsidian` files were wrongly classified unsupported.
- GREEN: the final scope suite passed with the full plugin suite at 16 files and 259 tests.
- AC-31 test now checks the first apply stops after preserving the observed changed bytes, leaves the base unchanged, then succeeds only on a later `resume()` retry. This test was written after the initial guarded-apply implementation.
- Final `bun run check` on the current source revision passed. Totals: 90 test files and 1,483 tests. No commit was made because required sync behavior and the OAB-8.9 owner decision remain unresolved.

Owner authorization: implement the narrow OAB-8.9 DeviceJournal.resolve monotonic successor-precondition fix in a separate commit on this branch. Never lower a queued match. Rebase absent successors and same-epoch matches below the receipt revision. Preserve same-or-newer match revisions and other-epoch preconditions. Do not add schema state or change unrelated OAB-8.9 behavior.

OAB-8.9 coverage in this branch: its criterion 1 is covered by DeviceJournal tests for late receipt, absent successor rebasing, older same-epoch match rebasing, newer match preservation, and other-epoch preservation. Its criterion 2 is covered by a publication/reconciliation regression that loses a create response, replays feed revision 2, queues a later edit at revision 2, returns the stored revision-1 receipt, sends the successor at revision 2, and confirms server revision 3. OAB-8.9 criteria 3 and 4 remain out of scope and unchecked. No OAB-8.9 task criteria were changed.

Final semantic self-review: TextApplyEngine owns the shared text/blob apply transition. SyncTransport validates byte metadata; ObsidianTextVault owns host byte effects; the journal stores exact pending identity and confirmed bases. Publication owns immutable send authority, while reconciliation owns manifest/feed order. Their decisions remain intentionally layered. The unchanged OAB-8.5 revision and receipt rules remain in the existing journal and publication tests.

Found and fixed a binary rename regression: when only the source side was pending and the destination base was newer, completion could write the older rename destination before the journal rejected its base revision. The engine now applies and advances only pending sides. Added a regression test that checks the newer destination bytes and base remain unchanged. RED: `cd apps/plugin && bunx vitest run test/text-apply.test.ts` failed on the invalid rename completion. GREEN: the same command passed 51 tests.

Final validation: `bun run docs:check` passed; `git diff --check` passed; `bun run check` passed lint, docs, all typechecks, 1,381 tests across 76 files, and builds. Worker fault-injection tests printed expected network and SQLite errors. The Worker build used dry-run mode. No deployment, live service call, or vault access occurred.

The owner-approved Obsidian binary residual window remains: a change after the second stat and during durable-copy/write I/O can replace current disk bytes, but the observed bytes remain in the seven-day recovery copy. No independent task or branch reviewer ran in this worker pass. Keep this task In Progress for parent review; do not check acceptance criteria or claim closure.

Validation count correction: `bun run check` passed 91 test files and 1,503 tests: tooling 5/56, protocol 16/300, plugin 17/278, Worker 53/869.

Task-review corrective pass for revision 698a4b9, report `/Users/moisesmorillo/.pi/agent/sessions/--Users-moisesmorillo-workspace-moisesmorillo-obsidian-ai-bridge--/subagent-artifacts/1c692234-7ea2-4dd2-bf70-fe122914faea_code-review_output.md`:

- F1 fixed: `PublicationController.observe` now reads the expected hash for blob paths, hashes the current exact bytes, and consumes the expected marker only when the hash matches. A different concurrent edit does not consume the marker and still becomes its own immutable queued payload. The test covers both matching echo and different bytes. RED: `cd apps/plugin && bunx vitest run test/publication.test.ts` failed because the matching echo queued a put. GREEN: the same command passed 42 tests.
- F2 fixed: `.pi/plans/oab-8.6-blob-sync.md` now says to keep `TextApplyEngine` named as-is. The plan is ignored and is not part of the commit.
- Reviewed source: `apps/plugin/src/sync/publication.ts` blob and text event paths, `apps/plugin/src/sync/device-journal.ts` expected-write operations, `apps/plugin/src/sync/text-apply.ts` expected markers before binary effects, `apps/plugin/test/publication.test.ts`, and the changed plan line. Exact `consumeExpectedWrite` keeps the journal authority check; controller `assertOpen` fences the awaited transition. Different bytes retain their expected marker and queue under current observed authority.
- Validation after correction: `bunx biome check apps/plugin/src/sync/publication.ts apps/plugin/test/publication.test.ts` passed without warnings; `bun run docs:check` passed; `git diff --check` passed; `bun run check` passed lint, docs, all typechecks, 91 test files and 1,504 tests, and builds. The Worker build used dry-run mode.
- The task remains In Progress. No push or pull request was made.
<!-- SECTION:NOTES:END -->
