---
id: OAB-16
title: Sync .obsidian settings categories
status: In Progress
assignee: []
created_date: 2026-10-12 15:14
updated_date: '2026-11-07T02:04:00Z'
labels: []
dependencies: []
documentation:
  - docs/spec.md
ordinal: 16000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The owner triggered the settings-category seam on 2026-11-06 because manual configuration became a daily cost. Implement the categories and exclusions in spec section 7.1. Keep external proof open under the supervisor restriction.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A default-off Sync settings categories setting has appearance, core, and community plugin switches. The scope matches the owner brief.
- [x] #2 Workspace JSON, AI Bridge files, cache paths, graph.json, and plugin node_modules remain excluded with every switch combination.
- [ ] #3 Raw events capture local unindexed settings changes. Tests and the Mac dev vault prove capture.
- [x] #4 Adapter apply preserves exact-revision guards and conflict copies. Documentation explains plugin data and enabled-list reload needs.
- [x] #5 First enable publishes local settings as ordinary creates. Different receiving-device settings survive as conflict copies.
- [ ] #6 The owner proves that desktop-only plugins remain harmless on mobile after release.
- [x] #7 Spec sections 7.1 and 16 list settings categories and exclusions, and record the 2026-11-06 trigger and move to section 7.1.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Plan: /private/tmp/oab16-settings-sync-plan.md. Extend the single scope classifier, guarded blob adapter, raw events, existing controllers, settings UI, and release metadata. Get plan approval before implementation. Use one worker and independent review. Run bun run check. Get branch review, open one PR, remove the worktree, and stop. Leave device proof open.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reconciled after merged F0: this section16 feature has no committed delivery phase. Preserve the exact trigger and seam in the description; no trigger is evidenced and no future acceptance case is completed by this classification. The seam is a preservation obligation, not proof of an implemented feature. Reopen for research and reviewed planning only when the documented trigger is evidenced; no fake blocking dependency is added.

Owner triggered the settings scope seam on 2026-11-06. The owner authorizes F5 copy-vault work through the supervisor. Personal-vault access and live service cases remain prohibited. The S16 brief sets this branch scope.

Code implementation is complete for release target 0.1.4. Device proof remains open. The owner override on 2026-11-07 stopped all Obsidian, dev-vault, and service actions before any such action occurred. Unit tests and fakes are the only runtime evidence. Resume device proof only when a device is available and BRAT release plugin-v0.1.0 is published. The current code target is 0.1.4. No release is authorized.

Final correction wave follows 47b2c39 on origin/main 4b6bc04. The session-tier escalation preserves the existing implementation. R1 follows the owner decision: retain automatic settings installation with pre-write target stat, adapter write, and hash read-back. Observable races preserve remote and observed local versions as visible conflict files and record attention. This method is not atomic. A local version can appear after the last observation and disappear under the adapter write before any read observes it. The plugin cannot detect or recover that unobserved version. This residual race applies to creation and replacement. No manual-placement fallback or new capability claim exists.

R2 stores consent and switches only in app device-local configuration storage. Shared settingsSync.enabled never grants consent. R3 saves the full-hydration duty with that policy. Recovery starts a fresh manifest pass, not an old-scope checkpoint. Pause, disconnection, suspension, interrupted saves, and restart retain the duty. Normal event admission and publication wait for completion. Only immutable sent retries can resolve manifest blockers before completion. R4 prunes excluded trees through enrollment-scope.ts and validates path identity candidates. R5 applies global exclusions before settings admission and case-folds AI Bridge exclusion. N1 uses canonical admission to select a supported extension for every settings conflict.

RED: the focused four-file test command reported 20 failures and 237 passes before product edits. Three legacy persistence gates timed out because their new local-storage hook did not exist yet. Later focused RED commands reproduced retained-event ordering (1 failure), observation preservation (1), checkpoint completion (2), sent-only recovery (2), rename-target races (4), write-error recovery (1), and local-config property-order verification (1). Final focused command: bun --filter @obsidian-ai-bridge/plugin test -- enrollment-scope.test.ts text-vault.test.ts text-apply.test.ts lifecycle.test.ts publication.test.ts reconciliation.test.ts settings-sync-storage.test.ts. Result: 8 files, 444 passed, exit 0. Biome formatting and bun run docs:check passed. bun run check passed: 2165 passed, 1 skipped, 0 failed. Plugin: 813 passed and 1 skipped. All check phases exited 0. Worker build used dry-run only. No live service, vault, Obsidian, deployment, release, or PR action occurred.

Self-review covers the correction overlay on 47b2c39, plugin source and tests, and spec sections 7.1 and 16. Structural owners remain cohesive: enrollment-scope owns path policy, local configuration owns consent persistence, main owns lifecycle and hydration admission, publication owns sent-only retry selection, and apply plus adapter own revision decisions and host mechanics. The state matrix covers scope expansion, durable duty, old cursor/checkpoint, paused/disconnected/suspended/restarted owners, sent versus queued work, and observed adapter races. Tests cover those rows and byte preservation. The owner-accepted R1 window remains open by design. Independent scoped review remains with the parent. OAB-16 stays In Progress. External Mac and device proof stays unchecked.

Independent task review and corrective review closed the raw callback, disabled-base reads, sent blob retry, adapter delete, and persistence-interruption findings. Whole-branch review at 47b2c39 found R1 through R5 and N1. Final scoped review at 52c8e74 approves with notes. R2 through R5 and N1 are fixed with specific regression tests. R1 remains intentionally deferred under the supervisor decision to keep automatic guarded installation. This is a real possible data-loss window, not atomic creation. Revisit it when a supported atomic create/write capability becomes available. The earlier lifecycle coverage note remains bounded. Current review scope covers every changed plugin source/test declaration, spec sections 7.1 and 16, and release metadata. Structural candidates: main lifecycle/hydration, device-only storage, path classifier, publication/reconciliation, apply/adapter, and raw event ownership. Review evidence maps the state transitions and declaration comments to tests. No further actionable finding remains under the stated limit.

Acceptance: criteria 1, 2, 4, 5, and 7 have unit or integration-fake evidence and documentation. Criterion 4 retains the explicit R1 write limit. Criterion 3 stays unchecked because the supervisor canceled Mac-vault proof. Criterion 6 stays unchecked because owner mobile proof needs a future authorized release and device session. Revoked dev clients and closed dev vaults must not resume. The historical plugin-v0.1.0 trigger grants no current action authority. Earlier parent planning used guarded read-only dev-2 capability probes before the restriction. The parent made no vault writes or service calls. Workers used tests and fakes only. This clarifies the earlier note that said no such action occurred.

The final reviewed feature commits rebased without conflicts onto origin/main 8dbd702. Equivalent current revisions are 7188fde, 3fee604, and f83a06e. The parent will run the complete check on this integration before publication. OAB-16 remains In Progress.
<!-- SECTION:NOTES:END -->
