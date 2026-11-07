---
id: OAB-36
title: Prompt cancellation of pending storage reads for fixed-length bodies
status: In Progress
assignee: []
created_date: '2026-11-04T04:11:00Z'
updated_date: '2026-11-07T03:46:00Z'
labels: []
dependencies: []
references:
  - OAB-35
type: enhancement
ordinal: 57000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
FixedLengthStream exposes consumer cancellation at the next write, not while a storage read waits. OAB-35 joins that read before cleanup and slot release. Trigger: workerd exposes a writer-side cancellation signal, or request abort proves reliable on client disconnect. Revisit prompt source cancellation only after one trigger occurs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Evidence confirms a supported early cancellation signal without loss of native Content-Length.
- [x] #2 Tests prove pending storage reads and cleanup settle before slot reuse, including unknown cancellation failures.
- [x] #3 Full and range responses keep exact bytes and native fixed-length framing.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
# Prompt read cancellation Implementation Plan

Goal: Test early cancellation signals in the local Workers runtime without loss of native fixed-length framing.
Architecture: Keep ownedReadResponse and its source cleanup contract. Use runtime evidence before any production change.
Tech Stack: TypeScript, Vitest pool workers, workerd.
Spec: docs/spec.md, blob reads and admission capacity sections.

Owner decisions
- The overnight brief replaces human plan and branch gates. No live service or personal vault access.
- Keep FixedLengthStream. Do not replace native framing with a generic stream.
- If no early signal exists, ship regression tests and safe settlement changes only. Keep criterion 1 unchecked.
- No new dependencies. Only the named response, budget, reads, test files, and this task can change.

Review focus
- Consumer cancellation while a source read waits.
- Request abort versus actual consumer disconnect.
- Unknown cancellation rejection and uncertain admission.
- Pending read and cleanup before local slot reuse, except the existing hold deadline.
- Exact full and range bytes with native framing.

Steps
- [x] Read current response tests and relevant spec sections. Run baseline tests.
- [x] Test request.signal and FixedLengthStream writer.closed during consumer cancellation in workerd. Record signal scope and limits.
- [x] Add a failing regression before a production fix. If the runtime lacks a signal, retain explicit behavior tests instead.
- [x] Implement only the smallest supported cancellation or settlement change.
- [x] Run focused tests, bun run docs:check, bun run check, and Worker preflight.
- [ ] Review the task diff and complete branch with the code-review TypeScript profile.
- [ ] Record evidence against each criterion. Rebase, push, open the PR, remove the worktree.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
OAB-35 implements the approved next-write cancellation rule and keeps this task Deferred. The final Worker body uses FixedLengthStream. Pending source reads settle before source cancellation and slot release. The complete route direct-socket probe passed for full and range responses. Revisit this task only when its stated trigger occurs.

OAB-36 runtime probe and validation

Baseline: `cd apps/worker && bunx vitest run --config vitest.config.ts test/read-response.test.ts test/content-reads.test.ts test/blob-streams.test.ts` passed 113 tests across 3 files.

Runtime findings: In Vitest pool workers, canceling the fixed response body reader did not abort a synthetic Request signal passed to `ownedReadResponse`. The test uses a constructed Request and does not prove network disconnect behavior. With a FixedLengthStream consumer canceled while the producer waits on a pending source read, `writer.closed` stayed pending until the source read settled and the producer attempted its write. The pending read still needed to settle before source cancellation and cleanup. These tests do not establish a real client disconnect signal. No supported early signal was demonstrated.

No production fix was justified. Existing settlement ownership remains: pending producer reads and source cancellation join before slot release, and rejected unknown cancellation marks admission uncertain. RED-before-fix: not applicable because runtime evidence did not support a production fix.

Added two runtime limitation tests in `apps/worker/test/read-response.test.ts`. Focused validation passed: owner/content/blob tests 115/115, HTTP blob tests 38/38. Full `bun run docs:check` passed. `bun run check` passed lint, documentation, typechecks, all tests, and builds. Test totals: Worker core 713, Worker HTTP 122, Worker F2 121, tooling 91, protocol 307, plugin 828 passed and 1 skipped. Worker tests printed expected simulated cancellation, network-loss, and SQLite failure diagnostics. Worker preflight passed.

AC evidence: #1 remains unchecked because no supported early signal or direct network disconnect proof exists. #2 is checked based on pending-read/source-cancel ordering and unknown-cancellation uncertainty tests. #3 is checked based on full/range native framing tests and passing HTTP blob cases. Task stays In Progress for independent review. No live service, vault, Cloudflare change, deployment, or dependency change.

Branch review finding closure

The MINOR finding about repeated source work is addressed. The request-signal test now emits one bounded byte, waits on a barrier for the next source result, then returns EOF. It asserts exactly two source calls, no owner settlement before the barrier resolves, and only the `settled` owner outcome. This excludes the previous accidental overlength path. The Request remains synthetic and does not prove real client disconnect behavior.

Final validation: `bunx vitest run --config vitest.config.ts test/read-response.test.ts` passed 30/30. `bun run docs:check` passed. `bun run check` passed with Worker core 713, Worker HTTP 122, Worker F2 121, tooling 91, protocol 307, and plugin 828 passed with 1 skipped. Worker preflight passed. Expected simulated cancellation, network-loss, and SQLite failure diagnostics appeared. OAB-36 remains In Progress. No live resource action occurred.
<!-- SECTION:NOTES:END -->
