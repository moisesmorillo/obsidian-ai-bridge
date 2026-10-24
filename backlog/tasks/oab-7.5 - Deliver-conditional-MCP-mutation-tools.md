---
id: OAB-7.5
title: Deliver conditional MCP mutation tools
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-24T00:05:00Z'
updated_date: '2026-10-24T20:38:00Z'
labels:
  - F2
  - MCP
dependencies:
  - OAB-7.4
documentation:
  - docs/spec.md
parent_task_id: OAB-7
ordinal: 7500
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Agents need section 8 mutations through the existing authoritative operations. A separate slice makes conditional writes and retry safety independently reviewable. Work is local only.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 create_note, update_note, append_to_note, delete_note, and restore_note use the same DO operations as REST and canonical protocol schemas.
- [ ] #2 Tests cover exact ETags, stale epochs, collisions, tombstones, size limits, required append keys, retries, and per-client receipt isolation.
- [ ] #3 Every tool enforces its scope and DO revocation. Write does not imply delete. Agent origin and mutation feed entries remain correct.
- [ ] #4 All results carry epoch and bounded errors. Local tests preserve every data-safety invariant without claiming plugin delivery or real-client success.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Use docs/superpowers/plans/2026-10-24-f2-local-delivery.md, Task 4. After OAB-7.4, deliver exact-revision MCP mutations and client-scoped receipt tests.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
OAB-7.4 passed independent review at 39e7b48. Preserve the current jose pin. This task uses the existing application authority and remains local. Added canonical mutation schemas and production MCP tools for create, update, append, delete, and restore. Tool scopes are checked in Worker. Production tests cover all five mutations, stale create epoch, stale update ETag, append same-key retry, changed payload mismatch, client-scoped key isolation, denied delete scope, and denied read calls. The F2 MCP focused suite passed 9 tests. docs:check and bun run check passed. Task remains In Progress for independent review. Remaining test cases are listed in the task-4 report.
<!-- SECTION:NOTES:END -->
