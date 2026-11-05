---
id: OAB-10.6
title: Keep plugin remote destructive events out of coexistence confirmations
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-05T22:05:00Z'
updated_date: '2026-11-05T22:42:00Z'
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
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The P4 owner brief activates this task after OAB-8.7.1 merged as e52fad1. Work stays in the approved plugin scope and this task record. No vault or live service access is allowed. The reported real-vault incident remains unverified by this session.

RED: `bun run --cwd apps/plugin vitest run test/vault-events.test.ts -t 'proves an accepted plugin delete'` failed as expected: 1 failed, 4 skipped. The proof returned false because destructive events had no origin evidence.
GREEN: focused event, text-vault, and coexistence tests passed: 24 tests. `bun run docs:check` passed.
Full check: `bun run check` passed lint, docs, typecheck, tests, and build. Tooling 91, protocol 307, plugin 650 with 1 skipped, Worker suites 702, 122, and 115 tests passed. Worker tests printed expected injected network and SQLite fault diagnostics.
Self-review: destructive proof uses exact host object identity and accepted effect. Rename proof also checks target bytes. Weak event association carries proof into capture. Existing content proof remains byte-based. No Worker, protocol, journal, desktop-sync, publication, or live-vault changes.
Evidence limit: tests use fake host ports. No claim about real Obsidian event timing. Full requested remote-apply and adversarial matrix remain for independent review.
<!-- SECTION:NOTES:END -->
