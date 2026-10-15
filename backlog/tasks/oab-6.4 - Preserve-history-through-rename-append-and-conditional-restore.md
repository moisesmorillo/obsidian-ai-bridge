---
id: OAB-6.4
title: Preserve history through rename append and conditional restore
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
ordinal: 27000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Sections5.1 and6.1 need operations beyond PUT without weakening lost-response, collision or epoch guarantees. Source/destination numbering and concurrent append are particularly vulnerable to stale-state decisions around asynchronous work.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Rename emits one self-contained change, leaves the source tombstone, permits case-only renames and uses the destination lifetime revision counter, including AC-14/26.
- [ ] #2 Append is current-revision atomic, requires an idempotency key and observed epoch, and rejects tombstones, blobs, missing paths and oversized results without partial effects, covering AC-22/29/34.
- [ ] #3 History and restore preserve exact retained bytes; restore requires the current destination ETag, refuses occupied paths unless requested and cannot resurrect a later delete on retry.
- [ ] #4 Real DO interleaving and retry tests verify immutable feed/history and the server-side conflict preconditions without claiming plugin conflict-copy behavior.
<!-- AC:END -->
