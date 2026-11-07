---
id: OAB-47
title: 'Owner console redesign: Bordeaux and copper'
status: To Do
assignee: []
created_date: '2026-11-07T21:08:00Z'
labels:
  - worker
  - ui
  - F6
dependencies: []
priority: medium
ordinal: 83000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner order 2026-11-07: restyle every Worker HTML page with the approved design (direction F, Bordeaux and copper, Deep navy layout). Design canvas: https://claude.ai/artifact/KZQUbRknmconpgDCzMiWqb (owner only). Decisions: no Tailwind and no front-end dependency; one hand-written stylesheet with CSS custom properties embedded in the Worker as a string module and served inline in a <style> tag (CSP friendly, no external requests); system font stack in production (Sora is design-only); responsive with flex and grid, phone width stacks the sidebar into a chip bar and tables scroll in a box; real buttons, links and labels, 4.5:1 contrast, no inline event handlers. Pages: /owner/clients, /owner/clients/:id/grants, /owner/measurements, /owner/exports, /owner/blob-gc and /authorize consent. Phase 1 (foundation): tokens stylesheet, page shell (sidebar, header, cards, table, buttons, status dot), split owner page rendering into pure render functions under apps/worker/src/transport/owner-pages/ with snapshot tests, restyle clients and grants. Phase 2: measurements, exports, blob-gc. Phase 3: consent page in the OAuth module. Behavior, routes, CSRF, Access checks and forms do not change.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Phase 1: a tokens stylesheet module exists with the approved palette and is served inline on every owner page. Clients and grants pages render with the new shell. Render functions are pure and covered by HTML snapshot tests. Existing owner tests stay green.
- [ ] #2 Phase 2: measurements, exports and blob-gc pages use the shell and components. Numbers, links, forms and CSRF behave as before.
- [ ] #3 Phase 3: the consent page uses the same tokens and a centered card. Approve and Deny keep their names and semantics.
- [ ] #4 Phone width: the sidebar becomes a horizontal chip bar, cards stack, tables scroll horizontally. Checked with a DOM test at 390px or an equivalent assertion on the CSS.
- [ ] #5 No new dependency, no external request from the pages, no inline event handlers. bun run check and Worker preflight green.
<!-- AC:END -->
