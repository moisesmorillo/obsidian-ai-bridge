---
id: DRAFT-5
title: 'Deferred: prove AC-03 AC-04 and AC-05 on three copy devices'
status: Draft
assignee: []
created_date: '2026-11-05T23:21:00Z'
labels:
  - F5
  - Deferred
dependencies: []
parent_task_id: OAB-11
type: task
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
