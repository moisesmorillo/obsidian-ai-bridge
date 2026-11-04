---
id: OAB-35
title: Emit exact Content-Length on Worker blob reads
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-04T02:39:00Z'
updated_date: '2026-11-04T04:53:00Z'
labels: []
dependencies: []
references:
  - OAB-36
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

Owner scope extension: preserve fixed-length framing at the final response owner in read-response.ts, with content-reads.ts changes if needed. Add valid BYOB regression and cancellation-failure tests. Prove framing through a direct Worker socket or equivalent boundary with a passing positive control. Run full checks, then scoped review of both blocking findings and TSDoc.

Supervisor decision: use FixedLengthStream as the final blob body. Observe consumer cancellation at the next write after pending source reads settle. Preserve the generic JSON path. Add known-length owner tests, correct blob cancellation expectations, and prove full/range framing through the complete route on a direct Worker socket. Create the named Deferred cancellation task. Repeat both reviews and owner branch review before publication.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner approved the plan in Plannotator pn-9ebe50. Approval covers a test-only unknown-length wrapper around real R2 streams if needed. Baseline: 38 passed, zero failures. A local Miniflare probe confirms plain streamed responses drop manual Content-Length. No vault access or deployment.

RED: baseline with the unknown-length R2 read wrapper failed: 11 failed, 27 passed, exit 1. Blob GETs returned 500 before the new length assertions, and one existing check found a missing X-File-Large header. The runtime failed while dispatching streamed responses when the manual Content-Length lacked a fixed-length body. The first fixture attempt using TransformStream also caused client-disconnect errors. Replaced it with a test-only ReadableStream pump that forwards real R2 bytes and propagates cancellation.
GREEN: focused HTTP blob suite passed 38/38, exit 0. Full check attempt 1 failed lint formatting. Full check attempt 2 failed 4 existing apps/worker content-reads tests (3 timeouts and one unexpected 429), with 644/648 worker tests passing. Final docs:check passed. Final bun run check still fails on the same 4 content-reads cases. Remaining 37 worker test files and all tooling (56), protocol (304), and plugin (397) tests passed. Lint, docs, and all workspace typechecks passed.
Changed files: apps/worker/src/transport/blobs.ts; apps/worker/test/http/blobs.test.ts; apps/worker/test/fixtures/http-worker.ts. Limits: Local Workers tests do not prove deployed framing. OAB-8.8 must repeat the probe after merge and CI deployment. Test output includes uncaught simulated disconnect/network/SQLite errors. Task remains In Progress for parent review.

Correction: The full-check content-reads failures were outside the changed files, but this run does not prove they predated this branch. Treat them as unresolved validation failures, not confirmed baseline failures.

Continuation diagnosis: The three timeout failures came from cancellation not reaching the real storage reader through FixedLengthStream.pipeTo in the Workers test runtime. The known-policy test passed by itself. The later unexpected 429 was a cascade from unreleased read slots after the timeouts. An explicit source-reader/fixed-writer pump now owns source cancellation and pipe settlement. It also stops source demand when request abort races a delayed storage read. Added a source-failure response test. The content-read ownership suite now passes 14/14.
RED repeated with FINAL regression fixture and base production apps/worker/src/transport/blobs.ts from 2779837. Command: cd apps/worker && bunx vitest run --config vitest.http.config.ts test/http/blobs.test.ts, wrapped to record failure safely. Exit 1, 11 failed and 27 passed. Base streamed full and range requests returned runtime status 500 instead of 200 or 206. Other body checks received error JSON instead of blob bytes, and X-File-Large was absent. This is a clear runtime framing failure with the manual Content-Length and unknown-length stream fixture. Exact log: /tmp/oab35-final-red.log. Restored the implementation after the run.
Final green checks after repairs: focused blob HTTP tests 38/38; content-read tests 14/14; docs:check passed; bun run check passed. Full check: lint and documentation passed; workspace typechecks passed; tests tooling 56/56, protocol 304/304, plugin 397/397, Worker 649/649 (38 files); protocol, plugin, and Worker builds passed. Wrangler reported an available update warning only. Worker tests emit expected simulated network, client-disconnect, and SQLite failure diagnostics. These did not fail tests.

Follow-up commit: 70991a3 (fix(worker): preserve blob stream cancellation). Working tree is clean. Task remains In Progress for parent review.

