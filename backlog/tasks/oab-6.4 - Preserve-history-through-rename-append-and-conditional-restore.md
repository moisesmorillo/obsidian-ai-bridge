---
id: OAB-6.4
title: Preserve history through rename append and conditional restore
status: Done
assignee:
  - '@pi'
created_date: '2026-10-15 00:38'
updated_date: '2026-10-19 21:29'
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
- [x] #1 Rename emits one self-contained change, leaves the source tombstone, permits case-only renames and uses the destination lifetime revision counter, including AC-14/26.
- [x] #2 Append is current-revision atomic, requires an idempotency key and observed epoch, and rejects tombstones, blobs, missing paths and oversized results without partial effects, covering AC-22/29/34.
- [x] #3 History and restore preserve exact retained bytes; restore requires the current destination ETag, refuses occupied paths unless requested and cannot resurrect a later delete on retry.
- [x] #4 Real DO interleaving and retry tests verify immutable feed/history and the server-side conflict preconditions without claiming plugin conflict-copy behavior.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Owner approved plan pn-d60fcc: docs/superpowers/plans/2026-10-19-f1-history-mutations.md. OAB-6.8.1 measurement prerequisite passed independent review at c2661ff. Continue with canonical command contracts, native rename/append/history/restore, and real HTTP tests. Restore with as_conflict_copy true writes the same path, preserves displaced history, and checks the current ETag. Each task owns RED, GREEN, full checks, and its commit. Independent task reviews, whole-branch review, and human branch review precede publication.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Planning starts from fetched origin/main at 58b074f after merged PR 10 and PR 11. Use isolated feature/oab-6.4. Preserve the original checkout. The owner explicitly approved measurements first and in-place restore semantics. No Cloudflare resource changes, personal-vault access, or dependency additions are authorized.

The owner approved plan review pn-d60fcc. Start Task 1 measurements before any new mutation SQL. Use task-owned implementation and independent reviews.

OAB-6.8.1 passed independent review at c2661ff. Parent accepted its bounded native measurements. T1-R1 corrected stale approval wording in both task plans. Continue approved Task 2 only. OAB-6.4 acceptance criteria remain unchecked.

Task 2 accepted at 2620b6d after independent corrective review f10474d8. T2-R1 fixed: native preparation tests reject forged append size and changed rename/restore bodies with old identity. Omitted and false restore flags share one fingerprint. T2-R2 fixed: prepared commands expose deep readonly types and runtime frozen snapshots. Type RED first showed three unused ts-expect-error diagnostics before the type correction. Initial Task 2 import failures did not prove functional RED. Keep the working implementation and record that process exception. Final parent bg_run bec0ca373 passed docs:check and full check: 610 tests, zero failed, exit 0. Source and dry-run builds passed. Task 3 can now start. Native and HTTP enforcement remain pending, and all OAB-6.4 acceptance criteria remain unchecked.

Task 3 accepted at 781cca1 after full native review 9e30172e and corrective review 2f3c411a. T3-R1 fixed: history uses explicit SQL revision ordering. Native reverse_unordered_selects exposed functional RED with unordered revisions [3,1]. The fixed query returns [1,3], including a tombstone and pruning gap without other-path data. The test restores the pragma in finally. Final full check passed 648 tests: standard Worker340, HTTP16, protocol238, tooling52, plugin2. Earlier report and reviewer labels called the16 HTTP tests budget tests. The corrected report verifies actual configs. SQL measurements omit internal FTS SQL and implicit transaction control. Runtime memory remains unmeasured. Task 4 may start. Native source-bound rename capacity leases precede body reads without granting content authority. Complete command activation retains original deadlines and ownership. All OAB-6.4 acceptance criteria remain unchecked until branch completion and human review.

Final acceptance at 0796968 follows human approval pn-619d4a. All four acceptance criteria have native and HTTP test evidence.

AC1: vault-history.test.ts and HTTP history tests verify one rename change, source tombstones, case-only names, collisions, and destination lifetime counters.
AC2: vault-append.test.ts verifies current-state CAS, concurrent changes, exact input bytes, epoch/key checks, and atomic refusals.
AC3: native and HTTP tests verify retained bytes, exact current destination ETags, occupied-path consent, replay, and stale retries after delete.
AC4: real Durable Object interleavings verify immutable revisions and feed state. These tests make no plugin conflict-copy claim.

Independent reviews closed T1-R1, T2-R1, T2-R2, T3-R1, T4-R1, WB-R1, and WB-R2. WB-R1 now rejects omitted or wrong commit keys without state changes. WB-R2 counts explicit application FTS dispatches. Historical measurements retain their original revision boundary.

Human corrections H-R1, H-R2, and H-R4 passed independent review at e495971. H-R3 retains the approved ascending varint guards. Parent verified the sole later comment correction at 0796968. It names the current destination ETag. Human correction review pn-619d4a approved the resulting diff.

Final docs and full checks passed at 0796968: 664 tests, zero failures, successful typechecks and builds. Standard Worker344, HTTP28, protocol238, tooling52, plugin2. Wrangler used dry-run mode only. Earlier branch-wide LSP checks include 17 inconclusive silent rechecks. Correction-path probes reported no TypeScript errors.

Runtime memory and aggregate qualification remain unmeasured. Production identity remains deny-all. Deployment and plugin qualification remain outside this task.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented conditional rename, atomic append, metadata-only history, and exact retained-revision restore through native authority and HTTP routes. Source-only rename capacity leases precede body reads without granting destination authority. Publication preserves exact revisions, ownership, receipts, and collision visibility.

Final validation passed 664 tests plus documentation, formatting, typechecks, and dry-run builds. Independent reviews and human review pn-619d4a accepted the corrections. Runtime memory, aggregate capacity, deployment, and plugin qualification remain outside this result.
<!-- SECTION:FINAL_SUMMARY:END -->
