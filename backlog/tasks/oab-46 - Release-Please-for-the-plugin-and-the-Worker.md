---
id: OAB-46
title: Release Please for the plugin and the Worker
status: Done
assignee:
  - '@pi'
created_date: '2026-11-07T18:44:00Z'
updated_date: '2026-11-07T19:17:00Z'
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
- [x] #1 On push to main, Release Please opens or updates one release PR per changed component with changelog and version bump. Components without changes get no PR.
- [x] #2 Merging the plugin release PR creates tag ai-bridge-v<version> and the GitHub Release with main.js and manifest.json, inside the same workflow run. package.json, manifest.json and versions.json agree and release.ts validation passes.
- [x] #3 Merging the worker release PR creates tag worker-v<version> and deploys the Worker with the existing preflight and owner-only guard. Push to main no longer deploys by itself.
- [x] #4 Tests cover the versions.json sync step and the deployment config. bun run check green. Workflow files validated with actionlint or an equivalent offline check if available without a new runtime dependency.
- [x] #5 docs/plugin-release.md and the Worker deployment docs describe the new flow. Backlog notes record the bootstrap versions.
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

Completion: all implementation, tests, documentation, task review, and branch review steps completed. Parent accepted both finding closures. Publication follows with the owner-requested PR.
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

Review correction at revision 8ef4faf3cd9db7ca33e4a3ba1a62d5ef07c3679f:
- Closed finding [MAJOR] Plugin compatibility sync depended on plugin-created being false. The verified Release Please action omits false for unreleased components, so the old condition skipped the sync.
- The job now starts when `pull-requests` output is nonempty and not `[]`, independent of plugin-created. Its step still selects only PRs with files under `apps/plugin/`.
- Added RED cases for a missing plugin-created output with a plugin PR, and a Worker release plus plugin PR in one run. RED: `bun run --filter '@obsidian-ai-bridge/tooling' test -- tooling/test/release-please-config.test.ts` failed at the old workflow gate in both cases.
- GREEN: the same focused test passed, 4 tests. Final `bun run check` passed, including 9 tooling test files/96 tests, 19 protocol files/314 tests, 52 Worker files/753 tests plus 9 files/132 tests and 10 files/142 tests, and 30 plugin files/838 passed/1 skipped.
- Final Worker preflight passed: `bun run --filter '@obsidian-ai-bridge/worker' preflight`.
- No live calls, deployment, tag creation, vault access, or Cloudflare changes occurred. Parent owns re-review.

Whole-branch review correction at revision 1df0c34567e5b8f6a13270089c292db548ad4791:
- Closed finding [MAJOR] Bootstrap version assertions blocked future release PRs. The live release manifest now compares with the plugin manifest version and Worker package version. No current version literals remain in these live metadata checks. The fixed bootstrap SHA check and release policy assertions remain.
- Added synthetic version fixtures derived from current metadata. Tests accept plugin-only, Worker-only, and combined future patch bumps without changing tracked release metadata. Plugin or Worker release-manifest mismatches fail the alignment assertion.
- RED: the mismatch cases failed because the future-version helper did not increment versions. Corrected the helper to increment the patch suffix. GREEN: `bun run --filter '@obsidian-ai-bridge/tooling' test -- tooling/test/release-please-config.test.ts` passed, 9 tests.
- Final `bun run docs:check` passed. Final `bun run check` passed: tooling 101 tests, protocol 314 tests, Worker 753 plus 132 and 142 tests, plugin 838 passed and 1 skipped. Type checks and builds passed.
- Final Worker preflight passed: `bun run --filter '@obsidian-ai-bridge/worker' preflight`.
- No tracked release metadata changed. No live call, deployment, tag, push, vault access, or Cloudflare change occurred. Parent owns scoped re-review.

Final review acceptance: task review and whole-branch review completed. Both MAJOR findings received fixes and scoped approval. Final reviewed code revision: 9a625cb23ba5b6780e8da1b7e44d1e0e06ba1578. Documentation scope: plugin release guide, Worker deployment section, spec tooling statement, and TypeScript declaration contracts. Review found cohesive release orchestration, reusable build/publication and deployment ownership, and compatibility-map tooling. Final validation evidence appears above. git diff --check passed. No open actionable findings remain. Limits: no live workflow execution, no actionlint, and future-version regression cases use synthetic metadata. Owner explicitly excluded live calls. Acceptance checks describe offline implementation and test evidence, not observed production releases. Rebase on origin/main made no changes.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added manifest-mode component release PRs, same-run reusable release workflows, tested plugin compatibility-map synchronization, and release documentation. Final local checks and Worker preflight passed. Independent reviews closed two release-flow defects. Production behavior remains untested because the owner excluded live calls. Owner must allow Actions PR creation and retain deployment secrets. Non-owner Worker release merges need owner dispatch.
<!-- SECTION:FINAL_SUMMARY:END -->
