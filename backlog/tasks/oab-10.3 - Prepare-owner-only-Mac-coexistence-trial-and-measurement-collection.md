---
id: OAB-10.3
title: Prepare owner-only Mac coexistence trial and measurement collection
status: To Do
assignee: []
created_date: '2026-11-05T12:48:00Z'
updated_date: '2026-11-05T12:52:00Z'
labels: []
dependencies:
  - OAB-10.2
documentation:
  - docs/spec.md
parent_task_id: OAB-10
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The supervisor performs real-vault steps for the owner. Agents and subagents never access the real vault. This task ships supervisor instructions and service-only measurement collection tooling for the bounded F4 trial. Scope: spec §7.10, §11.5, §12, and §14. Read OAB-10 standing authorizations and the relayed dated-copy confirmation before work. Trial observations belong in OAB-10 notes, not evidence documents.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Instructions record supervisor-relayed confirmation of a dated local copy outside iCloud before any real-vault step. The supervisor performs these steps for the owner. Agents never access the real vault.
- [ ] #2 Instructions cover supervisor installation for the owner, coexistence mode, Mac-only operation, and a trial duration of at most two weeks.
- [ ] #3 Collection tooling uses service data only and cannot inspect or change the personal vault. Tests cover this boundary and secret-safe output.
- [ ] #4 Instructions explain attention review, measurements, Pause, empty-queue exit, and supervisor disable or cutover for the owner without cloud resource changes.
- [ ] #5 The deliverables do not claim completion of the owner trial. OAB-10 retains trial dates, results, attention explanations, and evidence limits.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Authorization update, 2026-11-05: The supervisor performs the real-vault steps for the owner, including installation and enablement when this task is ready. The supervisor relayed dated-copy confirmation. Read OAB-10 Standing authorizations for F4 before work. Owner-manual wording in this task includes this authorized supervisor. Agents and subagents still never access the real vault.
<!-- SECTION:NOTES:END -->
