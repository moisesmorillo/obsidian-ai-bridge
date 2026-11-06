---
id: OAB-11
title: F5 Mobile copy-first delivery gate
status: To Do
assignee: []
created_date: 2026-10-12 15:13
updated_date: '2026-11-06T16:52:00Z'
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

F4C closure, 2026-11-06: owner merge of the closure PR approves promotion, not F5 execution. F5 prerequisites remain: owner tag plugin-v0.1.0 for the BRAT release, iPhone and iPad with copy vaults, and explicit F5 authorization. Live copy-vault writes also need isolated service authority. Promoted mapping and order: DRAFT-3 to OAB-11.3, DRAFT-1 to OAB-11.4, DRAFT-2 to OAB-11.5, DRAFT-4 to OAB-11.6, DRAFT-5 to OAB-11.7. The first three come before acceptance tooling and three-device proofs. Their existing triggers still apply. OAB-11 stays To Do. No tag, release, device action, service isolation, or personal-vault access occurs in this branch.
<!-- SECTION:NOTES:END -->
