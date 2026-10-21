---
id: OAB-6.6
title: Expose bounded manifest and change-feed reads
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-15 00:38'
updated_date: '2026-10-21 22:27'
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

Execution partition for approved unit 3: complete three serial components with one writer at a time. Component 3A owns lazy metadata traversal and response mechanics. Component 3B owns current/exact content and blob/range admission plus cancellation. Component 3C owns the final HTTP recovery/AC matrix and acceptance mapping. Each component owns checks and a commit. The existing unit review remains after complete integration. This changes delivery boundaries only, not scope or contracts.

Owner execution decision: use openai/gpt-6.1-sol:medium as the sole writer for all remaining integration components. Preserve the current worktree and changes. Complete the full approved contract and commit only after bun run check passes. No more routine questions before human branch review. Independent unit and whole-branch reviews still apply.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Unit 2 retained-code exception: commit e83c8a10955d3cbecbfbfbb2472e727ea9ebda49 arrived green without valid pre-implementation real-DO RED evidence. The first command used the wrong Vitest environment. Keep the working implementation. Add the missing native regressions and capture genuine failing assertions before corrections. The unit remains incomplete until the approved coverage and ownership contracts pass. No acceptance criterion is checked.

The sole integration writer connects lazy manifest, history, and feed sessions to shared response ownership. Current/exact text and blob/range reads use the same four read slots and one durable response ticket. Native selection checks that ticket in its policy transaction. Real HTTP tests cover server AC-12/21/25/40, recovery, and slot sharing. Plugin apply, no-op, trash, and conflict-copy behavior stays outside this task. RED evidence: missing lazy history/feed entry point, missing response owner module, content slot bypass, noncanonical content selectors, and unknown vault query keys. Added recovery, native content fencing, pending-work, and slot-sharing regressions started green after their related implementation. Keep this code under the retained-code exception. No task acceptance or closure occurs before independent review.

Self-review found two contract gaps. Content selection checked ticket epoch before the requested epoch. A real RPC regression failed with invalid_ticket instead of epoch_mismatch. Both native selectors now check current policy first, then the active ticket, in the same transaction. The cursor decoder also accepted nonzero base64url padding bits. A protocol regression failed before canonical re-encoding validation. Focused tests pass after both corrections. The first complete check found three old history tests that retained unread GET bodies. Those tests now consume each body after using its headers. No mutation assertion changed.

The complete focused integration run passes: four application/response files with 28 tests, and five real HTTP files with 93 tests. The obsolete unbounded history router is removed. Direct native history callers stay unchanged because native regressions still use them. Self-review covers lazy traversal, shared response ownership, content ticket fencing, canonical failure mapping, documentation, and inward imports. Independent task and branch review remain pending. The task stays In Progress with all acceptance boxes unchanged.
<!-- SECTION:NOTES:END -->
