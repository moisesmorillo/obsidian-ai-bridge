---
id: OAB-54
title: Fix plugin reconnect and unsent create rename
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-10T00:06:00Z'
updated_date: '2026-11-10T00:07:00Z'
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
- [ ] #1 Connect and Reconnect share the authorization action, link display, status messages, generation fence, and visible errors.
- [ ] #2 Unsent creates follow local renames without false attention, content loss, or a remote delete for an absent server path.
- [ ] #3 Tests cover create then rename, rename then edit, rename after a sent put, and an empty note renamed at once.
- [ ] #4 Sent and uncertain operations keep safe immutable retry handling. bun run check passes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Plan gate: /private/tmp/r4-plugin-fixes-plan.md. Extract one settings connection action for Connect and Reconnect with generation checks and safe errors. Reconcile proven unsent absent-source creates during rename, with durable destination bytes before source retirement. Keep sent operations unchanged. Add regression tests first, run bun run check, complete task and branch reviews, rebase on main, and open a pull request. No vault access or deployment.
<!-- SECTION:PLAN:END -->
