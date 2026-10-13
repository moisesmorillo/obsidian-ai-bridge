---
id: OAB-13
title: 'Deferred: Blob garbage collection'
status: To Do
assignee: []
created_date: '2026-10-12 15:14'
labels:
  - deferred
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
