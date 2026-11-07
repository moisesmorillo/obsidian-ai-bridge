---
id: OAB-42
title: Scheduled packed exports to a backup bucket
status: Done
assignee:
  - '@pi'
created_date: '2026-11-07T13:12:00Z'
updated_date: '2026-11-07T14:27:00Z'
labels:
  - F6
  - backup
  - worker
dependencies: []
priority: medium
ordinal: 79000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner order 2026-11-07: run the packed baseline export every hour and retain 15 days. Store snapshots in a dedicated R2 bucket, separate from the blob bucket. Infra PR #20 creates oab-backups and a lifecycle rule that deletes backups/ objects after 15 days. Infra PR #21 extends incomplete multipart lifetime to seven days. The owner merges #21 before the Worker PR. A Cron Trigger (0 * * * *) starts hourly work through PackedExportService. BACKUP_BUCKET stores archives. R2_BUCKET stores source blobs and remains the only blob GC bucket. Owner routes list exports and download archives. The owner reports no existing production packed exports and directs no migration code. Missing archives return a clear download failure. At about 18 MB per snapshot, 360 snapshots use about 6.5 GB-month.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A Workers Cron Trigger starts one packed export per hour, skips when an export is already running, and records failures in the owner page.
- [x] #2 Exports write to the BACKUP_BUCKET binding. Blob GC and blob publication never read or write that bucket.
- [x] #3 Owner listing and download work from the backup bucket. docs/packed-export-restore.md and docs/spec.md §11 and §16 record the schedule, retention and bucket.
- [x] #4 Retention is an R2 lifecycle rule in cloudflare-infra, 15 days on backups/, not Worker code. The infra PR merges before the Worker PR.
- [x] #5 Tests cover the scheduled handler, the skip when busy, the binding selection, and the failure record. bun run check green. Worker preflight green.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
# Scheduled exports implementation plan

Goal: Create hourly packed snapshots in the separate backup bucket.
Architecture: The Worker Cron Trigger selects the canonical SERVICE_ORIGIN host and calls the Vault export service. Existing alarms advance ZIP work.
Spec: docs/spec.md sections 11 and 16, plus the S5 owner brief.

## Owner decisions
- Use Cron Trigger 0 * * * * and BACKUP_BUCKET for oab-backups.
- Keep blob reads and GC on R2_BUCKET. Keep backups/<epoch>/<createdAt>.zip.
- Infra PR #20 owns the 15-day backups/ lifecycle. Add no Worker pruning.
- Use the scheduled event timestamp as the export identity. Skip queued or uploading work and record that result.
- Keep export failure details in durable records visible on the owner exports page.
- Use only unit tests, runtime fakes, and local preflight. No deployed service or vault access.
- The unattended owner order replaces plan and branch browser gates.
- Change only export-related wiring, tests, and documentation. Necessary binding types and deployment configurations belong to that wiring.

## Task 1: Scheduled packed exports
- [ ] Read existing export capture, concurrency, alarm, owner rendering, and runtime test contracts.
- [ ] Add failing tests for Cron forwarding, canonical host selection, busy skip, failure visibility, and isolated bucket selection.
- [ ] Run those tests and record their actual failing assertions before implementation.
- [ ] Add scheduled Vault entry and Worker handler. Preserve exact snapshot cuts and existing upload retries.
- [ ] Bind archives to BACKUP_BUCKET in local and production configuration. Keep all blob operations on R2_BUCKET.
- [ ] Show failed export records on the owner page without download links. Keep protocol shapes canonical.
- [ ] Update restore guidance and spec sections 11 and 16. Correct conflicting destination summary text.
- [ ] Run focused tests, bun run docs:check, bun run check, and Worker preflight.
- [ ] Commit implementation and report evidence. Complete task review, then whole-branch review.
- [ ] Rebase on origin/main, push, and create one PR with the infra PR #20 dependency first.

