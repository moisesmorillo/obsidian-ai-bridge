---
id: OAB-7.4
title: Deliver authenticated MCP discovery and read tools
status: Done
assignee:
  - '@pi'
created_date: '2026-10-24T00:05:00Z'
updated_date: '2026-10-24T20:13:00Z'
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
- [x] #1 Authenticated /mcp supports initialization, tools/list, list_notes, read_note, search_notes, and get_history with canonical protocol schemas.
- [x] #2 Resource and authorization metadata match the OAuth service. Initialize instructions preserve the section 8 conventions and retry guidance.
- [x] #3 Every result carries the current epoch. ETag fragment checks prevent mixed revisions. Scope and DO revocation checks cover each tool call.
- [x] #4 Local protocol tests exercise real MCP messages and production composition without treating them as real-client or deployed qualification.
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

OAB74-1 and OAB74-2 review corrections are implemented locally. MCP list traversal now scans bounded metadata batches under one admission and limits only matching rows and estimated bytes. Internal read owners stay with MCP response production through EOF or cancellation cleanup. Production tests check late prefix matches, byte overflow without partial rows, real DO admission state, EOF/cancellation settlement, and shared REST/MCP slots. `bun run check` passed lint, docs checks, typechecks, all tests, and builds with 1,146 tests across workspace suites. Limits: EOF does not prove client receipt or native release. Local tests do not qualify deployed behavior or remote MCP clients. Keep this task In Progress for parent scoped review.

Independent review a743de32 found OAB74-1 and OAB74-2 at 6499589. The worker fixed both in 39e7b48. Scoped review 5a1d2fdd approved both closures. Documentation and structural review covered MCP schemas, application adaptation, SDK transport, response ownership, REST manifest compatibility, and tests. MCP list filtering now traverses bounded batches and retains bounded matching output. Durable read owners remain active through response EOF or cancellation cleanup, with uncertain outcomes preserved. Real DO tests observe active admission before and during response demand, then settlement at EOF or cancellation. Full check passes 1,146 tests. The remaining byte-estimate note belongs to OAB-7.6 aggregate validation. The 65,536-byte chunk bound does not mean every complete JSON-RPC response fits one chunk. Local tests do not qualify external clients or deployment.

Correction to the dependency note: the parent checked npm latest and selected exact jose@6.2.13 under the owner instruction. The owner did not supply the registry result. No new plan review applies.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Complete authenticated MCP discovery and four read tools in 6499589 and 39e7b48. Canonical schemas, current epochs, exact ETag fragments, literal search, scope checks, and DO revocation use the production OAuth path. Prefix and response-ownership regressions pass. Independent and scoped reviews approve both findings. The full check passes 1,146 tests. Exact jose@6.2.13 passes Access/OAuth tests. No deployment or real-client qualification claim applies.
<!-- SECTION:FINAL_SUMMARY:END -->
