---
id: OAB-11
title: F5 Mobile copy-first delivery gate
status: To Do
assignee: []
created_date: '2026-10-12 15:13'
updated_date: '2026-10-13 10:04'
labels:
  - phase-gate
  - F5
dependencies:
  - OAB-10
documentation:
  - docs/spec.md
type: task
ordinal: 11000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Track F5 against docs/spec.md §14. Intent-only; research/decompose when selected; no implementation plan authorized now. Install via BRAT on iPhone/iPad against a copy of vault before real vault. Exit AC-03/04/05 across three devices; record secretStorage behavior per platform; offline iPhone edit resolves correctly. Real-vault use requires separate explicit owner authorization.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 F4 is complete before F5 starts.
- [ ] #2 Copy-vault mobile tests and all §14 exit cases pass before any real-vault test.
- [ ] #3 Any personal-vault access has separate explicit owner authorization.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reconciled after merged F0: this is a committed section14 phase entry/exit gate, not a trigger-based deferred feature or an implementation task. Its original acceptance cases and dependency edges are unchanged. Dependency readiness only permits selection for research and decomposition; it does not authorize implementation, deployment or personal-vault access.
<!-- SECTION:NOTES:END -->
