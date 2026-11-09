---
id: OAB-50.5
title: Rename the GitHub repository and local tooling
status: Done
assignee: []
created_date: '2026-11-09T15:37:00Z'
updated_date: '2026-11-09T17:34:00Z'
labels:
  - rename
dependencies:
  - OAB-50.1
parent_task_id: OAB-50
type: chore
ordinal: 90000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Rename moisesmorillo/obsidian-ai-bridge to moisesmorillo/vaultwire after the label task merges. GitHub redirects the old URL. Update the deploy secret repository target in cloudflare-infra, local remotes, Orca worktree registration, supervisor scripts and the pi launcher in dotfiles.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The repository is moisesmorillo/vaultwire and CI, Release Please and the deploy secret work on it.
- [x] #2 Local clones and Orca worktrees point at the new remote.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Rename the GitHub repository with gh repo rename. 2. Point local remotes at the new URL. 3. Update the current plugin release doc link. Historical plans and CHANGELOG links stay. 4. Change the deploy secret repository target in cloudflare-infra. 5. Verify CI, Release Please and secret on the renamed repository.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-11-09: repository renamed with gh repo rename to moisesmorillo/vaultwire. The old URL returns 301 to the new one. The local remote points at git@github.com:moisesmorillo/vaultwire.git. All Orca worktrees share that git directory. The local folder name stays obsidian-ai-bridge to keep Orca registration and supervisor paths stable. docs/plugin-release.md now names the new repository. Historical plans and CHANGELOG links stay. Deploy secret target change: cloudflare-infra PR #27. BRAT on iPhone and iPad follows the redirect. The cutover task re-adds the repository as moisesmorillo/vaultwire.

2026-11-09 verification: cloudflare-infra #27 merged and applied (secret repository vaultwire, GitHub App token repository vaultwire). The CLOUDFLARE_DEPLOY_TOKEN secret exists on moisesmorillo/vaultwire. Check and Release Please ran green on main of the renamed repository. Local remote and all Orca worktrees use git@github.com:moisesmorillo/vaultwire.git. Supervisor executed this task directly.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Renamed the GitHub repository to moisesmorillo/vaultwire. The old URL redirects. Local remotes, the plugin release doc, the infra deploy secret target and the infra GitHub App token request use the new name. CI and Release Please pass on the renamed repository. Folder names stay unchanged to keep Orca registration stable.
<!-- SECTION:FINAL_SUMMARY:END -->
