---
id: OAB-8.7
title: Expose sync status and control one serialized desktop loop
status: To Do
assignee: []
created_date: '2026-10-28T19:31:00Z'
labels: []
dependencies:
  - OAB-8.6
documentation:
  - docs/spec.md
parent_task_id: OAB-8
ordinal: 45000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make the complete synchronizer usable from Obsidian without falsely claiming settled state. One focused PR. decision-1 adds the device revocation obligation. Owner-interactive proof remains in OAB-8.8.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 One serialized loop uses 15, 60, and 300 second polling, two-second event debounce, immediate load/resume/Sync now, and at most four network requests.
- [ ] #2 Status panel shows section 7.9 states and per-path reasons with labelled keyboard controls. Settled needs empty queues, confirmed cursor/head equality, and persisted state.
- [ ] #3 AC-08 device tests show revoked, stop publishing and applying, preserve files and queued work, and offer Reconnect. Pause preserves queues and stops effects.
- [ ] #4 Panel reports unsupported files, storage failures, operation failures, and server backup/capacity state without treating absent telemetry as success. Unload releases host resources.
<!-- AC:END -->
