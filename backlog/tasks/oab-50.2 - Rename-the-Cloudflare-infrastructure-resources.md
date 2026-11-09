---
id: OAB-50.2
title: Rename the Cloudflare infrastructure resources
status: To Do
assignee: []
created_date: '2026-11-09T15:37:00Z'
labels:
  - rename
  - infra
dependencies: []
parent_task_id: OAB-50
type: chore
ordinal: 87000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Repository cloudflare-infra (OpenTofu, owner merge applies). Create the new resources next to the old ones: R2 buckets `vaultwire-blobs` (prevent_destroy) and `vaultwire-backups` (same lifecycle as oab-backups), KV namespace `vaultwire-oauth`, Access application, policy and one-time PIN identity provider named for Vaultwire and covering `vaultwire.mmorillo.dev`, and deploy token `vaultwire-github-deploy` with the same permissions plus access to the new buckets. The Workers custom domain for the new hostname attaches at cutover. Rename Terraform addresses and files from oab and obsidian_ai_bridge to vaultwire with moved blocks where the resource survives. Old buckets, KV, domain and token stay until the decommission task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The plan creates the new resources and moves addresses without destroying any existing resource.
- [ ] #2 Offline tests pin the new names and the old names that must survive until decommission.
- [ ] #3 Outputs expose the new bucket names, KV id, hostname and Access audience for the Worker task.
<!-- AC:END -->
