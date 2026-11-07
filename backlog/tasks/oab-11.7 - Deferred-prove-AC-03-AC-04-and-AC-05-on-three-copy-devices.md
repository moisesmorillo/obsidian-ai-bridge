---
id: OAB-11.7
title: 'Deferred: prove AC-03 AC-04 and AC-05 on three copy devices'
status: To Do
assignee: []
created_date: '2026-11-05T23:21:00Z'
updated_date: '2026-11-07T00:12:00Z'
labels:
  - F5
  - Deferred
dependencies: []
parent_task_id: OAB-11
type: task
ordinal: 67000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Trigger: F4 closes, release artifacts exist, prior mobile compatibility and tooling drafts pass, and the owner approves the copy-only trial. F5 needs independent Mac, iPhone, and iPad evidence. A local copy alone does not isolate the shared service vault.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 BRAT installs one identified release on iPhone and iPad. Records include app, OS, plugin version, and artifact identity.
- [ ] #2 AC-03 preserves both offline edits and converges the authoritative note plus one conflict copy on all three devices.
- [ ] #3 AC-04 preserves the tombstone and offline bytes in a conflict copy on all three devices. The original enters Obsidian trash.
- [ ] #4 AC-05 converges Y and a Y conflict copy on all devices. X stays absent. Links change only on the rename origin.
- [ ] #5 Each mobile device serves as an offline editor. Both publisher orders and a third-device catch-up are tested.
- [ ] #6 An offline iPhone edit survives app restart and resolves after network return.
- [ ] #7 No real-vault access follows from this result. That step needs separate explicit owner authorization.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Promoted at F4 closure, 2026-11-06. DRAFT-4 still needs isolated service authority from the owner. DRAFT-5 still needs the BRAT release plugin-v0.1.0 and devices.

Device evidence 2026-11-06 (supervisor, Mac plus one iPhone, plugin 0.1.2): online round trip of a note in both directions, online delete from the iPhone with the Mac tombstone, and one offline iPhone edit against a concurrent Mac edit that produced the authoritative Mac revision at the path and a visible conflict copy named with the iPhone device on both devices. No data loss. These runs used the shared service and a fresh local iPhone vault. They are partial evidence for criteria 2 and 6 and no evidence for the three-device, tombstone-with-offline-bytes, rename and restart cases. Criteria stay unchecked until an iPad joins and the exact scripts run.

Device evidence 2026-11-06 evening: three devices enrolled (Mac real vault, iPhone local vault, iPad local vault), all on plugin 0.1.3. A note created on the iPad (ipad-test-1.md) reached the Mac (51 files) and the iPhone without any action on them: third-device catch-up evidenced for an online create. The exact AC-03, AC-04 and AC-05 scripts with three devices did not run. The owner may close F5 with this real-use evidence as a recorded waiver (see OAB-12 decomposition).
<!-- SECTION:NOTES:END -->
