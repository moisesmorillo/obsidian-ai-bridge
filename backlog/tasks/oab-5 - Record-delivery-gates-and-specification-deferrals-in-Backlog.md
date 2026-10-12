---
id: OAB-5
title: Record delivery gates and specification deferrals in Backlog
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-12 13:17'
updated_date: '2026-10-12 15:36'
labels:
  - F0
dependencies:
  - OAB-3
  - OAB-4
documentation:
  - docs/spec.md
  - docs/superpowers/plans/2026-10-12-f0-foundation.md
type: docs
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The tracking tool is initialized but empty. F0 must make committed work, phase entry conditions and deferred reopening triggers discoverable without creating a second roadmap. Existing F0 tasks must be reused rather than duplicated.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Later delivery phases have bounded tracking tasks with dependencies and the acceptance gates from spec section 14, without speculative implementation plans.
- [ ] #2 Every deferred item in spec section 16 is tracked with the deferred label, its reason and its concrete reopening trigger.
- [ ] #3 Tracking preserves explicit authorization gates for Cloudflare changes and personal vault access, and the verified export plus demonstrated restore gate before F4.
- [ ] #4 README documents the actual local checks and clearly distinguishes F0 readiness from implemented synchronization.
- [ ] #5 README identifies docs/spec.md as the product and phase-gate contract, Backlog tasks as status/evidence tracking, and linked plans as the implementation approach rather than an alternative roadmap.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Inventory existing work against docs/spec.md §§14 and 16; reuse matching records and create only missing F1–F6 gate and deferred records through Backlog CLI.
2. Record actual returned task IDs and prerequisite edges; preserve authorization and safety gates in task descriptions.
3. Update README with verified Bun 1.4.3 local setup/check commands, package roles, inert/default-deny and current delivery status, and source-of-truth roles.
4. Verify task views, dependency graph, triggers, README scope and git diff; request the parent frozen install/full check and commit only after actual logs.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parent validation on the completed snapshot passed: `bun install --frozen-lockfile && WRANGLER_SEND_METRICS=false bun run check && git diff --check` (bg_run b64a99b62, exit 0). Frozen install left the lockfile unchanged; Biome reported 27 clean files; all source/tool typechecks, 31 tests (protocol 24, Worker 5, plugin 2), all builds, and final diff check passed. Wrangler build was `--dry-run` with no bindings; nothing was deployed. Full log: `.pi/tasks/01a12e59-7861-7763-802b-239398f8d319-17313/b64a99b62.output` relative to `/Users/moisesmorillo/workspace/moisesmorillo/obsidian-ai-bridge`.

Correction round 1 (review finding, Important): The initial OAB-6 metadata incorrectly had `dependencies: []`; its acceptance text naming OAB-2/OAB-3/OAB-4/OAB-5 was not a substitute for required graph edges. Corrected only OAB-6 dependencies through Backlog CLI to exactly OAB-2,OAB-3,OAB-4,OAB-5. Verified `backlog task view OAB-6 --plain` now reports 4 direct dependencies and raw task metadata lists exactly those four IDs. Verified OAB-6 remains To Do; OAB-7→OAB-6, OAB-8→OAB-7, OAB-9→OAB-6, OAB-10→OAB-8+OAB-9, OAB-11→OAB-10, OAB-12→OAB-11 remain unchanged; no cycles in displayed graph. OAB-5 remains In Progress with all five criteria unchecked. No source/full-suite run was needed for this metadata-only correction; prior complete source check evidence remains above.
<!-- SECTION:NOTES:END -->
