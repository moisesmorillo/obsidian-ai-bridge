---
id: OAB-6.2
title: Authorize operations and enforce durable ticket lifecycles
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-15 00:38'
updated_date: '2026-10-17 21:08'
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

Task 2 correction: docs/superpowers/plans/2026-10-17-f1-global-admission-budget.md. The owner selected an aggregate limit now. Numerical limits and rejection behavior await human plan approval. Preserve the original plan, retained writer, strict TDD, parent validation, and independent corrective review.

Human approval: pn-bf0890. The owner approved the complete aggregate admission correction plan. Resume the retained Task 2 writer with tests only. The parent must observe functional RED before production changes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Task 1 passed parent acceptance at 65d1dc0a3d8fa68d0c9dab84a924b46c0fad9e68.
The initial combined review and scoped correction review closed all four findings.
The final full check passed with 203 tests, all workspace typechecks, lint, and builds.

The Worker build used Wrangler dry-run only. No deployment occurred.
Task 2 and Task 3 remain pending. All OAB-6.2 acceptance criteria remain unchecked.

Task 2 remains unaccepted at e5113dcf032fe52d5c237ef241f31b114bf538f9. The full check passed with 249 tests before this correction.

The owner selected an aggregate admission limit now. CR-1 and DF-1 remain open until implementation, native evidence, validation, and corrective review.

The independent design check accepts the proposal for human plan review after corrections. DF-2 closes through dated primary Cloudflare documentation. The account tier remains unverified.

The proposed 1,024-row limit and 32 MiB native measurement target await human approval. Product source remains unchanged. All four acceptance criteria remain unchecked.

Before any separately authorized deployment, verify Workers Paid for the existing 2 GB product envelope.

The approved contract sets 1,024 retained rows and a 32 MiB native storage regression target. Keep Task 2 unaccepted until validation and corrective code and design review close the blocking findings.

The plan has one editorial grammar correction. Its approved behavior remains unchanged.
<!-- SECTION:NOTES:END -->
