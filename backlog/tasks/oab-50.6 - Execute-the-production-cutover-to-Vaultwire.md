---
id: OAB-50.6
title: Execute the production cutover to Vaultwire
status: Done
assignee: []
created_date: '2026-11-09T15:37:00Z'
updated_date: '2026-11-09T21:26:00Z'
labels:
  - rename
dependencies:
  - OAB-50.1
  - OAB-50.2
  - OAB-50.3
  - OAB-50.4
  - OAB-50.5
  - OAB-12.6
parent_task_id: OAB-50
type: chore
ordinal: 91000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner rule: no coexistence. The owner stops all clients, the supervisor executes the cutover, then all clients reconnect. Order: confirm the seven-day watch closed, pause clients, take a final export, copy every blob and backup object from the oab buckets to the vaultwire buckets with SHA-256 checksums, deploy the vaultwire script with the Durable Object transfer, attach vaultwire.mmorillo.dev, verify journal cursor, file count and blob checksums against the final export, reconnect Mac, then iPhone, iPad and ChatGPT.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Object counts and checksums match between old and new buckets.
- [x] #2 The vaultwire Worker serves the same cursor and file set as the final export.
- [x] #3 Mac, iPhone, iPad and ChatGPT connect to vaultwire.mmorillo.dev and a note change converges on all three devices.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Cutover evidence, 2026-11-09:
- Final export at 17:38Z. The 51 blob objects matched by size, ETag and SHA-256. The 51 backup objects matched by content SHA-256.
- The vaultwire script took the Durable Object through the transferred_classes migration vaultwire-transfer-v1.
- The export at 18:15Z matched the 17:38Z export in all 85 entries. Only the manifest created_at differed.
- Mac, iPhone and iPad reconnected to vaultwire.mmorillo.dev with plugin 0.3.0. ChatGPT connected as a custom MCP connector.
- A test note made on the Mac reached the iPhone and the iPad. The owner confirmed it. The supervisor then deleted it and the delete synced.
- Worker 0.6.0 deployed through Release Please. The Mac shows connected, no failure, cursor 337.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The production cutover to Vaultwire is complete. Data in the new buckets and the Durable Object matches the final export. All three devices and ChatGPT use vaultwire.mmorillo.dev. Follow-up: the obsidian://ai-bridge/callback scheme keeps the old name.
<!-- SECTION:FINAL_SUMMARY:END -->
