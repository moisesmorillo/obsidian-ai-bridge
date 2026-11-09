---
id: OAB-50
title: Rename the product to Vaultwire
status: To Do
assignee: []
created_date: '2026-11-09T15:37:00Z'
labels:
  - rename
dependencies: []
priority: high
type: chore
ordinal: 85000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner decision 2026-11-09: the product name becomes Vaultwire. The old name "AI Bridge" describes only the agent bridge. The product is also a self-hosted vault sync and storage service, and later semantic search. Tagline: "Self-hosted vault sync and storage, with MCP tools for AI agents." The rename covers every name: labels, packages, release tags, the GitHub repository, the plugin id, the Worker script, the hostname, R2 buckets, the KV namespace, the Durable Object namespace, Access objects and the deploy token. Owner rule: no coexistence period. The owner stops all clients during the cutover, then reconnects them. Target names: plugin id and Worker script `vaultwire`, packages `@vaultwire/*`, hostname `vaultwire.mmorillo.dev`, buckets `vaultwire-blobs` and `vaultwire-backups`, KV `vaultwire-oauth`. Historical task notes, plans, tags and released versions stay unchanged.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every subtask is Done.
- [ ] #2 No current product surface, package, configuration, Cloudflare resource or repository name uses ai-bridge, obsidian-ai-bridge, AI Bridge or oab. Historical records are the only exception.
- [ ] #3 The real vault on Mac, iPhone and iPad and the ChatGPT connection work against vaultwire.mmorillo.dev with the same content as before the cutover.
<!-- AC:END -->
