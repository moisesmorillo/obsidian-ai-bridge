---
id: OAB-46
title: Release Please for the plugin and the Worker
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-07T18:44:00Z'
updated_date: '2026-11-07T18:58:00Z'
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

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Release Please implementation plan
Goal: Automate component release PRs and release follow-on jobs without calls to production during this task.
Architecture: Manifest mode controls separate plugin and Worker PRs. Reusable workflows publish assets or deploy only after release creation.
Spec: S9-release-please.md and COMMON-NIGHT.md from the owner brief.

## Owner decisions
The owner fixed the design and waived Plannotator. Use separate component PRs, the workflow token, and no new runtime dependency.
Bootstrap plugin 0.1.6 and Worker 0.1.0. Use bootstrap-sha eec41e68778e0d9e674d8e40c80b7c28e9ef80ed.
Keep manual plugin tags and manual Worker dispatch. Keep both owner actor checks.
Update an existing Release Please GitHub Release with checked assets instead of refusing its existing release object.

## Task 1: Release automation
- [ ] Inspect existing release validation, deployment tests, artifact tests, docs, and pinned actions.
- [ ] Write failing tests for compatibility-map synchronization, reusable workflow guards, and manifest-based artifact version checks.
- [ ] Add tested tooling under apps/plugin/tools that preserves old versions and inserts the manifest version with minAppVersion.
- [ ] Add root release-please-config.json and .release-please-manifest.json. Set separate-pull-requests and exact component tags.
- [ ] Add .github/workflows/release-please.yml with pinned action, release PR synchronization, and same-run reusable workflow calls.
- [ ] Convert release.yml and deploy.yml to reusable workflows. Build the exact released source. Retain tag verification and owner guards.
- [ ] Add Worker package version 0.1.0. Update plugin release docs, Worker deployment docs, and the optional-later spec text.
- [ ] Run focused tests, docs:check, bun run check, and Worker preflight. Run actionlint if present.
- [ ] Commit implementation. Record RED/GREEN commands and limits in task notes.
- [ ] Complete independent task review and whole-branch review. Correct findings and validate changed code.
- [ ] Rebase on origin/main. Close the task with evidence. Push, open one PR against main, and remove the worktree.

## Review focus
Check separate component PR outputs, absent outputs, existing release assets, tag source identity, token-trigger limits, PR update idempotence, and bot actor deploy refusal.
No live calls, deployment, tag creation, personal vault access, or Cloudflare changes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implementation evidence, 2026-11-07:
- Baseline `bun run check` passed. Baseline Worker preflight passed.
- RED: `bun run --filter '@obsidian-ai-bridge/plugin' test -- test/release-versions.test.ts` failed because the compatibility sync tool did not exist.
- RED: the deployment-config test failed because `deploy.yml` lacked `workflow_call` and still had a `push` trigger.
- GREEN: focused plugin release, asset, and compatibility tests passed: 23 tests. Tooling config and deploy tests passed: 7 tests.
- GREEN: `bun run docs:check`, `bun run check`, and `bun run --filter '@obsidian-ai-bridge/worker' preflight` passed. Full check: 9 tooling files/94 tests, 19 protocol files/314 tests, 52 Worker files/753 tests plus suites of 9 files/132 tests and 10 files/142 tests, and 30 plugin files/838 passed/1 skipped.
- Workflow validation: `actionlint` is unavailable. Ruby Psych parsed all three changed workflows. Static tests cover workflow guards and same-run calls. This does not validate GitHub Actions expressions or live workflow behavior.
- Public source checks: Release Please action v4 resolves to `5c625bfb5d1ff62eadeeb3772007f7f66fdcf071`; its README documents path outputs and PR outputs. The source confirms component tags use the configured separator and `v` prefix.
- Bootstrap: plugin `0.1.6`, Worker `0.1.0`, main SHA `eec41e68778e0d9e674d8e40c80b7c28e9ef80ed`. No runtime dependency was added.
- Worker deploy retains owner actor checks. A non-owner merge can create a release but cannot deploy. The owner must dispatch deploy.yml on main. Bot branch updates need repository Actions write permission.
- No live service call, deployment, tag, vault access, or Cloudflare change occurred.
<!-- SECTION:NOTES:END -->
