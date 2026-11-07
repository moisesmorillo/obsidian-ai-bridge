---
id: OAB-42
title: Scheduled packed exports to a backup bucket
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-07T13:12:00Z'
updated_date: '2026-11-07T13:46:00Z'
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
Owner order 2026-11-07: run the packed baseline export every hour and retain 15 days. Store snapshots in a dedicated R2 bucket, separate from the blob bucket. Infra part (cloudflare-infra, OpenTofu, owner merges): bucket oab-backups plus a lifecycle rule that deletes objects under backups/ after 15 days and aborts incomplete multipart uploads after 1 day. Worker part: a Cron Trigger (0 * * * *) starts one export per hour through the existing PackedExportService, writing to a new BACKUP_BUCKET binding instead of R2_BUCKET. Owner routes list and download from the backup bucket. Blob GC never touches the backup bucket. The Worker PR merges only after the bucket exists. Cost estimate at current size (about 18 MB per snapshot, 360 snapshots): about 6.5 GB-month, inside the R2 free tier; worst case cents per month.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A Workers Cron Trigger starts one packed export per hour, skips when an export is already running, and records failures in the owner page.
- [ ] #2 Exports write to the BACKUP_BUCKET binding. Blob GC and blob publication never read or write that bucket.
- [ ] #3 Owner listing and download work from the backup bucket. docs/packed-export-restore.md and docs/spec.md §11 and §16 record the schedule, retention and bucket.
- [ ] #4 Retention is an R2 lifecycle rule in cloudflare-infra, 15 days on backups/, not Worker code. The infra PR merges before the Worker PR.
- [ ] #5 Tests cover the scheduled handler, the skip when busy, the binding selection, and the failure record. bun run check green. Worker preflight green.
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
<!-- SECTION:NOTES:END -->