## Review focus
Concurrent owner and Cron starts must not create two active exports.
Duplicate Cron delivery must not create two snapshots.
Failed work must appear without a download link.
Missing or invalid service origin must not select a different vault.
Separate archive writes must not change blob publication or garbage collection.

Final review result: stop implementation and publish a draft PR under the owner blocker rule. F1 and F2 need correction before merge. F3 remains a non-blocking availability issue. Keep acceptance criteria unchecked until the blockers close.

Final accepted outcome: the supervisor replaced the draft-only decision. No migration code under the reported empty production export state. Missing archives return a clear no-store 404. Infra PR #21 sets seven-day multipart lifetime before Worker merge. All implementation and local validation steps are complete. Scoped review approves with documented limits. Publish one non-draft PR against main with the #21 dependency first, then remove this worktree.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner decision: a busy scheduled attempt emits a structured scheduled_export_skipped event with reason export_already_running and the scheduled timestamp. It does not create a failed export or change protocol statuses. The log omits owner identity and payload data.

RED evidence before implementation: the owner page test failed because HTML omitted Failed exports and export_source_unavailable. The scheduled handler tests failed because scheduled was undefined. The backup-store test failed because BACKUP_BUCKET was unavailable. Results: owner test 1 failed of 4, scheduled and backup tests 3 failed of 3.

TDD exception: the exact SQLite concurrent-admission integration test was added after implementation. It now runs owner and Cron starts concurrently against the real Durable Object and asserts one persisted export.

Dependencies: bun install --frozen-lockfile installed locked dependencies. No live service or Cloudflare resource access.

Final validation: bun run docs:check passed. bun run check passed with exit 0. Tooling: 8 files and 91 tests passed. Protocol: 19 files and 314 tests passed. Worker: 71 files and 1,017 tests passed. Plugin: 29 files and 836 tests passed, with 1 skipped. All workspace typechecks and builds passed. Worker dry-run build showed both R2 bindings. bun run --filter @obsidian-ai-bridge/worker preflight passed with exit 0 and local runtime simulation. No live service or Cloudflare resources were used. Review found no blockers. Production application still depends on cloudflare-infra PR #20 to create oab-backups before Worker release.

Review finding closure for reviewer revision 247fb0b: corrected the three stale statements. The architecture diagram now shows the hourly scheduled trigger and owner-started export. docs/api/f2.md names the dedicated BACKUP_BUCKET for scheduled and owner exports. PackedExportService constructor TSDoc names the dedicated backup-bucket adapter for owner and scheduled exports. No protocol or runtime behavior changed.

Validation after correction: bun run docs:check passed with exit 0. bun run check passed with exit 0. Tooling 91 tests, protocol 314 tests, Worker 1,017 tests, and plugin 836 tests passed. One plugin test was skipped. Workspace typechecks and builds passed.

Supervisor report: owner applied cloudflare-infra PR #20 and oab-backups exists. This is reported evidence only. I did not check or change Cloudflare resources.

Final branch review at 47871ef: REQUEST CHANGES. This supersedes the earlier task-review statement about no blockers. The documentation finding at 247fb0b is closed. F1 MAJOR stays open: existing completed archives and multipart upload IDs belong to R2_BUCKET, but new wiring uses only BACKUP_BUCKET. Existing completed downloads can fail. Existing uploads can retry forever and prevent later scheduled exports. No agent examined production records. A compatibility path or explicit migration prerequisite needs tests for both legacy states. F2 MAJOR stays open: 1,908 output steps at one minute each take about 31.8 hours for a near-2 GB archive. Infra aborts multipart uploads after 24 hours. Expired upload IDs remain retryable and can block future exports. Continuation timing and expired-upload recovery need controlled-clock tests. F3 MINOR stays open: lifecycle-deleted archives retain completed SQLite records and owner download links. Availability-aware listing needs a missing-object test. The owner brief directs a draft PR when a real blocker appears. Keep OAB-42 In Progress and publish this branch as a draft. No readiness claim or live-vault test follows from passing automated checks. Review scope covered the full 21-file diff, export admission and recovery, bucket wiring, owner rendering, tests, and documentation. Static diff checks passed. The reviewer did not repeat worker checks or inspect Cloudflare. Supervisor reports owner applied infra PR #20 and the bucket exists.

