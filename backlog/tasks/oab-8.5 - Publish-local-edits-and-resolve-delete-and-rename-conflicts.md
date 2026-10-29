---
id: OAB-8.5
title: Publish local edits and resolve delete and rename conflicts
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-28T19:31:00Z'
updated_date: '2026-10-29T15:46:00Z'
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

Corrective review for F1–F3:

- F1 RED: `cd apps/plugin && bunx vitest run test/publication.test.ts` showed stale queued bytes sent with the newer revision after scan, then remote apply. GREEN: `does not send scan bytes after a newer remote apply changes the base and file` checks this interleaving. Queued puts now check current bytes and base before first send. Sent retries keep their original bytes and precondition. The test `keeps sent payload and precondition immutable after a newer remote apply` checks that rule.
- F2 RED: both stale-rename cursor cases failed before recovery changes. GREEN: `recovers a clean before`, `clean after`, `edited before`, and `edited after` stale rename cases pass. Rename records keep the old source hash. Recovery replays changes, reads current source authority, and applies it through TextApplyEngine. Recovery trashes only exact unchanged moved bytes. Edited destination text gets a new queued put. A simulated interruption after trash, journal reopen, and retry also pass. Cursor assertions stay at the feed head.
- F3 RED: create-delete before flush and a sent-create dependency case failed before the fixes. GREEN: `cancels an unsent create when a live delete arrives before flush`, `preserves a sent create and queues its delete after the receipt`, and `blocks a dependent delete when its sent create is rejected` pass. A queued create is cancelled. A sent create remains immutable. Its dependent delete waits for a receipt and then uses the new live revision. Rejection moves both operations to attention.

Transition ownership review:
- DeviceJournal owns durable operation identity, exact preconditions, payload evidence, receipt rebasing, and dependent-delete transitions. Its serializer commits these state changes.
- PublicationController owns live event admission, queued-put validation, outbound requests, and response classification. It never refreshes a sent operation. Conditional server preconditions protect any race after local validation.
- ReconciliationController owns feed replay and the cursor-independent current-source read. TextApplyEngine owns guarded local apply and conflict copies. `createPublication` wires them to one journal, vault, and remote adapter.
- Policy rows covered: queued or sent put with current, stale, missing, or changed local text; clean or edited rename destination with cursor before or after the feed change; create-delete before send, after uncertain send, receipt, and rejection; mutation receipt versus feed cursor. Tests cover these transitions and the post-trash restart boundary.
- Self-review found no open blockers in these findings. Parent review remains required. No real vault or live service test ran. OAB-8.6 and OAB-8.7 remain out of scope.

Validation after correction: `bun run docs:check` passed. `bun run check` passed lint, docs, typecheck, tests, and build. All 90 test files and 1,440 tests passed. Worker fault-injection tests printed expected error logs. All worker test groups passed.

Correction to the earlier OAB-8.1 review note: DeviceJournal.resolve now distinguishes receipts from rejections. It retains rejected sent evidence, rebases queued conflicts after receipts, and moves dependent deletes to attention after rejection.
<!-- SECTION:NOTES:END -->
