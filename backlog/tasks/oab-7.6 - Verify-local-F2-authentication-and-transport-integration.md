---
id: OAB-7.6
title: Verify local F2 authentication and transport integration
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-24T00:05:00Z'
updated_date: '2026-10-24T23:43:00Z'
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

Corrective review findings F1, F2, and F3: fixed in tests and API documentation. F1 now pauses the real Durable Object finishAdmission call after response cancellation. While cleanup waits, the test proves REST read and MCP envelope capacity refuse competing requests with 429. It then releases cleanup, confirms capacity reuse, and releases all gates in finally. F2 adds gated worst-case MCP output, two held maximum-size REST bodies, three held REST responses, shared admission checks, competing refusal checks, actual encoded byte and chunk measurements, exact stored bodies, size/hash/origin, and publication side effects. F3 now defines one 128-byte list base allowance, entry JSON bytes, and comma bytes. It distinguishes the estimate from the full JSON-RPC frame and chunk bound. No production behavior changed. The existing Worker passed; coverage is postimplementation.

RED/GREEN: F1 focused test first passed 1 test. The mixed test first failed because it expected four active admissions after two gated REST writes. Real DO state showed six: four reads and two writes. Corrected the test to expect six. Focused command passed 2 tests: cd apps/worker && bunx vitest run --config vitest.f2.config.ts test/f2/mcp-reads.test.ts -t 'delayed real cleanup|worst-case MCP output with gated REST bodies'.

Validation: bun run docs:check passed. git diff --check passed. cd apps/worker && bunx vitest run --config vitest.f2.config.ts passed 7 files and 93 tests. bun run check passed with lint, docs, all workspace type checks, tests (52 tooling, 282 protocol, 2 plugin, 643 Worker, 120 HTTP, 93 F2; 1,192 total), and builds. Wrangler used --dry-run. Existing expected injected failure and disconnect reports appeared in negative-control tests. Self-review found no blockers or actionable findings. Local tests do not prove native heap use, deployed Access policy, client receipt, or plugin/device state. OAB-7.6 remains In Progress for independent review. See .superpowers/sdd/2026-10-24-f2-local-delivery/task-5-report.md.

Corrective commit: e4676aa test(worker): verify MCP cleanup and aggregate limits. Commit includes the new F1/F2 integration tests and F3 API wording only. git diff --cached --name-only is empty. Keep this task In Progress for independent review.

Record corrections: the Task 5 implementation commit is ea63ccb4a6863f08c746035ef3b161dec7c483b6, not aa98818. The aggregate test uses two representative 65,536-byte REST bodies, not maximum-size REST bodies. The worst-case escaped MCP response contains a 1,000,000-byte note. The correction source commit is e4676aa969fec17e3337d6066ed4e8301723c218. Scoped review remains pending.

Corrective work started from branch review findings BR-01 through BR-03. Root causes confirmed in production dispatch, MCP parsing, and pinned provider 1.2.4 cleanup source. OAB-7.6 remains In Progress.

BR-01 closed: production-entry tests failed first for absent KV (400) and invalid origin (404), then passed after provider-unavailable requests stopped before API dispatch. BR-02 closed: a pre-parse structural scanner bounds depth, containers, separators, strings, and per-container separators; high-element, deep nesting, high-key, and worst-escaped tests pass. BR-03 implementation and real provider-state test cover per-request operation budgeting and interruption recovery. The BR-03 end-to-end test followed the adapter implementation due to integration wiring, recorded as a TDD exception in branch-fix-report.md. OAB-7.6 stays In Progress for scoped re-review.

Corrective validation: cd apps/worker && bunx vitest run --config vitest.f2.config.ts passed 7 files/100 tests. Focused production OAuth regressions passed 4 tests. Focused MCP structure and escaped-output regressions passed 4 tests. Existing entry suite passed 12 tests and admission-commit suite passed 31 tests after updating unconfigured-entry expectations. bun run docs:check and git diff --check passed. Final bun run check passed lint, docs, type checks, 1,199 total tests (52 tooling, 282 protocol, 2 plugin, 643 Worker, 120 HTTP, 100 F2), and dry-run builds. Self-review loaded code-review and TypeScript profile. No blocker in this corrective slice. Native heap and SDK-copy sizes remain unmeasured. OAB-7.6 stays In Progress for required scoped re-review. Full report: .superpowers/sdd/2026-10-24-f2-local-delivery/branch-fix-report.md.

BR-03 scoped follow-up against rereview base 318fc1fa: retained the 48-call cap as provider KV calls plus registry RPCs only. Renamed OwnerCleanupBudget to OwnerCleanupExternalCallBudget and clarified units. One optional configured JWKS fetch on cache miss is outside that budget. SqliteClientRegistry.revokeClient now uses a set-based denial INSERT SELECT in the same atomic generation/consent/pending transaction. It no longer materializes all grant IDs or loops one denial insert per grant. Six data statement calls run inside the callback (2 tx.all, 4 tx.run). At 8,192 grants, three grant-range statements process at most 24,576 total candidate rows. Anti-join reads at most 8,192 retained denials. Conflict checks at most 8,192 denial keys. Consent deletion scans at most 1,024 rows. Update affects at most 8,192 flags; insert adds at most 8,192 new denial rows; final selection inspects at most 8,192 candidates, returns 17, and sends 16. These are source bounds, not physical SQL page, CPU, or heap measurements. Real SQLite near-cap test proves all-or-nothing rollback, all grant denials, old timestamp/state preservation, generation increment, 1,024 consent deletion, and bounded batch. No behavioral RED surfaced: the semantic test passed against the prior loop implementation and passed after set-based SQL. See the postimplementation coverage exception in branch-fix-report.md. OAB-7.6 stays In Progress.

Final branch technical review covers main 860e462 through 08000cf. It found BR-01, BR-02, and BR-03. Corrections 318fc1f and 6299451 close these findings. Scoped reviews accept BR-01 fail-closed dispatch and BR-02 pre-parse structural bounds. The final scoped review accepts BR-03 at 62994517ce8d325fa9034196bb67956c5a8441d6. Provider cleanup stays incremental. Atomic denial uses bounded set-based SQLite work. External calls and local SQL use separate units. The near-cap test covers 8,192 grants and 1,024 consents with rollback. Final recorded validation passes 1,200 tests, lint, documentation, types, and dry-run builds.

Documentation scope includes canonical protocol schemas, named TypeScript declarations, docs/api/f2.md, and plan resource statements. Structural review covers composition, trusted identity, registry policy, application adapters, transport ownership, canonical contracts, and tests. Every actionable task and branch finding has an explicit closure. Native heap, SDK copy sizes, SQLite CPU, deployed Access, external clients, and plugin/device behavior remain unqualified. The provider distribution source was unavailable to scoped reviewers. The worker records local pinned-source inspection and real KV adapter tests. No deployment occurred. Keep OAB-7.6 In Progress for the owner branch review and publication. Keep OAB-7 and later deployed gates open.
<!-- SECTION:NOTES:END -->
