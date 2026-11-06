---
id: OAB-11.9
title: Show a visible notice when a conflict copy is created
status: To Do
assignee: []
created_date: '2026-11-06T21:40:00Z'
labels: []
dependencies: []
parent_task_id: OAB-11
ordinal: 69000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner feedback 2026-11-06 from the iPhone offline conflict run: the owner read the result as a lost edit because the path showed the remote revision and the conflict copy appeared only as a separate file. Add a visible, dismissible notice on desktop and mobile when the plugin writes a conflict copy, with the copy path. No change to conflict semantics.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A notice appears on each device when the plugin writes a conflict copy, with the copy path.
- [ ] #2 The notice does not block sync and does not change conflict naming or bytes.
- [ ] #3 Tests cover the notice on text and blob conflict copies.
<!-- AC:END -->
