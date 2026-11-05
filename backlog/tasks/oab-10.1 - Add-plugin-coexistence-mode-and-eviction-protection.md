---
id: OAB-10.1
title: Add plugin coexistence mode and eviction protection
status: In Progress
assignee: []
created_date: '2026-11-05T12:48:00Z'
updated_date: '2026-11-05T21:57:00Z'
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
- [x] #1 An explicit coexistence setting defaults off. Local delete and rename events need durable owner confirmation and never auto-publish.
- [x] #2 Placeholder files stay excluded. A placeholder transition marks the source unavailable without a remote delete or rename.
- [x] #3 Pause retains confirmation and operation queues. Restart retains confirmations. Exit with pending confirmations fails safely.
- [x] #4 The keyboard-accessible panel shows each confirmation, safe actions, and the text and binary residual risks. Pending confirmations prevent settled status.
- [x] #5 Confirmation preserves the exact observed epoch and revision. A stale confirmation never deletes or renames newer content.
- [ ] #6 AC-19 passes with simulated eviction on both authorized Mac test vaults. Existing service evidence stays intact.
- [x] #7 Failing regressions precede implementation. bun run check, semantic TypeScript reviews, and human branch review pass.
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

Source-safety correction: TextApplyEngine now checks the shared fence and exact affected paths at each local effect admission. Rename effects check both paths. Startup restore and stale-rename cleanup also check the fence and placeholder state immediately before mutation. Refused apply effects clear only a matching expected-write hash and keep pending apply state and base authority. DeviceJournal now keeps post-epoch destructive events visible without pairing a new epoch with a stale base. Confirmation transfer rejects stale-base paths. Status marks those items stale, while Keep server state stays available.

TDD RED: `bun test apps/plugin/test/publication.test.ts apps/plugin/test/device-journal.test.ts apps/plugin/test/sync-status.test.ts apps/plugin/test/text-apply.test.ts` exited 1. All 12 new safety regressions failed before production changes. The direct Bun runner also failed two unrelated tests because its Vitest compatibility layer lacks required APIs.

GREEN: focused Vitest validation passed 269 tests across coexistence, journal, status, publication, apply, and lifecycle files. `bun run docs:check` passed. `bun run check` passed with all type checks, tests, and builds. Plugin tests passed 602 with one skipped. No live vault, host, browser, or network actions occurred. Independent branch review remains pending. Dev-2 AC-19 remains unverified, and OAB-10.1 stays In Progress.

Final independent review closure: Whole-branch review 73e0bbf0 found R1 direct publication effects, R2 stale-base epoch authority, and R3 late placeholder admission at d028a98. Commit 0b22647 corrects these paths. Scoped review 9e131bd3 closes all three with source and regression evidence and reports no new blocking finding. It retains the accepted external evidence limit in Deferred OAB-10.1.1.

The semantic review covered changed production and internal TypeScript declarations, canonical schemas, event capture, journal authority, Pause persistence, publication and apply admission, status actions, tooling builders, and named test helpers. The journal owns durable authority, the shared fence owns effect admission, and each effect owner checks exact affected paths before mutation. Already-issued host effects can finish.

Final worker validation at source revision 0b22647 passed 269 focused tests, docs:check, and bun run check. The full check passed 1,925 tests with 1 skipped, workspace type checks, lint, and builds. Worker build used dry-run mode. Pi-lens alias resolution remains a diagnostic limit, while canonical type checks pass. docs/spec.md matches origin/main. PR #57 and #58 enter through the upstream merge.

Criteria 1 through 5 now have code and regression evidence. Criterion 6 remains incomplete under the supervisor decision. Criterion 7 waits for human branch review. OAB-10.1 remains In Progress. No further host or service retry ran during source correction or review.

Human branch review pn-a9d2de approved revision 41dba32 with no changes requested. The independent whole-branch review and scoped correction review close all source findings. Criterion 7 is now checked. Criterion 6 remains incomplete with Deferred OAB-10.1.1 and the supervisor-accepted evidence limit. Publish the reviewed branch without further live retries. Keep OAB-10.1 In Progress until the bounded service proof resolves.

Publication: PR #59 is open at https://github.com/moisesmorillo/obsidian-ai-bridge/pull/59. Human review pn-a9d2de approved the branch. Fresh parent bun run check passed at ee623c2, exit 0, with 1,925 tests passed and 1 skipped, plus lint, documentation, type checks, and builds. No manual deployment ran. The owner merges. OAB-10.1 stays In Progress with criterion 6 incomplete and Deferred OAB-10.1.1. The PR records the accepted evidence limit and the automatic deployment trigger from protocol changes.

Criterion 6 update from P1, 2026-11-05: dev-2 normal sync processed 50 retained create events under explicit supervisor authorization. The original and new baseline each had 0 operations, 0 applies, 4 attention items, and 0 confirmations. Attention identities did not change. One fresh service case used oab-10.1/dev-2/simulated-eviction-p1-20261105-01.md. The CLI reached its 60000 ms timeout and returned no safe case result. Error facts: exitCode 0, spawnCode ETIMEDOUT, no signal, empty stderr. P1 did not repeat the case. Failure-safe Pause and one scoped manifest read passed. At 21:46:06.965Z the fixture had one live revision 1, no placeholder row, and authority equal to the local base. Dev-2 remains in Pause with unchanged new-baseline identities. No durable-confirmation result survived, so criterion 6 remains incomplete. Dev-1 evidence still covers capture and reload only. OAB-10.1.1 retains the bounded-runner follow-up. No real iCloud eviction or complete two-vault pass is claimed.

Criterion 6 safety correction from P1: the real vault shares the service vault with dev-2, and normal hydration carried the P1 fixture into it. The supervisor now blocks live dev-2 service creates, changes, and renames during F4. A second isolated service vault or the end of the trial is the new live-case trigger. The supervisor authorized deletion of only the P1 fixture. Scoped manifest at 2026-11-05T21:53:04.368Z confirms its tombstone at revision 2, no live row, and no placeholder row. Dev-2 remains in Pause with coexistence off, empty queues, no confirmations, and four unchanged attention items. This supersedes the earlier live revision 1 state. Criterion 6 remains incomplete. No more live case will run during F4.
<!-- SECTION:NOTES:END -->
