---
id: OAB-7.4
title: Deliver authenticated MCP discovery and read tools
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-24T00:05:00Z'
updated_date: '2026-10-24T19:27:00Z'
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
1. Add canonical MCP tool schemas and production-entry protocol tests first. 2. Add the pinned MCP SDK and stateless custom HTTP transport with bounded incremental encoding. 3. Compose authenticated MCP dispatch over existing application reads and current epoch checks. 4. Run focused tests, docs:check, bun run check, self-review, record evidence, and commit.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
OAB-7.3 passed independent and scoped reviews at aad9ea3. Start Task 3 from the approved plan. Use the existing production OAuth identity, durable revocation, and application operations. Local MCP work only.

Approved dependency: add @modelcontextprotocol/server@2.4.0 for MCP dispatch, protocol semantics, and the supported custom Transport boundary. The custom HTTP adapter retains F1 byte, admission, streaming, cancellation, and ownership limits.

Owner override: the owner checked the npm registry latest endpoint and selected exact jose@6.2.13, which supports Web APIs and Cloudflare/workerd. This replaces the earlier jose@6.1.3 pin without a new plan review. Access and OAuth compatibility checks passed on jose@6.2.13: 2 files and 26 tests.

Task 3 implementation is complete locally. `bun run check` passed lint, docs:check, all typechecks, builds, and 1,142 tests across 72 files. Focused MCP, Access/OAuth, protocol, application-read, and cancellation suites passed. The MCP lazy-read adapter retains uncertain admissions after unknown failures and waits for cancellation cleanup. Internal manifest timestamps do not change the public REST manifest shape. Review found no blocking issue. Tests run locally do not qualify deployed Worker behavior or remote MCP client interoperability. Keep this task In Progress for independent review.
<!-- SECTION:NOTES:END -->
