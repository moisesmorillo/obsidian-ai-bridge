---
id: OAB-10.2
title: Measure F4 polling latency and storage
status: To Do
assignee: []
created_date: '2026-11-05T12:48:00Z'
labels: []
dependencies:
  - OAB-10.1
documentation:
  - docs/spec.md
parent_task_id: OAB-10
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
F4 needs measured request cost and storage use before the real-vault trial. Use service data and plugin status, not vault content. Scope: spec §7.4, §7.9, §12, and §14. OAB-8.7.1 names plugin-caused activity as an F4 measurement trigger.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Service and plugin status expose requests per day per device, p95 feed latency, DO database bytes, and R2 bytes with units and observation windows.
- [ ] #2 Tests define counting boundaries, latency samples, empty windows, resets, and unknown or stale observations without false zero values.
- [ ] #3 Measure plugin-caused events and genuine edits. Fold OAB-8.7.1 into this task if cadence changes are needed. Otherwise retain Deferred status and its trigger.
- [ ] #4 Two-test-vault evidence records client ids, times, and results only. Existing service evidence remains unchanged.
- [ ] #5 Protocol shapes stay canonical in packages/protocol. No Cloudflare resource change or manual deployment occurs.
<!-- AC:END -->
