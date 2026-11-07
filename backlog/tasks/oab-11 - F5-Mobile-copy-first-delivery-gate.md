---
id: OAB-11
title: F5 Mobile copy-first delivery gate
status: Done
assignee: []
created_date: 2026-10-12 15:13
updated_date: '2026-11-07T03:35:00Z'
labels:
  - phase-gate
  - F5
dependencies:
  - OAB-10
documentation:
  - docs/spec.md
type: task
ordinal: 11000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Track F5 against docs/spec.md §14. Intent-only; research/decompose when selected; no implementation plan authorized now. Install via BRAT on iPhone/iPad against a copy of vault before real vault. Exit AC-03/04/05 across three devices; record secretStorage behavior per platform; offline iPhone edit resolves correctly. Real-vault use requires separate explicit owner authorization.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 F4 is complete before F5 starts.
- [x] #2 Copy-vault mobile tests and all §14 exit cases pass before any real-vault test.
- [x] #3 Any personal-vault access has separate explicit owner authorization.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reconciled after merged F0: this is a committed section14 phase entry/exit gate, not a trigger-based deferred feature or an implementation task. Its original acceptance cases and dependency edges are unchanged. Dependency readiness only permits selection for research and decomposition; it does not authorize implementation, deployment or personal-vault access.

F4C closure, 2026-11-06: owner merge of the closure PR approves promotion, not F5 execution. F5 prerequisites remain: owner tag plugin-v0.1.0 for the BRAT release, iPhone and iPad with copy vaults, and explicit F5 authorization. Live copy-vault writes also need isolated service authority. Promoted mapping and order: DRAFT-3 to OAB-11.3, DRAFT-1 to OAB-11.4, DRAFT-2 to OAB-11.5, DRAFT-4 to OAB-11.6, DRAFT-5 to OAB-11.7. The first three come before acceptance tooling and three-device proofs. Their existing triggers still apply. OAB-11 stays To Do. No tag, release, device action, service isolation, or personal-vault access occurs in this branch.

F5 device evidence, 2026-11-06, recorded by the supervisor. The owner started copy-vault use on a real iPhone with a fresh local vault, not the iCloud vault. Releases: plugin-v0.1.0 and plugin-v0.1.1 were published, then deleted on owner order after PR #75 renamed the tag scheme. ai-bridge-v0.1.2 (main fedd512) is the current release and the only remaining tag. The Mac real vault runs the same 0.1.2 build. Live results on 2026-11-06, Mac client e12MCRtYZ0t4tb0v and one iPhone client: enrollment through the Open authorization page link and the Access PIN (PR #74); note create, rename and edit from the iPhone reached the Mac (cursor 186 to 191) with zero confirmations after PR #76; a Mac edit reached the iPhone; an iPhone delete produced the Mac tombstone (cursor 191 to 192); an iPhone edit in airplane mode against a concurrent Mac edit converged to the Mac revision at the path plus a visible iPhone conflict copy on both devices (cursor 194). Limits: one iPhone only, no iPad, no attachments or images yet, no app restart during offline edit, no placeholder case. These results do not check the OAB-11.7 criteria, which need three devices and the exact AC-03, AC-04 and AC-05 scripts.

Owner and supervisor report, 2026-11-06 (local UTC-6), recorded after cutover.

These are reported observations, not new agent tests.

The owner accepts real use on Mac, iPhone, and iPad instead of the exact OAB-11.7 scripts for F5 closure.

The scripts did not run.

AC1: F4 closed before the reported F5 device use.
AC2: checked by the explicit owner waiver, not a claim that every section 14 exit script passed.

OAB-11.7 records unproven script cases.
AC3: the owner's separate cutover order explicitly authorized personal-vault use.

It grants no further agent access.
Reported cutover occurred at about 2026-11-07T00:20Z.

This closure record follows cutover and does not invent an earlier F5 closure.
Current releases: ai-bridge-v0.1.2, ai-bridge-v0.1.3, ai-bridge-v0.1.4, and ai-bridge-v0.1.5.

The plugin-v tags were deleted.

Worker main 877d037 is deployed.
Limits: no Android, no exact three-device scripts, no near-25 MB device transfer, no zip restore test, and no production read-slot stall observation.

Placeholder proof is not applicable after cutover.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
F5 closed under the explicit owner real-use waiver. The separate cutover order supplies personal-vault authorization. Unproven device cases remain explicit in child tasks.
<!-- SECTION:FINAL_SUMMARY:END -->
