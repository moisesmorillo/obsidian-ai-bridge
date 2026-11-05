---
id: OAB-10.6
title: Keep plugin remote destructive events out of coexistence confirmations
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-05T22:05:00Z'
updated_date: '2026-11-05T23:23:00Z'
labels: []
dependencies: []
parent_task_id: OAB-10
type: bug
ordinal: 61000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Relayed observation, not independently verified: at origin/main b5210f5, cursor 180, on 2026-11-05 about 22:05Z, a plugin remote-tombstone apply trashed `oab-10.1/dev-2/simulated-eviction-p1-20261105-01.md`. Its delete event entered the coexistence confirmation queue and blocked sync. Trigger: the next F4 coexistence correction after OAB-8.7.1 merges. Keep this task deferred until that correction.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Proved plugin remote delete and rename applies do not create owner confirmations.
- [ ] #2 Genuine user destructive edits, including concurrent same-path edits, still capture before debounce with exact authority.
- [ ] #3 Replay and restart preserve queues, with no suppression leaks.
- [ ] #4 Failing controller integration regressions cover these cases, and bun run check passes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Plan review: /tmp/oab-10.6/coexistence-origin-plan.md. Extend bounded destructive-effect proof. Preserve capture-time authority before proof waits. Keep uncertain events local and hold the capture fence until a safe result. Add failing real-controller tests, implement through one worker, run bun run check, complete independent task and whole-branch reviews, receive human branch review, and publish one PR.

Final F1 correction: test DELETE and RENAME with plugin-first and user-first dispatch under a held host effect. Include indexed same-source objects and replacement callback objects. Check frozen authority, proof settlement, confirmations, pending apply, and fence release. Preserve production behavior unless a regression proves a defect.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The P4 owner brief activates this task after OAB-8.7.1 merged as e52fad1. Work stays in the approved plugin scope and this task record. No vault or live service access is allowed. The reported real-vault incident remains unverified by this session.

RED: `bun run --cwd apps/plugin vitest run test/vault-events.test.ts -t 'proves an accepted plugin delete'` failed as expected: 1 failed, 4 skipped. The proof returned false because destructive events had no origin evidence.
GREEN: focused event, text-vault, and coexistence tests passed: 24 tests. `bun run docs:check` passed.
Full check: `bun run check` passed lint, docs, typecheck, tests, and build. Tooling 91, protocol 307, plugin 650 with 1 skipped, Worker suites 702, 122, and 115 tests passed. Worker tests printed expected injected network and SQLite fault diagnostics.
Self-review: destructive proof uses exact host object identity and accepted effect. Rename proof also checks target bytes. Weak event association carries proof into capture. Existing content proof remains byte-based. No Worker, protocol, journal, desktop-sync, publication, or live-vault changes.
Evidence limit: tests use fake host ports. No claim about real Obsidian event timing. Full requested remote-apply and adversarial matrix remain for independent review.

Correction after parent follow-up: the earlier implementation transiently saved then cleared proved confirmations. That path passed `false` to the capture fence and latched it forever. A regression test failed at `fence.isBlocked()` after a proved event (observed true, expected false). Replaced the transient persistence with synchronous frozen authority and paths, proof wait under the fence, then `saveCoexistenceConfirmation` only for uncertain proof. Successful handled events release the fence as success and use weak handled/in-flight event state. Rejected proofs fall back to persistence. Persistence failures keep the fence blocked.
Supervisor ruling: keep `device-journal.ts` out of scope. Use a private UUIDv7 helper in `coexistence.ts` that matches the journal generator and existing confirmation schema. Do not add a schema or dependency. The actual confirmation persistence test passes the canonical state schema.
RED evidence: `bun run --cwd apps/plugin vitest run test/coexistence.test.ts -t 'does not persist a confirmation or latch'` failed before the fix because the capture fence remained blocked. An earlier focused test also exposed and fixed fake-host adapter/stat omissions and invalid test epochs.
Focused GREEN after correction and main merge: `bun run --cwd apps/plugin vitest run test/coexistence.test.ts test/text-vault.test.ts test/vault-events.test.ts` passed 3 files and 37 tests. `bun run docs:check` passed.
Integration coverage now runs remote text tombstone, binary tombstone, and remote rename through TextApplyEngine, ObsidianTextVault, VaultEventAdapter, DesktopSyncController, CoexistenceController, and the shared effect fence. Tests assert queue and pending-apply state, source and destination revisions, exact destination bytes, and fence outcome.

