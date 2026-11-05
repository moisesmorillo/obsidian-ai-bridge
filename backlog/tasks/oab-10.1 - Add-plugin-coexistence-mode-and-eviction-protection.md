---
id: OAB-10.1
title: Add plugin coexistence mode and eviction protection
status: In Progress
assignee: []
created_date: '2026-11-05T12:48:00Z'
updated_date: '2026-11-05T14:21:00Z'
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
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Baseline before implementation: bun run check passed at main dbb0481 in the isolated Orca worktree, exit 0. No product code changed. Plan approval remains pending.

Owner decision: Place the coexistence confirmation type and schema in the existing DeviceState exports in packages/protocol/src/index.ts. This replaces the earlier append-only constraint for these two exports so Biome passes. No other exports changed. Reconcile with origin/main at 7abee2c found no competing index exports.

Round-1 review fix: CoexistenceEffectFence blocks later publication, reconciliation writes, and local apply effects after destructive capture. In-flight effects can finish. AC-19 evidence and independent branch review remain pending.
<!-- SECTION:NOTES:END -->
