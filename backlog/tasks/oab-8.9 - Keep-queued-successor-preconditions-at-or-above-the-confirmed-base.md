---
id: OAB-8.9
title: Keep queued successor preconditions at or above the confirmed base
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-29T17:16:00Z'
updated_date: '2026-11-02T22:49:00Z'
labels: []
dependencies: []
parent_task_id: OAB-8
ordinal: 49000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Independent review of the merged OAB-8.5 branch (source 5577b03, main 548119c) reproduced a precondition regression. DeviceJournal.resolve rewrites every queued successor on the receipt path to the receipt base revision without comparison (apps/plugin/src/sync/device-journal.ts, the successor rebase near line 696). Interleaving: create P1 commits at rev 1 and the response is lost. The feed applies another device's rev 2, so base is rev 2 with a conflict copy. The user edits, and P3 is queued with If-Match rev 2. The P1 retry returns the stored rev-1 receipt, and resolve lowers P3 to rev 1. The server answers 412 and P3 lands in attention as 'Local text met newer remote content'. The edit reaches the server only after a later scan. No invariant breaks and no bytes are lost, but task OAB-8.5 criterion 2 promises the correct next precondition. The same review noted three smaller gaps: the TSDoc of recoverPrecondition in publication.ts and reconciliation.ts claims the cursor does not advance, but replay persists it per entry; AC-06 has no end-to-end test of a plain delete that meets 412 and restores remote bytes before recordRejected; restoreMissing never clears expected_writes on success and relies on the host create event.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 DeviceJournal.resolve never lowers an existing match precondition. It rebases only absent successors or successors whose revision is below the receipt base.
- [ ] #2 A regression test reproduces the lost-response, newer-feed-row, later-edit, late-receipt interleaving and proves the successor is sent with the confirmed base revision and reaches the server.
- [ ] #3 AC-06 has an end-to-end test: a plain delete meets 412, recoverPrecondition restores the remote bytes, and the operation is recorded as rejected with attention.
- [ ] #4 The TSDoc of recoverPrecondition describes the cursor effect truthfully, and restoreMissing clears expected_writes after a verified restore.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Retain merged commit 3990939 and verify the existing successor authority regressions. 2. Add a plain-delete 412 integration test through publication, reconciliation, and text apply. Verify remote bytes and base before rejection, attention, and cursor persistence. 3. Add failing restore echo-cleanup tests without host events. Cover text and binary restore paths, then clear expected writes after verified effects. 4. Correct both recoverPrecondition comments to describe replay cursor persistence and rename authority reads. 5. Run focused tests, docs:check, and bun run check. Get independent task and whole-branch reviews. Address human branch annotations, close the task, push, create the PR, and remove the worktree. No live-service work, new dependency, or protocol change.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner approved plan pn-4b04c0. Criteria 1 and 2 are met by merged commit 3990939. apps/plugin/test/device-journal.test.ts covers monotonic queued successor preconditions. apps/plugin/test/late-receipt-successor.test.ts covers the lost response, newer feed revision, later edit, late receipt, and successful successor publication. Retain this implementation and evidence. Complete criteria 3 and 4 under the approved plan.

Implementation: publication restore paths clear expected_writes only after verified readback; failed readback still clears the echo and leaves base authority unchanged. Both recoverPrecondition TSDoc comments now state that replay persists accepted cursors and direct rename-source reads do not advance them. Added publication integration tests for text restore, binary restore, binary-read fallback to text, failed text readback, and plain-delete 412 recovery. RED: bun run --filter '@obsidian-ai-bridge/plugin' test -- test/publication.test.ts initially failed three expected_writes assertions (3 failed, 50 passed, exit 1). The first run also exposed a test expectation mismatch for the rejected operation state; corrected that test assertion. The plain-delete path itself passed existing behavior and is added as test-only coverage, not claimed as a product bug fix. GREEN: focused publication/journal/late-receipt/reconciliation tests passed 180/180. bun run docs:check passed. bun run check passed before the final failed-readback coverage addition. Full final check pending. No protocol, dependency, Worker, vault, service, Cloudflare, or merged successor changes.

Final validation: bun run check passed exit 0. Summary: lint checked 231 files; docs:check passed; all workspace typechecks passed; tests passed (tooling 56, protocol 304, plugin 371, Worker 646 + 120 + 103, across 66 test files); all builds passed. Focused tests passed 180/180. Formatting passed. No staged changes before commit; task remains In Progress and acceptance criteria remain unchecked. Local-only review: publication restore success paths verify exact bytes before echo cleanup; failure branches retain cleanup and no base advance on failed text readback. Plain-delete integration confirms feed replay before rejection, durable cursor, restored bytes/base, and one 412 request with no successful delete. No live service or external resources touched.
<!-- SECTION:NOTES:END -->
