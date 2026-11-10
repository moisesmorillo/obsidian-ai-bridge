---
id: OAB-55
title: Fix consent scope checkbox layout
status: Done
assignee:
  - '@pi'
created_date: '2026-11-10T01:30:00Z'
updated_date: '2026-11-10T02:15:00Z'
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
- [x] #1 Each requested scope has a compact checkbox row with its name and a plain description.
- [x] #2 Read stays visibly required and cannot be cleared. Optional labels remain clickable and accessible.
- [x] #3 Rosé Pine colors, keyboard focus, and the 390 px layout remain intact.
- [x] #4 Regression tests and bun run check pass. Synthetic screenshots at 1440 px and 390 px appear in the pull request.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add failing consent layout and description tests. 2. Use consent-only compact checkbox rows and keep all form contracts. 3. Check synthetic pages at 1440 px and 390 px with label clicks, keyboard input, and screenshots. 4. Run bun run docs:check and bun run check. 5. Complete task and branch reviews, attach screenshots to the pull request, and remove the worktree. Local plan: .pi/plans/2026-11-10-consent-layout.md.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
RED: bun test apps/worker/test/consent-page.test.ts exited 1 on the missing read status. GREEN: focused Vitest run passed 3 tests. bun run docs:check passed. bun run check passed with 15 existing non-null assertion warnings and expected Worker test diagnostics. Orca used the real renderer with synthetic ChatGPT values. At 1440x1000 and 390x844, scope rows stayed compact and the page had no horizontal overflow. Label click and Space toggled optional scopes. Read stayed checked and disabled. FormData included vault:read. The checkbox focus outline appeared after focus. Screenshots: /tmp/oab-55/consent-1440x1000.png and /tmp/oab-55/consent-390x844.png. No personal vault or remote service was used.

Task and complete branch reviews approved f4297c59f7158d9476a373af639c19606de324e6 with no findings. Documentation scope: consent view model, renderer, tests, snapshot, and task notes. The renderer remains cohesive and owns only presentation. Reviewers inspected the diff and screenshots without repeating the worker checks. Human branch review approved the same implementation with no changes. Both screenshots appear in PR #152: https://github.com/moisesmorillo/vaultwire/pull/152. Mobile evidence uses a 390x844 viewport and a 390x934 full-page image. Browser and screen reader coverage stays limited to the synthetic Orca checks.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Fixed compact consent rows with descriptions and a visible read status. Preserved labels, scope submission, focus, and palette. The failing regression test preceded the fix. The full check passed 2,402 tests with 1 skipped and built all packages. Independent task review, complete branch review, and human review approved the change. PR #152 includes both screenshots. No deployment or personal vault access occurred.
<!-- SECTION:FINAL_SUMMARY:END -->
