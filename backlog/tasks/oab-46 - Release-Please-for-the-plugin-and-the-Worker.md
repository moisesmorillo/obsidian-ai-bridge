---
id: OAB-46
title: Release Please for the plugin and the Worker
status: To Do
assignee: []
created_date: '2026-11-07T18:44:00Z'
labels:
  - ci
  - release
  - worker
  - plugin
dependencies: []
priority: high
ordinal: 82000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner order 2026-11-07: add Release Please to the monorepo so each component publishes when it has changes. Owner decision: the Worker deploys when its release PR merges, not on every merge to main. Design: release-please manifest mode with release-please-config.json and .release-please-manifest.json. Components: apps/plugin with component ai-bridge and tag ai-bridge-v<version> (current 0.1.6), apps/worker with component worker and tag worker-v<version> (start from the current package.json version). Conventional Commits already drive the repo. One workflow .github/workflows/release-please.yml runs the action on push to main, then, inside the same workflow run, builds and publishes the plugin assets when the plugin release was created and deploys the Worker when the worker release was created. Reuse release.yml and deploy.yml through workflow_call so the GITHUB_TOKEN limitation on cross-workflow triggers does not apply. deploy.yml stops deploying on push to main. Keep the owner-only actor guard and workflow_dispatch. The plugin release PR must leave package.json, manifest.json and versions.json consistent so apps/plugin/tools/release.ts validation passes (extra-files for manifest.json, plus a tested tooling step for the versions.json entry). Update docs/plugin-release.md and the deployment docs. Bootstrap the manifest with the current versions and a bootstrap-sha at the current main so the first changelog starts here.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 On push to main, Release Please opens or updates one release PR per changed component with changelog and version bump. Components without changes get no PR.
- [ ] #2 Merging the plugin release PR creates tag ai-bridge-v<version> and the GitHub Release with main.js and manifest.json, inside the same workflow run. package.json, manifest.json and versions.json agree and release.ts validation passes.
- [ ] #3 Merging the worker release PR creates tag worker-v<version> and deploys the Worker with the existing preflight and owner-only guard. Push to main no longer deploys by itself.
- [ ] #4 Tests cover the versions.json sync step and the deployment config. bun run check green. Workflow files validated with actionlint or an equivalent offline check if available without a new runtime dependency.
- [ ] #5 docs/plugin-release.md and the Worker deployment docs describe the new flow. Backlog notes record the bootstrap versions.
<!-- AC:END -->
