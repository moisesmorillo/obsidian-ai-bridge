---
id: OAB-8.5
title: Publish local edits and resolve delete and rename conflicts
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-28T19:31:00Z'
updated_date: '2026-10-29T16:50:00Z'
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
- R1: the fake server commits create revision 1, loses its response, accepts a remote edit at revision 2, then returns the stored revision-1 receipt. `does not delete a newer edit after a delayed create receipt` confirms the dependent delete is not sent. DeviceJournal.resolve uses supplied receipt-produced authority, not a later base. It moves the delete to attention when current base differs from the create receipt.
- R2: `rejects a delayed delete when remote apply restores a newer revision` holds an unrelated send, admits delete at revision 1, applies revision 2, then releases the callback. No delete request targets revision 2. The event captures epoch and base before queue wait. It checks continued absence and base identity before admission. `does not admit a rename against a source restored after its event` also blocks the stale rename and preserves target bytes as a put.
- R3, earlier pass: the restart test checked metadata but did not check source bytes or queued source edits. The later review showed that this pass did not close R3. Current-source metadata was not receipt-produced evidence or confirmed local apply. See the bounded correction below.
- R4: `does not create startup text after disposal during expected-write persistence` pauses the durable marker write, closes publication, then releases it. The expected-write marker clears and no create starts. `does not trash a stale rename destination after disposal during its read` checks the cleanup fence. Scan and event paths also check lifecycle after awaited host reads and before new effects.

Transition and ownership review:
- DeviceJournal owns event-base comparison and durable successor transitions. Publication captures event authority synchronously, checks continued local absence, and sends only the captured precondition. Publication passes only the mutation receipt base to journal resolution.
- Rename destination authority comes from its mutation receipt. Current-source reads are observations, not receipt-produced evidence. TextApplyEngine owns guarded local apply before source base confirmation. ReconciliationController owns feed replay. The earlier pass bypassed this source boundary. See the bounded correction below.
- Cross-state tests cover queued and sent work, receipt and current-base divergence, delayed destructive events, rename receipt plus source recreation, retry after restart, and disposal during persistence and cleanup. Exact preconditions and lifecycle checks protect races after admission. The prior stateful ownership concern now has targeted cross-product evidence. Parent whole-branch acceptance remains pending.

Validation: `bun run docs:check` passed. `bun run check` passed lint, docs, typecheck, tests, and build. All 90 test files and 1,446 tests passed. Worker fault-injection cases printed expected error logs. All worker test groups passed. The task remains In Progress.

Escalation: authority transition ownership remains open after three review rounds. Final branch review at e0808d1 retains R3: successful rename recovery confirms unrelated current source metadata without guarded apply and can authorize a queued source overwrite. Escalate only remaining R3 scope to a fresh worker on session model openai/gpt-6.1-sol at high thinking. Preserve all closed F1-F3 and R1/R2/R4 regressions.

Bounded R3 correction after escalation:

- The authority defect remained open after three review rounds at e0808d1. This fresh-context correction changes only R3 and its authority boundary.
- Reviewed source revision: 5577b031e7b4bcfe2a56eae536114ea7cfc37a7c. The parent escalation note remains intact. Task status remains In Progress.
- Root cause: publication treated a current source observation as both confirmed local state and rename-produced successor evidence. Those meanings are different.
- Publication now sends current source observations through the shared TextApplyEngine before receipt settlement. The engine uses pinned reads and guarded effects. Dirty local source text reaches a visible conflict copy before remote text replaces it. Source revisions come only from server observations or feed rows.
- DeviceJournal.resolve now accepts one receipt-produced base, not an arbitrary path-to-base map. The journal selects the receipt path from the sent operation. For rename, only the destination can receive receipt successor authority. Source successors keep their observed preconditions. A newer confirmed source base does not change that rule.
- TextApplyEngine.applyCurrent owns cursor-independent apply identity and durable recovery. It resumes saved work first. It rejects completion if attention leaves apply work pending. Publication retains the sent rename and blocks overlapping successors in that case. Reconciliation uses this same apply boundary for stale-rename source recovery.

RED and GREEN evidence:

