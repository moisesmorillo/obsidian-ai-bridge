---
id: OAB-7.8
title: Verify real F2 clients revocation and owner account decision
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-24T00:05:00Z'
updated_date: '2026-10-28T15:51:00Z'
labels:
  - F2
  - needs-owner-authorization
  - deployed-service
dependencies:
  - OAB-7.7
documentation:
  - docs/spec.md
parent_task_id: OAB-7
ordinal: 7800
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Needs explicit owner authorization for deployed-service use and synthetic test writes. F2 exit needs real MCP clients and an owner account decision. Worker tests cannot supply this evidence.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 MCP Inspector, Claude Code, and ChatGPT web connect to the authorized deployed revision and complete real read and write checks.
- [x] #2 Real OAuth and owner revocation checks prove the next DO request fails with 401 revoked without waiting for KV propagation.
- [ ] #3 Owner verifies Developer mode and iPhone availability in their ChatGPT account. Record the result and the owner mobile client strategy.
- [x] #4 Record the AC-08 evidence boundary. Plugin revoked status and local-file preservation remain later plugin obligations, not proof from Worker or MCP tests.
- [x] #5 Any unresolved exit requirement stays open with its blocker. Do not start OAB-8 or later phases or access the personal vault.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Correct the task record with owner results. The owner assistant cancelled the dialog, not the owner. 2. Add failing regression tests for protected-resource scopes_supported and the 401 Bearer scope parameter. Fix scope discovery with canonical protocol scopes and preserve exact origin and denial behavior. 3. Assess owner-subject disclosure and missing console revoked state against the spec without silent scope expansion. 4. Run docs:check and check. Complete task review and branch review, then publish the pull request. 5. Stop before deployment and request separate owner authorization. Repeat named clients and account checks only after an authorized deployment. Keep incomplete criteria and the F2 gate open. Do not start OAB-8.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Correction from the owner on 2026-10-28: the owner did not decline the action batch. The owner assistant cancelled the dialog because the results did not fit its options. This record replaces the earlier cancellation claim and Deferred status. The owner supplied the results below. The earlier Backlog-only review did not assess these results or the scope defect.

Access PASS: at 15:03Z the owner completed the PIN login in the Orca browser. The Worker rendered Connected clients. Exact subject verification passed through the Worker verifier. The Access session also served consent pages without another login. No subject, JWT, PIN, token, or cookie belongs in tracked files.

Named clients: no named client completed both read and write. MCP Inspector 2.12.0 used Streamable HTTP and reached consent. Approval returned an authorization code, then Inspector showed Auth challenge: unauthorized. The consent page listed no scopes. The owner reproduced the cause: protected-resource metadata omits scopes_supported and the 401 Bearer challenge omits scope. SDK clients therefore request no scope. Authorization-server scopes_supported does not supply that SDK path. A curl OAuth client without scope received a token with empty scope, then MCP initialize returned 403 forbidden_scope. Explicit vault:read vault:write produced MCP initialize 200. AC #1 stays open until a corrected deployment and real Inspector, Claude Code, and ChatGPT web checks.

Synthetic curl read/write at 15:12Z: tools/list returned nine tools. list_notes with prefix oab-7.8/ returned epoch e3e0b88a44776e55eb8ef8301015f427 and no entries. create_note wrote oab-7.8/20261028-curl-01.md with ETag "e3e0b88a44776e55eb8ef8301015f427.1". read_note returned matching content and ETag. This proves the deployed service path, not any named client.

Revocation PASS for real OAuth client probe rw: baseline GET /v1/vault returned 200 at 15:12:39Z. Owner console revocation completed at 15:12:41Z. The first same-token request at 15:12:42Z returned 401 revoked without WWW-Authenticate. The next request at 15:12:43Z returned 401 invalid_token with the Bearer challenge. The first response proves DO denial before provider cleanup. AC #2 is complete. The scope defect prevented use of the Inspector token.

Account strategy OPEN: ChatGPT web, Developer mode, web write tools, iPhone availability, and the owner mobile strategy wait for the scope correction and an authorized deployment. AC #3 stays open.

AC #4 boundary: actual plugin evidence must prove revoked status and preservation of local files and queues. Worker or MCP results cannot prove those effects. This record does not waive them. AC #5: incomplete exit criteria and the parent F2 gate stay open. No OAB-8 or personal-vault access belongs to this task.

Leftover deployed state from owner checks: probe noscope revoked, probe rw revoked, MCP Inspector 7.8 active with an empty-scope token, and synthetic note oab-7.8/20261028-curl-01.md. Do not remove this state without owner authority.

Findings for assessment: provider authorization codes contain the owner subject as their user-id prefix. Consider an opaque provider identity without changing durable authority or existing grants silently. Revoked clients still show View grants (1) and Revoke with no revoked state. Assess against the spec and OAB-7.3. The owner authorized the local scope correction with TDD on this branch, checks, review, and a pull request. No deployment or Cloudflare resource change is authorized.
<!-- SECTION:NOTES:END -->
