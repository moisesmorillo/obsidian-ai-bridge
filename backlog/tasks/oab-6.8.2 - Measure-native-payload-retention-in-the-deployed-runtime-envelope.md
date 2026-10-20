---
id: OAB-6.8.2
title: Measure native payload retention in the deployed runtime envelope
status: Deferred
assignee: []
created_date: '2026-10-20 23:27'
labels: []
dependencies: []
references:
  - OAB-6.5
documentation:
  - docs/spec.md
parent_task_id: OAB-6.8
priority: medium
type: spike
ordinal: 35000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Trigger: measure native retention in a real deployment when OAB-6.8 runtime-envelope work starts. The owner closes the remaining OAB-6.5 R1 native-retention scope as intentionally deferred. The OAB-6.5 32 MiB application limit excludes native workerd buffers, transport-retained RPC results, and fragments retained by native layers. Local actor-gate and unread-body tests do not prove a deployed heap breach or native release bound. Deployment and Cloudflare resource changes still need explicit owner authorization.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A real authorized deployment measures native payload retention during concurrent upload, RPC result, slow response, and cancellation paths.
- [ ] #2 Measurements separate active application data, native buffers, transport-retained RPC results, native response fragments, and total process observations.
- [ ] #3 The report states the deployed runtime, compatibility settings, workload, measurement method, peaks, release observations, and measurement limits.
- [ ] #4 OAB-6.8 uses the measurements for its runtime envelope without treating the OAB-6.5 application-only limit as total platform headroom.
<!-- AC:END -->
