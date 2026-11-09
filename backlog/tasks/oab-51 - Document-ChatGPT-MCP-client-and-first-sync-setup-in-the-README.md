---
id: OAB-51
title: Document ChatGPT, MCP client and first-sync setup in the README
status: Done
assignee:
  - '@pi'
created_date: '2026-11-09T21:37:00Z'
updated_date: '2026-11-09T22:05:00Z'
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
- [x] #1 README explains ChatGPT setup, OAuth consent, account visibility, tool selection, and three example prompts.
- [x] #2 README explains other MCP clients with verified examples, real server instructions, consent, and revocation.
- [x] #3 README explains first sync, existing-device conflicts, coexistence, dated backups, and safe cutover for any existing sync tool.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Preserve the README title, layout, logo, badges, diagram, and screenshots. 2. Replace the ChatGPT guide and add verified MCP client setup and exact server instructions. 3. Add first-sync, coexistence, and cutover guidance from the code and specification. 4. Run bun run check and independent semantic review. 5. Get owner branch review, close OAB-51, open the pull request, and remove the worktree.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner approved the plan in Plannotator session pn-e39aa8. Scope stays README guides with no runtime or infrastructure changes.

README guides now cover ChatGPT, Claude and Streamable HTTP clients, exact MCP instructions, first sync, coexistence, backup, and cutover. Validation: bun run check passed; tooling README-related test passed (4 tests); bun run docs:check passed. The source review checked apps/worker/src/transport/mcp.ts, plugin reconciliation and coexistence code, docs/spec.md sections 7.2, 7.3, 7.10, 8, 9, 11 and 14, and both linked backup/coexistence guides. No runtime tests or test-file edits were needed. The task remains In Progress for parent review.

Branch-review correction wave completed. Finding 1: README now states that authorization starts sync unless this device has a saved local Pause, and instructs users of an existing provider-managed vault to back up and enable Coexistence mode before Connect. Finding 2: README states that a concurrent binary edit can disappear from the live file, and only bytes seen before apply are kept at .ai-bridge/pre-apply/<hash> for seven days. Finding 3: README dates ChatGPT personal-account visibility to the owner observation on 2026-11-09. Finding 4: README directs cutover to fresh empty vaults outside the former provider folder on every device, including the first. Finding 5: changed descriptive paragraphs now contain no more than three sentences. Coexistence exit guidance now notes that confirmations and active or queued sync work block exit. Validation: bun run docs:check, focused product-labels test, and bun run check each passed with exit code 0. The task remains In Progress.

Final branch-review correction wave passed validation. Finding 1 closed by documenting automatic startup after authorization unless local Pause is saved, plus backup and Coexistence mode before Connect. Finding 2 closed with binary live-file loss and observed-byte-only recovery path and seven-day retention. Finding 3 closed by dating personal-account visibility to the 2026-11-09 owner observation. Finding 4 closed by requiring fresh empty vaults outside the former provider folder on every cutover device, including the first. Finding 5 closed by splitting descriptive paragraphs to three or fewer sentences. Coexistence exit now requires no confirmations and no active or queued sync work. bun run docs:check exit 0. Focused product-labels test exit 0, 4 passed. bun run check exit 0, 2,339 passed and 1 skipped. The earlier plan claim that Resume starts sync was corrected to match the code and lifecycle tests. The task remains In Progress.

Final semantic review approved revision 5967c36 against b793f0a. All five findings closed with source evidence. Documentation scope: README client setup, enrollment, coexistence, cutover, and exact MCP instructions. No source structural candidate applies. Owner approved branch review pn-454774 with no changes. No live client, vault, or Cloudflare checks ran.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added verified README guides for ChatGPT, other MCP clients, first sync, coexistence, and cutover. Preserved all existing assets and title. Corrected the plan claim about Resume to match automatic startup after authorization unless locally paused. Project check passed with exit 0, 2339 tests passed and 1 skipped. Focused README tests passed, 4 passed and 0 failed. Documentation and whitespace checks passed. Independent and owner reviews passed. Client interfaces can change. Binary apply retains the documented race and seven-day observed-byte recovery limit.
<!-- SECTION:FINAL_SUMMARY:END -->
