---
id: OAB-35
title: Emit exact Content-Length on Worker blob reads
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-04T02:39:00Z'
updated_date: '2026-11-04T02:58:00Z'
labels: []
dependencies: []
priority: high
type: bug
ordinal: 56000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The owner blob probe received all 1,100,033 bytes without Content-Length. Plain streamed responses lose the manual header. This hotfix stays separate from OAB-8.8 and its test vaults.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Full and range blob reads expose Content-Length equal to their exact body size in the Workers test runtime.
- [ ] #2 Blob bytes and existing response headers stay unchanged, including empty and boundary-size reads.
- [ ] #3 Documentation checks and the complete project check pass, with counts in task notes.
- [ ] #4 Owner approves the plan and branch review before pull request publication. No deployment occurs.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Read the owner brief and spec section 5.4. Add runtime regression tests first and capture RED through a success wrapper. Stream selected bytes through FixedLengthStream with the exact length. Run focused tests, docs:check, and check. Complete task and branch reviews. Get owner branch approval, push, create the pull request, and remove only this worktree.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner approved the plan in Plannotator pn-9ebe50. Approval covers a test-only unknown-length wrapper around real R2 streams if needed. Baseline: 38 passed, zero failures. A local Miniflare probe confirms plain streamed responses drop manual Content-Length. No vault access or deployment.

RED: baseline with the unknown-length R2 read wrapper failed: 11 failed, 27 passed, exit 1. Blob GETs returned 500 before the new length assertions, and one existing check found a missing X-File-Large header. The runtime failed while dispatching streamed responses when the manual Content-Length lacked a fixed-length body. The first fixture attempt using TransformStream also caused client-disconnect errors. Replaced it with a test-only ReadableStream pump that forwards real R2 bytes and propagates cancellation.
GREEN: focused HTTP blob suite passed 38/38, exit 0. Full check attempt 1 failed lint formatting. Full check attempt 2 failed 4 existing apps/worker content-reads tests (3 timeouts and one unexpected 429), with 644/648 worker tests passing. Final docs:check passed. Final bun run check still fails on the same 4 content-reads cases. Remaining 37 worker test files and all tooling (56), protocol (304), and plugin (397) tests passed. Lint, docs, and all workspace typechecks passed.
Changed files: apps/worker/src/transport/blobs.ts; apps/worker/test/http/blobs.test.ts; apps/worker/test/fixtures/http-worker.ts. Limits: Local Workers tests do not prove deployed framing. OAB-8.8 must repeat the probe after merge and CI deployment. Test output includes uncaught simulated disconnect/network/SQLite errors. Task remains In Progress for parent review.

Correction: The full-check content-reads failures were outside the changed files, but this run does not prove they predated this branch. Treat them as unresolved validation failures, not confirmed baseline failures.
<!-- SECTION:NOTES:END -->
