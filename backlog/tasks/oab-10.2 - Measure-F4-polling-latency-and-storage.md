---
id: OAB-10.2
title: Measure F4 polling latency and storage
status: Done
assignee: []
created_date: '2026-11-05T12:48:00Z'
updated_date: '2026-11-05T14:33:00Z'
labels: []
dependencies:
  - OAB-10.1
documentation:
  - docs/spec.md
parent_task_id: OAB-10
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
F4 needs measured request cost and storage use before the real-vault trial. Use service data and plugin status, not vault content. Scope: spec §7.4, §7.9, §12, and §14. OAB-8.7.1 names plugin-caused activity as an F4 measurement trigger.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Service and plugin status expose requests per day per device, p95 feed latency, DO database bytes, and R2 bytes with units and observation windows.
- [x] #2 Tests define counting boundaries, latency samples, empty windows, resets, and unknown or stale observations without false zero values.
- [ ] #3 Measure plugin-caused events and genuine edits. Fold OAB-8.7.1 into this task if cadence changes are needed. Otherwise retain Deferred status and its trigger.
- [ ] #4 Two-test-vault evidence records client ids, times, and results only. Existing service evidence remains unchanged.
- [x] #5 Protocol shapes stay canonical in packages/protocol. No Cloudflare resource change or manual deployment occurs.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Owner approved S2-plan.md through Plannotator pn-06c15e. Implement canonical measurement schemas, durable bounded daily aggregates, request and feed preparation observations, Access-protected owner console and JSON reads, API documentation, and failing tests first. Run bun run check, task review, complete branch review, and owner diff review before the PR.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner authorized parallel F4 execution despite dependency order. Service-only scope follows the approved S2 plan. Plugin display remains follow-up after OAB-10.1. OAB-8.7.1 stays Deferred with its F4 trigger because service request origin and cadence cannot classify local Obsidian events. After merge, the F4 continuation uses the two test vaults and harness-browser consent for one bounded live measurement read. Record only client IDs, times, and results. Preserve all existing service evidence. No personal-vault access, Cloudflare resource changes, or manual deployment.

Service implementation evidence for branch feature/oab-10-2-measurements: canonical strict protocol schemas now define verified request observations, durable v1 daily aggregates, owner requests, and explicit unknown/stale response states. The Worker records verified REST/MCP entry observations and successful /v1/changes preparation without reading lazy bodies. SQLite stores one bounded aggregate in meta and reads allocation plus deduplicated current/retained blob references. The Access-protected owner JSON and HTML summary use no-store responses.

Validation: failing schema test first: `bun run --cwd apps/worker vitest run test/measurement-schemas.test.ts` failed 2 tests because the schemas did not exist. GREEN: the same command passed 2 tests. Failing rollback case: `bun run --cwd apps/worker vitest run test/application-measurements.test.ts` failed because rollback still showed observed values. GREEN after correction: the same command passed. Focused Worker measurement tests passed, including native SQLite references, restart/corrupt state, request boundaries, feed headers, lazy body ownership, and owner Access. `bun run docs:check`, `bun run typecheck`, and `bun run check` passed.

The service tests do not prove plugin display or event classification, real two-test-vault evidence, live Access behavior, or production billing totals. OAB-8.7.1 remains Deferred with its F4 trigger. No vault content, deployment, or Cloudflare resource was accessed or changed. Full command evidence and reviewed file list: `.superpowers/sdd/S2-plan/task-1-report.md`. Keep task In Progress until parent review and the plugin/live criteria are proven.

Review round 1 correction: request freshness uses separate request observation bounds. Feed samples cannot refresh request freshness. Same-day reordered observations update totals without moving timestamps backwards. The owner response shows the request window and keeps missing request data unknown.

RED: `bun run --cwd apps/worker vitest run test/application-measurements.test.ts` failed 4 tests for stale freshness, reordered totals, sample cap order, and unknown requests. `test/vault-measurements.test.ts` failed 1 SQLite ordering test. `test/transport-measurements.test.ts` failed 1 controlled RPC ordering test. Request-window response coverage failed 2 assertions before implementation.

GREEN: Focused measurement tests passed 21 tests in 4 files. Owner tests passed 3 tests. `bun run docs:check` passed. `bun run check` passed, including all workspace tests and dry-run builds. Full evidence: `.superpowers/sdd/S2-plan/task-1-report.md`. The task remains In Progress. Parent review and plugin/live evidence remain open.

Branch correction for B1 and N1-N4.

B1: Reordered feed requests set `poll_cadence_incomplete` and clear min/max intervals for that day. The latest feed timestamp stays monotonic. N1: A negative wall-clock duration adds no latency sample. N2: The aggregate schema constrains request, sample, and client feed times to their windows. Contradictory native state reads as unknown and remains unchanged. N3: Owner HTML shows retained sample bounds and the cap-eviction note. N4: `MEASUREMENT_LIMITS` has one protocol-package owner. Schemas, application code, and cap tests consume it.

RED: `bun run --cwd apps/worker vitest run test/application-measurements.test.ts test/measurement-schemas.test.ts test/transport-measurements.test.ts test/vault-measurements.test.ts` failed 7 tests. The owner test command failed 1 HTML assertion. GREEN: The focused measurement suites passed 27 tests in 4 files. Owner tests passed 3 tests. `bun run docs:check` and `bun run check` passed. Worker tests passed 688. Full evidence: `.superpowers/sdd/S2-plan/task-1-report.md`. Task remains In Progress. Parent scoped review and human branch review remain pending.

Final review: implementation revision 40e6453. Task review and complete branch review used the code-review skill and TypeScript profile. Structural review covered aggregation state policy, canonical schemas, SQLite persistence, Access authority, transport timing, and lazy response ownership. Documentation review covered all changed semantic declarations, owner output, and docs/api/measurements.md. F1 separate request freshness and F2 reordered request totals closed at f5081e4. B1 incorrect reordered cadence, N1 false zero duration, N2 contradictory durable windows, N3 missing HTML sample window, and N4 duplicate limit ownership closed at 40e6453. Each closure has focused tests and a corrective review. No actionable finding remains. Parent bun run check passed on 40e6453 with exit 0. Human branch review pn-5a8de5 approved without changes. Service-only scope completes under the owner brief. AC1 remains unchecked for plugin display. AC3 remains unchecked for local event classification. OAB-8.7.1 stays Deferred with its F4 trigger. AC4 remains unchecked pending the bounded live read after merge. These limits remain with the F4 continuation. No live evidence, production policy, or complete billing claim follows from the tests.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added Access-protected service measurements with canonical protocol schemas, durable bounded daily request counts by client, p95 feed preparation latency, physical SQLite bytes, and distinct referenced blob bytes. Units, observation windows, partial coverage, stale values, and unknown values remain explicit. Regression tests cover asynchronous ordering, malformed state, caps, resets, stream ownership, and owner authority. Full project check and independent task, branch, corrective, and human reviews passed. Done applies only to the approved service-side deliverable. Plugin display, local event classification, and the two-test-vault live read remain unproven follow-up work.
<!-- SECTION:FINAL_SUMMARY:END -->
