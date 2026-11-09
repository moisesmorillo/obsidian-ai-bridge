---
id: OAB-50.5
title: Rename the GitHub repository and local tooling
status: To Do
assignee: []
created_date: '2026-11-09T15:37:00Z'
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
- [ ] #1 The repository is moisesmorillo/vaultwire and CI, Release Please and the deploy secret work on it.
- [ ] #2 Local clones and Orca worktrees point at the new remote.
<!-- AC:END -->
