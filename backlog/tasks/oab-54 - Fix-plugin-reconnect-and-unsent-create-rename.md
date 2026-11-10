---
id: OAB-54
title: Fix plugin reconnect and unsent create rename
status: Done
assignee:
  - '@pi'
created_date: '2026-11-10T00:06:00Z'
updated_date: '2026-11-10T01:10:00Z'
labels: []
dependencies: []
type: bug
ordinal: 94000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner brief R4 reports a status Reconnect button without an authorization link on mobile and false attention after a quick create and rename. Scope stays inside apps/plugin. No vault access or deployment. R3 changes Worker code in parallel.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Connect and Reconnect share the authorization action, link display, status messages, generation fence, and visible errors.
- [x] #2 Unsent creates follow local renames without false attention, content loss, or a remote delete for an absent server path.
- [x] #3 Tests cover create then rename, rename then edit, rename after a sent put, and an empty note renamed at once.
- [x] #4 Sent and uncertain operations keep safe immutable retry handling. bun run check passes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Plan gate: /private/tmp/r4-plugin-fixes-plan.md. Extract one settings connection action for Connect and Reconnect with generation checks and safe errors. Reconcile proven unsent absent-source creates during rename, with durable destination bytes before source retirement. Keep sent operations unchanged. Add regression tests first, run bun run check, complete task and branch reviews, rebase on main, and open a pull request. No vault access or deployment.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reviewed implementation revision 42dc813. Settings and main share one connection action with safe errors and generation fences. Publication and journal tests cover unsent, sent, empty, repeated rename, restart, storage failure, binary bytes, and exact destination revision. Initial task review test gap closed in 885f154. Final review findings F1 and F2 closed in 42dc813. Scoped review approved both corrections. Owner approved branch review pn-d7460d without changes. Documentation scope: changed named declarations and surrounding caller contracts. Publication and journal remain cohesive policy and persistence owners. Validation: 147 focused tests, docs:check, and full bun run check passed. Full check reports 869 plugin tests passed, one skipped, and 15 existing Worker lint warnings. Local tests do not prove iPhone or iPad browser behavior. No vault access or deployment.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Fixed shared Connect and Reconnect authorization controls. Unsent creates now follow local renames through verified durable queue replacement. Exact destination revisions and binary bytes remain intact. Regression tests and bun run check passed. Independent reviews and owner branch review approved. Real mobile browser behavior remains untested.
<!-- SECTION:FINAL_SUMMARY:END -->
