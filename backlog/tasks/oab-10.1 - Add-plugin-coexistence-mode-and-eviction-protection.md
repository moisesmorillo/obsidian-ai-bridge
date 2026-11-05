---
id: OAB-10.1
title: Add plugin coexistence mode and eviction protection
status: In Progress
assignee: []
created_date: '2026-11-05T12:48:00Z'
updated_date: '2026-11-05T17:04:00Z'
labels: []
dependencies: []
documentation:
  - docs/spec.md
parent_task_id: OAB-10
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
iCloud eviction can emit destructive Obsidian events. F4 needs owner confirmation before publication while iCloud and the plugin share files. Scope: spec §7.10, §7.9, §7.7, §7.8, and AC-19. Automated evidence uses only the two authorized test vaults.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An explicit coexistence setting defaults off. Local delete and rename events need durable owner confirmation and never auto-publish.
- [ ] #2 Placeholder files stay excluded. A placeholder transition marks the source unavailable without a remote delete or rename.
- [ ] #3 Pause retains confirmation and operation queues. Restart retains confirmations. Exit with pending confirmations fails safely.
- [ ] #4 The keyboard-accessible panel shows each confirmation, safe actions, and the text and binary residual risks. Pending confirmations prevent settled status.
- [ ] #5 Confirmation preserves the exact observed epoch and revision. A stale confirmation never deletes or renames newer content.
- [ ] #6 AC-19 passes with simulated eviction on both authorized Mac test vaults. Existing service evidence stays intact.
- [ ] #7 Failing regressions precede implementation. bun run check, semantic TypeScript reviews, and human branch review pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Approved plan pn-40b7a0 is /tmp/oab-10-1/2026-11-05-f4-coexistence.md. Do not commit plans or evidence documents. Add canonical durable confirmations, capture exact event authority before debounce, protect unavailable paths, add safe controls, prove simulated AC-19 on both test vaults, complete checks and reviews, then open one PR.

Persist the plugin Pause state so a controlled bundle reload starts paused. Test startup and explicit Resume before any host reload. Save the prior history counts and verify them after setup. Run dev-2 service evidence, then dev-1 capture and reload checks. Preserve the task as In Progress if safe live evidence remains incomplete.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Baseline before implementation: bun run check passed at main dbb0481 in the isolated Orca worktree, exit 0. No product code changed. Plan approval remains pending.

Owner decision: Place the coexistence confirmation type and schema in the existing DeviceState exports in packages/protocol/src/index.ts. This replaces the earlier append-only constraint for these two exports so Biome passes. No other exports changed. Reconcile with origin/main at 7abee2c found no competing index exports.

Round-1 review fix: CoexistenceEffectFence blocks later publication, reconciliation writes, and local apply effects after destructive capture. In-flight effects can finish. AC-19 evidence and independent branch review remain pending.

AC-19 readiness, read-only, 2026-11-05T14:35:28Z. Exact CLI root checks and in-app adapter path checks passed for both approved test vaults. dev-1 client 2co2-3SyCC3aatQJ was connected, sync status paused, mode off, with 1 queued operation, 1 pending apply, and 2 attention items. dev-2 client j-jAYgxDZ6cyAPVM was connected, sync status paused, mode off, with 0 operations, 0 pending applies, and 4 attention items. Both fixture roots, source files, and placeholders were absent. AC-19 needs settled state, mode on, empty queues, and no attention. No plugin install, service call, journal change, resume, reset, cleanup, browser flow, or real-vault action occurred. Supervisor directed no host mutations while a bounded decision remains open. Full safe results and commands are in /tmp/oab-10-1/implementation-report.md.

Latest acceptance update: origin/main at f1a3a35 merged in 09883b3 after PR #58. The current guide collector scope remains unchanged.

