---
id: OAB-11.6
title: 'Deferred: add guarded three-device acceptance tooling'
status: Done
assignee: []
created_date: '2026-11-05T23:21:00Z'
updated_date: '2026-11-07T13:06:00Z'
labels:
  - F5
  - Deferred
dependencies: []
parent_task_id: OAB-11
type: task
ordinal: 66000
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Promoted at F4 closure, 2026-11-06. DRAFT-4 still needs isolated service authority from the owner. DRAFT-5 still needs the BRAT release plugin-v0.1.0 and devices.

Owner and supervisor report, 2026-11-06 (local UTC-6), recorded after cutover.

These are reported observations, not new agent tests.

The F5 real-use waiver does not build guarded acceptance tooling.

It still needs isolated service authority and named disposable vaults.

Keep To Do without live-service authority.

Owner waiver 2026-11-07: three devices (Mac, iPhone, iPad) run the plugin in daily use after the F6 cutover. The owner closes this tooling task as not needed. Criteria stay unchecked by evidence.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed by owner waiver: three devices in daily use replace guarded acceptance tooling.
<!-- SECTION:FINAL_SUMMARY:END -->