Supervisor decisions: owner reports zero completed packed exports in production. Do not add migration code. A missing pre-switch archive must return a clear owner-visible download failure. Infra PR #21 extends incomplete multipart lifetime to seven days. The owner merges that PR before this Worker PR. Record the seven-day limit in documentation. These decisions replace the draft-only blocker plan. The supervisor authorizes one force-with-lease push after rebase, because the remote branch contains only the original task commit. Conflict resolution retained the current task notes. Rebase omitted the duplicate original task-file commit.

## Owner decisions after final review

- F1 — closed by owner decision. The owner reports zero completed packed exports in production, and the owner page says “No completed exports.” Do not add migration code for legacy archive records or multipart upload IDs.
- F2 — closed by owner decision. Infra PR #21 changes the incomplete multipart abort lifetime to seven days. The owner will merge it before the Worker PR. Do not add Worker pruning or redesign multipart timing.
- F3 — resolved in the Worker. A missing archive returns a no-store 404 with a clear message that directs the owner to `/owner/exports` to create a new export. Protocol shapes remain unchanged.

## Follow-up TDD and validation

RED: `bunx vitest run --config vitest.f2.config.ts test/f2/owner.test.ts` failed as expected. The new assertion received `Not found` instead of the missing-archive message. Three other tests passed.
GREEN: the focused owner test passed all 4 tests after the transport change. `bun run docs:check` passed. `bun run check` passed with exit 0. Tooling: 8 files and 91 tests passed. Protocol: 19 files and 314 tests passed. Worker: 52 files and 745 tests passed, plus 9 files and 132 tests, plus 10 files and 140 tests. Plugin: 29 files and 836 tests passed, with 1 skipped. Typechecks and builds passed. Worker dry-run showed both R2 bindings. `bun run --filter @obsidian-ai-bridge/worker preflight` passed with exit 0.

## Residual risks

- A stale completed row can still show a download link if lifecycle retention removed its archive. The download now explains the failure, but the list does not check archive availability.
- The owner reports infra PR #21 will set the seven-day multipart abort lifetime. I did not check or change Cloudflare resources. The Worker PR remains dependent on that infra change.
- Production CPU duration and account-tier limits remain unverified. Local tests and preflight do not prove deployed behavior.

Scoped corrective review at 1ae4182: APPROVE WITH NOTES. F1 closes under the owner no-migration decision and reported zero production exports. F2 closes under the seven-day infra PR #21 prerequisite. F3 closes for download responses. The owner accepts stale list links with a clear missing-archive response. The reviewer checked authorization order, absence of secret exposure, unchanged protocol and successful-download behavior, regression assertions, and documentation. The reviewer inspected recorded validation without repeating worker tests. AC1: scheduled forwarding, timestamp replay, concurrent admission, busy skips, and failure rendering have passing tests. AC2: runtime tests check backup writes and blob-bucket separation. AC3: owner routes and restore/spec documentation pass checks. AC4: supervisor reports owner applied infra PR #20 for bucket and 15-day lifecycle. No Worker pruning exists. Infra PR #21 must precede merge for seven-day multipart lifetime. AC5: worker recorded passing focused tests, docs:check, full check, and local preflight after the last behavior fix. No live-vault or cloud validation occurred.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added hourly packed exports and a dedicated backup bucket in local and production configuration. Atomic admission skips busy work and preserves timestamp replay. Owner pages show failures, and missing downloads explain recovery. Local tests, docs:check, full check, and Worker preflight pass in worker evidence. Task and branch reviews closed findings under explicit owner decisions. Merge only after infra PR #21 sets the seven-day multipart window. Stale download links can remain, and no legacy migration exists under the reported empty production export state. No agent touched a live vault or Cloudflare resource.
<!-- SECTION:FINAL_SUMMARY:END -->
