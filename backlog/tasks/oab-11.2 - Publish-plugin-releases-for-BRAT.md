---
id: OAB-11.2
title: Publish plugin releases for BRAT
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-05T23:19:00Z'
updated_date: '2026-11-05T23:35:00Z'
labels: []
dependencies: []
parent_task_id: OAB-11
ordinal: 63000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
F5 preparation needs release assets for BRAT on copied mobile vaults. The owner authorized this preparation on 2026-11-05. Mobile trials stay gated by OAB-11 and separate owner approval.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A plugin-v<version> tag starts a checked build and publishes manifest.json and main.js as release assets.
- [ ] #2 The workflow rejects tag, manifest, and compatibility mapping mismatches before publication.
- [ ] #3 The compatibility map holds the current manifest version and minAppVersion. The manifest keeps isDesktopOnly false.
- [ ] #4 The release guide explains owner tags, BRAT installation, and the separate mobile trial gate.
- [ ] #5 Automated release checks and bun run check pass. No tag or release is created during this task.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Get approval for the external plan at /tmp/oab-11.2-brat-release-plan.md, including the validator and test write-scope extension. 2. Add failing release metadata and publication command tests. 3. Add the validator, tag-only workflow, compatibility map, and owner BRAT guide. 4. Run bun run docs:check and bun run check. Complete independent task and branch reviews. 5. Get the Plannotator branch review, close OAB-11.2, push one pull request, remove the worktree, and stop. Never create a tag or release in this session.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parallel F5 preparation follows the owner brief F5A-release.md dated 2026-11-05. OAB-11 stays To Do and F4 stays active. No vault access, service mutations, Cloudflare changes, or deploy.yml changes are authorized. No new dependency is planned.

## Implementation evidence

- Scope changed only `.github/workflows/release.yml`, `apps/plugin/versions.json`, `apps/plugin/tools/release.ts`, `apps/plugin/test/release.test.ts`, `docs/plugin-release.md`, and this OAB-11.2 task record. No package scripts, dependencies, manifest, runtime source, deploy workflow, or vault/service resources changed. The manifest still has `isDesktopOnly: false`.
- RED: `bun run --cwd apps/plugin test test/release.test.ts` first exposed a test harness mistake because Vitest runs under Node, not Bun. After replacing Bun globals with Node APIs, the same command failed 5 tests and passed 10. The failures showed the validator and release workflow did not exist.
- GREEN: `bun run --cwd apps/plugin test test/release.test.ts` passed 17 tests, including metadata rejection, CLI file/JSON failures, failed-check propagation, checked and remote commit mismatch, existing-release refusal, and exact release assets. The GitHub CLI test stub creates no release.
- `bun run docs:check` passed. `bun run check` first found import-order and regex-spacing issues. Biome fixed them. The final `bun run check` passed after merge of `origin/main` at `54ad88e`.
- Final full check: Biome passed on 266 files; docs check passed; all four workspace type checks passed; tooling tests passed 91, protocol tests passed 307, plugin tests passed 686 with 1 skipped, and worker tests passed 702 + 122 + 115. All builds passed. Worker tests printed expected injected network and SQLite failure diagnostics but all test commands exited 0.
- The checked branch includes the fast-forward integration of `origin/main` at `54ad88e`, which changed coexistence and vault runtime files. This task made no edits to those files.
- Evidence limits: release shell tests use local git and non-creating `gh` stubs. No real GitHub release, tag push, remote publication, BRAT install, device test, or mobile trial ran. The owner creates tags and releases only after merge and separate OAB-11 approval.
<!-- SECTION:NOTES:END -->
