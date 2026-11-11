---
id: OAB-57.2
title: Validate bounded native Base YAML
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-11T01:37:00Z'
updated_date: '2026-11-11T01:54:00Z'
labels: []
dependencies:
  - OAB-57.1
parent_task_id: OAB-57
ordinal: 104000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
MCP Base authoring needs structural checks without a false copy of the Obsidian expression engine. Apply approved plan Task 2.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 RED tests precede implementation for official and two-view fixtures, invalid structures, and unknown plugin fields.
- [ ] #2 Validation bounds bytes, lexical tokens, parser stack, indicators, depth, nodes, and diagnostics before expensive composition.
- [ ] #3 Aliases, anchors, tags, duplicate keys, and multiple documents fail. Expressions stay opaque and unknown fields survive.
- [ ] #4 bun run check passes and fresh task review findings receive evidence-based closure.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Follow approved plan Task 2. Write failing tests before a bounded incremental YAML parser and canonical schemas. Add yaml@2.8.1 for Worker-portable parsing. Run focused tests, docs:check, bun run check, fresh review, and commit.
<!-- SECTION:PLAN:END -->
