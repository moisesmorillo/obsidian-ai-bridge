---
id: OAB-11.3
title: 'Deferred: verify iOS placeholder safety in copy vaults'
status: Deferred
assignee: []
created_date: '2026-11-05T23:21:00Z'
updated_date: '2026-11-07T13:02:00Z'
labels:
  - F5
  - Deferred
dependencies: []
parent_task_id: OAB-11
type: task
ordinal: 63000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Trigger: the owner approves isolated iCloud copy-vault tests after F4. Current detection recognizes two .icloud filename forms only. iOS File Provider event and metadata behavior remain unknown. No personal-vault or shared-service fixture action is authorized.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Records show native iOS and iPadOS eviction, hydration, metadata, and event order without source content.
- [ ] #2 Unavailable files publish no delete or rename without the existing exact-revision confirmation contract.
- [ ] #3 Fixtures cover filename placeholders, absent files without placeholders, read failures, hydration races, and restart.
- [ ] #4 Any native behavior outside current detection has a failing test before a scoped correction.
- [ ] #5 Mobile coexistence policy is explicit before any real-vault proposal.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Promoted at F4 closure, 2026-11-06. DRAFT-4 still needs isolated service authority from the owner. DRAFT-5 still needs the BRAT release plugin-v0.1.0 and devices.

Owner and supervisor report, 2026-11-06 (local UTC-6), recorded after cutover.

These are reported observations, not new agent tests.

Not applicable after cutover: no device keeps an iCloud vault as a live vault.

The iCloud vault remains frozen as a backup copy.

No placeholder behavior is proven.

Trigger: a device keeps an iCloud vault.

Keep this task Deferred and all criteria unchecked.

Not applicable 2026-11-07: no device keeps an iCloud vault after the F6 cutover. The iCloud vault is frozen with the plugin disabled. Archived. Restore if a device enrolls an iCloud vault again.
<!-- SECTION:NOTES:END -->
