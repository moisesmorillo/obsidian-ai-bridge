---
id: OAB-50.1
title: Rename product labels, documentation and package scopes
status: Done
assignee:
  - '@pi'
created_date: '2026-11-09T15:37:00Z'
updated_date: '2026-11-09T16:39:00Z'
labels:
  - rename
dependencies: []
parent_task_id: OAB-50
type: chore
ordinal: 86000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Repository obsidian-ai-bridge. Scope: visible plugin name and settings text, owner console brand and titles, consent page, README, docs/spec.md and docs/api, package names to `@vaultwire/*` and the root package to `vaultwire`, workspace imports of published package names, Release Please components and tag prefix (plugin tags become `vaultwire-v*`), and AGENTS.md product references. Out of scope: the plugin manifest id and plugin data storage (sibling task), Worker wrangler configs and the deploy workflow (sibling task). Internal path aliases such as `@protocol/*`, `@worker/*` and `@plugin/*` stay.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A repository search for ai-bridge, obsidian-ai-bridge and "AI Bridge" outside historical records and the files owned by sibling tasks returns no match.
- [x] #2 Release Please config and its tests produce `vaultwire-v<version>` plugin tags and keep worker tags. Existing tags and releases stay.
- [x] #3 bun run check passes and snapshots change only in brand text.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
# Vaultwire labels and packages implementation plan

Goal: Rename current product labels, documentation, published packages, and plugin release tags to Vaultwire.
Architecture: Keep existing runtime behavior and internal aliases. Change names at public text, package, and release boundaries.
Tech Stack: TypeScript, Bun, Vitest, Release Please.
Spec: Owner brief S16-vw-labels.md, V-COMMON.md, and docs/spec.md.

