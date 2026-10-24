---
id: OAB-7.7
title: Deploy F2 service and Access policy with owner authorization
status: To Do
assignee: []
created_date: '2026-10-24T00:05:00Z'
labels:
  - F2
  - needs-owner-authorization
  - deployed-service
dependencies:
  - OAB-7.6
documentation:
  - docs/spec.md
parent_task_id: OAB-7
ordinal: 7700
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Needs explicit owner authorization in the current execution conversation before service deployment or any Cloudflare resource change. Task creation and plan approval grant no such authorization. Use only an authorized synthetic vault.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Owner authorization names the permitted environment, resource operations, Access settings, and synthetic test data before any remote change.
- [ ] #2 Authorized deployment configures OAuth storage, service bindings, Access protection, identity claims, redirect addresses, and discovery endpoints.
- [ ] #3 Deployed checks prove unauthorized requests fail closed and Access cannot be bypassed. No personal vault is accessed.
- [ ] #4 Record the deployed revision and actual remote results in task notes. Local tests are not substituted for deployed evidence.
<!-- AC:END -->
