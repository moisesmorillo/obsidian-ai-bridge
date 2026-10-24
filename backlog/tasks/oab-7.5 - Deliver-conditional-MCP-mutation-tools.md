---
id: OAB-7.5
title: Deliver conditional MCP mutation tools
status: To Do
assignee: []
created_date: '2026-10-24T00:05:00Z'
updated_date: '2026-10-24T15:31:00Z'
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
