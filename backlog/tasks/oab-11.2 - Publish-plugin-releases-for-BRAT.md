---
id: OAB-11.2
title: Publish plugin releases for BRAT
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-05T23:19:00Z'
updated_date: '2026-11-05T23:50:00Z'
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

## Review round 1 corrections

- MAJOR finding closure: the `build` job now has only `contents: read`. Checkout, frozen install, metadata validation, `bun run check`, and artifact upload run only in this job. The dependent `publish` job alone has `contents: write`. It checks out the event commit, verifies the event and remote tag commits, downloads the checked artifact, and runs only release-view/create commands. It runs no repository script, dependency install, or build code. The artifact contains exactly `manifest.json` and `main.js`.
- MINOR finding closure: publication-shell tests execute the actual tag verification shell. They cover annotated refs, matching lightweight direct refs, mismatched annotated and lightweight commits, missing refs, and event/check-out commit mismatch. The non-creating `gh` stub records no release on every refusal.
- Before pinning artifact actions, read-only GitHub API checks confirmed `actions/upload-artifact` commit `cf430e030ddbb5b0abf93d22962f4752f3646cd9` and `actions/download-artifact` commit `9000827ccba6bdab643e8b6fd33ac0654aef8333`. Both action manifests identify GitHub as author, use the Node 24 runner, and point to present bundled runtime files. `git ls-remote` confirmed the stable `v7.0.2` and `v8.0.2` tags resolve to those pinned commits.
- Correction RED: `bun run --cwd apps/plugin test test/release.test.ts` failed the new build/publish permission and artifact contract test against the old single-job workflow. The other 19 tests passed.
- Correction GREEN: the same focused command passed all 20 tests after the job split and direct lightweight-ref test changes.
- `bun run docs:check` passed. Final `bun run check` passed after the corrections. Biome checked 266 files; documentation checks and all four workspace type checks passed. Tooling passed 91 tests, protocol passed 307, plugin passed 689 with 1 skipped, and worker passed 702 + 122 + 115. All builds passed. Worker tests printed injected network and SQLite failure diagnostics but exited 0.
- Review finding limits: no live tag or release was created. Artifact transfer and GitHub release actions were checked by configuration and local stubs, not a live GitHub run. No BRAT install or mobile trial ran. OAB-11.2 remains In Progress.
<!-- SECTION:NOTES:END -->
