---
id: OAB-29
title: Classify delete feed rows without repeated manifest scans
status: Deferred
assignee: []
created_date: '2026-10-29T12:16:00Z'
labels:
  - deferred
dependencies: []
references:
  - apps/plugin/src/sync/reconciliation.ts
documentation:
  - docs/spec.md
type: bug
ordinal: 47000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner deferred this OAB-8.4 review item. Trigger: OAB-8.7 serialized loop implementation. Each delete currently scans the manifest from page one. A later recreate can make the historical delete produce misleading attention. Preserve obsolete revision and per-side safety rules.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Delete feed classification does not scan the manifest from page one for each row
- [ ] #2 A delete followed by recreate does not create misleading attention or overwrite the newer base
- [ ] #3 Tests cover inline text, unsupported blobs, obsolete deletes, and delete followed by recreate
<!-- AC:END -->
