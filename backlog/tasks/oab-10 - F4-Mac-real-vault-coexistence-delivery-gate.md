---
id: OAB-10
title: F4 Mac real-vault coexistence delivery gate
status: To Do
assignee: []
created_date: 2026-10-12 15:13
updated_date: '2026-11-05T12:39:00Z'
labels:
  - phase-gate
  - F4
dependencies:
  - OAB-8
  - OAB-9
documentation:
  - docs/spec.md
type: task
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Track F4 against docs/spec.md §14. Intent-only; research/decompose when selected; no implementation plan authorized now. Requires F3, one dated local copy of the real vault outside iCloud (spec §11.5), plus separate explicit owner authorization before personal-vault use. Coexistence on Mac only, plugin only on Mac, at most two weeks; exit AC-19, polling/storage measured, no unexplained attention item.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 F3 is complete, one dated local copy of the real vault outside iCloud exists, and explicit owner authorization to access the personal vault is recorded before access.
- [ ] #2 Coexistence is Mac-only, plugin runs only on Mac, and duration does not exceed two weeks.
- [ ] #3 AC-19 and polling/storage measurement pass; no attention item is unexplained.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reconciled after merged F0: this is a committed section14 phase entry/exit gate, not a trigger-based deferred feature or an implementation task. Its original acceptance cases and dependency edges are unchanged. Dependency readiness only permits selection for research and decomposition; it does not authorize implementation, deployment or personal-vault access.

Owner decision 2026-11-05: F4 no longer requires F3b or a service-side backup. A dated local copy of the real vault outside iCloud replaces the restore demonstration (spec §11.5).
<!-- SECTION:NOTES:END -->
