---
id: OAB-8.5
title: Publish local edits and resolve delete and rename conflicts
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-28T19:31:00Z'
updated_date: '2026-10-29T15:14:00Z'
labels: []
dependencies:
  - OAB-8.4
documentation:
  - docs/spec.md
parent_task_id: OAB-8
ordinal: 43000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Connect vault events and startup hash scans to conditional publication and rename application. One focused PR. Preserve the journal send barrier and use the same application engine. Device proof remains in OAB-8.8.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Automated AC-03, AC-04, AC-05, and AC-06 cover offline edits and confirmed remote precedence. AC-24 fetches destination bytes by destination revision.
- [ ] #2 AC-30 retains sent keys and bytes after a lost response. Later edits receive separate keys and the correct next precondition. Receipt sequence never advances the feed cursor.
- [ ] #3 AC-33 resolves rename sides separately. Newer source revisions survive replay. Deletes and renames come only from live vault events. Missing startup files restore from the server.
- [ ] #4 Publication handles 412, path collisions, size limits, expired operations, and bounded retry with Retry-After. Local link rewrites publish as ordinary puts.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Owner approved .pi/plans/oab-8.5-local-publication.md in pn-e2a35e. Add a text publication controller and explicit live-event adapter. Reuse the journal and apply engine. Cover the approved acceptance cases with RED/GREEN tests. Preserve immutable sent operations, exact preconditions, durable conflict recovery, and feed cursor authority. Keep scheduling in OAB-8.7 and blobs in OAB-8.6. One worker owns implementation, checks, and commits. Complete task review, whole-branch review, owner diff review, and pull request.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
OAB-8.1 branch review obligation: DeviceJournal.resolve ignores outcome.kind and removes rejected operations. The publisher must secure and verify the conflict copy before it resolves a rejected operation. Alternatively, change resolve to retain rejected operations. OAB-8.2 does not change rejection handling.

TDD evidence:
- RED `cd apps/plugin && bunx vitest run test/publication.test.ts` first failed because the publication module did not exist. The final publication suite passed 17 tests.
- RED for case-only rename showed `Rename paths must differ`. GREEN passed the case-only rename and related publication tests.
- RED for a pending live delete restored remote bytes. GREEN passed after scan skipped restoration for pending deletes and renames.
- RED for queued payload discard showed the journal method did not exist. GREEN passed the journal and publication suites.
- RED for unchanged modify events queued an unnecessary put. GREEN passed after base-hash comparison.
- TDD exception: the explicit delete success test was added after its controller implementation. The test passed and remains in the suite.

Validation:
- `bun run docs:check` passed.
- `bun run check` passed lint, documentation, typecheck, tests, and build. All 90 test files passed with 1,431 tests. Worker fault-injection tests printed error logs. All worker test groups passed.
- Focused plugin tests passed: 4 files and 65 tests.

Review scope:
- Structural candidates reviewed: publication controller, device journal, protocol state schema, authenticated transport, event adapter, and composition factory.
- No blockers found in this self-review. Parent review remains required.
- No live service or real Obsidian vault test ran. No deployment or vault access occurred.
- OAB-8.6 owns blob work. OAB-8.7 owns scheduling and lifecycle activation. Task remains In Progress.
<!-- SECTION:NOTES:END -->
