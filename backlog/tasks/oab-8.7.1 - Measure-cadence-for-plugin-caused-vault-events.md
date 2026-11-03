---
id: OAB-8.7.1
title: Measure cadence for plugin-caused vault events
status: Deferred
assignee: []
created_date: '2026-11-03T00:36:00Z'
labels: []
dependencies: []
parent_task_id: OAB-8.7
type: task
ordinal: 55000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Trigger: the OAB-8.7 F4 review measurement raised uncertainty about plugin-generated vault events. The lifecycle controller updates recent activity for explicit host events. Plugin-created or modified files can produce events that echo suppression consumes before the controller sees them. Measure the effect and distinguish plugin-generated events from genuine user edits.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Genuine user edits update recent activity and select the 15-second foreground polling cadence.
- [ ] #2 Plugin-generated events retain echo suppression and do not lose or duplicate durable local intent.
- [ ] #3 Tests measure event origin, queue admission, echo suppression, and selected cadence.
<!-- AC:END -->