Whole-branch review at 989cfc0 requests changes. Final JavaScript wrappers lose native fixed-length framing. Direct Worker socket control emitted length 3 for fixed.readable and no length for the wrapper. The RED fixture lacked BYOB support, so its 500 errors do not isolate framing. Unknown cancellation failures also disappear through allSettled. Owner approved scope extension to transport/read-response.ts, content-reads.ts if needed, and Worker tests. Keep all other limits. Repair both findings and TSDoc before owner branch review.

Scope extension blocked at 989cfc0. Miniflare 5 direct-socket probes showed that direct FixedLengthStream readable cancellation did not reach a pending source read. A zero-byte writer bridge did not expose cancellation. Native pipeTo also did not call source cancellation on output disconnect. Wrapping fixed.readable restores cancellation but drops Content-Length. I restored all experimental code and test edits. No repair commit or full check followed. See /private/tmp/worker-hotfix3-task-report.md for probes, logs, and contract costs. OAB-35 remains In Progress for owner decision.

Scope-extension repair is blocked. Corrected BYOB fixture passes all 38 blob cases against base through SELF.fetch, so prior 500 RED evidence was invalid. Direct Worker socket positive control preserves length only for direct FixedLengthStream.readable. Native zero-byte writer and pipeTo probes did not propagate downstream cancellation to a pending source read. Request-abort-only cleanup would weaken the current contract and was not accepted. Worker restored all experimental code and tests. No scope-extension fix commit exists. Current revision remains 989cfc0 with both branch-review findings open. No PR or deployment. A supported runtime mechanism or explicit contract decision is needed before implementation can continue.

Supervisor supplied hotfix3-cancellation-decision.md. This follows spec lines 313-323, not a spec exception. Consumer cancellation joins started storage reads. The runtime reports cancellation at the next write boundary. Request abort remains an extra early trigger. Keep storage, admission, cleanup, and slot ownership until settlement. Both review findings still need repairs.

Hotfix 3 correction after supervisor review

RED owner tests: On the base owner, `cd apps/worker && bunx vitest run --config vitest.config.ts test/read-response.test.ts` returned exit 1 with 2 failed and 8 passed. Both failures showed source cancellation started before a pending read settled. Log: `/tmp/oab35-read-response-red-final.log`.

Ordering correction: The first direct owner order exposed the response end before durable `finishAdmission` settled. After each consumed SELF.fetch body, SQLite still held one active admission. Four reads filled the limit and the next read returned 429. The supervisor approved separate durable settlement and local slot release. The owner now holds one bounded final chunk until source EOF, settles admission before the final write and close, and releases the local slot after response production settles. Cancellation still waits for the pending read, then cancels the source and joins cleanup.

Focused validation: `cd apps/worker && bunx vitest run --config vitest.config.ts test/read-response.test.ts test/content-reads.test.ts` passed 26/26. `cd apps/worker && bunx vitest run --config vitest.http.config.ts test/http/blobs.test.ts` passed 38/38.

SELF.fetch checks retain exact full and range Content-Length, bytes, and headers. SELF.fetch alone does not prove wire framing. A Miniflare direct-socket probe ran the complete HTTP blob route. Command: `bun build apps/worker/test/fixtures/http-worker.ts --target=browser --external 'cloudflare:*' --outfile=/tmp/oab35-http-worker-bundle.js`, then copy the bundle to `apps/worker/.tmp-oab35-http-worker.js`, run `node /private/tmp/oab35-full-route-framing.mjs`, and remove the temporary bundle. Output: upload 201; full read status 200, Content-Length 4096, 4096 bytes, bytes match; range read status 206, Content-Length 31, 31 bytes, bytes match. Probe output: `/tmp/oab35-direct-socket-probe-final.log`.

Full validation: `bun run docs:check` passed. `bun run check` passed lint, documentation, all typechecks, all tests, and all builds. Test counts: Worker core 654/654 across 38 files; Worker HTTP 122/122; Worker F2 103/103; tooling 56/56; protocol 304/304; plugin 397/397. Wrangler 4.45.0 reported an available update. Worker tests printed expected client-disconnect, network-loss, and injected SQLite failure diagnostics.

OAB-36 already tracks prompt cancellation as Deferred. This task references OAB-36. Do not act on OAB-36 unless its stated trigger occurs. OAB-35 remains In Progress for review.
<!-- SECTION:NOTES:END -->
