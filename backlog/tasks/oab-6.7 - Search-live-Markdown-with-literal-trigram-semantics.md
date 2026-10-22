---
id: OAB-6.7
title: Search live Markdown with literal trigram semantics
status: Done
assignee:
  - '@pi'
created_date: '2026-10-15 00:38'
updated_date: '2026-10-22T13:51:00Z'
labels:
  - F1
dependencies:
  - OAB-6.4
  - OAB-6.5
documentation:
  - docs/spec.md
parent_task_id: OAB-6
type: feature
ordinal: 30000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Section10 requires literal case/diacritic-insensitive substring search, not a query language or semantic search. Mutations must never leave stale FTS results, and callers must see coverage for files that cannot be indexed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The real DO FTS5 search passes every AC-15 example, including punctuation, internal quotes, literal AND and cafe matching café.
- [x] #2 Unicode query length 3–200 and result limits 1–50/default 20 are validated; ranking/snippets follow section 10 without interpreting user operators.
- [x] #3 Only live inline Markdown is indexed; canvas, blobs, oversized Markdown and tombstones remain excluded with accurate coverage counts.
- [x] #4 Mutation rollback, rename/delete/recreate and concurrent reads cannot expose an index inconsistent with authoritative state.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Plan: docs/superpowers/plans/2026-10-22-f1-literal-markdown-search.md. One implementer owns the complete search delivery: protocol RED/GREEN, native FTS RED/GREEN, HTTP and response-lifetime RED/GREEN, formatting, bun run docs:check, bun run check, and commit. Use canonical Zod search contracts, the existing trigram index, atomic native policy/ticket checks, and shared read-response ownership. Add no dependencies. Preserve all existing prerequisite edges. Keep deployment, native-runtime memory measurements, retention, OAuth, MCP, and plugin work outside scope. Wait for explicit human plan approval before product edits. After implementation, use one independent task reviewer, whole-branch semantic review, and human branch review before the PR.

Owner approved this plan in Plannotator pn-e01de1 on 2026-10-22. Execute the complete OAB-6.7 delivery with one implementer and one independent task reviewer. Keep human branch review before publication. Baseline frozen install and bun run check passed with exit 0 before product edits.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Preflight: one task owns protocol, native search, and HTTP search as one cohesive feature. No inter-task file or interface conflicts exist. Task 1 agrees with its global constraints and acceptance criteria. The native search gateway returns SearchResponse, and the application returns ReadOutcome<SearchResult>. Existing mutation owners stay unchanged unless a failing search regression proves an index defect. One writer owns this approved delivery. Human plan review pn-e01de1 approved the exact response fields, coverage definition, and snippet cap. No product edits preceded approval.

Implemented canonical query/result/RPC schemas, native bounded FTS selection, application authorization, strict HTTP validation, shared response ownership, and specification details.

Evidence: the initial protocol search test run returned exit 1 with four failed assertions for missing search schemas and query failure kinds. Its root workspace command also reported expected no-test-file results in unrelated workspaces. After implementation, the focused protocol suite passed 4 tests. Native and application search suites passed 5 tests. HTTP search suite passed 5 tests, including literal AC-15 cases, update/delete index visibility, strict parameters, scope checks, and shared four-slot admission. Response lifetime and production default-deny suites passed 20 tests.

Commands passed: `cd packages/protocol && bun run test -- search.test.ts`; `cd apps/worker && bunx --no-install vitest run --config vitest.config.ts test/vault-search.test.ts test/application-search.test.ts test/search-response.test.ts test/entry.test.ts`; `cd apps/worker && bunx --no-install vitest run --config vitest.http.config.ts test/http/search.test.ts`; `bun run docs:check`; `bun run check`. The final check passed lint, documentation checks, type checks, all tests, and builds.

TDD limit: the initial protocol RED was observed before protocol implementation. Native and HTTP tests were added after their implementation, so no pre-implementation native or HTTP RED was observed. One first HTTP run correctly rejected `OR` because it had only two code points; the test query changed to `OR `, which then passed. No earlier mutation implementation was changed.

Acceptance evidence added after c77bc17; retained the implementation and did not invent earlier RED results. Native and HTTP suites start green because they characterize the implemented search behavior. The earlier protocol RED remains the only pre-implementation RED.

AC 1: `apps/worker/test/http/search.test.ts` tests `cafe`/`café`, uppercase input, AC-15 literals, quotes, operators, and SQL-looking text through the real DO. `apps/worker/test/vault-search.test.ts` tests native FTS and literal matches.

AC 2: `packages/protocol/test/search.test.ts` covers Unicode code-point boundaries, passthrough, limit schema boundaries/default, strict result shape, ETags, and finite scores. `apps/worker/test/vault-search.test.ts` covers native score ordering, binary tie order, 20/50 limits, and 1,024-code-point snippets. `apps/worker/test/http/search.test.ts` covers default 20, maximum 50, strict syntax, and safe failures.

AC 3: `apps/worker/test/vault-search.test.ts` covers live Markdown, Canvas, attachments, oversized blob metadata, and tombstones with coverage counts. `apps/worker/test/http/search.test.ts` publishes a real 1,500,000-byte Markdown blob and confirms exclusion with coverage count.

