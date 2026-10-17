---
id: OAB-6.2
title: Authorize operations and enforce durable ticket lifecycles
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-15 00:38'
updated_date: '2026-10-17 12:58'
labels:
  - F1
dependencies:
  - OAB-6.1
documentation:
  - docs/spec.md
parent_task_id: OAB-6
type: feature
ordinal: 25000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Section6.3 authorization must precede every content side effect, and section 9.5 requires authoritative revocation even when OAuth grants are stale. F2 will supply the real token provider; F1 must remain fail-closed in default composition rather than exposing a test identity adapter.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Authoritative scope, epoch, path, size and revoked-grant checks occur before content effects; a revoked client cannot write any R2 byte.
- [ ] #2 Tickets expire after 60 seconds, bind the operation fingerprint, are single-use and recheck revocation and preconditions atomically at commit.
- [ ] #3 Concurrent requests and uncertain completion have bounded, recoverable admission accounting, including cancellation and expired tickets; no transient Worker map is the authoritative per-client limiter.
- [ ] #4 Real DO tests prove denial and interleaving behavior; production HTTP composition has no fixture identity or authentication bypass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Human plan approval: pn-f925b0. Execution: subagent-driven, selected by the owner.

Plan: docs/superpowers/plans/2026-10-17-f1-authorization-tickets.md.

1. Define canonical admission contracts and rules.
2. Add durable reservations, binding, and expiry accounting.
3. Add atomic consumption and revocation interleaving tests.

Keep acceptance criteria unchecked until evidence and final human branch review pass. The parent owns validation and task closure.
<!-- SECTION:PLAN:END -->
