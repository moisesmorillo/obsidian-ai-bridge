---
id: OAB-30
title: Use a valid timestamp for hydration conflict copy names
status: Deferred
assignee: []
created_date: '2026-10-29T12:16:00Z'
labels:
  - deferred
dependencies: []
references:
  - apps/plugin/src/sync/reconciliation.ts
  - apps/plugin/src/sync/text-apply.ts
documentation:
  - docs/spec.md
type: bug
ordinal: 48000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner deferred this OAB-8.4 review item. Trigger: conflict names become user visible. Manifest application currently uses at: 0, so hydration conflict copies contain a 1970 date. Preserve stable names across restart and keep every visible copy.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Hydration conflict copy names use a meaningful timestamp instead of the Unix epoch
- [ ] #2 Restart retains the same persisted conflict name and does not create duplicate copies
- [ ] #3 Tests cover hydration conflict naming and interrupted copy recovery
<!-- AC:END -->
