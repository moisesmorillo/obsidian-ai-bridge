---
id: OAB-49
title: 'Owner console palette: Rosé Pine'
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-08T02:45:00Z'
updated_date: '2026-11-08T03:00:00Z'
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
## Status
Safe partial palette work and whole-branch review corrections are committed. OAB-49 remains In Progress. Fresh/Stale and agent-kind color mappings remain blocked because their markup lacks semantic selectors. No markup changed.

## Review findings
- Finding 1 fixed: updated consent-page snapshot for current Rosé Pine styles. A comparison confirms HTML outside <style> stayed unchanged.
- Finding 2 fixed: existing .consent-deny hover and active selectors preserve transparent background, highlight-high border, and text ink. Added a focused assertion.
- Finding 3 remains open: Fresh/Stale and agent kind lack selectors. Keep this as a draft blocker.
- Finding 4 fixed: .owner-sidebar uses --surface and .about-panel uses --overlay. Added focused mapping assertions.

## Validation
Added regression assertions before implementation fixes. No tests ran for this correction. Earlier focused command `bun run --filter '@obsidian-ai-bridge/worker' test -- owner-pages.test.ts` stopped before Vitest because apps/worker/node_modules/wrangler/bin/wrangler.js was missing. The earlier root `bun run check` failed at lint with 52 errors and 2 informational diagnostics, as the branch-review report corrected. Worker preflight also failed because Wrangler was missing.

For this correction, changed-file Biome checks passed for tokens.css.ts, consent.ts, owner-pages.test.ts, and consent-page.test.ts. `bun run docs:check` passed. Snapshot comparison confirmed consent HTML outside its stylesheet stayed unchanged. `git diff --check` passed. The full check, focused tests, and Worker preflight remain incomplete.
<!-- SECTION:NOTES:END -->
