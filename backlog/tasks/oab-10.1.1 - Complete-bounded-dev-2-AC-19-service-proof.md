---
id: OAB-10.1.1
title: Complete bounded dev-2 AC-19 service proof
status: Deferred
assignee:
  - '@pi'
created_date: '2026-11-05T16:52:00Z'
updated_date: '2026-11-05T21:57:00Z'
labels:
  - deferred
  - F4
dependencies: []
documentation:
  - docs/spec.md
parent_task_id: OAB-10.1
ordinal: 60000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Live AC-19 service proof remains incomplete after the one bounded case reached the Obsidian CLI timeout. During F4, dev-2 and the real vault share one service vault. Normal service hydration carried the synthetic fixture into the real vault. Live cases are blocked during the trial. Trigger: a second isolated service vault or the end of F4, a host runner that returns safe bounded evidence, and supervisor authorization for another case. The supervisor authorized cleanup of only the P1 fixture through normal dev-2 deletion. The scoped service read confirmed its tombstone at revision 2. Preserve the recorded historical observations. Do not create, change, or rename service files from dev-2 during F4.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Record the exact CLI exit status or spawn error, bounded secret-safe stderr, and a guarded dev-2 trivial eval result.
- [x] #2 Use one fresh oab-10.1 fixture in the exact authorized dev-2 vault. Preserve historical queue, apply, and attention identities with baseline-relative assertions.
- [ ] #3 Confirm one new durable confirmation, placeholder exclusion, and no delete or rename commit for the fixture path. Pause dev-2 after the bounded case.
- [x] #4 Keep dev-1 paused. Do not resume, reset, clear, or publish its historical work. Record that its live proof covers capture and reload only.
- [x] #5 Update OAB-10.1 criterion 6 and OAB-10 gate notes with actual results and remaining limits. Claim no real iCloud eviction proof.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Plan for review: /tmp/oab-10-1-1/plan.md. Correct the existing acceptance runner with failing tests first. Prove resumed dev-2 eviction with one fresh fixture, scoped service reads, and baseline-relative identity checks. Reuse the connected client unless a guarded recheck proves enrollment is needed. Keep dev-1 paused. Pause dev-2 after the case. Complete checks, task review, branch review, and one PR. No personal-vault or Cloudflare action.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
P1 starts under the owner brief dated 2026-11-05. Parallel execution is authorized. Scope covers acceptance tools, desktop acceptance tests, and this task. Dev-1 stays paused. No personal-vault action is authorized.

Planning probe: exact dev-2 identity and guarded eval each exited 0 with empty stderr. Safe state: connected, client j-jAYgxDZ6cyAPVM, paused, coexistence off, zero operations, zero applies, four attention items, zero confirmations. This differs from the brief disconnected state. No enrollment or mutation ran. The first identity comparison refused execution. A later diagnostic confirmed the exact target path.

Plan pn-b6bdc8 received owner approval. Tool changes: 88b1b66 and 04d111f. RED tests exposed missing resumed-state guards, missing host guards, missing CLI facts, and absent Retry-After conversion to zero. GREEN: 101 focused tests, docs:check, and bun run check passed. Final worker check reported 1937 tests passed and one skipped. Task review at 88b1b66 requested a Retry-After fix. Scoped review at 04d111f approved that fix and the new behavioral host tests. Reviews used the code-review skill and TypeScript profile. No live mutation ran.

Live preflight 2026-11-05T21:32:47Z to 21:33:33Z: each exact-target identity call and guarded eval exited 0 with empty stderr. Every eval checked the dev-2 vault name, adapter path suffix, and exact absolute path before access. Client j-jAYgxDZ6cyAPVM remains connected and paused, coexistence off, zero journal operations, zero applies, four historical attention items, and zero confirmations. The controller retains 50 create events, so isBusy is true. Three events concern old oab-10.1 fixtures and 47 concern other paths. Resume would process these events outside the one-fresh-fixture case. P1 did not resume, clear events, enable coexistence, enroll, create a fixture, or read the service. Supervisor decision remains open for this scope conflict. No dev-1, personal-vault, window, or Cloudflare action ran. No live AC-19 pass is claimed.

Supervisor decision after preflight: authorize full dev-2 Resume because the test vault is disposable and F3 gates are closed. Preserve journals. Record counts and attention fingerprints before Resume. Let normal sync process all 50 retained create events, including three old oab-10.1 fixtures whose service revisions are tombstones. Historical attention may change during this preparation. After operations and applies reach zero, record a new baseline and use it for the one-fixture AC-19 assertions. This authorization replaces the pending scope decision above. No other vault action is authorized.

