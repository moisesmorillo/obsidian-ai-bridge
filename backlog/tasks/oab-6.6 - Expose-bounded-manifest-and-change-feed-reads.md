---
id: OAB-6.6
title: Expose bounded manifest and change-feed reads
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-15 00:38'
updated_date: '2026-10-21 18:40'
labels:
  - F1
dependencies:
  - OAB-6.4
  - OAB-6.5
documentation:
  - docs/spec.md
parent_task_id: OAB-6
type: feature
ordinal: 29000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Sections6.1 and7.3 require complete authoritative reads during concurrent publication and after long offline periods. A manifest or feed must preserve tombstones and epoch/revision identity without materializing the full vault or falsely treating absence as deletion.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Vault, manifest, changes, exact-revision/current content and history endpoints return canonical metadata/ETags with bounded pagination and authorization.
- [ ] #2 Epoch mismatch, expired cursors, pruned revisions and concurrent manifest writes have deterministic recovery responses; retained feed entries do not change when current state advances.
- [ ] #3 Manifest/page/feed/range limits are enforced with bounded response memory and correct cancellation/admission cleanup.
- [ ] #4 Real Worker/DO tests exercise the server portions of AC-12/21/25/40 and explicitly distinguish them from unimplemented plugin apply/no-op assertions.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Owner approved docs/superpowers/plans/2026-10-21-bounded-authoritative-reads.md in Plannotator pn-08b6dd. Complete three sequential work units: canonical read contracts, native authoritative reads, and bounded Worker transport. Each implementer owns RED/GREEN tests, bun run check, and commits. Each unit gets an independent review. Then review the complete branch, get human branch review, and create the PR. History uses {epoch, entries, next_page}. Keep physical pruning and runtime-envelope work in OAB-6.8. Keep native retention intentionally deferred to OAB-6.8.2.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Unit 2 retained-code exception: commit e83c8a10955d3cbecbfbfbb2472e727ea9ebda49 arrived green without valid pre-implementation real-DO RED evidence. The first command used the wrong Vitest environment. Keep the working implementation. Add the missing native regressions and capture genuine failing assertions before corrections. The unit remains incomplete until the approved coverage and ownership contracts pass. No acceptance criterion is checked.
<!-- SECTION:NOTES:END -->
