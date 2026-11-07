---
id: OAB-12.3
title: Record the F5 closure waiver and cutover backup decision
status: To Do
assignee: []
created_date: '2026-11-07T00:14:00Z'
updated_date: '2026-11-07T00:21:00Z'
labels:
  - F6
dependencies: []
references:
  - OAB-11
  - OAB-11.7
  - OAB-9
documentation:
  - docs/spec.md
parent_task_id: OAB-12
ordinal: 71000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The supervisor reports Mac cutover at about 2026-11-07T00:20Z on owner order. The owner already selected a dated zip plus the frozen iCloud vault as backup. Record that decision, not another backup selection or another cutover authorization.

F5 closure still needs an explicit owner waiver for the exact OAB-11.7 scripts. Use the reported 2026-11-06 real-use evidence without claiming those scripts passed.

The frozen copy lacks later edits and service revision history. Keep it and the zip for 30 days from cutover. No service restore proof or Cloudflare-native backup exists.

This task records decisions only. It grants no agent access to the personal vault. See OAB-9 and docs/spec.md §11, §14 F6, and §16.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The owner F5 closure decision has a date and states the waiver for the exact OAB-11.7 scripts.
- [ ] #2 OAB-11 records the closure decision. OAB-11.7 keeps unproven script cases unchecked and states the waiver scope.
- [ ] #3 OAB-12 and OAB-9 record the owner backup choice: dated zip plus frozen iCloud vault, selected before the reported cutover.
- [ ] #4 The backup record states 30-day retention through at least 2026-12-07T00:20Z and the frozen copy limits.
- [ ] #5 The record distinguishes the reported cutover at about 2026-11-07T00:20Z from later documentation. It does not invent an earlier F5 closure.
<!-- AC:END -->
