---
id: OAB-12.3
title: Record the F5 closure waiver and cutover backup decision
status: Done
assignee:
  - '@pi'
created_date: '2026-11-07T00:14:00Z'
updated_date: '2026-11-07T03:39:00Z'
labels:
  - F6
dependencies: []
references:
  - OAB-11
  - OAB-11.7
  - OAB-9
documentation:
  - docs/spec.md
parent_task_id: OAB-12
ordinal: 71000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The supervisor reports Mac cutover at about 2026-11-07T00:20Z on owner order. The owner already selected a dated zip plus the frozen iCloud vault as backup. Record that decision, not another backup selection or another cutover authorization.

F5 closure still needs an explicit owner waiver for the exact OAB-11.7 scripts. Use the reported 2026-11-06 real-use evidence without claiming those scripts passed.

The frozen copy lacks later edits and service revision history. Keep it and the zip for 30 days from cutover. No service restore proof or Cloudflare-native backup exists.

This task records decisions only. It grants no agent access to the personal vault. See OAB-9 and docs/spec.md §11, §14 F6, and §16.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The owner F5 closure decision has a date and states the waiver for the exact OAB-11.7 scripts.
- [x] #2 OAB-11 records the closure decision. OAB-11.7 keeps unproven script cases unchecked and states the waiver scope.
- [x] #3 OAB-12 and OAB-9 record the owner backup choice: dated zip plus frozen iCloud vault, selected before the reported cutover.
- [x] #4 The backup record states 30-day retention through at least 2026-12-07T00:20Z and the frozen copy limits.
- [x] #5 The record distinguishes the reported cutover at about 2026-11-07T00:20Z from later documentation. It does not invent an earlier F5 closure.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read each named task and map the owner report to its criteria.
2. Append dated evidence, the F5 waiver, cutover decisions, and explicit limits through the CLI.
3. Check only supported criteria, except the explicit OAB-11 gate waiver. Preserve unproven scripts as unchecked.
4. Review each task and the complete Backlog diff. Run bun run check.
5. Rebase on origin/main, push, create one PR, and remove the worktree.

Owner decisions
- Follow the unattended overnight order without Plannotator gates.
- Use the supplied supervisor and owner reports as attributed evidence, not new agent observations.
- Keep incomplete compound device criteria unchecked. Done records accepted closure, not proof of every case.
- No product changes or new tests. RED/GREEN does not apply to this records-only scope.
- Preserve all existing notes. Add current decisions after historical statements.
- Do not change tasks that other sessions own.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner and supervisor report, 2026-11-06 (local UTC-6), recorded after cutover.

These are reported observations, not new agent tests.

The owner accepts real use on Mac, iPhone, and iPad instead of the exact OAB-11.7 scripts for F5 closure.

The scripts did not run.

The owner selected a dated zip plus the frozen iCloud vault before cutover.

Keep both for 30 days, through at least 2026-12-07T00:20Z.

The frozen copy lacks later edits and service revision history.

No zip restore test or Cloudflare-native backup exists.

OAB-12.7 stays Deferred until the owner selects a design.

OAB-11 records gate closure and the separate owner cutover authorization.

OAB-11.7 preserves unproven script criteria.

OAB-12 and OAB-9 record the selected backup.
The supervisor reports cutover at about 2026-11-07T00:20Z.

This later record does not claim F5 closure preceded cutover.

No agent accessed a vault or tested the service.

Task review: APPROVE for all 19 task changes against 877d037. No actionable finding remains. Documentation scope covers the changed Backlog records. No TypeScript, executable configuration, or structural candidate changed.

bun run check passed with exit 0: 2180 tests passed, one skipped, and no failures. Lint, documentation checks, typechecks, tests, and builds passed. Worker build used dry-run only.

Scope assertions passed for 19 task states and the named checked criteria. git diff --check passed. Unsupported script and compound criteria remain unchecked. No device or service observation occurred in this session.

Whole-branch review: APPROVE at 476a1a8 against origin/main 877d037. The reviewer examined all 19 resulting task records, criteria, dates, retention, and edit boundaries. No actionable finding remains. No implementation structural candidate applies. The reviewer used the parent check results and did not repeat the suite. Human review gates do not apply under the unattended owner order.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Recorded the dated F5 waiver and the backup choice made before reported cutover. Retention lasts through at least 2026-12-07T00:20Z. Restore and seven-day watch proof remain open.
<!-- SECTION:FINAL_SUMMARY:END -->
