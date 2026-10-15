---
id: OAB-6.5
title: Verify declared blob integrity before authoritative publication
status: To Do
assignee: []
created_date: '2026-10-15 00:38'
updated_date: '2026-10-15 00:40'
labels:
  - F1
dependencies:
  - OAB-6.3
documentation:
  - docs/spec.md
parent_task_id: OAB-6
type: feature
ordinal: 28000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner explicitly selected declared SHA-256 and byte size for blob PUT during F1 research. This is the approved bounded amendment against spec5.3/6.1/6.3: R2 needs the content-addressed key before consuming the upload, while 16 buffered 25 MB requests already exceed the 128 MB shared isolate limit. Keep authentication-before-storage and immutable blob references; do not introduce staging keys or GC.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Canonical protocol schemas and useful API documentation define the approved declared SHA-256/byte-size requirements and errors; the affected spec contract is amended through this task rather than a new spec-only review round.
- [ ] #2 Actual size and digest are verified with bounded backpressure before any DO reference is committed; forged hashes, declared-length mismatch, unknown transport length, cancellation and R2 failure cannot corrupt an existing content-addressed object.
- [ ] #3 Binaries and oversized Markdown/canvas obey the 25 MB blob and 1 MB inline rules; exact bytes, large markers, range reads and search exclusion satisfy AC-16, while revoked uploads satisfy AC-28.
- [ ] #4 Aggregate upload memory is bounded across clients in one isolate, not merely per request; retry after R2 success/uncertain response is safe and leaves at most authorized unreferenced blobs.
<!-- AC:END -->
