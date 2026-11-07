---
id: OAB-42
title: Scheduled packed exports to a backup bucket
status: To Do
assignee: []
created_date: '2026-11-07T13:12:00Z'
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
