---
id: OAB-6.9
title: Verify F1 server acceptance without claiming client qualification
status: To Do
assignee: []
created_date: '2026-10-15 00:38'
updated_date: '2026-10-15 00:41'
labels:
  - F1
dependencies:
  - OAB-6.8
documentation:
  - docs/spec.md
parent_task_id: OAB-6
type: task
ordinal: 32000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The section 14 F1 exit list includes scenarios with both server and plugin assertions. The phase needs traceable tests against actual Worker/DO behavior, not synthetic client implementations that accidentally qualify offline apply or conflict copies before F3.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every named F1 acceptance case maps to executable real Worker/DO assertions and an explicit statement of the portion actually proven; omissions block phase closure.
- [ ] #2 Client-only portions such as base advancement, stale-feed no-ops and local conflict copies remain visibly unqualified until real plugin tests; any required section 14 gate interpretation is explicitly approved before OAB6 is closed.
- [ ] #3 Default-deny authentication boundaries, canonical protocol contracts, all existing tests, full bun run check and actual remote CI pass on the reviewed final head.
- [ ] #4 OAB6 closes only with objective exit evidence and applicable explicit owner authorizations; no document or passing foundation test substitutes for product acceptance.
<!-- AC:END -->
