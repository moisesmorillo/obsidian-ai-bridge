---
id: OAB-6.8
title: Enforce retention capacity and aggregate runtime budgets
status: To Do
assignee: []
created_date: '2026-10-15 00:38'
updated_date: '2026-10-15 00:41'
labels:
  - F1
dependencies:
  - OAB-6.6
  - OAB-6.7
documentation:
  - docs/spec.md
parent_task_id: OAB-6
type: feature
ordinal: 31000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Section12 budgets apply to the whole vault and shared Worker isolate, not just individual calls. Retention must preserve tombstones and future export pins, and capacity pressure must not silently erase history or prevent the allowed recovery operations.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The 10,000-file / 2 GB envelope and attention thresholds are enforced without off-by-one admission races; reads/deletes remain available at the declared cap, satisfying AC-43.
- [ ] #2 Feed/receipt/history retention honors 30 days, the 25-day + 5-minute receipt safety, the 7-day history floor and export pins; tombstones and lifetime revision identity survive pruning.
- [ ] #3 Per-client concurrency above 16 yields 429 with Retry-After under distributed Worker interleavings, not only within a single isolate.
- [ ] #4 Aggregate memory, SQL row/parameter limits, connection/subrequest counts and slow-stream/cancellation recovery have explicit bounded behavior and executable checks; unmeasured claims are not reported as proven platform headroom.
<!-- AC:END -->