Authorized preparation ran 2026-11-05T21:43:11.664Z to 21:43:27.363Z. Before Resume: 0 operations, 0 applies, 4 attention items, 0 confirmations, and 50 retained create events. Attention SHA-256: c9806c50c291706ca4a043e447a8ed27dbbd882f9cf18d5a8a4e26e5e29fd56d. Normal sync drained all 50 events. After preparation: 0 operations, 0 applies, 4 attention items, 0 confirmations, 0 retained events, idle, sync active, and the same attention fingerprint. No journal clearing ran. The new baseline stores exact queue, apply, attention, and confirmation identities privately in the guarded host. Coexistence enabled at 21:44:20.112Z. The same baseline matched, and the approved new fixture and placeholder were absent locally. Every identity and eval call exited 0 with empty stderr. Limits: attention did not change, but these counts do not prove the exact local disposition of each old fixture.

The single authorized live case started at 2026-11-05T21:44:26.929Z and returned no safe result at 21:45:26.943Z. ObsidianCliError recorded exitCode 0, signal null, spawnCode ETIMEDOUT, and empty stderr. The helper timeout was 60000 ms. ExitCode 0 does not establish case success because the process also reported a timeout. No second case ran. Guarded failure-safe Pause at 21:45:52.589Z exited 0 with empty stderr. Dev-2 then showed paused, idle, no active composition, zero operations, zero applies, four attention items, zero confirmations, zero unavailable fixture paths, a local source with a live base, and no placeholder. Historical operation, apply, and attention identities match the new baseline. Attention fingerprint remains c9806c50c291706ca4a043e447a8ed27dbbd882f9cf18d5a8a4e26e5e29fd56d. The new fixture remains as evidence. The returned state cannot prove whether eviction and cleanup completed. Do not claim durable-confirmation or resumed-service acceptance from this timeout.

Scoped final manifest at 2026-11-05T21:46:06.965Z: one complete page, one read, no retry, identity exit 0, eval exit 0, and empty stderr. Projection covered only the new fixture source and placeholder. Source has one live row at revision 1 whose epoch, revision, and hash match the local base. Placeholder has zero service rows, no base, and no queued operation. Dev-2 remains in Pause with coexistence on, zero operations, zero applies, four attention items, zero confirmations, and exact post-resume baseline identities. No live confirmation result survived the CLI timeout. Criterion 3 remains incomplete. Dev-1 evidence still covers capture and reload only. No real iCloud eviction proof exists.

Deferred trigger: a bounded host runner returns a safe phase checkpoint or case result without the Obsidian CLI timeout, plus supervisor authorization for a new bounded service case. Preserve the current live fixture. The owner-approved plan forbids another case after an uncertain mutation result. This branch can publish the tested acceptance-tool corrections and exact evidence limits, but cannot close AC-19 or OAB-10.1.1.

Supervisor safety decision after the case: dev-2 and the real vault share one service vault. Normal hydration carried the new live fixture into the real vault. No direct personal-vault access ran, but the service write had this cross-device effect. During F4, P1 must not create, change, or rename any service file from dev-2. Live cases need a second isolated service vault or the end of the trial. This decision supersedes the earlier live-fixture preservation instruction and retry trigger.

Supervisor-authorized cleanup: only oab-10.1/dev-2/simulated-eviction-p1-20261105-01.md. Guarded dev-2 disabled coexistence, resumed normal sync, trashed that exact file through the Obsidian Vault API, waited for the normal conditional delete receipt, and entered Pause. The host reported completion at 2026-11-05T21:52:27.455Z, deleted base revision 2, source absent locally, coexistence off, idle, 0 operations, 0 applies, 0 confirmations, and 4 attention items. A complete one-page scoped manifest read at 21:53:04.368Z confirmed one tombstone at revision 2, no live source row, no placeholder row, and authority equal to the local base. It used one service read and no retry. Every cleanup identity and eval call exited 0 with empty stderr. The attention fingerprint remains c9806c50c291706ca4a043e447a8ed27dbbd882f9cf18d5a8a4e26e5e29fd56d. Current state supersedes the earlier live revision 1 observation. The supervisor received the tombstone report. No other fixture cleanup or live case ran.

Whole-branch semantic review at 6f5bc9a approved publication with one non-blocking raw retry-metadata finding. Commit c5d7bd1 separates private retry metadata from safe serialized diagnostics and adds regressions for private text, circular data, BigInt, and throwing getters. Focused tests passed 105/105. Worker docs:check and bun run check passed with 1941 tests and one skipped. The scoped corrective review and human branch review remain pending.
<!-- SECTION:NOTES:END -->
