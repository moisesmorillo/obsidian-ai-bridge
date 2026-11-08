---
id: OAB-49
title: 'Owner console palette: Rosé Pine'
status: To Do
assignee: []
created_date: '2026-11-08T02:45:00Z'
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