AC 4: `apps/worker/test/vault-search.test.ts` forces a trigger failure after FTS changes and checks prior result body/ETag, empty replacement query, coverage, and head sequence. It tests real append, rename from Markdown to Canvas and back, delete/recreate, and restore. It gates the application gateway before native search RPC, commits a real mutation, then checks the returned snippet, ETag, path, and coverage all match the committed state.

Authority/lifetime evidence: the native search matrix tests current revocation, read-scope denial, expired, foreign, and old-epoch tickets. `apps/worker/test/application-search.test.ts` tests abort before authorization, during authorization, and during search, plus unknown RPC retention. `apps/worker/test/http/search.test.ts` checks invalid syntax uses no admission, a post-search RPC fault retains its active ticket, and search shares the four slots with manifest, vault, and content reads.

Validation after these additions: focused native/application suites passed 19 tests; focused HTTP suite passed 8 tests. `bun run docs:check` passed. `bun run check` passed lint, docs, types, 590 worker unit tests, 101 worker HTTP tests, protocol/tooling/plugin tests, and builds. The expected post-FTS failure appears in Cloudflare test runtime logs, while its test passes and proves rollback.

Independent task review d62f8ee3 inspected base2c5cbe5 through cfc8bc6 and returned spec compliance OK and task quality OK with notes. T1-P2 remains open: transport duplicates canonical query-length and limit policy. Whole-branch review at cfc8bc6 found WB1: search failureResponse discards encodeFileFailure headers, so a native admission_limited response loses Retry-After. The isolate-only refusal uses a separate hand-written response. This violates canonical retry behavior when durable client/vault capacity fills across requests. Correct both through canonical validation and failure encoding, with HTTP boundary and durable-refusal regressions. Structural review: native search owns one atomic policy/result/coverage transaction, application owns admission plus demand checks, and the existing response owner owns EOF/cancellation settlement. No mutation owner changed. Review scope includes all changed TypeScript declarations, tests, composition, specification details, and the approved plan. Platform-wide memory and deployed retention remain outside the evidence boundary.

Correction wave at cfc8bc6.
T1-P2 closed: `SearchQuerySchema` owns Unicode code-point bounds and failure identity. `SearchLimitSchema` owns the 1–50 range and default 20. Transport retains only canonical integer spelling checks. Real HTTP tests cover query lengths 2, 3, 200, and 201 with astral characters. They cover limits 0, 1, 50, and 51. Invalid queries and limits add no admission rows. Protocol tests confirm exact query text and canonical short/long failures.
WB1 closed: A real HTTP test filled all 16 durable client admissions. Before the fix, it failed because `Retry-After` was absent. The observed assertion was `expected 0 to be greater than 0`, with exit 1. `failureResponse` now forwards encoder headers. Isolate read-slot refusal now uses `encodeFileFailure` through that same response path. The regression checks status 429, canonical body, and positive `Retry-After`.
Typing correction: `makeGateway` now implements `SearchVaultGateway` directly. Test tickets use a 32-character ID and `expires_at`. No unchecked double cast remains.
Focused checks passed: protocol search tests (4), application search tests (6), and Worker HTTP search tests (11). `bun run docs:check` passed. `bun run check` passed lint, docs, type checks, 590 Worker unit tests, 104 Worker HTTP tests, 267 protocol tests, 52 tooling tests, 2 plugin tests, and builds. Expected network-disconnect and trigger-failure logs came from deliberate lifecycle and rollback tests. Task stays In Progress.

Final acceptance at implementation revision 71ede0e8fced84d89a0dad3b18effa6ec35952fd. Independent task review d62f8ee3 accepted the feature with T1-P2. Parent whole-branch review found WB1 and checked the complete change against the specification. Correction review 3eff7735 returned APPROVE and closed T1-P2, WB1, and the typed test-double correction with source and regression evidence. Human branch review pn-75ac54 approved the complete branch without changes. All four acceptance criteria now have the test mapping above. Documentation review covered changed protocol schemas, derived types, internal helpers, native store methods, application ownership, transport, fixtures, and specification details. The native transaction remains cohesive. Canonical schemas own value policy, transport owns URL syntax, and the shared response owner owns EOF/cancellation settlement. No actionable finding remains open. The parent accepts the recorded native/HTTP TDD exception and retains the added coverage. The final bookkeeping tree receives bun run check before publication. No deployment, personal-vault access, plugin qualification, aggregate memory claim, or F1 closure applies.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Completed literal Markdown search through real Worker and Vault DO paths. Canonical query limits, native ranking, bounded plain-text snippets, epoch-bound ETags, and exact coverage counts preserve the approved contract. Atomic rollback and mutation/interleaving tests protect index consistency. Shared response ownership preserves admission through cancellation and EOF. A genuine regression exposed lost Retry-After on durable admission refusal, and the correction uses canonical failure headers. Worker validation passed all checks with 590 Worker unit, 104 HTTP, 267 protocol, 52 tooling, and 2 plugin tests. Independent and human reviews approved implementation 71ede0e. The native/HTTP TDD exception remains explicit. OAB-6.8 and OAB-6.8.2 retain runtime-envelope and deployed-retention work.
<!-- SECTION:FINAL_SUMMARY:END -->
