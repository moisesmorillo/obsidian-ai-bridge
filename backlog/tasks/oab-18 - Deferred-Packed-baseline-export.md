---
id: OAB-18
title: 'Deferred: Packed baseline export'
status: To Do
assignee: []
created_date: '2026-10-12 15:14'
labels:
  - deferred
dependencies: []
documentation:
  - docs/spec.md
ordinal: 18000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Deferred per docs/spec.md §16 because it only matters for large first exports; current vault exports in under an hour. Seam: export manifest and pins are independent of item publish strategy. Reopen when vault exceeds 5,000 items or owner is unwilling to wait days for first backup.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Task remains deferred until one specified size/wait trigger; when triggered, evaluate and test the §16 seam.
<!-- AC:END -->
