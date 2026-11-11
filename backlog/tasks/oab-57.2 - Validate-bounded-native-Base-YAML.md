---
id: OAB-57.2
title: Validate bounded native Base YAML
status: Done
assignee:
  - '@pi'
created_date: '2026-11-11T01:37:00Z'
updated_date: '2026-11-11T03:55:00Z'
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

Supervisor re-audit closure at 7efdf8b.
N1 exception under AGENTS.md: valid historical pre-implementation RED evidence is unavailable for audit-round-1 items 1, 2, and 5.
Keep the implementation and tests. Do not treat test-discovery errors or later assertion failures as historical RED.
The earlier report overstated item 5 RED evidence. This note supersedes that claim.
Marker assertion changes follow the owner-directed compatibility correction, not weaker expectations.
blobs.test.ts now rejects large=true and accepts large=false for oversized Base blobs.
vault-blob-files.test.ts preserves the 1,000,001-byte size and blob checks, but expects large=false.
A later negative control temporarily bypassed the note guard. Three existing-Base tests failed with exit 1.
The worker restored the guard. This proves regression detection after implementation, not historical RED.
N2 uses a frozen manifest schema from main revision 66ff86a.
A real SQLite Worker manifest contains a 1,000,001-byte Base blob and parses through that frozen schema.
The Base row carries large=false. Oversized Markdown retains large=true.
N3 passes delete_note and restore_note inputs through the Base refusal guard.
Tests use existing Base bytes and real current/source ETags. They prove unchanged files, revisions, changes, receipts, content, and ETags.
The worker also removed stacked CST documentation and corrected the stale test title.
Focused manifest tests passed: 3. Focused existing-Base mutation tests passed: 3.
bun run docs:check and bun run check passed. Full check reported 2520 passed and 1 skipped.
Existing lint warnings remain. Supervisor re-audit and human approval remain pending.

Audit-round-1 final closures, with round-2 proof:
1. Base rows always carry large=false. Only oversized Markdown and Canvas carry large=true.
This supersedes the earlier Base marker proposal. Native Base storage limits remain unchanged.
2. All six note mutation tools refuse Base paths before mutation. Base tools retain validation and conditional operations.
Existing-Base tests cover update, both append tools, delete, and restore without persistent changes.
3. noSourceOwner documentation covers validation and refused mutations before storage admission.
4. The manifest comment states result budgets, next_page refusal, and deadline ownership.
5. A direct checkCstBounds test reaches the 16384-node limit without changing parser caps.
6. Note listing uses the canonical classifier for Markdown and Canvas.
7. Official Bases syntax states that formula properties use YAML strings. Numeric scalar rejection now has a test.
Official source revision: 24a31567c8a124aaaf95192fa49683bd35305dde.
No query engine, generic-sync validation, personal vault access, or Cloudflare change entered this correction.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added canonical Base schemas and bounded structural validation with yaml@2.8.1. The parser does not execute expressions. Fixed allocation and unknown-field preservation defects after review. Full check passed at 04443b7. Fresh corrective review approved.
<!-- SECTION:FINAL_SUMMARY:END -->
