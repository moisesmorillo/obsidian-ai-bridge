---
id: OAB-8.6
title: Synchronize blobs with guarded apply and recovery copies
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-28T19:31:00Z'
updated_date: '2026-10-31T04:50:00Z'
labels: []
dependencies:
  - OAB-8.5
documentation:
  - docs/spec.md
parent_task_id: OAB-8
ordinal: 44000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Complete attachment and oversized text handling through the existing blob protocol. One focused PR. Preserve the approved binary residual window and use no Node or Electron APIs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 AC-31 changes mtime between hash verification and writing. Apply stops and preserves the current bytes as a conflict copy.
- [ ] #2 Binary apply uses double stat, durable pre-apply bytes, read-back verification, and seven-day recovery retention. Base advances only after confirmed bytes.
- [ ] #3 Scope matches section 7.8, including 25 MB limits and all exclusions. Binary and oversized text publication uses immutable journal payloads and the authorize/commit protocol.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Plan for owner review: .pi/plans/oab-8.6-blob-sync.md. Extend the existing shared apply engine, publication, reconciliation, journal, and transport with exact-byte support. Preserve atomic inline text and guarded binary effects. Test AC-31, seven-day recovery retention, size and scope limits, immutable retries, content-kind transitions, and restart authority. One worker owns implementation and checks after approval. Independent task review, whole-branch review, and owner diff review precede the pull request. No deployment or live-vault work.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner constraints: Keep TextApplyEngine named as-is. Preserve OAB-8.5 authority regressions. No Worker changes, dependencies, deployment, live service, or vault access. Keep task In Progress and acceptance criteria unchecked.

OAB-8.9 authorization: Keep only the narrow DeviceJournal.resolve successor-precondition fix. Never lower a queued match. Rebase absent and older same-epoch successors. Preserve newer and other-epoch matches. OAB-8.9 criteria 3 and 4 remain out of scope.

Earlier valid RED/GREEN evidence remains: enrollment size-boundary RED found oversized files classified as blobs. GREEN passed enrollment-scope tests. The rename source-only regression RED and GREEN are recorded in prior task history. F1 binary echo suppression and F2 TextApplyEngine naming remain closed.

R1-R8 closure: binary deletes and renames verify visible recovery copies, apply remote effects, and only then advance bases. Pinned content kind selects byte/text handling. AC-31 saves exact changed bytes before abort. Lifecycle fences block new binary effects after close. Binary path-key collisions preserve both byte versions and permit feed continuation. Rejected binary renames use exact current authority. Rename replacement stores and verifies pre-apply bytes. Copied-step recovery refreshes recovery retention. Tests cover each correction.

Corrective review follow-up R2/R9/R10: R2 now preserves exact bytes from oversized Markdown during blob-to-inline transition. It stores visible conflict and seven-day pre-apply copies before replacing the path with inline text. The SyncTransport test uses invalid UTF-8 bytes and checks exact copies, remote text, and confirmed base. R9 calculates pending rename sides before pinned destination reads. Source-only and neither-pending regressions use SyncTransport and verify that the destination is not read, including current tombstone authority. R10 accepts an absent original after verified binary trash and durable copy verification. A restart regression injects a journal write failure after trash. A separate regression verifies changed or recreated bytes block completion and leave base unchanged.

RED/GREEN: The initial focused run failed the invalid-byte test and both pending-side rename tests. An R10 negative-control edit restored the previous absent-file refusal. Its crash/restart test failed with exit 1 and unchanged base. The fix was restored. Focused GREEN: text-apply passed 65 tests. Related plugin suites passed 4 files and 171 tests.

Validation: bun run check passed lint, docs, all workspace typechecks, 91 test files and 1,526 tests, plus builds. Counts: tooling 5 files/56 tests, protocol 16/302, plugin 17/299, Worker 53/869. Worker build used dry-run mode. Biome and git diff --check passed before the task note update. The earlier full-check count of 1,421 was incorrect. Commit 0dc4561 passed 91 files and 1,521 tests. No independent reviewer approval is claimed. The approved binary I/O residual window remains.
<!-- SECTION:NOTES:END -->
