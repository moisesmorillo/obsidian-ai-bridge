---
id: OAB-7.3
title: Deliver owner client console and durable revocation
status: To Do
assignee: []
created_date: '2026-10-24T00:05:00Z'
labels:
  - F2
  - owner
dependencies:
  - OAB-7.2
documentation:
  - docs/spec.md
parent_task_id: OAB-7
ordinal: 7300
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
F1 stores revoked grants and checks them, but exposes no owner console. F2 needs protected client inspection and revocation through the real authentication path. Work is local only.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Verified Access protects owner client listing, names, and revocation. Untrusted content cannot execute in console output. State changes reject forged owner requests.
- [ ] #2 Revocation persists in the authoritative DO before provider KV revocation. Local tests prove the next request fails with 401 revoked despite stale KV or KV failure.
- [ ] #3 Revocation covers the selected client grants, preserves committed data, and never depends on KV propagation for immediate denial.
- [ ] #4 Tests cover invalid Access claims, unauthorized callers, repeat revocation, operation races, and provider failures. No plugin or deployed behavior is claimed.
<!-- AC:END -->
