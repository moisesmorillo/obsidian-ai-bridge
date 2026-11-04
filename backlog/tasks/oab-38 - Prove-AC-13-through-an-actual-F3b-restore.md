---
id: OAB-38
title: Prove AC-13 through an actual F3b restore
status: Deferred
assignee: []
created_date: '2026-11-04T18:04:00Z'
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

Trigger: F3b provides the real backup and restore flow, and the owner authorizes an epoch-changing restore of a disposable synthetic vault. Record the device baseline before that restore. No personal vault or current test-client enrollment authority follows from this task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An actual authorized restore changes the service epoch through the F3b restore flow.
- [ ] #2 Devices detect the new epoch and retain matching files without unnecessary writes.
- [ ] #3 Devices preserve different local bytes in visible conflict copies without an obsolete overwrite.
- [ ] #4 The ordered feed resumes with valid bases and no unexplained pending work.
<!-- AC:END -->
