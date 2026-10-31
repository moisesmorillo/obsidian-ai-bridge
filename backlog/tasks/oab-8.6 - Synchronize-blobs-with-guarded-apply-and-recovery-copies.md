---
id: OAB-8.6
title: Synchronize blobs with guarded apply and recovery copies
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-28T19:31:00Z'
updated_date: '2026-10-31T05:02:00Z'
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

Escalation: R2 remains open after repeated corrective deliveries at 0dc4561 and 42c527c without a named blocker. Final review at 42c527c also finds R11 in blob-to-inline pruning recovery. Global model policy authorizes a fresh-context worker on the session model for only R2 and R11. Preserve all closed findings and existing tests. Source review and acceptance remain incomplete.

Escalated correction at base 42c527c: R2 fixed for feed, explicit manifest kind, manifest hydration, and applyCurrent. Local blob admission now selects byte preservation independently of validated remote kind. Tests use 1,000,001-byte Markdown with invalid UTF-8. They compare every visible conflict and recovery byte, remote text, confirmed base, pending state, and cursor authority.

R11 fixed: rebasePendingApply retains content_kind when copy plans remain. Blob-to-inline fallback retains existing plans and resumes their durable step without naming them again. Restart tests stop after durable copy creation and optionally after durable authority rebase. They verify unchanged copy identities, newer inline authority, repeated resume, obsolete-row replay, and later feed continuation. A copied-blob fallback test also rejects duplicate conflict names.

RED evidence: Before fixes, the two-file run passed 109 tests and failed four tests, exit 1. The copied-blob plan test then failed with two visible conflict names, exit 1. Final negative control restored both production files from 42c527c temporarily. It failed all six new cases, passed the retained feed case, and skipped 108 tests, exit 1. Failures included missing exact copies, lost content_kind, and the rejected copied-to-named transition. Each negative-control wrapper exited 0 after checking the observed failure. The corrected production files were restored before GREEN checks.

Validation: Biome formatted four changed TypeScript files. bun run docs:check passed. Focused text-apply, reconciliation, device-journal, and publication suites passed four files and 200 tests, exit 0. The first full check hit two 5-second test timeouts during repeated million-byte deep comparisons. Exact length-and-every-byte assertions removed that cost. No timeout, fixture size, behavior assertion, or discovery rule changed. The final negative control still failed all six new cases.

Final bun run check passed, exit 0. Biome checked 231 files. Documentation, all four workspace typechecks, tests, and builds passed. Counts: tooling 5 files/56 tests, protocol 16/302, plugin 17/305, Worker 53/869. Total: 91 files/1,532 tests, zero failures. Worker build used dry-run mode. git diff --check passed.

Semantic self-review covered 42c527c plus this correction, not an independent branch approval. TSDoc now explains separate local preservation and copy-route retention. Canonical schemas remain unchanged in packages/protocol, with optional legacy fields intact. No new persisted shape, dependency, transport policy, or SDK boundary exists.

State-matrix audit: caller mode plus remote kind plus local admission selects preservation in TextApplyEngine.applyPathChange. Unknown remote kind resolves through the existing pinned reader. Inline authority with local blob bytes always reaches exact-byte preservation. Prepared work names plans once. Named work verifies copies before copied. Copied work verifies bytes and retention before remote effects. Rebase changes authority, retains local copy identities and content_kind, and rechecks named copies. Existing plans never return from copied to named through updateApply. Confirmed effects alone advance bases. Feed replay alone advances its cursor. Changed local bytes, corrupt copies, lifecycle close, and unconfirmed effects retain pending work or attention.

Structural candidates remain cohesive within this correction. TextApplyEngine owns preservation, recovery routing, effects, and completion. DeviceJournal owns durable step legality and authority persistence. Publication owns immutable sends, echoes, receipt checks, retries, and rejection recovery. SyncTransport owns validated remote identity and bytes. ObsidianTextVault owns guarded host effects. Enrollment scope owns path and size admission. No second apply engine or independent preservation policy was added.

Closure audit: R1 and R3-R10 remain closed through retained effect, race, lifecycle, collision, rename, retention, side-admission, and completed-trash regressions. F1 echo suppression and F2 TextApplyEngine naming remain closed. The OAB-8.5 suite and narrow OAB-8.9 successor-precondition regressions pass unchanged. DeviceJournal.resolve remains unchanged. R2 and R11 now have direct behavioral closure evidence. The approved binary I/O residual window remains. OAB-8.7 UI/loop work and OAB-8.8 live proof remain deferred. No live service, deployment, personal vault, push, PR, or task closure occurred. Task remains In Progress with acceptance unchecked. Independent review remains necessary.
<!-- SECTION:NOTES:END -->
