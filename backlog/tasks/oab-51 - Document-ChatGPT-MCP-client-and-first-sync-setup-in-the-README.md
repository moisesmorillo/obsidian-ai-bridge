---
id: OAB-51
title: Document ChatGPT, MCP client and first-sync setup in the README
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-09T21:37:00Z'
updated_date: '2026-11-09T21:43:00Z'
labels: []
dependencies: []
type: docs
ordinal: 93000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The owner needs verified setup guides for AI clients and existing local vaults. Preserve the README layout and all current images. Limit changes to documentation and a README test only if needed. Never access personal vaults or change Cloudflare resources.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 README explains ChatGPT setup, OAuth consent, account visibility, tool selection, and three example prompts.
- [ ] #2 README explains other MCP clients with verified examples, real server instructions, consent, and revocation.
- [ ] #3 README explains first sync, existing-device conflicts, coexistence, dated backups, and safe cutover for any existing sync tool.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Preserve the README title, layout, logo, badges, diagram, and screenshots. 2. Replace the ChatGPT guide and add verified MCP client setup and exact server instructions. 3. Add first-sync, coexistence, and cutover guidance from the code and specification. 4. Run bun run check and independent semantic review. 5. Get owner branch review, close OAB-51, open the pull request, and remove the worktree.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner approved the plan in Plannotator session pn-e39aa8. Scope stays README guides with no runtime or infrastructure changes.

README guides now cover ChatGPT, Claude and Streamable HTTP clients, exact MCP instructions, first sync, coexistence, backup, and cutover. Validation: bun run check passed; tooling README-related test passed (4 tests); bun run docs:check passed. The source review checked apps/worker/src/transport/mcp.ts, plugin reconciliation and coexistence code, docs/spec.md sections 7.2, 7.3, 7.10, 8, 9, 11 and 14, and both linked backup/coexistence guides. No runtime tests or test-file edits were needed. The task remains In Progress for parent review.
<!-- SECTION:NOTES:END -->
