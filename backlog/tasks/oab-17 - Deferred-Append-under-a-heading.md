---
id: OAB-17
title: Append under a heading
status: In Progress
assignee:
  - '@pi'
created_date: 2026-10-12 15:14
updated_date: '2026-11-07T03:41:00Z'
labels:
  - deferred
  - trigger-based
dependencies: []
documentation:
  - docs/spec.md
ordinal: 17000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The owner triggered spec section 16 through daily notes and task lines under fixed headings. Add a conditional Durable Object append operation. Keep existing end-of-note append unchanged.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 One Durable Object operation appends UTF-8 text under a named heading against the exact observed revision. Success creates one revision and feed entry.
- [ ] #2 Match trimmed heading text exactly at any level. First match wins. A missing heading returns a typed failure without a write.
- [ ] #3 Accept an idempotency key. Replays return the same result.
- [ ] #4 REST and MCP expose exact ETag input and new ETag output. Document the MCP tool beside existing tools.
- [ ] #5 Tests cover stale revision refusal, missing heading, replay, UTF-8, CRLF, heading at EOF, and feed publication.
- [ ] #6 No plugin change.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Goal: Add conditional append under a heading for the owner daily-note workflow.
Architecture: Keep canonical request and result schemas in protocol. Use one Durable Object operation and the existing text publication authority. Keep end-of-note append unchanged.
Spec: docs/spec.md section 16 and the W5 owner brief.
Owner decisions: Use an exact observed ETag. Match trimmed heading text, case-sensitive, at any level. First match wins. Insert at the end of that section before the next heading of equal or lower level. Preserve existing text bytes and line endings. Ignore fenced code headings. Use existing mutation policy and limits. No new dependency.
Task 1:
- [ ] Read the current history, text mutation, MCP, REST, and Durable Object owners.
- [ ] Write failing tests for all six criteria. Record the expected RED result without a failed shell task.
- [ ] Add protocol append request/result schemas and final index exports.
- [ ] Add application append.ts and a final Vault method. Use existing exact-revision publication and receipt behavior.
- [ ] Add the REST route at the end of its list. Expose the MCP tool with canonical schemas.
- [ ] Document input, output, errors, heading boundaries, newline rules, and receipt retention beside existing tools.
- [ ] Run focused tests, docs:check, bun run check, and Worker preflight. Commit the task.
Review focus: duplicate headings, heading-like code, mixed line endings, stale-revision races, replay after intervening edits. Tests must cover each.
Constraints: Edit only the owner file list and OAB-17. No owner.ts, read-response.ts, blob, plugin, live service, vault, or Cloudflare changes. Report a file-boundary blocker instead of widening scope.
Parent acceptance: Independent task review, complete branch review, final rebase on origin/main, preflight before push, one PR, worktree removal.

Supervisor scope decision: Use the real semantic owners in transport/mcp.ts, application/mcp-mutations.ts, infrastructure/sqlite/text-files.ts, application/text-files.ts or history.ts, and transport/files.ts. The original brief files remain allowed. Select other behavior owners when needed. Do not stop for file-scope questions tonight. Continue on this branch and update existing PR 89. Run tests first, the complete check, and Worker preflight. Push and mark PR 89 ready after reviews.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reconciled after merged F0: this section16 feature has no committed delivery phase. Preserve the exact trigger and seam in the description; no trigger is evidenced and no future acceptance case is completed by this classification. The seam is a preservation obligation, not proof of an implemented feature. Reopen for research and reviewed planning only when the documented trigger is evidenced; no fake blocking dependency is added.

The owner W5 brief and COMMON-NIGHT order authorize unattended planning and implementation. No Plannotator gate applies. The trigger supersedes the earlier deferred classification.

Blocked before tests or source edits: the MCP registry and handlers are in apps/worker/src/transport/mcp.ts, not mcp-http.ts. SQLite publication is in apps/worker/src/infrastructure/sqlite/text-files.ts, outside the allowed files. Atomic heading resolution and publication cannot be added safely through the allowed appends without adding separate unapproved paths. See /private/tmp/oab17-worker-report.md for exact evidence and required scope change.

Parent validation: bun run check and Worker preflight exited 0 on baseline 877d037 with task-only changes. No feature test exists. Keep all acceptance criteria unchecked. Publish a draft PR for the file-scope blocker under the overnight order. Resume only after the owner expands the source boundary to the real MCP and SQLite owners.

The supervisor grants the real semantic owners and resolves the earlier file-boundary blocker. Continue implementation under the existing unattended plan. Preserve the live-service and vault restrictions.
<!-- SECTION:NOTES:END -->
