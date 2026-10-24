---
id: OAB-7.2
title: Connect real OAuth and verified Access authentication
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-24T00:05:00Z'
updated_date: '2026-10-24T16:35:00Z'
labels:
  - F2
  - auth
dependencies:
  - OAB-7.1
documentation:
  - docs/spec.md
parent_task_id: OAB-7
ordinal: 7200
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The production entry returns no identity. F2 needs the specified real OAuth path, not a development identity bypass. Plan this task from current provider and Access contracts when selected. Work is local only.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The specified provider supports code plus PKCE, DCR, pre-registered clients, rotating refresh tokens, and discovery. Client-credentials grants are rejected.
- [ ] #2 Authorize and consent verify the Access JWT against public keys and expected claims. Consent shows client name, redirect URI, scopes, and owner naming.
- [ ] #3 REST receives only validated client, grant, and scope context. Invalid, expired, malformed, or failed-refresh credentials fail closed. Write never implies delete.
- [ ] #4 Real local Worker tests cover the production composition, not only injected identities. No Cloudflare deployment or resource action occurs.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Use docs/superpowers/plans/2026-10-24-f2-local-delivery.md, Task 1. Plan review precedes implementation. Add real OAuth and verified Access, then complete the task test and review cycle.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner approved the combined local F2 plan in pn-1365dd. Execute OAB-7.2 through OAB-7.6 in order on this branch. One worker owns each task. One fresh reviewer follows each task. No deployment or later phase is authorized.

Partial implementation only: added pinned OAuth/jose packages, optional configuration bindings, and the owner-only Access verifier with two focused tests. Focused tests and bun run check passed. Production OAuth composition, consent, F2 production-entry suites, and full criteria remain incomplete. No commit created. Full evidence and limits: .superpowers/sdd/2026-10-24-f2-local-delivery/task-1-report.md. Task remains In Progress for parent review and continuation.

Completed OAB-7.2 local OAuth and Access composition. Added OAuth provider and jose for OAuth flows, discovery, consent primitives, token validation, and Access JWT/JWKS verification. The first two Access tests arrived green without RED. Per repository rule, I preserved them, added production-entry RED coverage before the OAuth implementation, and recorded this exception. OAuth RED output included discovery returning 404 instead of 200 before provider composition. F2 GREEN passed: 2 files and 19 tests. bun run docs:check and bun run check passed. The Worker build used dry-run only. No deployment or Cloudflare resource operation occurred. Task remains In Progress for independent review.

The initial partial note above is superseded by the completed report in .superpowers/sdd/2026-10-24-f2-local-delivery/task-1-report.md. Commit 96fe91d0c72a8c28d49a43c5ed2402f673896f0c contains the complete local implementation. The report records test evidence, limits, and Task 2 integration seams. OAB-7.2 remains In Progress for independent review.

Correction: the complete implementation commit is 36ecb297cd46188a9c79de43104046da42518a01. The earlier hash in these notes is stale.

Code review found a duplicate OAuth scope list. OAuth now reads accepted scopes from the canonical VaultScopeSchema. The discovery regression assertion and full check passed. Review correction commit: a142d2547e541ec47cf76dec69c22d0ee71fdcd4. The task remains In Progress for independent parent review.

Hash correction: commit 36ecb297cd46188a9c79de43104046da42518a01 was amended before review. The current implementation commit is 1154a411a520251bdd3ac816cae6f2899570814b.
<!-- SECTION:NOTES:END -->
