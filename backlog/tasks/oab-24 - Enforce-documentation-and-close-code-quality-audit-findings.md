---
id: OAB-24
title: Enforce documentation and close code-quality audit findings
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-17 04:24'
updated_date: '2026-10-17 04:26'
labels: []
dependencies: []
references:
  - docs/spec.md
documentation:
  - docs/superpowers/plans/2026-10-17-review-quality-enforcement.md
type: chore
ordinal: 33000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The owner requested one PR for the baseline audit findings. Missing declaration contracts and absent documentation gates let review debt persist. Shared alias conversion and persistence fixtures also have editable copies. Keep runtime behavior and the current delivery scope unchanged.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Useful TSDoc covers the agreed production declarations and important test helpers, with generated code and trivial bindings excluded.
- [ ] #2 The canonical check rejects missing declaration documentation and invalid TSDoc syntax through tested positive and negative controls.
- [ ] #3 One tooling-only alias resolver serves the three test configurations without weakening runtime isolation or public package boundaries.
- [ ] #4 One documented fixture owns repeated storage teardown, and native tests cover invalid entropy lengths, epoch results, and creation times without partial state.
- [ ] #5 AGENTS.md states declaration coverage, semantic review duties, operation-specific control-flow guidance, and explicit finding closure.
- [ ] #6 Pinned baseline and final checks, semantic re-review, and human plan and branch-diff reviews support one PR with no deployment.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
One PR from chore/review-quality-enforcement. Pending human review: docs/superpowers/plans/2026-10-17-review-quality-enforcement.md. Tasks: tested documentation gate, useful contracts and AGENTS rules, shared tooling alias conversion, persistence fixture and input cases, full validation and review. Proposed native execution with a final independent review. No implementation before Plannotator approval.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Proposed development-only dependencies: @microsoft/tsdoc parses documentation syntax. @ast-grep/napi inventories TypeScript declarations without the unavailable TypeScript 7 compiler API. Verify compatibility and exact versions before installation. No runtime dependency or toolchain upgrade is part of this task.

Pinned baseline bc147c61d passed: frozen install, Biome 2.5.15 on 49 files, all workspace compilers, 68 tests, and local builds. Tests: protocol 41, plugin 2, Worker 25. Wrangler completed dry-run only. No implementation started. Human plan review pn-741257 remains pending.

Owner approved plan pn-741257. Execute natively with a final independent review. Pinned baseline bc147c61d passed all 68 tests and all checks.

Dependency probe resolved @microsoft/tsdoc 0.17.1 and @ast-grep/napi 0.51.0. Add exact root development versions only. The first parses TSDoc syntax. The second provides TypeScript syntax inventory without compiler API coupling. Native and parser behavior probes follow installation before checker implementation.
<!-- SECTION:NOTES:END -->
