---
id: OAB-16
title: Sync .obsidian settings categories
status: In Progress
assignee: []
created_date: 2026-10-12 15:14
updated_date: '2026-11-07T00:59:00Z'
labels:
  - deferred
  - trigger-based
dependencies: []
documentation:
  - docs/spec.md
ordinal: 16000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Deferred per docs/spec.md §16 because settings are not needed to replace iCloud for content. Seam: scope is a pattern list. Reopen when manual re-configuration becomes a daily cost.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A default-off Sync settings categories setting has appearance, core, and community plugin switches. The scope matches the owner brief.
- [ ] #2 Workspace JSON, AI Bridge files, cache paths, graph.json, and plugin node_modules remain excluded with every switch combination.
- [ ] #3 Raw events capture local unindexed settings changes. Tests and the Mac dev vault prove capture.
- [ ] #4 Adapter apply preserves exact-revision guards and conflict copies. Documentation explains plugin data and enabled-list reload needs.
- [ ] #5 First enable publishes local settings as ordinary creates. Different receiving-device settings survive as conflict copies.
- [ ] #6 The owner proves that desktop-only plugins remain harmless on mobile after release.
- [ ] #7 Spec sections 7.1 and 16 list settings categories and exclusions, and record the 2026-11-06 trigger and move to section 7.1.
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
<!-- SECTION:NOTES:END -->
