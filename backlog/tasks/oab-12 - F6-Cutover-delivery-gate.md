---
id: OAB-12
title: F6 Cutover delivery gate
status: To Do
assignee: []
created_date: '2026-10-12 15:13'
labels: []
dependencies:
  - OAB-11
documentation:
  - docs/spec.md
ordinal: 12000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Track F6 against docs/spec.md §14. Intent-only; research/decompose when selected; no implementation plan authorized now. Requires F5 and a fresh verified export before cutover. Exit: new local vaults outside iCloud on each device hydrated from service, iCloud no longer owns live vault, coexistence off, one sync owner per device, AC-13 after rehearsal restore.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 F5 and a fresh verified export are complete before cutover.
- [ ] #2 Cutover exit conditions and AC-13 after rehearsal restore are evidenced.
<!-- AC:END -->
