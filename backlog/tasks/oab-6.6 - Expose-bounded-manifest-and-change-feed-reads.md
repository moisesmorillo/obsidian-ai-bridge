---
id: OAB-6.6
title: Expose bounded manifest and change-feed reads
status: Done
assignee:
  - '@pi'
created_date: '2026-10-15 00:38'
updated_date: '2026-10-22T11:45:00Z'
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
- [x] #1 Vault, manifest, changes, exact-revision/current content and history endpoints return canonical metadata/ETags with bounded pagination and authorization.
- [x] #2 Epoch mismatch, expired cursors, pruned revisions and concurrent manifest writes have deterministic recovery responses; retained feed entries do not change when current state advances.
- [x] #3 Manifest/page/feed/range limits are enforced with bounded response memory and correct cancellation/admission cleanup.
- [x] #4 Real Worker/DO tests exercise the server portions of AC-12/21/25/40 and explicitly distinguish them from unimplemented plugin apply/no-op assertions.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Owner approved docs/superpowers/plans/2026-10-21-bounded-authoritative-reads.md in Plannotator pn-08b6dd. Complete three sequential work units: canonical read contracts, native authoritative reads, and bounded Worker transport. Each implementer owns RED/GREEN tests, bun run check, and commits. Each unit gets an independent review. Then review the complete branch, get human branch review, and create the PR. History uses {epoch, entries, next_page}. Keep physical pruning and runtime-envelope work in OAB-6.8. Keep native retention intentionally deferred to OAB-6.8.2.

Execution partition for approved unit 3: complete three serial components with one writer at a time. Component 3A owns lazy metadata traversal and response mechanics. Component 3B owns current/exact content and blob/range admission plus cancellation. Component 3C owns the final HTTP recovery/AC matrix and acceptance mapping. Each component owns checks and a commit. The existing unit review remains after complete integration. This changes delivery boundaries only, not scope or contracts.

Owner execution decision: use openai/gpt-6.1-sol:medium as the sole writer for all remaining integration components. Preserve the current worktree and changes. Complete the full approved contract and commit only after bun run check passes. No more routine questions before human branch review. Independent unit and whole-branch reviews still apply.

Review R1 correction: add barrier regressions for cancellation concurrent with known and unknown batch faults. Preserve known failure certainty in joined response cleanup. Keep pending work and cleanup charged until settlement. Run focused lifecycle tests, documentation checks, and the complete check before commit. Leave task closure to the parent.

WB-1 correction: add explicit barriers for abort during initial authority, metadata preparation, content selection, and blob preparation. Use one shared demand guard across existing read owners. Stop later demand but join started work and cleanup. Preserve known and unknown outcomes and R1. Run focused and full checks, commit, and retain review gates.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Unit 2 retained-code exception: commit e83c8a10955d3cbecbfbfbb2472e727ea9ebda49 arrived green without valid pre-implementation real-DO RED evidence. The first command used the wrong Vitest environment. Keep the working implementation. Add the missing native regressions and capture genuine failing assertions before corrections. The unit remains incomplete until the approved coverage and ownership contracts pass. No acceptance criterion is checked.

The sole integration writer connects lazy manifest, history, and feed sessions to shared response ownership. Current/exact text and blob/range reads use the same four read slots and one durable response ticket. Native selection checks that ticket in its policy transaction. Real HTTP tests cover server AC-12/21/25/40, recovery, and slot sharing. Plugin apply, no-op, trash, and conflict-copy behavior stays outside this task. RED evidence: missing lazy history/feed entry point, missing response owner module, content slot bypass, noncanonical content selectors, and unknown vault query keys. Added recovery, native content fencing, pending-work, and slot-sharing regressions started green after their related implementation. Keep this code under the retained-code exception. No task acceptance or closure occurs before independent review.

Self-review found two contract gaps. Content selection checked ticket epoch before the requested epoch. A real RPC regression failed with invalid_ticket instead of epoch_mismatch. Both native selectors now check current policy first, then the active ticket, in the same transaction. The cursor decoder also accepted nonzero base64url padding bits. A protocol regression failed before canonical re-encoding validation. Focused tests pass after both corrections. The first complete check found three old history tests that retained unread GET bodies. Those tests now consume each body after using its headers. No mutation assertion changed.

The complete focused integration run passes: four application/response files with 28 tests, and five real HTTP files with 93 tests. The obsolete unbounded history router is removed. Direct native history callers stay unchanged because native regressions still use them. Self-review covers lazy traversal, shared response ownership, content ticket fencing, canonical failure mapping, documentation, and inward imports. Independent task and branch review remain pending. The task stays In Progress with all acceptance boxes unchanged.

