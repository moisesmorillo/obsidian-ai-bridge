---
id: OAB-50.1
title: Rename product labels, documentation and package scopes
status: To Do
assignee: []
created_date: '2026-11-09T15:37:00Z'
labels:
  - rename
dependencies: []
parent_task_id: OAB-50
type: chore
ordinal: 86000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Repository obsidian-ai-bridge. Scope: visible plugin name and settings text, owner console brand and titles, consent page, README, docs/spec.md and docs/api, package names to `@vaultwire/*` and the root package to `vaultwire`, workspace imports of published package names, Release Please components and tag prefix (plugin tags become `vaultwire-v*`), and AGENTS.md product references. Out of scope: the plugin manifest id and plugin data storage (sibling task), Worker wrangler configs and the deploy workflow (sibling task). Internal path aliases such as `@protocol/*`, `@worker/*` and `@plugin/*` stay.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A repository search for ai-bridge, obsidian-ai-bridge and "AI Bridge" outside historical records and the files owned by sibling tasks returns no match.
- [ ] #2 Release Please config and its tests produce `vaultwire-v<version>` plugin tags and keep worker tags. Existing tags and releases stay.
- [ ] #3 bun run check passes and snapshots change only in brand text.
<!-- AC:END -->
