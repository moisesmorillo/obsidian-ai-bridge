---
id: OAB-6.8
title: Enforce retention capacity and aggregate runtime budgets
status: In Progress
assignee:
  - '@pi'
created_date: 2026-10-15 00:38
updated_date: '2026-10-23T19:00:00Z'
labels:
  - F1
dependencies:
  - OAB-6.6
  - OAB-6.7
documentation:
  - docs/spec.md
parent_task_id: OAB-6
type: feature
ordinal: 31000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Section12 budgets apply to the whole vault and shared Worker isolate, not just individual calls. Retention must preserve tombstones and future export pins, and capacity pressure must not silently erase history or prevent the allowed recovery operations.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The 10,000-file / 2 GB envelope and attention thresholds are enforced without off-by-one admission races; reads/deletes remain available at the declared cap, satisfying AC-43.
- [ ] #2 Feed/receipt/history retention honors 30 days, the 25-day + 5-minute receipt safety, the 7-day history floor and export pins; tombstones and lifetime revision identity survive pruning.
- [ ] #3 Per-client concurrency above 16 yields 429 with Retry-After under distributed Worker interleavings, not only within a single isolate.
- [ ] #4 Aggregate memory, SQL row/parameter limits, connection/subrequest counts and slow-stream/cancellation recovery have explicit bounded behavior and executable checks; unmeasured claims are not reported as proven platform headroom.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Draft plan: docs/superpowers/plans/2026-10-22-retention-capacity-runtime-budgets.md. Human approval is pending in Plannotator pn-71230a. Do not implement before owner approval. Complete three sequential units: atomic capacity and observable state, bounded durable retention, then distributed admission and aggregate runtime checks. Start with native transaction-size and exact storage-attribution checks. Stop and report if the pinned runtime cannot support the specified accounting. Keep OAB-6.8.2 deployed native retention deferred. No deployment authorization applies. Each unit owns RED/GREEN, bun run docs:check, bun run check, a commit, and independent review. Complete whole-branch and human branch reviews before publication.

Owner approved the plan in Plannotator pn-71230a. Execute its sequential work units with native feasibility gates first. Deployment remains unauthorized.

Owner resolution after the native gate: keep sql.databaseSize for the 2 GB total cap. Use logical payload bytes for revisions, receipts, and changes. Maintain category counters and their sum in meta within the publication transaction. Pruning subtracts deleted payload bytes atomically. Record missing dbstat in spec section 12. Do not create an investigation task. The owner approves the spec and plan amendment without another plan review. Resume Unit 1 with the same worker. Do not ask again before the PR except for a failed bun run check or another specification change.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Planning baseline: main synchronized by fast-forward to f30435f after merged PR #16. The original checkout was clean. Direct dependencies OAB-6.6 and OAB-6.7 are Done. OAB-6.8.1 is Done. OAB-6.8.2 remains Deferred. Frozen dependency installation and bun run check completed with exit 0 in the isolated task worktree before product edits. All acceptance criteria remain unchecked.

Unit 1 stopped at the approved native feasibility gate. The initial native attribution assertion failed with no such table: dbstat: SQLITE_ERROR. Transaction-visible database allocation, rollback, and page reuse passed. The capability-observation suite then passed 2 tests. This proves dbstat is absent, not that every possible attribution method is unavailable. apps/worker/test/vault-capacity-native.test.ts remains untracked and preserved. No production or protocol edits, full checks, or implementation commit occurred. Exact history-group accounting needs an owner decision before further implementation. Plan approval remains pn-71230a. No deployment authorization applies.

Unit 2 worker b3fedf96 stopped at its 1800000ms runtime timeout. No Unit 2 commit or report exists. Preserve all partial work: nine tracked files and three new retention/test files. Focused retention, alarm, documentation, and type checks appear in its log. The full check failed one native cursor-expiry regression in vault-read-admission.test.ts: the pruned-empty-feed case resolved an empty feed instead of rejecting. The parent did not repeat tests. Same-worker recovery must inspect this exact failure, preserve prior evidence, finish validation, and report the final state. No execution-mode or model change applies.

Unit 1 accepted at 2c54d1c after review 1cf3d264. Its non-blocking summary and evidence notes closed in Unit 2. Owner confirms pre-production schema breaks without migrations. Unit 2 completed at 75e6776 after same-worker timeout recovery and passed review a9a2b677. Its full check passed 1039 tests. The cursor fixture now records its simulated durable pruned boundary without weakening old-cursor rejection. Unit 3 completed at 472bd54, then review eaf8ff21 found two local evidence gaps. Correction 73dc5ae adds real HTTP response-lifetime overlap and replaces the false full-response allocation model with source-backed named-value arithmetic. Scoped review d3c7161c plus skill follow-up 2842ec5b closes U3-R1 and U3-R2. Direct execution already owns body slots. The actual corrected gap was HTTP response ownership. The 16000000-byte named-value subtotal is not complete application or process memory. Latest worker full check passed tooling 52, protocol 269, plugin 2, native 614, and HTTP 107 tests. Documentation, types, and dry-run builds passed. No acceptance box is checked yet. Whole-branch and human branch reviews remain open. Deployed native retention stays deferred under OAB-6.8.2. No deployment applies.

Whole-branch review examined f30435f..0682409 and found WB-R1 stale-precondition precedence and WB-R2 local aggregate payload evidence gaps. Correction commits ad2f82c and 3478056 close both. Admission now validates current preconditions before capacity and ticket consumption. Native and HTTP tests cover separate cap conditions, occupied create/collision, write-only 412, state preservation, and receipt replay. Retention selects identities and accounts one revision payload at a time. Tests exercise ordinary and pressure pruning over 49 maximum escaping-heavy revisions, plus simultaneous routed body/read payloads. Session-model scoped review aa3e583a APPROVE at 3478056. It confirms all prior finding closures and no fix-introduced or structural issue. The reviewer independently ran bun run check: 1052 tests across 64 files passed, exit 0. Formatting, docs, types, and dry-run builds passed. Frontend payload allowance is below 24000000 bytes. Separate DO retention payload allowance is 20050572 bytes. These are named local payload allowances, not complete heap/process proof. OAB-6.8.2 remains deferred. Human branch review remains pending. The earlier empty-command guard block was a worker error, not a tool outage. No product data or remote resources changed.
<!-- SECTION:NOTES:END -->
