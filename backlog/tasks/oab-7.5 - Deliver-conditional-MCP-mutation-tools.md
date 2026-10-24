---
id: OAB-7.5
title: Deliver conditional MCP mutation tools
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-24T00:05:00Z'
updated_date: '2026-10-24T21:06:00Z'
labels:
  - F2
  - MCP
dependencies:
  - OAB-7.4
documentation:
  - docs/spec.md
parent_task_id: OAB-7
ordinal: 7500
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Agents need section 8 mutations through the existing authoritative operations. A separate slice makes conditional writes and retry safety independently reviewable. Work is local only.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 create_note, update_note, append_to_note, delete_note, and restore_note use the same DO operations as REST and canonical protocol schemas.
- [ ] #2 Tests cover exact ETags, stale epochs, collisions, tombstones, size limits, required append keys, retries, and per-client receipt isolation.
- [ ] #3 Every tool enforces its scope and DO revocation. Write does not imply delete. Agent origin and mutation feed entries remain correct.
- [ ] #4 All results carry epoch and bounded errors. Local tests preserve every data-safety invariant without claiming plugin delivery or real-client success.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Use docs/superpowers/plans/2026-10-24-f2-local-delivery.md, Task 4. After OAB-7.4, deliver exact-revision MCP mutations and client-scoped receipt tests.

Escalation scope: preserve 16c89e5. Add the missing production OAuth/MCP safety matrix with existing real DO fixtures and race seams. Keep tests that pass after implementation and record that exception. Fix only exposed defects, run focused suites, docs:check and the final check, self-review, record evidence, and commit. Keep In Progress for independent review.

OAB75-1 correction: add production-entry tests for omitted, null, and non-object append arguments. Verify invalid supplied keys remain distinct. Verify identity, scope, and DO revocation precede classification. Change only missing-key classification, run focused MCP tests, docs:check and final check, record closure evidence, and commit. Keep In Progress for scoped re-review.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
OAB-7.4 passed independent review at 39e7b48. Preserve the current jose pin. This task uses the existing application authority and remains local. Added canonical mutation schemas and production MCP tools for create, update, append, delete, and restore. Tool scopes are checked in Worker. Production tests cover all five mutations, stale create epoch, stale update ETag, append same-key retry, changed payload mismatch, client-scoped key isolation, denied delete scope, and denied read calls. The F2 MCP focused suite passed 9 tests. docs:check and bun run check passed. Task remains In Progress for independent review. Remaining test cases are listed in the task-4 report.

Escalation completed the remaining production-entry safety matrix without rebuilding commit 16c89e5. Added 22 regressions in test/f2/mcp-mutations.test.ts. Tests use real provider tokens, production MCP, local native DO storage, and deterministic real-RPC pauses. Passing postimplementation tests remain, as the owner approved. Real RED evidence exposed restore payload binding, lost conflict details, byte-limit classification, missing append-key 428 behavior, early durable cleanup, invalid-input scope ordering, and lost authority-response classification. Fixed those causes only. Scope-specific DO epoch checks remain. Known cleanup transfers through response EOF/cancel. Unknown work keeps its original deadline. The parent ruled that create-only means no live destination. Preserve exact-tombstone recreation and revision monotonicity, as docs/spec.md:97-99,265-270,464-471 state. The native admission test remains unchanged. Focused command: cd apps/worker && bunx vitest run --config vitest.f2.config.ts test/f2/mcp-mutations.test.ts test/f2/mcp-reads.test.ts. Result: 31 passed, exit 0. Biome formatting, bun run docs:check, Worker typecheck, and git diff --check passed. Final bun run check passed: 1170 tests across 73 files. Counts: tooling 52, protocol 282, plugin 2, Worker native 643, HTTP 120, F2 71. All checks and dry-run builds exited 0. Expected disconnect and injected rollback diagnostics remain. Self-review used the code-review skill and TypeScript profile over the complete OAB-7.5 range from 939c163 through the final overlay. Reviewed scope mapping, canonical schemas, immutable receipts, exact epochs/ETags, restore history, public feed origin, and response ownership. No open task-scope finding remains. Detailed matrix and closure evidence remain in the ignored task-4 report. Keep In Progress and leave independent review pending. No dependency, deployment, push, external service, personal vault, plugin behavior, or later-task work occurred.

OAB75-1 implementation closure: added 15 production-entry regressions before the correction. Seven absent argument forms now return HTTP 428 idempotency_key_required with the current epoch. Forms cover omitted, null, string, number, boolean, empty array, and an array with a nested key. Seven supplied invalid-key cases remain invalid_request rather than missing-key failures. One test checks identity, scope, and real DO revocation across all seven forms. Denials contain no epoch or protected content. RED command: cd apps/worker && bunx vitest run --config vitest.f2.config.ts test/f2/mcp-mutations.test.ts -t "append arguments|absent key". Observed exit 1: 7 failed, 8 passed, 22 skipped. The wrapper exited zero and recorded that test exit. Omitted input returned generic invalid_request. Non-object forms reached SDK validation and returned INVALID_PARAMS. The narrow transport correction maps only missing-key INVALID_PARAMS responses to the existing epoch-bearing failure. Canonical input schemas, command authority, tombstone behavior, ownership, size handling, and retry policy remain unchanged. GREEN focused command: cd apps/worker && bunx vitest run --config vitest.f2.config.ts test/f2/mcp-mutations.test.ts test/f2/mcp-reads.test.ts. Result: 46 passed, exit 0. Biome checked three files. bun run docs:check and git diff --check passed. Final bun run check passed 1185 tests across 73 files, exit 0. Counts: tooling 52, protocol 282, plugin 2, native Worker 643, HTTP 120, F2 86. All typechecks and dry-run builds passed. Scoped self-review used the code-review skill and TypeScript profile. OAB75-1 is fixed in implementation and ready for scoped re-review. No other behavior changed. Full evidence remains in the ignored task-4-report.md. Keep In Progress.
<!-- SECTION:NOTES:END -->
