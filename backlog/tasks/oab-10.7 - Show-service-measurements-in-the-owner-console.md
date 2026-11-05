---
id: OAB-10.7
title: Show service measurements in the owner console
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-05T22:33:00Z'
updated_date: '2026-11-05T22:40:00Z'
labels: []
dependencies: []
parent_task_id: OAB-10
ordinal: 62000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The F4 supervisor needs browser-based service measurements through the existing Access session without a cookie file. Complete and test the existing HTML summary rather than add a second page. Scope stays within apps/worker, docs/api, and this task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The owner console links to an Access-only server-rendered measurement page and its JSON response.
- [ ] #2 The page shows per-client daily request totals, UTC bounds, coverage, feed p95, sample counts and windows, and SQLite and referenced R2 bytes.
- [ ] #3 Unknown, stale, partial, and empty observations remain explicit without false zero values. Client-controlled text stays escaped.
- [ ] #4 Workers runtime tests cover rendering and Access authority. bun run check and task and branch reviews pass.
- [ ] #5 The page reuses protocol measurement shapes without new dependencies, vault access, or Cloudflare resource changes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Complete the existing /owner/measurements?format=html page. Add failing runtime tests for per-client totals, empty-list meaning, and storage-scope text. Preserve canonical protocol shapes, Access authority, no-store responses, windows, coverage, and stale or unknown values. Add rendering and authority coverage, update docs/api/measurements.md, run bun run check, independent task and branch reviews, human branch review, and publish one PR. Plan review: /tmp/oab-10-7-console-measurements-plan.md.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The W2 owner brief authorizes this task under OAB-10 and parallel work with plugin-only P4. The existing HTML route already covers much of the brief. Keep it and add missing display semantics and runtime coverage. No cloud, live service, or vault action. main update used git pull --ff-only origin main after an unqualified pull reported multiple branches.

Owner approved the plan in Plannotator pn-ce1aed. Implement the existing HTML route under the approved scope. Baseline owner runtime tests passed with vitest.f2.config.ts. Worker owns RED/GREEN, full checks, and the commit. Parent owns reviews and publication.

Implemented the existing HTML measurements page. It shows per-client REST, MCP, and combined totals, states when no clients were observed without inferring zero, and explains that referenced R2 bytes count distinct blobs rather than complete bucket allocation. Tests cover escaped measurement client IDs, observed stale daily data, known-zero referenced storage, unknown request data, empty latency, incomplete cadence/coverage, browser and JSON content types, console links, absent and forged Access, wrong origin, and no-store responses.

RED: `bun run --cwd apps/worker vitest run --config vitest.f2.config.ts test/f2/owner*.test.ts` returned exit 1 because Vitest found no tests through that root-level filter. Correct worker-root run `cd apps/worker && bun vitest run --config vitest.f2.config.ts test/f2/owner.test.ts` failed as intended: 1 failed, 2 passed because the empty-client message was missing. GREEN: same worker-root command passed, 1 file and 3 tests. `bun run docs:check` passed. `bun run check` passed lint, docs, all typechecks, tests (tooling 8 files/91 tests, protocol 17/307, plugin 26/647 passed with 1 skipped, worker full 43/702 plus f2 8/115), and dry-run builds. Existing Worker tests print expected synthetic disconnect and injected SQLite error diagnostics despite passing.

Self-review scope: focused change against e52fad1, including `apps/worker/src/transport/owner.ts`, `apps/worker/test/f2/owner.test.ts`, and `docs/api/measurements.md`. Reviewed HTML escaping, output states and totals, canonical Access/origin checks, response headers, documented protocol meaning, and focused runtime coverage. No changes to schemas, dependencies, cloud resources, vault data, or route policy. No independent review in this worker; parent owns task and branch reviews.
<!-- SECTION:NOTES:END -->
