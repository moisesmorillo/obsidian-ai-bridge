---
id: OAB-4
title: Build the mobile-compatible Obsidian plugin artifact
status: To Do
assignee: []
created_date: '2026-10-12 13:17'
updated_date: '2026-10-12 13:17'
labels:
  - F0
  - plugin
dependencies:
  - OAB-2
documentation:
  - docs/spec.md
  - docs/superpowers/plans/2026-10-12-f0-foundation.md
type: feature
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
F0 must establish one production plugin package, not a parallel demo, before F3 implements synchronization. Its lifecycle is inert until the enrolled sync engine exists. Dependency purpose: Obsidian types define the host API and esbuild bundles the desktop/mobile-compatible plugin; no Node or Electron runtime API is allowed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The plugin manifest declares minAppVersion 1.13.0 and isDesktopOnly false.
- [ ] #2 The build produces main.js and manifest.json in the same directory, with Obsidian external and no Node or Electron runtime dependency.
- [ ] #3 Lifecycle tests prove no connection, vault mutation or persistent writes occur in the F0 entry point, and bun run check passes.
<!-- AC:END -->
