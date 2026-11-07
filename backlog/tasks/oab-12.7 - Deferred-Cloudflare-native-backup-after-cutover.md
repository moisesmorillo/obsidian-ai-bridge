---
id: OAB-12.7
title: 'Deferred: Cloudflare-native backup after cutover'
status: Deferred
assignee: []
created_date: '2026-11-07T00:15:00Z'
updated_date: '2026-11-07T00:21:00Z'
labels:
  - F6
  - deferred
dependencies: []
documentation:
  - docs/spec.md
parent_task_id: OAB-12
ordinal: 75000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Trigger: owner request after cutover. Consider a copy to a supplementary R2 bucket or Durable Object point-in-time recovery. The cutover backup choice belongs to OAB-12.3 and OAB-9. This deferred task does not replace that choice or block cutover. Existing OAB-9 and docs/spec.md §16 retain their before-F6 or iCloud-ownership triggers. This task captures the requested after-cutover scope only. Research the current platform and restore needs when the owner selects it. No Cloudflare resource change follows from task creation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A dated owner request after cutover activates research. No implementation or Cloudflare change precedes explicit authorization.
- [ ] #2 The owner selects or rejects an R2 copy or Durable Object point-in-time recovery after review of recovery limits and cost.
- [ ] #3 Before implementation, the selected design defines recoverable content, revision history, retention, failure visibility, and a restore test.
- [ ] #4 OAB-9 and docs/spec.md §11 and §16 agree with the owner decision before implementation. No duplicate backup mechanism enters scope.
<!-- AC:END -->
