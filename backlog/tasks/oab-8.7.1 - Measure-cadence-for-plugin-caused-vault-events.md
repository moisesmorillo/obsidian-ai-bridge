---
id: OAB-8.7.1
title: Measure cadence for plugin-caused vault events
status: Deferred
assignee: []
created_date: '2026-11-03T00:36:00Z'
updated_date: '2026-11-03T00:45:00Z'
labels: []
dependencies: []
parent_task_id: OAB-8.7
type: task
ordinal: 55000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Trigger: F4 measurement. Plugin-caused vault events reach the lifecycle controller, set activeSince, and can force the 15-second cadence before publication consumes echoes. Measure this effect and distinguish plugin-generated events from genuine user edits. Preserve echo suppression and durable local intent. Owner deferred this policy during OAB-8.7 branch review.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Genuine user edits update recent activity and select the 15-second foreground polling cadence.
- [ ] #2 Plugin-generated events retain echo suppression and do not lose or duplicate durable local intent.
- [ ] #3 Tests measure event origin, queue admission, echo suppression, and selected cadence.
<!-- AC:END -->