## Owner decisions
The owner fixes the product name as Vaultwire and the tagline as Self-hosted vault sync and storage, with MCP tools for AI agents.
Use @vaultwire/* packages and root package vaultwire. Keep versions and worker-v tags. Use vaultwire-v plugin tags.
No compatibility layer. Keep historical records, releases, tags, CHANGELOG entries, and plan files unchanged.
Skip Plannotator as the owner brief directs. Use offline tests only. No deployment, Cloudflare changes, or real vault access.
Keep the current Git remote and repository links until OAB-50.5.
Sibling-owned manifest, plugin storage, wrangler configs, and deploy workflow stay unchanged.
Regenerate bun.lock only for workspace package names. No new dependency.

## Review focus
Release Please must keep the current plugin version baseline despite its new component name.
Tag parsing, workflow triggers, release artifacts, and tests must agree on vaultwire-v tags.
Package filters, dependencies, exports, imports, and lockfile must agree on @vaultwire names.
Visible strings change without storage keys, protocol shapes, or sync behavior changes.
Document sibling cutover names without changing historical records or the current Git remote.

## Task 1: Complete OAB-50.1
- [ ] Read owned surfaces, release tooling, tests, spec sections, and package references.
- [ ] Add failing offline tests for Vaultwire labels, package names, tag generation, and release baseline safety.
- [ ] Run targeted tests and record the expected failures before implementation.
- [ ] Rename owned labels, current documentation, package names, and published imports. Keep private aliases unchanged.
- [ ] Change plugin release component and tooling to vaultwire-v. Keep path-based manifest keys and versions when paths stay unchanged.
- [ ] Make the release baseline explicit with supported Release Please configuration. Test it without creating or changing tags.
- [ ] Update package selectors and release workflow references within ownership. Record sibling-owned selectors for OAB-50.4.
- [ ] Run targeted tests, bun run docs:check, bun run check, and the renamed worker preflight command.
- [ ] Commit the task. Get one task review and one complete branch review with the code-review TypeScript profile.
- [ ] Close each finding with evidence. Rebase onto origin/main, close the task, push, and open the named PR.
- [ ] Remove the isolated worktree after publication.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner brief S16 and common rename rules authorize execution without Plannotator. OAB-50.4 owns `.github/workflows/deploy.yml`. Its package selector must become `@vaultwire/worker` when that sibling change lands. This branch does not edit that file. Current repository links stay until OAB-50.5.

Implementation and validation evidence:
- Baseline `bun run check` passed before edits. It reported 131 test files, 2,305 passed tests, and 1 skipped test.
- Initial RED tests failed as expected. Tooling reported 5 failed and 6 passed tests. Plugin release tests reported 2 failed and 23 passed tests.
- GREEN targeted tests passed: tooling passed 17 tests across 3 files. Protocol import tests passed 8 tests. Plugin release, lifecycle, and acceptance tests passed 188 tests. Owner and consent page tests passed 20 tests.
- Updated 6 HTML snapshots. The snapshot diff changes brand text and the owner page title only.
- `bun install --frozen-lockfile`, `bun run docs:check`, `bun run check`, and `bun run --filter '@vaultwire/worker' preflight` passed after the rebrand.
- Review round 1 found that a Worker-only release PR could permit early removal of the shared root pin while the plugin still had only legacy tags.
- RED for the corrective test: `bun run --filter '@vaultwire/tooling' test -- test/release-please-config.test.ts` reported 1 failed and 8 passed tests because the release guide allowed removal after any post-rename release PR.
- GREEN for the corrected policy: `bun run --filter '@vaultwire/tooling' test -- test/release-please-config.test.ts test/product-labels.test.ts test/deployment-config.test.ts` passed 17 tests across 3 files.
- Final `bun run docs:check` passed. Final `bun run check` passed 132 test files, 2,310 tests, and 1 skipped test. A formatting issue in an earlier run was fixed with Biome before this check.
- Final `bun run --filter '@vaultwire/worker' preflight` passed. Worker fault-injection tests printed expected failure logs.

Release baseline policy:
- The official Release Please manifest guide says root `last-release-sha` is top-level only and never ignored. The shared pin applies to both release components.
- The test covers a Worker-first state with `worker-v0.5.1` and only legacy plugin tag `ai-bridge-v0.2.1`. The pin stays configured in this state.
- The pin can be removed only after a `vaultwire-v*` plugin release is published. A Worker-only release PR does not meet this condition.
- The pin remains `7ed19cca1e566e9a6975c19c4c576213f4bb79ab`. Package paths and versions stay unchanged. Worker tags stay `worker-v`. No tag or release changed.

Sibling-owned follow-up:
- OAB-50.4 owns `.github/workflows/deploy.yml` and `apps/worker/wrangler*.jsonc`. The deploy selector and its test expectation stay unchanged here.
- OAB-50.3 owns `apps/plugin/manifest.json` and plugin storage identifiers and paths. OAB-50.2 owns Cloudflare resource names.
- Current repository links stay unchanged until OAB-50.5. Historical plans, tasks, changelogs, tags, releases, plugin IDs, storage paths, provider identity, and synthetic vault paths stay unchanged. No live service or real vault was used.

Root pin source check:
- The official manifest guide says `last-release-sha` applies only at the root and is never ignored. `src/manifest.ts` passes this root value to shared manifest options, then stops commit collection at that SHA. Both components use this shared baseline. See https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md and https://github.com/googleapis/release-please/blob/main/src/manifest.ts.

Final whole-branch correction evidence:
- The branch review found fixed assertions for live versions and a cutover paragraph that allowed a fresh namespace and skipped migration.
- RED for release metadata: simulated plugin `0.2.2`, Worker `0.5.1`, and matching Release Please manifest values. `bun run --filter '@vaultwire/tooling' test -- test/release-please-config.test.ts` failed 2 tests as expected. Fixed assertions had expected `vaultwire-v0.2.1` and `worker-v0.5.1`.
- GREEN for release metadata: the same temporary version fixture passed all 9 release configuration tests after the test refactor. The temporary metadata files were restored. No version or tag changed in the branch.
- The plugin-only, Worker-only, and combined future-version cases now call `expectReleaseConfigurationMatchesMetadata`, which checks component settings, version alignment, package paths, and tag families.
- The only fixed version tag in the worker-first fixture is historical plugin tag `ai-bridge-v0.2.1`. The Worker-first next tag and first Vaultwire plugin tag derive from current metadata.
- RED for cutover documentation: the new product-label test failed against the old fresh-namespace and no-migration statement.
- GREEN for both findings: `bun run --filter '@vaultwire/tooling' test -- test/release-please-config.test.ts test/product-labels.test.ts test/deployment-config.test.ts` passed 18 tests across 3 files.
- `docs/api/f2.md` now marks the four-note count as historical and states the OAB-50.4 namespace transfer and OAB-50.6 object-copy, checksum, cursor, and file-set duties. README history remains unchanged because it already limits the count to evidence recorded at that time and does not waive migration.
- Final `bun run docs:check` passed. Final `bun run check` passed 132 test files, 2,311 tests, and 1 skipped test. Final `bun run --filter '@vaultwire/worker' preflight` passed.
- No sibling implementation files, live service, vault, tag, release, deployment, or Cloudflare resource changed.

Review closure at 85acf64:
- Task review found early shared-pin removal. Commit daefc87 fixes the policy. The scoped reviewer approved the fix.
- Complete branch review covered 175 files at daefc87 against 7ed19cc. It found fixed live-version assertions and unsafe cutover guidance.
- Commit 85acf64 fixes both findings. The final scoped reviewer approved daefc87..85acf64 with no open actionable finding.
- Review covered public package boundaries, release state policy, named TypeScript helper contracts, current documentation, and brand-only snapshot changes.
- Final evidence: 132 test files, 2,311 tests passed, one test skipped. Documentation check and Worker preflight passed.
- Repository name matches remain only in historical records, sibling-owned names and tests, existing repository links, provider identity, and storage or synthetic path contracts. Owner scope preserves these names.
- Release pin regression checks local configuration and policy, not the Release Please engine. No live release or production transfer check occurred.
- Main remained at 7ed19cc during final review. The branch rebase reports no changes.
- Publication follows this closure commit. Keep the release pin until Release Please publishes the first vaultwire-v plugin release. OAB-50.4 must change the deploy workflow package selector before cutover.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Renamed current labels, documentation, published package names, imports, selectors, and plugin release tags to Vaultwire. Kept versions, private aliases, historical records, and sibling-owned contracts unchanged. Added regression tests for release baselines, future version updates, labels, and safe cutover guidance. All review findings are closed. Full check: 2,311 tests passed and one skipped. Worker preflight passed. No deployment, Cloudflare resource change, or real vault access occurred.
<!-- SECTION:FINAL_SUMMARY:END -->
