---
id: OAB-12.6
title: Watch daily use for seven days after cutover
status: Done
assignee: []
created_date: '2026-11-07T00:15:00Z'
updated_date: '2026-11-09T21:26:00Z'
labels:
  - F6
dependencies: []
documentation:
  - docs/spec.md
parent_task_id: OAB-12
ordinal: 74000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A one-time convergence check cannot prove stable daily use. The supervisor checks normal use once daily for seven days after cutover. Each daily check takes one sitting. Record dates, client ids, times, and counts of attention items, confirmations, and failures. Keep private details outside Backlog.

Stop rule: stop bridge use for missing content, unexplained hash differences, lost edits, persistent divergence, or unresolved attention items, confirmations, or failures. Pause the plugin on all three devices before rollback. Preserve post-cutover local edits separately before any change of sync ownership. Reopen the frozen iCloud vault with its bridge plugin disabled. Confirm iCloud as the sole sync owner for any restored live vault. Never enable both writers. The frozen copy holds pre-cutover state only and lacks later edits. The supervisor and owner reconcile later edits separately. A rollback ends the successful watch. Do not count it as seven successful days.

Keep the frozen folder and dated zip for at least 30 days from cutover, except an owner-directed rollback. No agent executes these steps.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Seven dated daily entries show supervisor checks for attention items, confirmations, and failures on all three devices.
- [ ] #2 Each entry records check times and alert counts without private file details or credentials.
- [ ] #3 Any stop condition stops bridge use and records the time and client ids. The supervisor pauses all three clients before rollback.
- [ ] #4 For rollback, the supervisor preserves later local edits and reopens the frozen iCloud vault with its bridge plugin disabled.
- [ ] #5 The rollback check confirms one sync owner per restored live vault. Later edits need separate owner review before reconciliation.
- [ ] #6 A successful seven-day watch ends without unresolved alerts or rollback. A failed watch stays incomplete with the owner decision recorded.
- [ ] #7 The frozen copy and zip remain available for the 30-day retention period, except an owner-directed rollback.
- [ ] #8 The first watch check verifies one sync owner and coexistence off on all three local vaults. Each device sends one note change to both others.
- [ ] #9 The supervisor records missing client ids when available. The record does not claim cutover steps need execution again.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Watch start: reported cutover at about 2026-11-07T00:20Z. Daily checks remain open. The completed Mac cutover and backup facts belong to OAB-12 notes. No daily check or three-device post-cutover convergence proof comes from that report.

Owner and supervisor report, 2026-11-06 (local UTC-6), recorded after cutover.

These are reported observations, not new agent tests.

Day 1, local 2026-11-06 to 2026-11-07: no unexplained attention was reported.

Cursor 262 and 47 files remained after the owner's test cleanup.

Old attention items were dismissed on both mobiles after 0.1.5, PR #88.
Limits: the report gives no exact daily check time, client IDs, or separate confirmation/failure counts for every device.

It does not prove seven days, all-device post-cutover exchange, rollback, or completed retention.

All criteria stay unchecked.

Keep In Progress.

Owner decision 2026-11-08: the three-device convergence check in AC #8 is covered by the F5 real-use evidence in OAB-12 notes (iPad note reaches Mac and iPhone, iPhone attachment and offline edit, Mac daily use). No new scripted check is needed. The supervisor records daily Mac checks and the owner reports mobile observations. Days 1 to 3 (2026-11-06 to 2026-11-08): no attention, no confirmations, no failures on Mac. Cursor 268, 47 files, hourly backups present.

Owner decision 2026-11-09: the owner closed the seven-day watch before day seven. The owner reports problems directly instead of daily supervisor checks. The Vaultwire cutover on 2026-11-09 replaced the watched service. Unchecked criteria were not proven and stay unchecked. No stop condition and no rollback occurred.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed by owner decision on 2026-11-09 without seven daily entries. No stop condition or rollback occurred. The owner reports later problems directly.
<!-- SECTION:FINAL_SUMMARY:END -->
