---
id: OAB-6.4
title: Preserve history through rename append and conditional restore
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-15 00:38'
updated_date: '2026-10-19 16:04'
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

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Plan review pending: docs/superpowers/plans/2026-10-19-f1-history-mutations.md. First complete the owner-approved OAB-6.8.1 measurement prerequisite against existing publication. Then add canonical command contracts, native rename/append/history/restore, and real HTTP tests. Restore with as_conflict_copy true writes the same path, preserves displaced history, and checks the current ETag. Each implementation task owns RED, GREEN, bun run check, and its commit. Independent task reviews, whole-branch review, and human branch review precede publication. No product implementation starts before plan approval.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Planning starts from fetched origin/main at 58b074f after merged PR 10 and PR 11. Use isolated feature/oab-6.4. Preserve the original checkout. The owner explicitly approved measurements first and in-place restore semantics. No Cloudflare resource changes, personal-vault access, or dependency additions are authorized.

The owner approved plan review pn-d60fcc. Start Task 1 measurements before any new mutation SQL. Use task-owned implementation and independent reviews.
<!-- SECTION:NOTES:END -->
