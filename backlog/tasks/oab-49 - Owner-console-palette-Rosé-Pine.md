---
id: OAB-49
title: 'Owner console palette: Rosé Pine'
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-08T02:45:00Z'
updated_date: '2026-11-08T02:54:00Z'
labels:
  - worker
  - design
dependencies: []
priority: medium
ordinal: 84000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Replace the Bordeaux and copper palette of the owner console and the consent page with Rosé Pine main (the original dark variant). Visual only. No route, form, CSRF, header or behavior change. Owner decision 2026-11-08: Rosé Pine main, no Moon or Dawn, start implementation directly.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every color in apps/worker/src/transport/owner-pages/tokens.css.ts and consent.ts comes from a CSS custom property declared once on :root. No hex or rgba literal remains outside the :root block except alpha variants built from a documented token.
- [ ] #2 Tokens map to Rosé Pine main: base #191724, surface #1f1d2e, overlay #26233a, muted #6e6a86, subtle #908caa, text #e0def4, love #eb6f92, gold #f6c177, rose #ebbcba, pine #31748f, foam #9ccfd8, iris #c4a7e7, highlight low #21202e, med #403d52, high #524f67. Rose is the single accent for primary buttons, active status dots and highlighted cards. Gold marks attention chips. Love marks danger. Pine marks borders of storage bars and slot segments. Background is flat base.
- [ ] #3 Text contrast: body text on base, surface and overlay reaches WCAG AA 4.5:1. Primary button ink on rose reaches 4.5:1. A test computes the contrast ratios from the token values.
- [ ] #4 Snapshots updated deliberately. Tests that asserted the old colors assert the new tokens. docs/api/f2.md token table updated. bun run check and Worker preflight green.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Goal
Use Rosé Pine main for the owner console and consent page. Preserve markup, layout, copy, routes, forms, CSRF, headers, and behavior.

## Owner decisions
The owner supplied the exact palette and mappings in brief S15. No Moon or Dawn variant. No new dependency. No live calls. The owner waived Plannotator. Use existing selectors for state colors and subtle text for meaningful 12px labels. Keep legacy class names for markup compatibility.

## Steps
- [ ] Add failing palette, root-token-only color, flat-background, state-color, and WCAG contrast tests in apps/worker/test/owner-pages.test.ts. Compute contrast from parsed CSS tokens. Assert text on base, surface, and overlay at 4.5, subtle on surface at 4.5, and base on rose at 4.5.
- [ ] Run focused tests before production edits. Record expected failure.
- [ ] Change apps/worker/src/transport/owner-pages/tokens.css.ts and consent.ts to the exact S15 palette. Declare each color once in :root. Use token references and color-mix alpha variants elsewhere. Keep selectors and layout rules unchanged except old gradient paint. Apply accessible subtle labels and the specified semantic state colors.
- [ ] Update color assertions and affected snapshots deliberately. Verify snapshot markup and behavior stay unchanged.
- [ ] Update the token table in docs/api/f2.md and existing token mentions in docs/spec.md, if any.
- [ ] Run focused tests, bun run docs:check, bun run check, and Worker preflight. Commit implementation and test evidence notes in this task only.
- [ ] Get independent task review and whole-branch review with the code-review skill and TypeScript profile. Resolve findings. Rebase on origin/main before publication.
- [ ] Mark OAB-49 Done with evidence notes. Push one branch and open the specified PR against main. Remove the worktree and report the URL.

## Review focus
Check consent CSS overrides, 12px meaningful labels, attention and fresh chips, agent kind text, and snapshot-only color changes. No external requests, web fonts, inline event handlers, or Cloudflare changes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implementation status: safe partial palette implementation completed and committed. Blocker: Fresh and Stale are both rendered by apps/worker/src/transport/owner-pages/measurements.ts:80 as <span class="chip"> with text only, so CSS cannot distinguish foam from gold without a state selector. Agent kind has no semantic class in apps/worker/src/transport/owner-pages/clients.ts:42, where the Kind column renders Unknown as plain text. Per parent decision, no renderer markup or class changed. No unused selectors or false tests were added. Remaining work needs a separately authorized class-only markup change before full acceptance.

Validation: Focused worker test command was blocked before Vitest because apps/worker/node_modules/wrangler/bin/wrangler.js is absent. bun run docs:check passed. `biome check` passed for all three changed TypeScript files. bun run check failed at root lint with 53 diagnostics, mainly existing unrelated formatting issues across the repository. Worker preflight failed because Wrangler is absent. Snapshot comparison confirmed all rendered HTML outside <style> is unchanged across five snapshot entries. CSS token inspection found one :root block and no hex or rgba literals outside it. Exact WCAG values from the token colors: text/base 13.3889:1, text/surface 12.5048:1, text/overlay 11.5066:1, subtle/surface 5.1180:1, base/rose 10.4549:1.

Task review finding disposition: selectors remain a known blocker because Fresh/Stale and agent-kind values lack semantic selectors. The F2 token table now labels gold, foam, and iris as unused tokens with their intended mappings and states the selector limits. Validation remains incomplete: docs:check passed for this correction, but prior full check, focused tests, and Worker preflight did not pass due repository lint diagnostics and missing Wrangler.
<!-- SECTION:NOTES:END -->
