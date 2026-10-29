---
id: OAB-8.3
title: Apply remote text and preserve durable conflict copies
status: Done
assignee:
  - '@pi'
created_date: '2026-10-28T19:31:00Z'
updated_date: '2026-10-29T03:13:00Z'
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
- [x] #1 Automated tests cover every durable conflict step and recovery for AC-02 and AC-39, including an edited pre-existing conflict copy.
- [x] #2 Atomic process guards preserve current local bytes for AC-10 and AC-32. Base advances only after confirmed effects. Identical bytes do not create conflicts.
- [x] #3 Incoming deletes use Obsidian trash. Collisions preserve both versions. Expected writes suppress only matching echoes. No absence publishes a delete.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Extend canonical device state and verified journal transitions. Add a serialized text-apply engine and Obsidian adapter with pinned text and exact-text process guards. Persist per-side conflict identities for restart recovery. Test durable crash boundaries, edited copies, obsolete entries, deletes, rename sides, collisions, lifecycle fences, and exact-hash echoes. Run focused tests, docs:check, and bun run check. Complete independent task review, whole-branch review, corrective review, owner diff review, and the pull request. Keep reconciliation, publishing orchestration, scheduling, status, and two-vault proof in their existing later tasks.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
AC1: text-apply tests cover prepared, named, copied, confirmed-effect recovery, edited copies, and dual-side rename preservation. AC2: process-race, identical-text, obsolete prepared recovery, and journal regression tests protect observed bytes and confirmed base. AC3: adapter tests use local Obsidian trash. Apply and journal tests cover collisions, absence, and exact-hash echoes. Final code revision: 49236d5. bun run check passed with exit 0 and 1,333 tests across 84 files. docs:check passed. Independent reviews closed all findings. Owner approved plan pn-cdf3af and branch diff pn-f551df. Host trash and rename lack atomic conditional APIs. No live vault or service test ran. OAB-8.8 retains live two-vault proof.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added guarded remote text apply with revision-pinned reads, durable per-side conflict copies, restart recovery, explicit remote trash, and exact-hash echo decisions. Canonical schemas and one verified journal protect recovery identity and base revisions. Tests cover AC-02, AC-10, AC-32, AC-39, obsolete recovery, and dual-dirty renames. Full check passed with 1,333 tests. Owner approved the branch review. Live host proof remains OAB-8.8. Trash and rename retain the documented host race limit.
<!-- SECTION:FINAL_SUMMARY:END -->
