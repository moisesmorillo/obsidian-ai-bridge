---
id: OAB-50.3
title: Rename the plugin identifier to vaultwire
status: To Do
assignee: []
created_date: '2026-11-09T15:37:00Z'
labels:
  - rename
  - plugin
dependencies: []
parent_task_id: OAB-50
type: chore
ordinal: 88000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Repository obsidian-ai-bridge, apps/plugin and plugin tooling. The manifest id becomes `vaultwire` and the name "Vaultwire". Obsidian keys plugin data by id, so local state lives under `.obsidian/plugins/ai-bridge` today. The owner accepts a full reconnect after the cutover. Local edits made before the cutover must not be lost. Install and release tooling, compatibility files and the dev-vault scripts use the new id.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A build produces a plugin with id `vaultwire` that installs next to an old ai-bridge folder without reading or deleting it by accident.
- [ ] #2 A documented and tested procedure moves a device from ai-bridge to vaultwire without loss of vault content or unsynced local edits.
- [ ] #3 bun run check passes.
<!-- AC:END -->
