---
id: OAB-50.1
title: Rename product labels, documentation and package scopes
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-09T15:37:00Z'
updated_date: '2026-11-09T16:08:00Z'
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
- [ ] #1 A repository search for ai-bridge, obsidian-ai-bridge and "AI Bridge" outside historical records and the files owned by sibling tasks returns no match.
- [ ] #2 Release Please config and its tests produce `vaultwire-v<version>` plugin tags and keep worker tags. Existing tags and releases stay.
- [ ] #3 bun run check passes and snapshots change only in brand text.
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
Owner brief S16 and common rename rules authorize unattended execution without Plannotator. OAB-50.4 owns .github/workflows/deploy.yml. Its old package selector must become @vaultwire/worker when the sibling branch merges. This branch cannot edit that file. Existing GitHub repository links stay until OAB-50.5.

Implementation and validation evidence:
- Baseline `bun run check` passed before edits. It reported 131 test files, 2,305 passed tests, and 1 skipped test.
- RED: `bun run --filter '@obsidian-ai-bridge/tooling' test -- test/release-please-config.test.ts test/product-labels.test.ts` failed as expected. It reported 5 failed tests and 6 passed tests.
- RED: `bun run --filter '@obsidian-ai-bridge/plugin' test -- test/release.test.ts` failed as expected. It reported 2 failed tests and 23 passed tests.
- GREEN: renamed tooling tests passed 16 tests across 3 files. Protocol import tests passed 8 tests. Plugin release, lifecycle, and acceptance tests passed 188 tests. Owner and consent page tests passed 20 tests.
- Updated 6 HTML snapshots. The snapshot diff changes brand text and the owner page title only.
- `bun install --frozen-lockfile`, `bun run docs:check`, `bun run check`, and `bun run --filter '@vaultwire/worker' preflight` passed after edits.
- Full check passed 132 test files with 2,309 passed tests and 1 skipped test. Worker fault-injection tests printed expected failure logs.

Release baseline:
- The official Release Please manifest guide supports root `last-release-sha`. It never ignores this setting.
- The pin at `7ed19cca1e566e9a6975c19c4c576213f4bb79ab` limits the next release calculation to changes after the existing release baseline.
- Remove or advance the pin after the first post-rename release PR merges. The pinned value applies to every run until then.
- Package paths and versions stay unchanged. Plugin tags use `vaultwire-v`. Worker tags use `worker-v`. No tag or release changed.

Sibling-owned follow-up:
- OAB-50.4 owns `.github/workflows/deploy.yml`. Its `@obsidian-ai-bridge/worker` filter stays unchanged here. `tooling/test/deployment-config.test.ts` keeps its matching expectation until that sibling change lands.
- OAB-50.4 also owns `apps/worker/wrangler*.jsonc`. OAB-50.3 owns `apps/plugin/manifest.json` and plugin storage identifiers and paths. OAB-50.2 owns Cloudflare resource names.
- Current repository links stay unchanged until OAB-50.5. Historical plans, tasks, changelogs, tags, releases, plugin IDs, storage paths, provider identity, and synthetic vault paths stay unchanged. No live service or real vault was used.
<!-- SECTION:NOTES:END -->
