---
id: OAB-7.3
title: Deliver owner client console and durable revocation
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-24T00:05:00Z'
updated_date: '2026-10-24T16:46:00Z'
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

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Use docs/superpowers/plans/2026-10-24-f2-local-delivery.md, Task 2. After OAB-7.2, deliver the owner console and authoritative grant revocation with race tests.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
OAB-7.2 passed independent review and scoped consent correction review at 3026486. Start Task 2 from the approved combined plan. Preserve the production identity path and explicit consent guard. Work remains local only.
<!-- SECTION:NOTES:END -->
