---
id: OAB-59
title: Design the path to publish the plugin in the Obsidian community marketplace
status: To Do
assignee: []
created_date: '2026-11-10T18:18:00Z'
labels: []
dependencies: []
references:
  - https://github.com/obsidianmd/obsidian-releases
  - https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin
  - https://docs.obsidian.md/Developer+policies
priority: medium
type: spike
ordinal: 99000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Today the plugin reaches devices only through BRAT and GitHub releases from Release Please (tag vaultwire-vX.Y.Z). The owner wants Vaultwire listed in the official Obsidian community plugins directory so that users install and update it from inside Obsidian without BRAT. Listing goes through a pull request to obsidianmd/obsidian-releases and the Obsidian review. The plugin needs a self-hosted Worker and an account, uses the network, and syncs vault content, so review policies on network use, disclosure, and data handling apply. The current release flow, manifest, versions.json and compatibility PRs must keep working.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A design note in the task lists every current Obsidian submission requirement and developer policy that applies, with its source link and the gap in the current plugin, manifest, README or release assets.
- [ ] #2 The design states the release flow from Release Please to the community directory, including how versions.json, minAppVersion and release assets stay correct for each release.
- [ ] #3 The design states the disclosure text for network use, the required self-hosted Worker, and data handling, and where it appears (README and plugin settings).
- [ ] #4 The design lists the follow-up implementation tasks, each with acceptance criteria, and the owner approves it before any submission pull request is opened.
<!-- AC:END -->
