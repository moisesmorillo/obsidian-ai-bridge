---
id: OAB-50.6
title: Execute the production cutover to Vaultwire
status: To Do
assignee: []
created_date: '2026-11-09T15:37:00Z'
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
- [ ] #1 Object counts and checksums match between old and new buckets.
- [ ] #2 The vaultwire Worker serves the same cursor and file set as the final export.
- [ ] #3 Mac, iPhone, iPad and ChatGPT connect to vaultwire.mmorillo.dev and a note change converges on all three devices.
<!-- AC:END -->
