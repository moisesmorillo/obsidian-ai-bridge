---
id: OAB-55
title: Fix consent scope checkbox layout
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-10T01:30:00Z'
updated_date: '2026-11-10T02:07:00Z'
labels: []
dependencies: []
type: bug
ordinal: 95000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The owner saw separate checkbox and label lines with large gaps on the ChatGPT consent page. Keep this fix within Worker owner pages. Never deploy or access the personal vault.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Each requested scope has a compact checkbox row with its name and a plain description.
- [ ] #2 Read stays visibly required and cannot be cleared. Optional labels remain clickable and accessible.
- [ ] #3 Rosé Pine colors, keyboard focus, and the 390 px layout remain intact.
- [ ] #4 Regression tests and bun run check pass. Synthetic screenshots at 1440 px and 390 px appear in the pull request.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add failing consent layout and description tests. 2. Use consent-only compact checkbox rows and keep all form contracts. 3. Check synthetic pages at 1440 px and 390 px with label clicks, keyboard input, and screenshots. 4. Run bun run docs:check and bun run check. 5. Complete task and branch reviews, attach screenshots to the pull request, and remove the worktree. Local plan: .pi/plans/2026-11-10-consent-layout.md.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
RED: bun test apps/worker/test/consent-page.test.ts exited 1 on the missing read status. GREEN: focused Vitest run passed 3 tests. bun run docs:check passed. bun run check passed with 15 existing non-null assertion warnings and expected Worker test diagnostics. Orca used the real renderer with synthetic ChatGPT values. At 1440x1000 and 390x844, scope rows stayed compact and the page had no horizontal overflow. Label click and Space toggled optional scopes. Read stayed checked and disabled. FormData included vault:read. The checkbox focus outline appeared after focus. Screenshots: /tmp/oab-55/consent-1440x1000.png and /tmp/oab-55/consent-390x844.png. No personal vault or remote service was used.
<!-- SECTION:NOTES:END -->
