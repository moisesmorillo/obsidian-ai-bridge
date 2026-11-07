---
id: OAB-38
title: Prove AC-13 through an actual F3b restore
status: Deferred
assignee: []
created_date: '2026-11-04T18:04:00Z'
updated_date: '2026-11-07T03:35:00Z'
labels:
  - deferred
  - F3b
dependencies: []
references:
  - OAB-8.8
  - OAB-9
  - apps/plugin/src/sync/reconciliation.ts
documentation:
  - docs/spec.md
priority: medium
type: task
ordinal: 58000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
OAB-8.8 passed controlled epoch reconciliation without changing the deployed service epoch. This does not prove recovery after an actual restore.

Trigger: a backup and restore flow exists (OAB-9, owner decision before F6) and the owner authorizes an epoch-changing restore of a disposable synthetic vault. Record the device baseline before that restore. No personal vault or current test-client enrollment authority follows from this task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An actual authorized restore changes the service epoch through the F3b restore flow.
- [ ] #2 Devices detect the new epoch and retain matching files without unnecessary writes.
- [ ] #3 Devices preserve different local bytes in visible conflict copies without an obsolete overwrite.
- [ ] #4 The ordered feed resumes with valid bases and no unexplained pending work.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner decision 2026-11-05: no backup export in v1, so no restore flow exists. The trigger now points to OAB-9.

Overnight decision, 2026-11-06 (local UTC-6): not started.

F3b is not built by owner decision, so an actual F3b restore flow does not exist.

Keep Deferred.
<!-- SECTION:NOTES:END -->