- Before implementation, `cd apps/plugin && bunx vitest run test/publication.test.ts` returned 3 failures and 31 passes. The wrapper recorded observed exit 1 and returned 0. The restart case showed missing source text. The queued-source case showed that local text overwrote the remote source. The interruption case showed premature operation settlement.
- Before the journal API change, `cd apps/plugin && bunx vitest run test/device-journal.test.ts` returned 2 failures and 35 passes. The wrapper recorded observed exit 1 and returned 0. These tests pin destination-only receipt authority with and without a newer confirmed source base.
- The first focused correction run returned 2 failures and 153 passes. The new journal tests wrongly expected a changed sent precondition to pass. The existing send barrier correctly refused it. The tests now assert refusal, unchanged operation identity, and exact retry bytes.
- Final focused command: `cd apps/plugin && bunx vitest run test/publication.test.ts test/device-journal.test.ts test/reconciliation.test.ts test/text-apply.test.ts test/vault-events.test.ts`. All 5 files and 157 tests passed, exit 0. Publication has 36 tests. Journal has 37 tests.
- The restart regression now checks recreated source bytes before actual ReconciliationController feed replay. It then replays rename revision 2 and source put revision 3. Both visible paths survive. Only feed replay advances the cursor.
- Queued-source regressions cover normal receipt retry, restart after conflict creation, and an edited conflict copy. Remote source bytes survive. Local conflict bytes remain visible. No source put occurs automatically. A normal scan publishes the verified conflict copy with an absent precondition.
- A newer confirmed source test applies revision 4 before the old rename receipt returns. A later local edit keeps its revision-4 precondition despite a revision-3 observation. Its lost-response retry keeps the same key, bytes, and precondition after restart.
- TDD exception: the newer-confirmed-source and edited-conflict-copy audit cases were added after the correction. Both passed. The main source-recreation and queued-overwrite regressions failed before implementation.
- Biome formatting passed. `bun run docs:check` passed, exit 0. `bun run check` passed lint, docs, typecheck, tests, and build, exit 0. All 90 files and 1,452 tests passed. Worker fault-injection cases printed expected error logs. Worker build used dry-run mode.

Finding and ownership closure:

- R3: fixed in this self-review. Source observation no longer confirms bytes or authorizes a queued source edit. Guarded apply confirms source state. Receipt resolution authorizes only its produced path. Tests prove visible bytes, conflict copies, feed replay, interrupted recovery, and immutable source retries.
- R3 documentation: corrected send TSDoc and the earlier task claims. Current observations, guarded apply, and receipt-produced authority now have distinct contracts.
- F1, F2, F3, R1, R2, and R4: existing regression tests remain unchanged and pass. Queued validation, stale-rename cleanup, dependent deletes, delayed-event guards, and disposal fences remain intact.
- Structural candidates: publication owns event admission, send policy, receipt classification, and retry. Journal owns durable identity and destination-only successor transitions. TextApplyEngine owns guarded local effects and confirmed bases. Reconciliation owns ordered feed replay. Composition shares one engine. Transport still owns canonical response validation. Event adapter still owns event delivery and disposal. Protocol schemas remain unchanged.
- Stateful matrix reviewed: queued versus sent operations, source versus destination, receipt versus current observation, older versus newer confirmed base, local absent/dirty/confirmed text, retry/restart, pending conflict attention, and lifecycle close. Tests cover the material R3 cross-products. No separate policy owner or new layer was added.
- No new blocker appeared in the bounded self-review. Parent corrective review and branch acceptance remain pending. No task closure, push, pull request, or worktree removal occurred.
- Limits: no live service, deployment, real vault, or hosted CI proof ran. No dependency, Worker source, or protocol schema changed. OAB-8.6, OAB-8.7, and OAB-8.8 remain outside scope.

Final whole-branch review approved main 9b06569 through 0161d3d. Reviewed source: 5577b03. Reviewer closed F1-F3 and R1-R4 with code and regression evidence. R3 separates current observation, guarded confirmed apply, and receipt-produced authority. Rename receipts authorize destination successors only. The stateful structural gate passed for publication, journal, text apply, reconciliation, transport, protocol schema, event adapter, and composition. Documentation audit covered changed semantic declarations, private helpers, ports, schemas, tests, and task notes. All four criteria have automated evidence within the approved text-only scope. Worker check passed 90 files and 1452 tests. Focused checks passed 5 files and 157 tests. Reviewer Git checks passed. No hosted CI, live service, real vault, or two-device proof ran. Owner diff review remains pending.
<!-- SECTION:NOTES:END -->
