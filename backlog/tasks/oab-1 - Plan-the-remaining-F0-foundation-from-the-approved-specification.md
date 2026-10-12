---
id: OAB-1
title: Plan the remaining F0 foundation from the approved specification
status: Done
assignee:
  - '@pi'
created_date: '2026-10-12 13:16'
updated_date: '2026-10-12 13:37'
labels:
  - planning
  - F0
dependencies: []
documentation:
  - docs/spec.md
type: docs
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The restarted repository contains the approved v1.3 specification, agent rules and Backlog configuration, but no executable implementation. Resume with a bounded F0 plan rather than reopening the design or planning the whole product at once. This task produces planning documents and tracking only; product implementation awaits owner review.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The plan distinguishes completed repository setup from remaining F0 deliverables and excludes F1-F6 implementation.
- [x] #2 Each code task names files, interfaces, failing tests, verification commands and its review gate.
- [x] #3 The owner can review the plan in Plannotator before any product code is written.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Contrast docs/spec.md with main and identify remaining F0 work. 2. Write docs/superpowers/plans/2026-10-12-f0-foundation.md covering OAB-2 through OAB-5, exact file boundaries, TDD loops and phase exclusions. 3. Self-review the plan against the frozen spec. 4. Open the plan in Plannotator and wait for owner feedback before product implementation.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Verified a clean documentation-only baseline at f4eb1ff. Owner chose a plan limited to remaining F0. Created OAB-2 through OAB-5 as unstarted work with dependency purposes and measurable acceptance criteria; no dependencies installed, code written, resources deployed or vault accessed. Plan awaits Plannotator review; no F0 completion claim.

Addressed Plannotator pn-ca44af annotations: added eight-stage delivery sequence and the next F1 planning step, distinguished spec/Backlog/plan/AGENTS/code authority, added per-constraint enforcement and evidence with explicit automation limits, and mapped plan tasks to OAB-2 through OAB-5. Feedback is not approval; implementation remains blocked pending owner review.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Produced the bounded remaining-F0 plan and OAB-2 through OAB-5 tracking tasks. Manually verified scope, file/interface/test/check/review definitions against spec sections 5.1 and 14-17; addressed all three owner annotations. Owner approved the revised plan in Plannotator pn-3ac54f and selected Superpowers subagent-driven execution. No executable baseline exists yet, so no product tests or F0 completion are claimed.
<!-- SECTION:FINAL_SUMMARY:END -->
