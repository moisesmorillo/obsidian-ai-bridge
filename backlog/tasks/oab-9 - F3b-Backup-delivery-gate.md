---
id: OAB-9
title: 'F3b Backup delivery gate (not built: owner decision 2026-11-05)'
status: Deferred
assignee: []
created_date: 2026-10-12 15:13
updated_date: '2026-11-07T03:35:00Z'
labels:
  - phase-gate
  - F3b
dependencies:
  - OAB-6
documentation:
  - docs/spec.md
type: task
ordinal: 9000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner decision 2026-11-05: the GitHub export mechanism of docs/spec.md §11 is not built. iCloud Drive keeps an independent copy of the live vault through F4 and F5. Trigger: owner request before F6 for a Cloudflare-native copy, such as a supplementary R2 bucket or Durable Object point-in-time recovery. Research and decompose only when the owner selects it. No personal-vault access follows from this task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The owner selects a Cloudflare-native backup mechanism before F6, and docs/spec.md records its exit cases before implementation.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reconciled after merged F0: this is a committed section14 phase entry/exit gate, not a trigger-based deferred feature or an implementation task. Its original acceptance cases and dependency edges are unchanged. Dependency readiness only permits selection for research and decomposition; it does not authorize implementation, deployment or personal-vault access.

Owner decision 2026-11-05: a GitHub export is too much for this vault. iCloud Drive remains the independent copy, as it does today. The spec change is in PR docs/no-backup-export. OAB-10 and OAB-12 no longer depend on a backup.

Owner and supervisor report, 2026-11-06 (local UTC-6), recorded after cutover.

These are reported observations, not new agent tests.

The owner selected a dated zip plus the frozen iCloud vault before cutover.

Keep both for 30 days, through at least 2026-12-07T00:20Z.

The frozen copy lacks later edits and service revision history.

No zip restore test or Cloudflare-native backup exists.

OAB-12.7 stays Deferred until the owner selects a design.

Not started tonight.

F3b remains Deferred and is not built by the 2026-11-05 owner decision.

The cutover backup choice does not implement export or restore.
<!-- SECTION:NOTES:END -->
