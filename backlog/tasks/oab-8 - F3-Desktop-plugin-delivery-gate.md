---
id: OAB-8
title: F3 Desktop plugin delivery gate
status: To Do
assignee: []
created_date: '2026-10-12 15:13'
updated_date: '2026-10-13 10:04'
labels:
  - phase-gate
  - F3
dependencies:
  - OAB-7
documentation:
  - docs/spec.md
type: task
ordinal: 8000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Track F3 against docs/spec.md §14. Intent-only; research/decompose when selected; no implementation plan authorized now. Exit: two test vaults on Mac pass AC-02, 03–06, 09, 10, 13, 20, 24, 30–33, 39; AC-09 runs against real ChatGPT. Vault access is not authorized by task dependencies.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 F2 is complete before F3 starts.
- [ ] #2 Every §14 F3 exit case is evidenced using the specified test context.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reconciled after merged F0: this is a committed section14 phase entry/exit gate, not a trigger-based deferred feature or an implementation task. Its original acceptance cases and dependency edges are unchanged. Dependency readiness only permits selection for research and decomposition; it does not authorize implementation, deployment or personal-vault access.
<!-- SECTION:NOTES:END -->
