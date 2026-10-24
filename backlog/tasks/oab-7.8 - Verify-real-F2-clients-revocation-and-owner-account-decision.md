---
id: OAB-7.8
title: Verify real F2 clients revocation and owner account decision
status: To Do
assignee: []
created_date: '2026-10-24T00:05:00Z'
updated_date: '2026-10-24T00:06:00Z'
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
- [ ] #2 Real OAuth and owner revocation checks prove the next DO request fails with 401 revoked without waiting for KV propagation.
- [ ] #3 Owner verifies Developer mode and iPhone availability in their ChatGPT account. Record the result and the owner mobile client strategy.
- [ ] #4 Record the AC-08 evidence boundary. Plugin revoked status and local-file preservation remain later plugin obligations, not proof from Worker or MCP tests.
- [ ] #5 Any unresolved exit requirement stays open with its blocker. Do not start OAB-8 or later phases or access the personal vault.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
AC-08 includes device status and file preservation. These remain unproved until actual plugin evidence exists. This decomposition does not waive that text or silently approve a server-only F2 exit. Keep the parent gate open if its evidence boundary needs an explicit owner decision. Do not start OAB-8 to manufacture evidence.
<!-- SECTION:NOTES:END -->
