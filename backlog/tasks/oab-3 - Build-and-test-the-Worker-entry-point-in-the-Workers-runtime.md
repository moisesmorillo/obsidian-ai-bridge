---
id: OAB-3
title: Build and test the Worker entry point in the Workers runtime
status: To Do
assignee: []
created_date: '2026-10-12 13:17'
updated_date: '2026-10-12 13:17'
labels:
  - F0
  - worker
dependencies:
  - OAB-2
documentation:
  - docs/spec.md
  - docs/superpowers/plans/2026-10-12-f0-foundation.md
type: feature
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Before F1 implements the vault authority, prove that the production Worker package builds and its entry point runs inside the local Cloudflare test runtime. No public API or authentication bypass is introduced in F0. Dependency purpose: Hono is the specified transport router; Wrangler provides local builds; Cloudflare worker types and the Vitest pool validate the actual target runtime.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The production Worker entry point is exercised using the Workers Vitest pool, not a Node-only substitute.
- [ ] #2 Unimplemented routes deny requests and introduce no public vault operations or development authentication bypass.
- [ ] #3 The local dry-run build and bun run check pass without remote deployment, secrets or production resource access.
<!-- AC:END -->
