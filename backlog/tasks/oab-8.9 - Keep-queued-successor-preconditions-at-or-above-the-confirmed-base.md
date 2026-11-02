---
id: OAB-8.9
title: Keep queued successor preconditions at or above the confirmed base
status: To Do
assignee: []
created_date: '2026-10-29T17:16:00Z'
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
