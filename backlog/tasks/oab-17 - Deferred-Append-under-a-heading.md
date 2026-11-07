---
id: OAB-17
title: Append under a heading
status: Done
assignee:
  - '@pi'
created_date: 2026-10-12 15:14
updated_date: '2026-11-07T04:48:00Z'
labels: []
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
- [x] #1 One Durable Object operation appends UTF-8 text under a named heading against the exact observed revision. Success creates one revision and feed entry.
- [x] #2 Match trimmed heading text exactly at any level. First match wins. A missing heading returns a typed failure without a write.
- [x] #3 Accept an idempotency key. Replays return the same result.
- [x] #4 REST and MCP expose exact ETag input and new ETag output. Document the MCP tool beside existing tools.
- [x] #5 Tests cover stale revision refusal, missing heading, replay, UTF-8, CRLF, heading at EOF, and feed publication.
- [x] #6 No plugin change.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Goal: Add conditional append under a heading for daily notes.
Owner decisions: Exact ETag and idempotency key. First exact trimmed ATX heading wins. Append before the next equal-or-lower heading. Preserve source bytes and line endings. Ignore fenced code headings. No new dependency.
- [x] Read current mutation, MCP, REST, admission, and SQLite history owners.
- [x] Write failing route tests before implementation.
- [x] Add canonical protocol schemas, result and failure shapes, and exports.
- [x] Extend existing history command and SQLite publisher. Keep legacy append unchanged.
- [x] Expose REST and MCP through their actual semantic owners.
- [x] Document contracts, heading rules, errors, and encoded limits.
- [x] Run focused tests, docs checks, full check, and Worker preflight.
- [x] Complete task review, whole-branch review, and scoped corrective reviews.
- [ ] Rebase onto current origin/main, run integration checks, publish existing PR 89, and remove worktree.
Supervisor scope decision supersedes original file limits. Use actual behavior owners. No live service, vault, Obsidian, Cloudflare, plugin, or deployment change.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reconciled after merged F0: this section16 feature has no committed delivery phase. Preserve the exact trigger and seam in the description; no trigger is evidenced and no future acceptance case is completed by this classification. The seam is a preservation obligation, not proof of an implemented feature. Reopen for research and reviewed planning only when the documented trigger is evidenced; no fake blocking dependency is added.

The owner W5 brief and COMMON-NIGHT order authorize unattended planning and implementation. No Plannotator gate applies. The trigger supersedes the earlier deferred classification.

Blocked before tests or source edits: the MCP registry and handlers are in apps/worker/src/transport/mcp.ts, not mcp-http.ts. SQLite publication is in apps/worker/src/infrastructure/sqlite/text-files.ts, outside the allowed files. Atomic heading resolution and publication cannot be added safely through the allowed appends without adding separate unapproved paths. See /private/tmp/oab17-worker-report.md for exact evidence and required scope change.

Parent validation: bun run check and Worker preflight exited 0 on baseline 877d037 with task-only changes. No feature test exists. Keep all acceptance criteria unchecked. Publish a draft PR for the file-scope blocker under the overnight order. Resume only after the owner expands the source boundary to the real MCP and SQLite owners.

The supervisor grants the real semantic owners and resolves the earlier file-boundary blocker. Continue implementation under the existing unattended plan. Preserve the live-service and vault restrictions.

Implementation and reviews: 13c4e7d added conditional heading append with route-first RED evidence. Task review found missing-key authority ordering. The corrective regression failed with 428 instead of 401, then passed after the authority check. Whole-branch review at d6c791d found F1 incomplete stale conflict details and F2 encoded JSON size handling. Commit d0324e2 fixes both with regression tests. Independent scoped review approves both fixes and reports no correction regression. Current semantic scope covers protocol schemas, immutable command identity, transport validation, pure heading parser, SQLite snapshot and publication, receipts, scoped conflict data, tests, and API/spec documentation. Existing admission and publication owners retain authority and atomicity. Shared heading identity owns encoded byte policy. Latest worker check reports 2199 passed and one skipped, with Worker preflight exit 0. No external runtime proof or deployment follows.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Add exact-ETag append under the first matching heading through REST and MCP. Reuse admission, receipts, and atomic revision/feed publication. Tests cover stale conflicts and scoped content, replay after later edits, heading selection, UTF-8, CRLF, EOF, escaped JSON, size refusal, and revocation. Full check and Worker preflight passed. Independent reviews close all actionable findings. No plugin or live service change.
<!-- SECTION:FINAL_SUMMARY:END -->
