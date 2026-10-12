---
id: OAB-2
title: Establish shared protocol identity and the monorepo check pipeline
status: To Do
assignee: []
created_date: '2026-10-12 13:17'
updated_date: '2026-10-12 13:17'
labels:
  - F0
  - protocol
dependencies: []
documentation:
  - docs/spec.md
  - docs/superpowers/plans/2026-10-12-f0-foundation.md
type: feature
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
F0 needs executable contracts shared by all runtimes before backend or plugin behavior is built. The current repository has no package manifests or test pipeline. Dependency purpose: Zod defines the sole protocol shapes; TypeScript and Bun types check the workspaces; Vitest proves the contracts; Biome enforces repository conventions. Exact compatible versions must be pinned during implementation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Bun workspaces expose packages/protocol and can add apps/worker and apps/plugin without duplicate protocol definitions.
- [ ] #2 Tests prove NFC path normalization, byte and segment limits, canonical lowercase keys, random-generation ETag syntax and unsafe revision rejection.
- [ ] #3 A frozen-lockfile install and bun run check pass locally and in CI; formatting, type errors and failed tests make the check fail.
<!-- AC:END -->
