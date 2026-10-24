---
id: OAB-7.6
title: Verify local F2 authentication and transport integration
status: To Do
assignee: []
created_date: '2026-10-24T00:05:00Z'
updated_date: '2026-10-24T15:31:00Z'
labels:
  - F2
  - acceptance
dependencies:
  - OAB-7.5
documentation:
  - docs/spec.md
parent_task_id: OAB-7
ordinal: 7600
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Separate local production-path evidence from deployment and external-client evidence. This task closes local integration gaps before any authorized service change.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Tests connect consent, token issue, REST and MCP reads and writes, refresh, scope denial, and owner revocation through production composition.
- [ ] #2 Local AC-08 evidence proves authoritative denial within one request despite stale KV. It does not claim device status or preserved plugin queues.
- [ ] #3 bun run check and technical reviews pass. Document implemented API contracts and commands without logging secrets or note bodies.
- [ ] #4 The remaining deployed checks and owner account decision stay open. F1 server-only scope and later plugin gates remain unchanged.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Use docs/superpowers/plans/2026-10-24-f2-local-delivery.md, Task 5. After OAB-7.5, complete local production-path integration, contracts, reviews, and one pull request. Do not deploy or start OAB-8.
<!-- SECTION:PLAN:END -->