Review R1 correction: two barrier regressions reproduced known batch failure cancellation as uncertain instead of settled. The RED run passed 13 tests and failed both known-result assertions. Joined response cleanup now treats canonical ReadBatchFailure as known. Unknown producer and cancellation faults stay uncertain. No pending-work join or local release order changed. The focused lifecycle run passes four files and 33 tests. Task and acceptance status stay unchanged for independent review.

WB-1 RED: pre-response abort barriers failed 10 of 22 tests before correction. Authorization, summary, history ceiling, text selection, and blob metadata continued into later demand after abort. A shared local demand checkpoint now stops new work. Existing owners still join started RPC/R2 work and cleanup. The checkpoint adds no protocol failure or admission ledger. Known authority failures retain their response. Unknown authority/storage results retain uncertainty and original deadlines. R1 regressions stay unchanged. Focused lifecycle tests pass four files and 60 tests, including already-aborted input, pending storage, signal-aborted batches, and cleanup barriers. Independent finding closure and human review remain pending.

Final acceptance: the parent accepts AC 1-4 at implementation revision 090f0e5238383ac1e3b743784f4144ec26f0f2d9. Independent unit and complete-branch reviews passed after explicit finding closures. Unit 3 R1 is closed: known batch failures settle during cancellation, while unknown outcomes retain uncertainty. Whole-branch WB-1 closure is APPROVE: abort stops future native and storage demand, and started work and cleanup still join before slot release. Human branch review pn-69b0a2 approved this revision without changes.

AC 1: native and HTTP tests verify canonical authorized vault, manifest, feed, history, and current/exact content reads. They verify ETags, strict selectors, pagination, and ticket fences. AC 2: recovery tests verify epoch mismatch, expired cursors, pruned revisions, captured heads, and immutable feed/rename identities. AC 3: barrier and range tests verify bounds, shared slots, known/unknown outcomes, no future demand after abort, and pending-work/cleanup joins. AC 4: real Worker/DO HTTP tests cover server AC-12/21/25/40 only. Evidence remains in apps/worker/test/http/read-recovery.test.ts, the native read suites, and the application/content/metadata/response lifecycle suites.

Documentation review covered named TypeScript declarations, internal lifecycle helpers, protocol schemas/codecs, composition, and the implemented specification contracts. Structural owners remain cohesive: native authority owns policy and tickets, application traversal owns seek progress and outcome certainty, and response ownership joins production and cleanup. Transport validates inputs and encodes bounded responses. Composition wires capabilities. The shared demand checkpoint adds no admission ledger or protocol shape.

The parent accepts the retained-code TDD exception. Native code arrived green without valid pre-implementation RED evidence. The wrong-environment test command was not RED. Working code stayed intact, and missing native/recovery regressions were added. Some added tests started green. Corrections, including R1 and WB-1, retain genuine failing regressions before their fixes.

Reviewed validation: bun run check passed with 979 tests across 52 files. Lint, documentation checks, workspace typechecks, and dry-run builds passed. Known fault-injection diagnostics remain in passing suites. This bookkeeping-only tree receives the same full check before commit.

Accepted limits: no plugin apply/no-op/trash/conflict-copy or crash-recovery qualification. No physical pruning, deployed native retention, or aggregate runtime qualification. Producer EOF is not client receipt or final native-owner release. Permanently unresolved started work can retain capacity and cause safe refusal. Publication remains with the parent.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Complete authoritative reads now use canonical metadata and ETags, bounded lazy pagination, strict selectors, and current/exact content ticket fences. Recovery preserves epochs, tombstones, captured heads, exact identities, and immutable feed entries.

Shared read slots retain ownership through pending native/storage work, response production, and cleanup. Known failures settle, unknown outcomes retain original deadlines, and abort stops future demand. R1 and WB-1 closures passed independent review. Human review pn-69b0a2 approved implementation revision 090f0e5. The parent accepts all four criteria and the recorded retained-code TDD exception. Validation passed 979 tests across 52 files, plus lint, documentation checks, typechecks, and dry-run builds.

Evidence covers server AC-12/21/25/40 only. Plugin effects, physical pruning, deployed native retention, and aggregate runtime qualification remain outside scope. Producer EOF does not prove client receipt. The parent owns publication.
<!-- SECTION:FINAL_SUMMARY:END -->
