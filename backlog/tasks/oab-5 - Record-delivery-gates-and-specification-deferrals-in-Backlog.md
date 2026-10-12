---
id: OAB-5
title: Record delivery gates and specification deferrals in Backlog
status: To Do
assignee: []
created_date: '2026-10-12 13:17'
updated_date: '2026-10-12 13:30'
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
