---
id: OAB-7.6
title: Verify local F2 authentication and transport integration
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-24T00:05:00Z'
updated_date: '2026-10-24T21:29:00Z'
labels:
  - F2
  - acceptance
dependencies:
  - OAB-7.5
documentation:
  - docs/spec.md
parent_task_id: OAB-7
ordinal: 7600
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Separate local production-path evidence from deployment and external-client evidence. This task closes local integration gaps before any authorized service change.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Tests connect consent, token issue, REST and MCP reads and writes, refresh, scope denial, and owner revocation through production composition.
- [ ] #2 Local AC-08 evidence proves authoritative denial within one request despite stale KV. It does not claim device status or preserved plugin queues.
- [ ] #3 bun run check and technical reviews pass. Document implemented API contracts and commands without logging secrets or note bodies.
- [ ] #4 The remaining deployed checks and owner account decision stay open. F1 server-only scope and later plugin gates remain unchanged.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Use docs/superpowers/plans/2026-10-24-f2-local-delivery.md, Task 5. After OAB-7.5, complete local production-path integration, contracts, reviews, and one pull request. Do not deploy or start OAB-8.

Integration carryover from Task 3: verify actual encoded result sizes against the documented list estimate, including long JSON-RPC IDs and framing. Keep per-chunk bounds distinct from complete response sizes. Record exact limits and test evidence. This stays within planned aggregate transport validation.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
OAB-7.5 passed independent and scoped reviews at 89170e7. Start Task 5 from the approved plan. Complete production-composition integration, aggregate resource/lifecycle tests, and public API documentation. Carry the Task 3 encoded-size estimate note into explicit tests. Keep deployment, real external clients, and parent F2 gate completion outside this local task.

Task 5 implementation evidence: added production-entry OAuth/REST/MCP integration for dynamically registered and pre-registered clients, refresh downscoping, independent write-only scope denial, and owner revocation denial despite provider KV cleanup failure. Added actual 6 MB worst-case escaped request and response checks, declared-size and slot-before-body checks, and bounded response chunk assertions. Existing tests cover list and registry limits, shared REST/MCP reads, cancellation, uncertain authority outcomes, and admissions. No production behavior changed.

RED/GREEN checkpoints: first focused integration run passed immediately after test addition, recorded as the approved postimplementation-test exception. `cd apps/worker && bunx vitest run --config vitest.f2.config.ts test/f2/mcp-reads.test.ts -t 'oversized declared envelope|one envelope slot'` first failed 2 assertions because the test stream used its default eager queue. After `highWaterMark: 0`, the envelope checks passed; the cancellation case also passed after it asserted the observed 500 abort response and release. The initial escaped-output assertion failed because it searched only the first response segment; rolling bounded scan fixed the test. The worst-escaped mutation assertion first used read scope for an epoch, then SQLite text length, which stops at NUL; separate reader scope and BLOB byte length fixed the evidence. Final focused F2 command: `cd apps/worker && bunx vitest run --config vitest.f2.config.ts` passed 91 tests.

Final validation: `bun run docs:check` passed. `git diff --check` passed. `bun run check` passed with 52 tooling, 282 protocol, 2 plugin, 643 native Worker, 120 HTTP, and 91 F2 tests. Lint, docs, all type checks, and builds passed. Wrangler used `--dry-run` only. Self-review loaded the code-review skill and TypeScript profile. No implementation blocker found. Review covered API semantics, authorization and epoch denial, shared real DO authority, response estimates versus encoded chunks, bounded metadata, and worktree scope. OAB-7.6 stays In Progress for independent review; later acceptance and publication gates remain open.

Commit: aa98818 test(worker): verify local F2 authentication and transports. OAB-7.6 remains In Progress for independent review.
<!-- SECTION:NOTES:END -->
