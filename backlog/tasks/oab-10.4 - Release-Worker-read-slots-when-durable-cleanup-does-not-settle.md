---
id: OAB-10.4
title: Release Worker read slots when durable cleanup does not settle
status: Done
assignee:
  - '@pi'
created_date: '2026-11-05T20:19:00Z'
updated_date: '2026-11-05T21:51:00Z'
labels: []
dependencies: []
parent_task_id: OAB-10
priority: high
type: bug
ordinal: 61000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner W1 brief, 2026-11-05 about 20:30 UTC: one keep-alive client received persistent 429 admission_limited on reads for more than 30 minutes while PUT and DELETE succeeded. Renderer fetch returned 200 on the same paths. Suspected cause: four isolate read slots wait without a deadline for durable settlement or fixed-body shutdown. Production causality remains a hypothesis until local tests reproduce the leak. Scope: apps/worker and docs/api only. No vault action, protocol shape change, dependency, or direct deployment.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Workers runtime tests first reproduce rejected settlement, unresolved settlement, and client abort before body drain. Each case permits a fifth read within a bounded deadline.
- [x] #2 Local slots release after source work ends without an unbounded durable cleanup or consumer shutdown wait. Unresolved source work retains its slot.
- [x] #3 Successful response completion still waits for successful durable settlement. A settlement deadline fails the response and logs a safe diagnostic.
- [x] #4 bun run check passes. Task and complete branch receive TypeScript semantic review. Owner branch review precedes one PR against main.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add failing Workers runtime tests for settlement rejection, timeout, and abort before drain, with four held slots and fifth-read recovery. 2. Release local slots after source work and cancellation settle, independently of durable settlement and native writer shutdown. Bound durable settlement at 5000 ms and fail the response on rejection or timeout. Keep successful completion conditional on settlement. 3. Update TSDoc and old lifetime assertions. Run focused tests, docs:check, and bun run check. 4. Complete task and branch TypeScript semantic reviews, owner branch review, rebase, task closure, PR publication, and worktree removal. Plan gate: external W1-plan.md. No implementation before approval.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The owner authorized this parallel W1 scope through W1-read-slot.md and COMMON-F4.md. Only this task file may change in backlog/tasks. No vault access or Cloudflare action. The owner merges the PR. Existing OAB-36 remains deferred.

RED: `cd apps/worker && bun run vitest run --config vitest.config.ts test/read-response.test.ts -t 'fails a response and releases local slots'` failed as expected. The unresolved settlement test timed out after 10,000 ms because the response did not fail at a bounded deadline. The first rejected-settlement fixed-length assertion also exposed a zero-length test setup that returned EOF before settlement; changed it to one byte before continuing.

GREEN evidence: focused read response, aggregate runtime budgets, content reads, metadata reads, and aggregate body work tests pass (70 tests). Updated tests that previously expected slot retention through durable finish, including read cancellation and cleanup. F2 delayed-cleanup assertions now prove read capacity reuse while durable admission remains active; preserve response cleanup after the barrier releases. The first whole check exposed these stale lifetime assertions and a held cleanup gate. F2 targeted tests then passed after moving response cancellation until after the gate release. Full bun run check passes after these edits; runtime emits expected disconnect and injected rollback diagnostics from existing Workers test fixtures. No docs/api text described local slot lifetime, so documentation changes stay in truthful TSDoc only.

Final validation: `bun run docs:check` passed. Final `bun run check` passed: Biome lint, docs check, protocol/plugin/worker type checks, 691 Worker Vitest tests in the main run, 122 worker integration tests, 115 F2 tests, and all three builds. The additional final read-response run passed 15 tests, including generic and fixed-length settlement timeout failure. `bun run check` emits expected worker-disconnect and injected SQLite rollback diagnostics from existing fixtures. OAB-36 remains deferred because runtime network disconnect is not proven to produce AbortSignal. Evidence covers Workers runtime tests and dry-run build only, not production causality.

Task review of e4867f0..ceaa89a requested changes. The response ignored resolved ok:false settlement results and one release comment described the old lifetime. Correction 6846a7c adds result validation, generic and fixed response failures, and zero-byte settlement gating. New tests failed before correction. Scoped review of ceaa89a..6846a7c approved both closures. Source-work lifetime, fixed framing, cancellation, safe diagnostics, and TSDoc received semantic review. Final worker checks passed: docs:check and bun run check, including 696 main Worker tests, 122 integration tests, and 115 F2 tests. No production reproduction or network-disconnect AbortSignal proof exists. OAB-36 remains deferred. Branch review and owner diff gate remain pending.

BR-1 and BR-2 corrections are implemented in apps/worker. RED tests failed on unresolved preparation settlement and fifth-slot acquisition. GREEN: focused Worker tests passed 70 tests and F2 MCP read tests passed 17 tests. Final bun run check passed: lint, docs, type checks, test suites (91 tooling, 307 protocol, 602 plugin with 1 skipped, 701 Worker, 122 integration, 115 F2), and builds. bun run docs:check, worker typecheck, and git diff --check passed. Round 2 evidence is in .superpowers/sdd/W1-plan/task-1-report.md. Parent review and task closure remain pending. Production causality and network-disconnect AbortSignal behavior remain unproven.

Scoped review correction OAB-10.4-R1 is closed. RED: search-response test expected HTTP 400 invalid_request after abort during completed search preparation but got HTTP 500. GREEN: test/search-response.test.ts and test/application-search.test.ts passed 10 tests. F2 MCP read tests passed 17 tests. docs:check and final bun run check passed, including 702 Worker tests. The application outcome now preserves invalid_request with deferred bounded settlement. This restores the prior MCP search classification. Search router TSDoc now describes active source-work lifetime. Commit pending. Production causality and AbortSignal limits remain unchanged.

OAB-10.4-R1 correction committed as ef0cf50 (fix(worker): preserve search abort classification). The working tree has no staged files. The task record remains unstaged.

Complete branch review at 6796a3e found BR-1 preparation paths still held slots through unbounded cleanup and BR-2 omitted the zero-byte framing exception. Commit 02fdd3e corrects both. Scoped corrective review closed both with source-lifetime and shared deadline evidence. That review found R1 search-abort classification drift. Commit ef0cf50 restores invalid_request. Final scoped review approved R1 at ef0cf50. All actionable findings now have evidence-based closure. Final checks passed: docs:check and bun run check, including 702 Worker, 122 integration, and 115 F2 tests. Owner branch diff review remains pending.

Owner approved the complete branch diff in Plannotator pn-606e51 with no changes requested. Plan approval was pn-5bed28. The final code revision ef0cf50 passed bun run check. Complete branch semantic review plus scoped corrective reviews closed every actionable finding. Rebase on origin/main needed no code change. No vault access, production probe, direct deployment, or Cloudflare resource change occurred.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Released local read capacity after source work and source cancellation settle. Shared 5000 ms durable settlement policy covers preparation failures, search, content, metadata, MCP, and streamed responses. Rejection, unsuccessful result, and timeout fail delivery without successful EOF. Regression tests cover blocked cleanup, abort, preparation, empty responses, and preserved search failure classification. docs:check and bun run check passed. Task, branch, and owner reviews complete. Production cause and network-disconnect AbortSignal behavior remain unproven. OAB-36 stays deferred.
<!-- SECTION:FINAL_SUMMARY:END -->
