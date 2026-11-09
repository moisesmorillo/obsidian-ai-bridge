---
id: OAB-12
title: F6 Cutover delivery gate
status: Done
assignee: []
created_date: 2026-10-12 15:13
updated_date: '2026-11-09T21:26:00Z'
labels:
  - phase-gate
  - F6
dependencies:
  - OAB-11
documentation:
  - docs/spec.md
type: task
ordinal: 12000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Track F6 against docs/spec.md §14. The supervisor reports completed Mac cutover at about 2026-11-07T00:20Z on owner order. The owner selected a dated zip plus the frozen iCloud vault as backup. Remaining work records the F5 closure decision and backup choice, watches daily use, and defers Cloudflare-native backup. Exit conditions remain unchecked until the supervisor supplies all evidence.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 F5 is complete and the owner decision on a backup (OAB-9) is recorded before cutover.
- [ ] #2 Cutover exit conditions are evidenced.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Owner scope change, 2026-11-07: record executed cutover in gate notes instead of future runbook tasks. Keep OAB-12.3 for F5 closure and backup records, OAB-12.6 for the seven-day watch, and OAB-12.7 Deferred. Include remaining three-device checks in the watch. Keep gate criteria unchecked. Run repository checks before the PR.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reconciled after merged F0: this is a committed section14 phase entry/exit gate, not a trigger-based deferred feature or an implementation task. Its original acceptance cases and dependency edges are unchanged. Dependency readiness only permits selection for research and decomposition; it does not authorize implementation, deployment or personal-vault access.

Owner decision 2026-11-05: the fresh verified export and the rehearsal restore leave the entry and exit conditions. The backup decision moves to OAB-9 before F6.

F6D scope, 2026-11-06:
- Backlog only. No agent vault access, live service test, or Cloudflare change.
- The owner authorizes F5 copy-vault work through the supervisor.
- The proposed cutover is Tuesday 2026-11-10 if the weekend stays quiet.
- In Progress means decomposition, not cutover authorization.
- Entry decisions remain open in OAB-12.3.

Supervisor and owner evidence, 2026-11-06:
- Plugin 0.1.3 (ai-bridge-v0.1.3) runs on the Mac real iCloud vault with coexistence on.
- iPhone and iPad use local vaults. Worker main 582d678 is deployed.
- Enrollment works through the authorization link and Access PIN.
- Note create, rename, edit, and delete work in both directions.
- An offline edit against a concurrent edit leaves a visible conflict copy.
- An image attachment from the iPhone works.
- An offline iPhone edit survives force-quit.
- An iPad note reaches Mac and iPhone.
- iPad use through Tailscale works after the read-slot fix.
- Fixed defects: mobile browser launch (PR #74), remote rename echo (PR #76), and read-slot hold deadline (PR #79 and #82).
- This newer report supersedes earlier no-iPad and missing-attachment limits. It does not prove the exact OAB-11.7 scripts.

Limits, 2026-11-06:
- No iCloud placeholder proof, no restore proof, and no Cloudflare-native backup.
- Placeholder proof does not apply after cutover because no live vault stays in iCloud.
- The 2026-11-05 owner decision states no backup export in v1.
- The before-F6 backup choice stays open under spec §11 and §16 and OAB-9.
- OAB-12.3 must record the F5 waiver and backup choice before cutover.
- OAB-12.7 records only the requested after-cutover backup trigger.
- Both gate criteria stay unchecked.

Task id allocation:
- Another active worktree owns OAB-12.2 for Worker deploy preflight.
- The CLI assigns OAB-12.3 through OAB-12.7 instead of the brief numbers.
- Order: OAB-12.3 decisions, OAB-12.4 Mac runbook, OAB-12.5 device checks, OAB-12.6 watch, and OAB-12.7 deferred backup.
- No foreign task changes. The parent OAB-11 dependency and both unchecked gate criteria remain unchanged.

Owner order and supervisor execution report, about 2026-11-07T00:20Z:
- The owner ordered cutover today, not Tuesday 2026-11-10.
- The owner selected backup: dated zip plus frozen iCloud vault.
- The supervisor made a fresh dated zip.
- The supervisor disabled the plugin in the iCloud vault at cursor 200.
- The new local Mac vault sits outside iCloud and hydrated 51 files from the service.
- All file hashes match the iCloud copy.
- A new client enrolled with coexistence off. The supervisor did not supply its client id.
- The iCloud vault stays frozen as a copy.
- These are supervisor-reported facts, not agent observations. No agent accessed the vault.

This report supersedes the proposed Tuesday date, future Mac runbook, and open backup-choice statements above.
The F5 closure waiver still needs an explicit record. Do not infer the exact OAB-11.7 scripts passed.
Keep both gate criteria unchecked. No restore proof or seven-day watch proof follows from cutover.

Revised decomposition:
- OAB-12.3 records F5 closure and the backup choice that the owner already made.
- OAB-12.6 watches seven days of daily use, including the remaining three-device convergence check.
- OAB-12.7 stays Deferred with trigger: owner request after cutover.
- Remove unpublished OAB-12.4 and OAB-12.5. Do not schedule completed cutover steps again.
- Keep the dated zip and frozen copy for 30 days from cutover, through at least 2026-12-07T00:20Z.
- The rollback rule remains: preserve later edits, pause all bridge clients, and reopen the frozen iCloud vault with its plugin disabled.
- Keep one sync owner per restored live vault. The frozen copy lacks post-cutover edits.

Owner and supervisor report, 2026-11-06 (local UTC-6), recorded after cutover.

These are reported observations, not new agent tests.

The owner accepts real use on Mac, iPhone, and iPad instead of the exact OAB-11.7 scripts for F5 closure.

The scripts did not run.

The owner selected a dated zip plus the frozen iCloud vault before cutover.

Keep both for 30 days, through at least 2026-12-07T00:20Z.

The frozen copy lacks later edits and service revision history.

No zip restore test or Cloudflare-native backup exists.

OAB-12.7 stays Deferred until the owner selects a design.

Reported cutover at about 2026-11-07T00:20Z:
- A fresh dated zip was made outside iCloud.
- The plugin in the iCloud vault was disabled at cursor 200 with empty queues.
- A new local Mac vault outside iCloud hydrated 51 files.

All 51 hashes matched the iCloud copy.
- New client Mac enrolled with coexistence off through the Orca internal browser, without a PIN.
- The iCloud vault stays frozen.

Test vaults were removed from the Mac and their clients revoked.
- The owner console now has three active clients: Mac, iPhone, and iPad.
This record follows the reported cutover.

It supersedes earlier open-waiver, open-backup-choice, and unchecked-AC1 statements.

AC1 is checked under the owner waiver and backup choice.

AC2 stays unchecked for OAB-12.6.

One day does not prove seven successful days.

Owner decision 2026-11-09: close the F6 gate. The watch in OAB-12.6 closed by owner decision. The Vaultwire cutover (OAB-50.6) moved all clients to vaultwire.mmorillo.dev with verified data. Criterion 2 stays unchecked because the seven-day watch did not complete.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
F6 closed by owner decision. Production runs on Vaultwire with Mac, iPhone, iPad and ChatGPT connected.
<!-- SECTION:FINAL_SUMMARY:END -->
