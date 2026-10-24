---
id: OAB-7.2
title: Connect real OAuth and verified Access authentication
status: To Do
assignee: []
created_date: '2026-10-24T00:05:00Z'
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
