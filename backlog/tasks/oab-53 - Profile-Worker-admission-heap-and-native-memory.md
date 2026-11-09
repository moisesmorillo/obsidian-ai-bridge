---
id: OAB-53
title: Profile Worker admission heap and native memory
status: To Do
assignee: []
created_date: '2026-11-09T22:05:00Z'
labels: []
dependencies: []
references:
  - docs/spec.md
ordinal: 94000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The admission byte reservations bound identified application payloads but do not prove total V8 heap or native memory use. This profiling work must run before another concurrency increase or after an exceeded-memory event, without access to the owner's personal vault.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Measure peak Worker heap and native memory for representative REST and MCP admission workloads
- [ ] #2 Compare measured peaks with the 128 MB isolate limit and record the workload, runtime, and limits
- [ ] #3 Keep application byte reservations distinct from measured heap and native memory
<!-- AC:END -->
