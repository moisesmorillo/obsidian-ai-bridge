---
id: OAB-28
title: Rename the production Worker script
status: Done
assignee:
  - '@pi'
created_date: '2026-10-28T19:38:00Z'
updated_date: '2026-10-28T19:46:00Z'
labels: []
dependencies: []
type: chore
ordinal: 39000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The F2 suffix came from OAB-7.7 phase naming and has no product meaning. A new script name creates a new Durable Object namespace. The current Vault holds only four synthetic notes under oab-7.8/. OAB-7.8 task notes retain that evidence. No migration is needed. Rename before OAB-8.2 stores real vault data. The owner authorizes the rename and deployment through the merge workflow. After deployment, the cloudflare-infra assistant changes the custom domain through OpenTofu. The owner then deletes the old script. This repository must not change Cloudflare resources directly.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Production config and its test use obsidian-ai-bridge. Development and F2 test configs stay unchanged.
- [x] #2 Current documentation uses the new identity and explains the domain transfer sequence. Historical task notes and plans stay unchanged.
- [x] #3 Worker behavior, apps/plugin, and packages/protocol stay unchanged. bun run check passes.
- [x] #4 Human plan and branch reviews complete. The task closes in the pull request without local deployment or deletion.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Use the owner-reviewed short plan outside tracked files. First change the production-name test and record its expected failure. Change only the production script name, current API documentation, and README. Preserve historical deployment facts, task notes, plans, development config, and F2 test config. Run focused tests, docs:check, and bun run check. Complete independent code review and human branch review. Close OAB-28 in the same PR, push the branch, open the PR, and remove the worktree. Do not deploy, delete, change Cloudflare resources, or touch plugin and protocol source.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implementation changed only the production script name, its deployment-config test, and current README/API documentation. RED: targeted test failed because config still named obsidian-ai-bridge-f2. GREEN: targeted test passed with 4 tests. docs:check passed. bun run check passed with lint, docs, typecheck, all tests, and dry-run builds. Review and task closure remain with the parent. No Cloudflare calls or deployment actions ran.

Task and whole-branch reviewers approved revision 1c71a9e with no actionable findings. Documentation scope covered README and API identity, namespace reset, and domain transfer. No structural candidate needed a stateful audit. Reviewers used worker check evidence and did not repeat runtime checks. The owner approved plan pn-fa9727 and branch review pn-6eea96 with no changes. Historical records and excluded paths remain unchanged. No local deployment, deletion, or Cloudflare operation occurred.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Renamed the production script to obsidian-ai-bridge before real vault data enters its Durable Object namespace. Updated the name assertion and current documentation. The focused test failed before the config change, then passed all four tests. Baseline and final bun run check passed. docs:check and diff checks passed. Independent and human reviews approved the change. Merge deployment creates the new script beside the original. The infrastructure assistant must transfer the domain through OpenTofu after deployment. The owner then deletes the original script. The public workflow check does not prove new-script traffic before transfer.
<!-- SECTION:FINAL_SUMMARY:END -->
