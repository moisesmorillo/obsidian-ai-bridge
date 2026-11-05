---
id: DRAFT-4
title: 'Deferred: add guarded three-device acceptance tooling'
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
Trigger: F4 closes and the owner approves an isolated service authority plus named Mac, iPhone, and iPad copy vaults. The current driver admits two desktop vaults only. F5 needs native mobile control without direct private callback injection.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The driver rejects unknown vaults and the current F4 service authority before a mutation.
- [ ] #2 A third-device target uses mobile host identity, not desktop getBasePath assumptions.
- [ ] #3 Native consent, network isolation, app suspension, reload, and UI rename have bounded phase results.
- [ ] #4 Results contain allowlisted client IDs, times, counts, revisions, and pass or fail states without tokens, cookies, owner subjects, or raw bodies.
- [ ] #5 Missing device automation reports a named blocker without weakening the vault guard.
- [ ] #6 Automated tests cover wrong-target rejection, timeouts, uncertain effects, and cleanup limits.
<!-- AC:END -->
