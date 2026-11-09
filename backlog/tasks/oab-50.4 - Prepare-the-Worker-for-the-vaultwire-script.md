---
id: OAB-50.4
title: Prepare the Worker for the vaultwire script
status: To Do
assignee: []
created_date: '2026-11-09T15:37:00Z'
labels:
  - rename
  - worker
dependencies: []
parent_task_id: OAB-50
type: chore
ordinal: 89000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Repository obsidian-ai-bridge, apps/worker wrangler configs, deploy workflow and their tests. The production script becomes `vaultwire` with SERVICE_ORIGIN https://vaultwire.mmorillo.dev and bindings to vaultwire-blobs, vaultwire-backups and vaultwire-oauth. The Durable Object namespace holds the real vault journal, so the new script must take over the existing namespace from the obsidian-ai-bridge script with a Durable Object transfer migration instead of starting empty. Development configs follow the same names. Rehearse the transfer on development scripts with synthetic data before production.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A development rehearsal transfers a Durable Object with synthetic journal data between two scripts and reads the same cursor and files after the transfer.
- [ ] #2 Deployment config tests pin the new script name, origin, bindings and migration.
- [ ] #3 bun run check and Worker preflight pass. No production deploy happens in this task.
<!-- AC:END -->
