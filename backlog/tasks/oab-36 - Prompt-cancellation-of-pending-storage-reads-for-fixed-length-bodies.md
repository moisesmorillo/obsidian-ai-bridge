---
id: OAB-36
title: Prompt cancellation of pending storage reads for fixed-length bodies
status: Deferred
assignee: []
created_date: '2026-11-04T04:11:00Z'
updated_date: '2026-11-04T04:53:00Z'
labels: []
dependencies: []
references:
  - OAB-35
type: enhancement
ordinal: 57000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
FixedLengthStream exposes consumer cancellation at the next write, not while a storage read waits. OAB-35 joins that read before cleanup and slot release. Trigger: workerd exposes a writer-side cancellation signal, or request abort proves reliable on client disconnect. Revisit prompt source cancellation only after one trigger occurs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Evidence confirms a supported early cancellation signal without loss of native Content-Length.
- [ ] #2 Tests prove pending storage reads and cleanup settle before slot reuse, including unknown cancellation failures.
- [ ] #3 Full and range responses keep exact bytes and native fixed-length framing.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
OAB-35 implements the approved next-write cancellation rule and keeps this task Deferred. The final Worker body uses FixedLengthStream. Pending source reads settle before source cancellation and slot release. The complete route direct-socket probe passed for full and range responses. Revisit this task only when its stated trigger occurs.
<!-- SECTION:NOTES:END -->
