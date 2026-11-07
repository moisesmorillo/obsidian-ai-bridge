---
id: OAB-47
title: 'Owner console redesign: Bordeaux and copper'
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-07T21:08:00Z'
updated_date: '2026-11-07T21:18:00Z'
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

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Owner console foundation implementation plan
Goal: Apply the approved Bordeaux and copper design to clients and grants without behavior changes.
Architecture: Keep Access, escaping, CSRF, registry calls, pagination, responses, and form semantics in their current boundaries. Pure page render functions consume escaped view models. One shell embeds one stylesheet.
Tech stack: TypeScript, inline CSS, existing Vitest tests. No new dependency.
Spec: Owner brief S10-console-foundation.md and COMMON-NIGHT.md, approved direction F. Repository contract: docs/spec.md and docs/api/f2.md.

## Owner decisions
The owner authorizes phase 1 without Plannotator. Use the supplied palette and system font stack. No external requests, live service calls, vault access, deployment, or Cloudflare changes.
Default: Service metadata shows unknown when current handlers lack authoritative values. Do not invent healthy state, version, or epoch.
Default: Apply the shell and inline stylesheet to measurements, exports, and blob-gc through render-only changes. Preserve their content for phase 2.
Default: Keep OAB-47 In Progress because phases 2 and 3 remain outside this branch.

## Task 1: Build and integrate the console foundation
Files: apps/worker/src/transport/owner-pages/{tokens.css.ts,shell.ts,clients.ts,grants.ts}, apps/worker/src/transport/owner.ts, tests and snapshots under apps/worker/test, docs/api/f2.md.
- [ ] Add failing snapshot tests for shell, clients, and grants. Assert every token and the 390px chip-bar, stacked-card, scroll-table, and 16px-padding rules.
- [ ] Assert empty states, all registry states, pending cleanup, remove eligibility, encoded pagination, and escaped hostile names and ids. Preserve CSRF values, action, method, button names, disabled state, input name, and maxlength.
- [ ] Run the new tests and record their expected failure before implementation.
- [ ] Add OWNER_CONSOLE_CSS, renderOwnerShell, renderClientsPage, and renderGrantsPage with documented internal view models. Keep escapeHtml unchanged in owner.ts.
- [ ] Pass escaped values from handlers. Render the shared frame with active navigation, system fonts, tokens, components, responsive rules, and honest service metadata.
- [ ] Wrap other owner HTML pages only where no logic change is needed. Keep JSON output unchanged.
- [ ] Document the design and token table. Add useful TSDoc to semantic declarations.
- [ ] Run focused render tests and existing test/f2/owner.test.ts. Run bun run docs:check, bun run check, and Worker preflight. Commit the complete task.

## Review focus
Check escaping at the handler boundary and URL encoding for hostile identifiers. Check all forms against the original markup. Check mixed and pending states without false token-health claims. Check empty pages and pagination. Check phone overflow and keyboard navigation.

## Acceptance and publication
- [ ] Fresh task review with the code-review skill and TypeScript profile. Resolve findings through the implementer.
- [ ] Rebase on origin/main. Complete a separate whole-branch review with the session model. No Plannotator.
- [ ] Record reviewed revision, documentation scope, structural candidates, checks, limits, and finding closures in task notes.
- [ ] Check only phase 1 criteria that this branch proves. Leave later phases open.
- [ ] Push and open one PR against main. First body line: OAB-47 phase 1: visual only, no behavior change.
- [ ] Remove the worktree, report the PR URL, and stop.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Scope: owner brief S10 covers phase 1 only. The owner skips Plannotator for this branch. No live service calls or Cloudflare changes. No new dependency.

Phase 1 implementation uses pure clients and grants renderers with escaped view-model values. Added CSS token and responsive assertions plus HTML snapshots. RED: focused render suite failed because owner page modules did not exist (exit 1). GREEN: focused render suite, F2 owner suite, docs:check, bun run check, and Worker preflight passed. Known limit: measurements, exports, and blob-GC keep their existing markup in phase 1; later phases remain open.
<!-- SECTION:NOTES:END -->
