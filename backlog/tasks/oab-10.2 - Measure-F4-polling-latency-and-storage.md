---
id: OAB-10.2
title: Measure F4 polling latency and storage
status: In Progress
assignee: []
created_date: '2026-11-05T12:48:00Z'
updated_date: '2026-11-05T13:39:00Z'
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
<!-- SECTION:NOTES:END -->
