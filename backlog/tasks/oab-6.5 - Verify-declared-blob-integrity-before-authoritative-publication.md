---
id: OAB-6.5
title: Verify declared blob integrity before authoritative publication
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-15 00:38'
updated_date: '2026-10-19 22:20'
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

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Owner approved Plannotator pn-be5940. Plan: docs/superpowers/plans/2026-10-19-f1-blob-integrity.md. Task 1 defines canonical blob contracts and the shared four-slot body budget. Task 2 adds immutable storage evidence and atomic native blob publication. Task 3 adds bounded streaming, HTTP integration, and cross-client upload evidence. Each worker owns RED, implementation, full checks, formatting, and commits. Independent task reviews, whole-branch review, and human branch review precede closure and publication. Blob PUT alone needs X-Content-SHA256 and X-Content-Size. No staging keys, GC, dependencies, deployments, or personal-vault access.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner approved implementation plan pn-be5940. Task 1 source commit 6f407b2 passed bun run check: 669 tests, zero failures. Initial RED reached only a missing-module setup failure, not a functional assertion. Retain working code and record this exception honestly. Independent task review remains pending. No acceptance criterion is complete yet.

Task 1 correction commit 3404689 adds canonical paired wire headers, blob failure codecs, bounded storage retry delays, and an exact duplicate-release regression. Worker full check passed 674 tests, exit 0. The worker changed implementation before its first correction test run, so this correction also lacks functional RED. Preserve the working code and this process exception. Corrective independent review now uses local copies of the full code-review skill and TypeScript profile. Acceptance remains pending.

Task 1 passed independent review at 9d0522d. F1 paired headers, F2 failure codecs, F3 duplicate-release coverage, and P2 admission retry compatibility are fixed with direct evidence. The final retry correction captured functional RED before code changes. Earlier Task 1 retained-code exceptions remain recorded. Full check passed 675 tests. Continue approved Task 2 only. Native blob publication, streaming, aggregate proof, and acceptance criteria remain pending.
<!-- SECTION:NOTES:END -->
