---
id: OAB-6.2
title: Authorize operations and enforce durable ticket lifecycles
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-15 00:38'
updated_date: '2026-10-18 00:54'
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

Task 2 correction: docs/superpowers/plans/2026-10-17-f1-global-admission-budget.md. The owner selected an aggregate limit now. The owner approved the numerical limits and denial behavior in review pn-bf0890. Preserve the original plan, retained writer, strict TDD, parent validation, and independent corrective review.

Human approval: pn-bf0890. The owner approved the complete aggregate admission correction plan. Task 2 passed parent validation and corrective review. Task 3 passed parent acceptance at 801e41899342a6ff59a3f24802f3b9e9b225c80f. The independent whole-branch review returned APPROVE WITH NOTES. The parent closed its documentation finding after correction and independent review. Human branch review remains pending.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Task 1 passed parent acceptance at 65d1dc0a3d8fa68d0c9dab84a924b46c0fad9e68.
The initial combined review and scoped correction review closed all four findings.
The final full check passed with 203 tests, all workspace typechecks, lint, and builds.

The Worker build used Wrangler dry-run only. No deployment occurred.
Task 3 was pending at that checkpoint. All OAB-6.2 acceptance criteria remain unchecked.

Before the aggregate correction, Task 2 remained unaccepted at e5113dcf032fe52d5c237ef241f31b114bf538f9. The initial full check passed with 249 tests.

The owner selected an aggregate admission limit instead of deferral. The initial review kept CR-1 and DF-1 open before implementation, native evidence, validation, and corrective review.

The independent design check accepted the proposal for human plan review after corrections. DF-2 closed through dated primary Cloudflare documentation. The account tier remains unverified.

The owner approved the 1,024-row limit and 32 MiB native measurement target in review pn-bf0890. Product source stayed unchanged until valid functional RED. All four acceptance criteria remain unchecked.

Before any separately authorized deployment, verify Workers Paid for the existing 2 GB product envelope.

The approved contract sets 1,024 retained rows and a 32 MiB native storage regression target. Parent acceptance follows validation and corrective code and design review.

The plan has editorial grammar and approval-status corrections. Its approved behavior remains unchanged.

Task 2 passed parent acceptance at 55db1282cd608d953fc45f16a7345d8ade8a049c after corrective review f2912b6c-9f7d-4d7e-8190-fb622b7bd55c.
The parent closed CR-1, DF-1, DF-2, and the minor approval-status conflict.
The status correction changes no product source or approved numerical contract.

The focused native run passed 91 cases. The full check passed 275 tests, all workspace types, lint, and builds.
Backlog doctor and the diff check passed.

Native storage grew by 9,572,352 bytes against the 33,554,432-byte target.
The test sampled 386 transactions across setup and three cycles.
The absolute peak and final retained size were 9,711,616 bytes against a 139,264-byte baseline.

Task 3 was pending at that checkpoint. All four acceptance criteria remain unchecked until final evidence and human branch review pass.
CPU, latency, and concurrent body memory remain separate OAB-6.5 and OAB-6.8 work.

The Worker build used Wrangler dry-run only. No deployment occurred.

Task 3 passed parent acceptance at 801e41899342a6ff59a3f24802f3b9e9b225c80f after independent review 03cfeb52-8dc9-4b35-83c6-4b51ce6ad045.
The code verdict is APPROVE. The design verdict is READY WITH BOUNDED FOLLOW-UPS.

The focused run passed 128 cases. Full validation passed 306 tests before main integration.
Functional RED reached 21 failed cases, 10 baseline passes, and 35 assertion-error records.

The parent integrated approved main d9742325e40706cf600f2382c78aef0b5056d149 at f9bcbd00745000ac2835919588dec77d28ed4443.
Current validation passed 369 tests, all workspace compilers, documentation checks, lint, and builds.
Backlog doctor and diff checks passed.

All ten documentation changes preserve the complete non-comment TypeScript trees.
The merge preserves both branches' native assertions and the existing shared fixture owner.
Native workspace compilers passed despite an inconclusive editor probe.

The Worker build used Wrangler dry-run only. No deployment occurred.

OAB-6.8 owns whole-vault capacity and cumulative revocation storage checks.
OAB-7 must not expose revocation before that evidence exists.
Verify Workers Paid before any separately authorized deployment of the 2 GB product envelope.

Operation-specific content algorithms remain in OAB-6.3 and OAB-6.4.
Actual R2, AC-28, and streaming-memory checks remain in OAB-6.5.
CPU and latency budgets remain in OAB-6.8.

All four acceptance criteria remain unchecked. Human branch review remains pending.

The independent whole-branch Sol review examined d9742325e40706cf600f2382c78aef0b5056d149 through 359f58ac87e7fa945c4d26323c9ef43324223459. The code verdict was APPROVE WITH NOTES. The design verdict was READY WITH BOUNDED FOLLOW-UPS.

WB-CR-1 identified an incorrect schema-version comment. The parent corrected only that comment in fb932790af4abdfdce5fa4573bbdbd1e58e22480, with identical non-comment TypeScript trees. The independent correction review returned APPROVE and closed WB-CR-1.

Fresh validation passed 369 tests, all workspace compilers, documentation checks, lint, and builds. Backlog doctor and diff checks passed. The Worker build used Wrangler dry-run only, without deployment.

The parent closed all technical findings. All four acceptance criteria remain unchecked until human approval. No product source or approved numerical contract changed during this metadata update.
<!-- SECTION:NOTES:END -->
