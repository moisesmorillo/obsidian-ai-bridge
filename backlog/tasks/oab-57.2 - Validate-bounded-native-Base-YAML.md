---
id: OAB-57.2
title: Validate bounded native Base YAML
status: Done
assignee:
  - '@pi'
created_date: '2026-11-11T01:37:00Z'
updated_date: '2026-11-11T03:17:00Z'
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
- [x] #1 RED tests precede implementation for official and two-view fixtures, invalid structures, and unknown plugin fields.
- [x] #2 Validation bounds bytes, lexical tokens, parser stack, indicators, depth, nodes, and diagnostics before expensive composition.
- [x] #3 Aliases, anchors, tags, duplicate keys, and multiple documents fail. Expressions stay opaque and unknown fields survive.
- [x] #4 bun run check passes and fresh task review findings receive evidence-based closure.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Follow approved plan Task 2. Write failing tests before a bounded incremental YAML parser and canonical schemas. Add yaml@2.8.1 for Worker-portable parsing. Run focused tests, docs:check, bun run check, fresh review, and commit.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Added yaml@2.8.1 because its browser export supports Workers portability, unlike Bun-only YAML parsing.

Reviewed revision 04443b701d6ad4326c1555ed96176e87434af2cb. Initial review found oversized-input allocation, ineffective node fixture, and public schema key stripping. Fixed all three in 04443b7. Scoped reviewer approved each closure. Tests now prove two actual views and the intended depth refusal. The node candidate reaches the lexical-token ceiling first, so independent node-ceiling coverage remains unclaimed. Documentation scope: new protocol schemas, types, and codec declarations. Structural candidate: bounded parser pipeline, cohesive with one safety-policy owner. Twenty-one focused tests, docs:check, typecheck, and bun run check passed. Existing unrelated lint warnings remain.

Final branch corrections at cb7c617 validate every present known filter operator and refuse malformed sibling operators, including nested filters. Diagnostics now use bounded content-free messages. Regression tests prove malformed create/update refusal without a new revision and sentinel removal. Full check passed at cb7c617. Scoped reviewer 10aeb9b0 confirmed F2 and F3 fixed. No parser finding remains deferred.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added canonical Base schemas and bounded structural validation with yaml@2.8.1. The parser does not execute expressions. Fixed allocation and unknown-field preservation defects after review. Full check passed at 04443b7. Fresh corrective review approved.
<!-- SECTION:FINAL_SUMMARY:END -->
