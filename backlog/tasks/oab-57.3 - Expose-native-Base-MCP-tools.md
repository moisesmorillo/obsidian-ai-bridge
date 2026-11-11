---
id: OAB-57.3
title: Expose native Base MCP tools
status: Done
assignee:
  - '@pi'
created_date: '2026-11-11T01:37:00Z'
updated_date: '2026-11-11T02:56:00Z'
labels: []
dependencies:
  - OAB-57.1
  - OAB-57.2
parent_task_id: OAB-57
ordinal: 105000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
ChatGPT needs native Base discovery and safe authoring through existing vault authority. Apply approved plan Task 3 with six tools and no query engine.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 RED tests precede implementation for discovery, CRUD, validation, stale revisions, retries, scopes, and invalid paths.
- [x] #2 Each tool follows the approved scope, admission, response ownership, cancellation, and epoch policy.
- [x] #3 One-view conditional edits preserve unrelated settings and note revisions in Opportunities fixtures.
- [x] #4 Public contracts document six tools, examples, structural limits, and no query_base. Existing note tools retain their behavior.
- [x] #5 bun run check passes and fresh task review findings receive evidence-based closure.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Follow approved plan Task 3 and six-tool authority table. Write failing discovery, CRUD, scope, revision, cancellation, and preservation tests. Reuse existing operations and parser. Run focused checks, docs:check, bun run check, review, and commit.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reviewed revision ed62b73d6538a96eb64f7086de08fa63dcfa4679. Fresh reviewer found spec compliance and approved quality with one MINOR: duplicate MCP list byte budget owners in mcp-bases and mcp-notes. Carry this finding into final branch review, not silent closure. Structural candidates: Base application boundary and transport/application authority matrix. Reviewer found cohesive policy ownership for revision, scope, epoch, admission, and response settlement. Documentation scope: protocol declarations, spec 8 and API catalog. Focused tests and bun run check passed. Parent recovered original RED commands from worker session lines 49-60: protocol schema tests failed on undefined schemas and production MCP tests failed discovery and pre-dispatch scope. Both wrappers recorded exit 1. Exception: separate RED runs for every later edge-case test are not proven. Keep current tests and implementation, as AGENTS.md directs. No Obsidian UI pass occurred. OAB-57.4 tracks the approved disposable-runtime trigger.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added six Base MCP tools with existing vault authority and exact conditional operations. Tests cover raw-text preservation, note stability, revisions, authorization, revocation, and response lifetimes. Full check passed at ed62b73. Fresh task review approved with a minor shared-budget finding for final branch review.
<!-- SECTION:FINAL_SUMMARY:END -->
