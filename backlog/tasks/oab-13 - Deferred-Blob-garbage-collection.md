---
id: OAB-13
title: Blob garbage collection
status: In Progress
assignee:
  - '@pi'
created_date: 2026-10-12 15:14
updated_date: '2026-11-07T07:44:00Z'
labels:
  - deferred
  - trigger-based
dependencies: []
documentation:
  - docs/spec.md
ordinal: 13000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner order activates blob garbage collection as a stacked change after packed baseline export. Preserve references with transactional marks before R2 deletion. Never touch backups/.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Preview unreferenced blob count and bytes before an explicit owner-confirmed run.
- [ ] #2 Mark unreferenced hashes in one SQLite transaction and reject publication of marked hashes with a typed retry failure.
- [ ] #3 Delete only marked blobs/ objects and clear marks only after confirmed deletion.
- [ ] #4 Keep marks and a visible typed failure after partial R2 deletion failure.
- [ ] #5 Make reruns idempotent and preserve live files, retained revisions, active export sources, and backups/.
- [ ] #6 Show reclaimable bytes in the owner console and test race, partial failure, retry, and owner access.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Blob garbage collection Implementation Plan
Goal: Let the owner preview and collect only unreferenced blob objects in the existing bucket.
Architecture: The application owns preview and confirmed collection. SQLite owns atomic reference checks and durable marks. R2 owns prefix-limited listing and object deletion. Publication checks marks within its final authority transaction. Keep the operation bounded and resumable when the candidate set exceeds one batch.
Spec: docs/spec.md section 16 and W7 PR B owner brief. Base: feature/packed-export, PR 93.
Global constraints: Unit tests and fakes only. No live service, vault access, deployment, or Cloudflare resource change. Never touch backups/. Keep exact revision predicates. Protocol shapes stay in packages/protocol. SQLite statements use at most 100 bindings. Each complete SQLite row stays below 2 MB. Append shared lists without reordering.
Owner decisions: The owner activates OAB-13 now, without a measured 1 GB trigger. Preview is non-mutating. Confirmed collection rechecks references in a transaction, rather than trust stale preview evidence. Snapshot copies in backups/ are independent. Active snapshot source hashes still need protection until copy completion. Reuse existing owner Access, same-origin, and CSRF controls. Scope extends to actual publication and reference owners, including text-files.ts, mutations.ts, history.ts, protocol failures, and tests as needed. Record extensions and reasons.
Review focus: Publication during mark window, delayed storage evidence after mark clearance, retained revision and export source references, partial deletion, crash/retry, orphan uploads absent from blob_refs, namespace isolation, and aggregate read/write limits.
- [ ] Write failing tests for preview, mark-window refusal, partial R2 failure with marks retained, idempotent rerun, and backups/ exclusion.
- [ ] Add canonical owner GC schemas and retry failure mappings in packages/protocol.
- [ ] Add blob_gc model, generated schema, compatible migration, and reference queries. Reference proof includes live files, retained revisions, and active export sources.
- [ ] Add application/blob-gc.ts and narrow R2 capabilities. List only blobs/ and validate hash keys. Bound candidate batches, SQL bindings, and external calls.
- [ ] Fence publication before and after external evidence. A delayed pre-delete HEAD result must never authorize publication after mark clearance. Use a durable generation fence or equivalent exact authority proof.
- [ ] Append Vault methods, owner preview and confirm controls, and a reclaimable-byte measurement line. Make partial progress and failures visible.
- [ ] Test concurrent publication, retained history, active export sources, stale preview, interrupted deletes, and restart recovery with native SQLite.
- [ ] Update docs/api and docs/spec.md. Run docs check, full bun run check, and Worker preflight. Commit.
- [ ] Complete task and whole-branch review. Open PR against feature/packed-export with first body line Merge after #93.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reconciled after merged F0: this section16 feature has no committed delivery phase. Preserve the exact trigger and seam in the description; no trigger is evidenced and no future acceptance case is completed by this classification. The seam is a preservation obligation, not proof of an implemented feature. Reopen for research and reviewed planning only when the documented trigger is evidenced; no fake blocking dependency is added.

Scope extension: GC does not use blob_refs as reachability proof or object inventory because that table is historical and cannot reveal R2 orphans. The run lists only blobs/ and rechecks live files, retained revisions, and active packed-export source hashes. Reference-owner extension: rename and restore retain or reuse revision hashes, so the native tests verify that those references remain protected. Publication-race extension: a pre-delete HEAD can finish after collection clears marks. The durable blob_gc_generation value advances on mark and clear, then the final publish transaction compares its captured generation and checks for a mark. This rejects stale evidence even after the mark row is gone.

Review fix round 1: Added a non-expiring durable blob_gc_delete_owner claim before each R2 delete. Concurrent owner and alarm calls cannot claim a second batch. Success clears exact marks and releases the claim in one SQLite transaction. A settled R2 failure releases the claim but retains marks so a later request or alarm can retry. If execution ends before R2 reports settlement, the claim remains and publication stays blocked. The system does not retry unknown R2 outcomes. Native tests verify claim ownership after service recreation and retry after a settled failure. SQL budget fix: Reachability queries use 96 candidate hashes per statement because the export query also binds four status and source predicates. Native storage tests observe bound counts for full 100-hash preview and mark batches. API docs describe claim state and no-timeout recovery behavior.

Alarm scheduling fix: A run with an unresolved durable delete claim does not schedule repeated GC continuation alarms. The owner page shows the held claim and the batch stays fenced. Normal completion schedules the next batch after the current request settles. The preview remains capped at 32 pages.

Parent ruling: accept a fail-closed claim when the R2 delete outcome is unknown. The API reports delete_state unknown. Marks and publication remain fenced. Elapsed time or an owner retry cannot clear the claim. Known settled success or failure supports idempotent reruns. OAB-41, Recover an unresolved blob delete outcome safely, tracks recovery when conditional-delete fencing or trustworthy provider settlement evidence becomes available.

Round 2 review fixes: Inventory pages now carry a durable run identity and expected cursor. SQLite checks run identity, marking phase, and cursor in the same transaction that marks references and advances progress. Stale inventory results and stale inventory failures cannot change completed or newer runs, including a newer run at the same initial cursor. Reachability queries select distinct hashes, so result rows cannot exceed candidate hashes. Added duplicate-heavy retained-revision and active-export tests with result-cardinality and binding assertions. Partial-delete evidence uses two keys, removes one before a simulated error, verifies all marks and failure remain, then retries both keys to completion.
<!-- SECTION:NOTES:END -->
