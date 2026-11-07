---
id: OAB-44
title: Continue pending packed exports with a short alarm interval
status: To Do
assignee: []
created_date: '2026-11-07T15:17:00Z'
labels:
  - worker
  - F6
  - backup
dependencies: []
priority: medium
type: bug
ordinal: 80000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner order 2026-11-07: the hourly packed export advances 1 MiB per alarm step, but Vault.alarm() reschedules every pending export with RETENTION_CONTINUATION_MS (60 s). An 18 MB snapshot takes about 20 minutes and a vault above about 55 MB cannot finish inside one hour, so the next hourly export skips as busy. Observed on the first scheduled export (15:00:37 UTC, ongoing multipart for more than 15 minutes). Fix: when an export is pending, reschedule the alarm with a short interval (1 s, the same value the constructor path uses), and keep 60 s only for retention and GC continuation. Keep every step bounded as it is. No change to step budgets, buckets, or lifecycle. Worker only.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A pending export reschedules the alarm with a short interval (about 1 s), not 60 s. Retention and GC continuation keep 60 s.
- [ ] #2 A unit test proves the alarm interval selection for pending export, pending retention, pending GC, and idle.
- [ ] #3 docs/packed-export-restore.md or docs/spec.md states the expected snapshot duration for the current step budgets.
- [ ] #4 bun run check green and Worker preflight green before the PR.
<!-- AC:END -->
