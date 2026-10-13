---
id: OAB-18
title: 'Deferred: Packed baseline export'
status: Deferred
assignee: []
created_date: '2026-10-12 15:14'
updated_date: '2026-10-13 10:04'
labels:
  - deferred
  - trigger-based
dependencies: []
documentation:
  - docs/spec.md
ordinal: 18000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Deferred per docs/spec.md §16 because it only matters for large first exports; current vault exports in under an hour. Seam: export manifest and pins are independent of item publish strategy. Reopen when vault exceeds 5,000 items or owner is unwilling to wait days for first backup.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Task remains deferred until one specified size/wait trigger; when triggered, evaluate and test the §16 seam.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reconciled after merged F0: this section16 feature has no committed delivery phase. Preserve the exact trigger and seam in the description; no trigger is evidenced and no future acceptance case is completed by this classification. The seam is a preservation obligation, not proof of an implemented feature. Reopen for research and reviewed planning only when the documented trigger is evidenced; no fake blocking dependency is added.

The under-an-hour statement is the specification baseline-export assumption, not a measured result from the current inert foundation. The ordinary exporter belongs to F3b (OAB9); packed archives remain deferred under the original size/wait trigger.
<!-- SECTION:NOTES:END -->
