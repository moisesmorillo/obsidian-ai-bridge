---
id: OAB-14
title: 'Deferred: WebSocket push from DO'
status: To Do
assignee: []
created_date: '2026-10-12 15:14'
labels:
  - deferred
dependencies: []
documentation:
  - docs/spec.md
ordinal: 14000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Deferred per docs/spec.md §16 because 15–60 second polling is sufficient for one owner. Seam: seq-based feed; push only signals new seq, pull remains unchanged. Reopen on measured latency complaint or request cost above 50% of allowance.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Task remains deferred until specified latency/cost trigger; when triggered, evaluate and test the §16 seam.
<!-- AC:END -->
