---
id: OAB-12.8
title: Remove revoked and never-consented clients from the owner console
status: Done
assignee: []
created_date: '2026-11-07T00:30:00Z'
updated_date: '2026-11-07T00:46:00Z'
labels: []
dependencies: []
parent_task_id: OAB-12
ordinal: 76000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The owner console retains revoked clients and abandoned registrations. The owner requested cleanup after cutover. Keep vault files and history intact.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Remove deletes a revoked registration and retained grants with existing CSRF protection. Active grants prevent removal.
- [x] #2 The next console render removes registrations with no accepted grant older than 24 hours.
- [x] #3 The console lists active clients first and revoked clients with a Remove control.
- [x] #4 Client removal leaves vault files and history intact. History client ids remain opaque strings.
- [x] #5 Tests cover revoked removal, active refusal, stale registration cleanup, and CSRF rejection.
- [x] #6 bun run check passes. No Cloudflare resource change or manual deployment occurs.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add failing F2 registry and owner tests. Add application registry removal and render-time stale cleanup. Keep durable denial rows and vault history. Refuse active grants and pending provider cleanup. Order clients before pagination. Add the protected Remove form and API docs. Run bun run docs:check and bun run check. Complete semantic and branch review. Publish one PR and remove the worktree.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner brief authorizes this scope under OAB-12. Parallel execution is authorized. No personal vault access. CI1 owns workflows and preflight scripts.

Supervisor order: all proof uses isolated tests and fakes only. Never open, enroll, or resume any vault in Obsidian. Production now holds the live owner vault. This order replaces the older dev-vault authorization.

Plan approval: Plannotator pn-00b30e. RED: all six new tests failed before implementation for missing removal, sweep, ordering, and form behavior. GREEN: 15 focused F2 tests pass across owner-cleanup, registry, and owner suites. Task review: code-review on openai/gpt-6-luna at high thinking approves the complete overlay against a235e1c with no actionable findings. Scope includes new declarations and TypeScript documentation. The registry remains the atomic policy owner. Active LSP checks report no TypeScript errors. Existing test API deprecation hints and heuristic source findings remain outside this change. Full repository check remains pending. No vault, Obsidian, or live-service access occurred.

bun run check passes with exit 0. This includes lint, docs:check, workspace typechecks, all tests, and builds. Worker build uses wrangler --dry-run only. No resource change or manual deployment occurs. The test runtime prints expected negative-path storage and disconnected-stream errors while all suites pass.

Final branch review: branch-review on openai/gpt-6.1-sol at high thinking approves 0bb0c51..83a1b37 with no actionable findings. Documentation scope includes all changed TypeScript declarations, named test helpers, and docs/api/f2.md. Structural candidates: SQLite registry and owner transport. Both retain cohesive responsibilities and one atomic registry policy owner. The reviewer notes that wrong-owner removal also encounters an active grant in its test. The SQL owner guard is explicit. No change is necessary. Validation: the full bun run check also passes after rebase. Totals: 2091 tests pass and one plugin test skips. Both reviews use static inspection. Parent owns all test execution. No hosted CI evidence exists before publication. Owner approved branch review in Plannotator pn-57ba34 with no changes.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Add protected removal for revoked clients after provider cleanup. Sweep stale never-consented records during console rendering. Order active clients before revoked clients across pages. Preserve vault history and durable denial rows. Six new tests failed before implementation. Focused tests and bun run check pass. Task review, branch review, and owner review approve the change. All proof uses isolated test storage and fakes. No resource change or manual deployment occurs.
<!-- SECTION:FINAL_SUMMARY:END -->
