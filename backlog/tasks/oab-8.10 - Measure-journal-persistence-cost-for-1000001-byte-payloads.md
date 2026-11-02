---
id: OAB-8.10
title: Measure journal persistence cost for 1,000,001-byte payloads
status: Deferred
assignee: []
created_date: '2026-11-02T21:59:00Z'
labels: []
dependencies: []
parent_task_id: OAB-8
type: task
ordinal: 53000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Hosted CI timed out on oversized Markdown publication and apply cases that persist a 1,000,001-byte payload. The plugin test timeout now allows 30,000 ms. Measure journal persistence cost during OAB-8.8 qualification so the team can judge this cost against observed device and test needs. Trigger: start this task when OAB-8.8 qualification begins.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Measure repeated journal write/enqueue, reopen or recovery, and payload-read operations for a 1,000,001-byte payload. Record runtime and environment, operation boundaries, repetition count, median and p95 elapsed time, and persisted-byte volume.
- [ ] #2 Record an explicit owner decision that the measured journal cost is acceptable or unacceptable for OAB-8.8. Cite the measurements and decision rationale. If the cost is unacceptable, define a separately approved follow-up rather than changing journal behavior in this measurement task.
<!-- AC:END -->
