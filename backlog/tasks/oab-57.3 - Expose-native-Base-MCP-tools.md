---
id: OAB-57.3
title: Expose native Base MCP tools
status: Done
assignee:
  - '@pi'
created_date: '2026-11-11T01:37:00Z'
updated_date: '2026-11-11T03:55:00Z'
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

Final branch corrections at cb7c617 preserve durable settlement ownership after list preparation failure, including known and uncertain completion. Base and note list budgets now share McpListResultBudget. Tests cover post-authorization abort cleanup exactly once and budget count/byte/Unicode boundaries. Full check reported 2611 passed and 1 skipped. Scoped reviewer 10aeb9b0 confirmed F1 and F4 fixed. Comment-only follow-up ebeb667 explains ReadOutcome.completion. Reviewer 42b62169 approved its truth against callers. No MCP review finding remains deferred.

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
Added six Base MCP tools with existing vault authority and exact conditional operations. Tests cover raw-text preservation, note stability, revisions, authorization, revocation, and response lifetimes. Full check passed at ed62b73. Fresh task review approved with a minor shared-budget finding for final branch review.
<!-- SECTION:FINAL_SUMMARY:END -->
