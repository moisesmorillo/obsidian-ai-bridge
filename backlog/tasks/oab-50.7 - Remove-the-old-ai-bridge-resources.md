---
id: OAB-50.7
title: Remove the old ai-bridge resources
status: Done
assignee: []
created_date: '2026-11-09T15:37:00Z'
updated_date: '2026-11-09T21:36:00Z'
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
- [x] #1 No Cloudflare resource uses the old names.
- [x] #2 The owner merged the removal PR after reviewing the plan summary.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner decision 2026-11-09: remove the old resources now, without the 48-hour wait.
Supervisor live steps, 2026-11-09:
- Every oab-blobs object exists in vaultwire-blobs with the same ETag.
- One backup existed only in oab-backups, from 17:49Z. The supervisor saved it as ~/vaults/oab-final-backup-2026-11-09T17-49Z.zip and the zip test passed.
- The Durable Object namespace list shows one namespace, owned by vaultwire. The old script had none.
- wrangler deleted the obsidian-ai-bridge script. Its custom domain obsidian-bridge.mmorillo.dev went away with it.
- The supervisor emptied oab-blobs and oab-backups.
- After these steps the Mac stayed connected and /mcp returned 401 without a token.
The cloudflare-infra PR removes the buckets, the KV namespace, the Access objects and the old deploy token. It also moves the GitHub deploy secret to the vaultwire-github-deploy token.

cloudflare-infra PR #30 merged on 2026-11-09. Its apply deleted the old deploy token, oab-blobs, oab-backups with its lifecycle, oab-oauth, and the old Access application and policy. The plan had 7 deletes and 1 in-place secret update. The GitHub secret CLOUDFLARE_DEPLOY_TOKEN now holds the vaultwire-github-deploy token.
Live check after the apply: the account lists only the vaultwire script, the vaultwire-oauth namespace, the vaultwire-blobs and vaultwire-backups buckets, and the vaultwire.mmorillo.dev domain.
A manual deploy.yml run with the new token passed and its metadata check passed. /mcp returned 401 without a token.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The old obsidian-ai-bridge script, domain, buckets, KV namespace, Access objects and deploy token are gone. The deploy workflow uses the vaultwire token and passed. A dated zip of the last old-only backup stays in ~/vaults.
<!-- SECTION:FINAL_SUMMARY:END -->
