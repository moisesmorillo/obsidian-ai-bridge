---
id: OAB-8.3
title: Apply remote text and preserve durable conflict copies
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-28T19:31:00Z'
updated_date: '2026-10-29T00:05:00Z'
labels: []
dependencies:
  - OAB-8.2
documentation:
  - docs/spec.md
parent_task_id: OAB-8
ordinal: 41000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Protect current local text before remote writes. Deliver the real conditional-apply and Option B engine with restart recovery, not a second plugin. One focused PR. Two-vault device proof remains in OAB-8.8.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Automated tests cover every durable conflict step and recovery for AC-02 and AC-39, including an edited pre-existing conflict copy.
- [ ] #2 Atomic process guards preserve current local bytes for AC-10 and AC-32. Base advances only after confirmed effects. Identical bytes do not create conflicts.
- [ ] #3 Incoming deletes use Obsidian trash. Collisions preserve both versions. Expected writes suppress only matching echoes. No absence publishes a delete.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implement the approved plan in .pi/plans/oab-8.3-remote-text.md. Extend canonical device state and verified journal transitions. Add a serialized text-apply engine and Obsidian adapter. Use exact-text process guards after hash verification. Test every conflict crash boundary, edited copies, deletes, rename sides, collisions, and exact-hash echoes. Run focused tests, docs:check, and bun run check. Complete task and branch reviews, owner diff review, and the pull request. Keep reconciliation, publishing orchestration, scheduling, status, and two-vault proof in their existing later tasks.
<!-- SECTION:PLAN:END -->
