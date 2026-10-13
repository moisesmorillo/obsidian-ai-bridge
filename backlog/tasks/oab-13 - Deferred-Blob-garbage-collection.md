---
id: OAB-13
title: 'Deferred: Blob garbage collection'
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
ordinal: 13000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Deferred per docs/spec.md §16 because orphan detection can race new references across DO I/O awaits. Seam: blob_refs table; transactionally mark hash in blob_gc, reject publishes referencing marked hashes, delete in R2, then clear mark. Reopen when unreferenced blobs exceed 1 GB.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Task remains deferred until unreferenced blobs exceed 1 GB; when triggered, evaluate and test the §16 seam.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reconciled after merged F0: this section16 feature has no committed delivery phase. Preserve the exact trigger and seam in the description; no trigger is evidenced and no future acceptance case is completed by this classification. The seam is a preservation obligation, not proof of an implemented feature. Reopen for research and reviewed planning only when the documented trigger is evidenced; no fake blocking dependency is added.
<!-- SECTION:NOTES:END -->
