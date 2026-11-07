---
id: OAB-11.7
title: 'Deferred: prove AC-03 AC-04 and AC-05 on three copy devices'
status: Done
assignee: []
created_date: '2026-11-05T23:21:00Z'
updated_date: '2026-11-07T03:35:00Z'
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
- [x] #6 An offline iPhone edit survives app restart and resolves after network return.
- [x] #7 No real-vault access follows from this result. That step needs separate explicit owner authorization.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Promoted at F4 closure, 2026-11-06. DRAFT-4 still needs isolated service authority from the owner. DRAFT-5 still needs the BRAT release plugin-v0.1.0 and devices.

Device evidence 2026-11-06 (supervisor, Mac plus one iPhone, plugin 0.1.2): online round trip of a note in both directions, online delete from the iPhone with the Mac tombstone, and one offline iPhone edit against a concurrent Mac edit that produced the authoritative Mac revision at the path and a visible conflict copy named with the iPhone device on both devices. No data loss. These runs used the shared service and a fresh local iPhone vault. They are partial evidence for criteria 2 and 6 and no evidence for the three-device, tombstone-with-offline-bytes, rename and restart cases. Criteria stay unchecked until an iPad joins and the exact scripts run.

Device evidence 2026-11-06 evening: three devices enrolled (Mac real vault, iPhone local vault, iPad local vault), all on plugin 0.1.3. A note created on the iPad (ipad-test-1.md) reached the Mac (51 files) and the iPhone without any action on them: third-device catch-up evidenced for an online create. The exact AC-03, AC-04 and AC-05 scripts with three devices did not run. The owner may close F5 with this real-use evidence as a recorded waiver (see OAB-12 decomposition).

Owner and supervisor report, 2026-11-06 (local UTC-6), recorded after cutover.

These are reported observations, not new agent tests.

The owner accepts real use on Mac, iPhone, and iPad instead of the exact OAB-11.7 scripts for F5 closure.

The scripts did not run.

Real-use evidence:
- Enrollment on iPhone and iPad used the authorization link and Access PIN.
- Note create, rename, edit, and delete worked in both directions.
- An offline iPhone edit against a concurrent Mac edit converged with a visible conflict copy on all three devices.
- An iPhone image reached the Mac with identical bytes.
- An offline iPhone edit survived force-quit and published after reconnection.
- An iPad note reached Mac and iPhone.

Tailscale sync worked after PR #79 and #82.
- Settings sync ran on three devices in 0.1.4.

Attention dismissal and the Open fix shipped in 0.1.5, PR #88.
The owner cutover order is separate authorization for real-vault use.

This closure grants no new agent vault access.
Limits for unchecked criteria:
- AC1: released artifacts exist, but complete app/OS and per-device artifact records are absent.
- AC2: real-use conflicts converged on three devices, but the exact AC-03 script did not run.
- AC3: the exact AC-04 tombstone, offline bytes, and trash script did not run.
- AC4: the exact AC-05 rename, offline conflict, and origin-only link script did not run.
- AC5: both mobile offline editors and both publisher orders lack script proof.
Other limits: no Android, no near-25 MB device transfer, no zip restore test, and no production read-slot stall observation.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed by the explicit owner waiver recorded after cutover. Real-use evidence replaces the exact scripts for gate closure only. AC1 through AC5 remain unchecked.
<!-- SECTION:FINAL_SUMMARY:END -->
