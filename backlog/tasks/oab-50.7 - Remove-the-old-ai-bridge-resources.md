---
id: OAB-50.7
title: Remove the old ai-bridge resources
status: To Do
assignee: []
created_date: '2026-11-09T15:37:00Z'
labels:
  - rename
  - infra
dependencies:
  - OAB-50.6
parent_task_id: OAB-50
type: chore
ordinal: 92000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
After 48 hours of clean use on Vaultwire, remove the obsidian-ai-bridge Worker script, the oab-blobs and oab-backups buckets, the old KV namespace, the obsidian-bridge.mmorillo.dev domain, the old Access objects and the old deploy token through a cloudflare-infra PR. Keep a dated export of the old buckets until the owner confirms removal.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 No Cloudflare resource uses the old names.
- [ ] #2 The owner merged the removal PR after reviewing the plan summary.
<!-- AC:END -->
