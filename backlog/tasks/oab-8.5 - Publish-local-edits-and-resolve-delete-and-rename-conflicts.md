---
id: OAB-8.5
title: Publish local edits and resolve delete and rename conflicts
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-28T19:31:00Z'
updated_date: '2026-10-29T16:21:00Z'
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

Whole-branch review corrections for R1–R4:

- RED: `cd apps/plugin && bunx vitest run test/publication.test.ts` first showed four failures for R1, R2 delete, R2 rename, and R4 restore disposal. After adding R3 restart coverage, five regressions failed. Each failure matched its stated unsafe interleaving. GREEN: all 32 publication tests pass.
- R1: the fake server commits create revision 1, loses its response, accepts a remote edit at revision 2, then returns the stored revision-1 receipt. `does not delete a newer edit after a delayed create receipt` confirms the dependent delete is not sent. DeviceJournal.resolve uses supplied successor authority, not a later base. It moves the delete to attention when current base differs from the create receipt.
- R2: `rejects a delayed delete when remote apply restores a newer revision` holds an unrelated send, admits delete at revision 1, applies revision 2, then releases the callback. No delete request targets revision 2. The event captures epoch and base before queue wait. It checks continued absence and base identity before admission. `does not admit a rename against a source restored after its event` also blocks the stale rename and preserves target bytes as a put.
- R3: `resolves a rename receipt after a newer source recreation and restart` commits a rename, loses its receipt, recreates the source at revision 3, restarts the journal, then receives the stored destination receipt at revision 2. Recovery records source revision 3 from current authority, destination revision 2 from the receipt, and resolves the operation. No source revision is invented.
- R4: `does not create startup text after disposal during expected-write persistence` pauses the durable marker write, closes publication, then releases it. The expected-write marker clears and no create starts. `does not trash a stale rename destination after disposal during its read` checks the cleanup fence. Scan and event paths also check lifecycle after awaited host reads and before new effects.

Transition and ownership review:
- DeviceJournal owns event-base comparison and durable successor transitions. Publication captures event authority synchronously, checks continued local absence, and sends only the captured precondition. Publication passes exact mutation receipt bases to journal resolution.
- Rename destination authority comes from its mutation receipt. Rename source authority comes from a separate current read. TextApplyEngine and ReconciliationController own guarded remote apply and feed replay. Composition still uses one journal and transport. No file split was needed.
- Cross-state tests cover queued and sent work, receipt and current-base divergence, delayed destructive events, rename receipt plus source recreation, retry after restart, and disposal during persistence and cleanup. Exact preconditions and lifecycle checks protect races after admission. The prior stateful ownership concern now has targeted cross-product evidence. Parent whole-branch acceptance remains pending.

Validation: `bun run docs:check` passed. `bun run check` passed lint, docs, typecheck, tests, and build. All 90 test files and 1,446 tests passed. Worker fault-injection cases printed expected error logs. All worker test groups passed. The task remains In Progress.
<!-- SECTION:NOTES:END -->
