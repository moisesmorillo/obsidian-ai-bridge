---
id: OAB-56
title: Run a security audit of the whole repository
status: To Do
assignee: []
created_date: '2026-11-10T03:43:00Z'
labels: []
dependencies: []
priority: high
ordinal: 96000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The owner asked for a full security audit after the Vaultwire 1.0 release. Use the Cloudflare security audit skill and the Trail of Bits (tob) skills that the owner named. The skills are not installed in ~/.claude or ~/.pi on 2026-11-09. Find and install them first, or ask the owner for the source. Scope: apps/worker, apps/plugin, packages/protocol, tooling, .github/workflows and the OpenTofu link to cloudflare-infra. The audit is read-only. Fixes go in separate tasks.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The Cloudflare security audit skill runs on the whole repository and its report lists each finding with file, line and severity
- [ ] #2 The Trail of Bits skills run on the whole repository and their findings use the same format
- [ ] #3 Each confirmed finding has its own Backlog task with severity, or a written reason why it is a false positive
- [ ] #4 The audit changes no code, no Cloudflare resource and no secret
<!-- AC:END -->