The dev-1 capture runner returned an unclassified action failure. A separate safe state check passed with one confirmation, one unavailable source, the expected placeholder, and unchanged historical queue, apply, and attention fingerprints. The measured capture delta was one confirmation and no queue, apply, or attention change. Dev-1 reload verification then passed with Pause retained. The confirmation, placeholder exclusion, source unavailability, and unchanged fingerprints persisted. The excluded reload baseline file was removed after the check.

The first dev-2 service case failed at the placeholder exclusion assertion. Its cleanup passed. A retry with a new fixture name returned an Obsidian CLI failure before a safe case result. The last read-only check showed dev-2 paused with unchanged historical counts and fingerprint. The retry source and a live base entry remain. No pending operation, apply, confirmation, or unavailable-path entry remains. Do not clean or reuse this fixture. No verified dev-2 service acceptance result exists.

The AC-19 script now waits for confirmation and unavailable-path state. It also supports a validated unique fixture name. Unit tests and bun run check passed. The guide control labels match the final UI labels. No guide edit was needed.

Keep this task In Progress. AC-19 is incomplete. Do not claim a full two-vault service pass or real iCloud eviction proof. The parent owns independent branch review and task closure.

A read-only service-authority probe for the retry fixture returned unknown-error and no result. It made no change. I stopped host actions. The latest tool fix used the failed live placeholder assertion as red evidence. Its focused unit assertion followed the implementation change. The full check passed afterward.

Supervisor-authorized diagnostic ran from 2026-11-05T16:41:43Z to 2026-11-05T16:47:23Z. The exact-target dev-2 trivial runHostCase check passed. Its assertion confirmed app.vault.getName() returned obsidian-ai-bridge-dev-2. The CLI identity and eval calls each exited 0. Stderr was empty.

I ran one fresh dev-2 service retry with fixture name simulated-eviction-retry-3. runHostCase raised Obsidian command failed. The wrapper recorded identity_exit=0, no eval exit record, and empty stderr. The helper did not expose the underlying spawn or process exit code. The retry returned no safe case result. I did not run another live retry.

The final read-only projection showed both vaults paused. Dev-1 kept its original fingerprint, one confirmation, one unavailable path, and its expected placeholder. Dev-2 kept its original fingerprint and counts: 0 pending operations, 0 applies, 4 attention items, 0 confirmations, and 0 unavailable paths. The retry-3 source, placeholder, and base entry were absent. The prior dev-2 fixture and retry-2 source with live base remain. I made no journal or service cleanup after the retry.

I checked guide controls against the UI. Coexistence mode, Pause, and Resume match. The UI also labels Confirm delete <path>, Confirm rename <path> to <destination>, Keep server state <path>, and Sync now. No guide edit was needed. Commits include 09883b3, 3fe35a3, 9fcd0de, 34bc226, and 6a5b15d. Final bun run check passed with 1,871 tests passed and 1 skipped. Keep OAB-10.1 In Progress. The parent owns independent review and task closure.

Supervisor decision, 2026-11-05: Criterion 6 has split evidence. Dev-1 capture, durable confirmation, placeholder exclusion, and reload checks passed with historical fingerprints unchanged. Its non-publication half rests on dev-2 evidence and real-controller tests, not a resumed dev-1 service run. Dev-2 service proof remains pending after the one bounded diagnostic retry failed at the CLI boundary. The supervisor accepts this external evidence limit for this PR and directs review and publication without another live retry. The follow-up trigger is merge plus safe exact-vault CLI case results. This decision does not claim a complete AC-19 pass or F4 gate closure.

Post-review correction: Restored only the unapproved Pause sentence in docs/spec.md. Pause now uses sync_paused in the verified device-local DeviceState journal. The plugin ignores the legacy shared syncPaused setting. Missing local Pause state defaults to normal startup. Tests cover restart, Resume, local save failure, and stale unload. Generated AC-19 service and capture/reload failure labels now pass parser table tests. Criterion 6 remains incomplete. Dev-2 service proof remains pending. OAB-10.1.1 remains Deferred.
<!-- SECTION:NOTES:END -->