At bfbe9c9, the destructive concurrency tests cover user-first callbacks with replacement objects only. The later adapter callback runs after mutation settlement. The content-change test covers both orders but not destructive capture.

Other tests cover refused, failed, and overlapping effects, mismatched and late reads, and rejected proof. They also cover frozen authority, Pause, replay, restart, existing confirmations, and later same-path intent.
Fetched and merged `origin/main` at 091b2b1 before final validation. The merge brought six upstream files unrelated to this task. No Worker source changes were made by this task. No vault or live service was accessed.

Final post-merge check: `bun run check` passed after origin/main 091b2b1 merged. Plugin: 663 passed, 1 skipped. Tooling: 91 passed. Protocol: 307 passed. Worker suites: 702, 122, and 115 passed. Lint, docs, all typechecks, and build passed. Worker test logs contain expected injected network/request-stream and SQLite fault messages. Focused tests passed 37/37. `git diff --check` passed. The branch includes merge commit 5128ed2. Task status remains In Progress.

Escalation signal: the prior implementer delivered this task twice without the full concurrency matrix or a named blocker. Global policy escalates only the remaining F1 scope to the session model. Parent retains review, task closure, and publication.

Final F1 correction from bfbe9c9 replaces two cases with eight real-controller cases. The matrix crosses DELETE/RENAME, plugin-first/user-first, and indexed same-source/replacement callback objects. The fake plugin host call emits only its plugin callback.

The test sends the user callback outside that call. Explicit gates keep host settlement pending across both dispatches. Same-source assertions check current Vault index identity at each dispatch.

Rename bytes and destination identity change before dispatch. Delete index removal occurs after release. No test claims real Obsidian event timing.

Each case checks exact epoch, base, paths, and event time. Before settlement, one confirmation persists before debounce while apply, host effect, and one proof stay pending. After settlement, pending apply clears and source/destination bases advance.

The confirmation keeps its original authority after apply completion. The fence stays blocked by that confirmation. It opens after keepServerState clears the confirmation, so no capture latch remains.

Same-source identical callbacks cannot identify their actors. The first callback claims proof and the second creates one exact-authority confirmation. User-first same-source proof results are [true, false], which preserve intent without actor attribution.

Replacement user-first proof results are [false, true]. Plugin-first proof results are [true, false]. The later user capture completes while the plugin proof stays pending.

RED/GREEN exception: the missing matrix passes the existing production implementation on its first run. Preserve that implementation under the approved scope. No new production defect appears.

A temporary negative control disables both claimed-evidence guards. The matrix then reports 4 failed, 4 passed, and 19 skipped, with observed exit 1. The wrapper exits 0 after it checks that failure.

The exact production file returns before validation. This negative control checks regression sensitivity, not an existing source defect. No production source change remains.

Formatting passes with bunx biome check --write apps/plugin/test/text-vault.test.ts. Focused vitest over coexistence.test.ts, text-vault.test.ts, and vault-events.test.ts passes 43 tests in 3 files, exit 0. bun run docs:check passes, exit 0.

bun run check passes lint, docs, typechecks, tests, and builds, exit 0. Counts: tooling 91, protocol 307, plugin 669 with 1 skipped, Worker 702/122/115. Total: 2006 passed, 1 skipped.

Local Worker tests print injected network/SQLite diagnostics. The Worker build uses dry-run. No vault access, live service access, deployment, or dependency change occurs.

Self-review uses the code-review skill and TypeScript profile. Origin matching, capture policy, and fence ownership stay unchanged. Parent owns independent scoped review and human review.

OAB-10.6 stays In Progress with unchecked acceptance criteria. Full commands and limits appear in the ignored task-1-report.md and /tmp/oab-10.6/fix-wave-result.md. No evidence document enters the commit.
<!-- SECTION:NOTES:END -->
