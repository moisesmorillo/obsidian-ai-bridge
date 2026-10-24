---
id: OAB-7.4
title: Deliver authenticated MCP discovery and read tools
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-24T00:05:00Z'
updated_date: '2026-10-24T17:48:00Z'
labels:
  - F2
  - MCP
dependencies:
  - OAB-7.3
documentation:
  - docs/spec.md
parent_task_id: OAB-7
ordinal: 7400
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
F2 clients need Streamable HTTP and read tools over existing application operations. REST tests alone do not prove MCP protocol behavior. Work is local only.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Authenticated /mcp supports initialization, tools/list, list_notes, read_note, search_notes, and get_history with canonical protocol schemas.
- [ ] #2 Resource and authorization metadata match the OAuth service. Initialize instructions preserve the section 8 conventions and retry guidance.
- [ ] #3 Every result carries the current epoch. ETag fragment checks prevent mixed revisions. Scope and DO revocation checks cover each tool call.
- [ ] #4 Local protocol tests exercise real MCP messages and production composition without treating them as real-client or deployed qualification.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Use docs/superpowers/plans/2026-10-24-f2-local-delivery.md, Task 3. After OAB-7.3, deliver authenticated MCP discovery and read tools through existing application operations.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
OAB-7.3 passed independent and scoped reviews at aad9ea3. Start Task 3 from the approved plan. Use the existing production OAuth identity, durable revocation, and application operations. Local MCP work only.
<!-- SECTION:NOTES:END -->
