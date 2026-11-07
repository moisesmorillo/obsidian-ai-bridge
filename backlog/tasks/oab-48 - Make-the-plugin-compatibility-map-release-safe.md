---
id: OAB-48
title: Make the plugin compatibility map release-safe
status: In Progress
assignee: []
created_date: '2026-11-07T21:33:00Z'
updated_date: '2026-11-07T22:44:00Z'
labels:
  - ci
  - release
  - plugin
dependencies: []
priority: high
type: bug
ordinal: 83000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Incident 2026-11-07: the plugin release PR #110 merged without the versions.json entry. Release Please force-updates its PR branch on every run, which drops the sync commit, and the sync job ran after the owner had merged (couldn't find remote ref). Result: tag ai-bridge-v0.2.0 and an empty GitHub Release, because 'Validate release metadata' failed on the tag. Hotfix: PR #112 records 0.2.0 by hand and the supervisor re-tags. Fix the design so the release PR never depends on a race: Option A (preferred): the release-plugin build job writes the versions.json entry from manifest.json on the tag checkout, validates manifest version against the tag and minAppVersion presence, builds, publishes, and then opens or pushes a chore commit to main that records the entry (chore type, no release bump). Remove the sync-plugin-compatibility job. Option B: keep the sync job but make it idempotent and retried, and make the release validation tolerate a missing entry by deriving it. Choose A unless a blocker appears. Keep release.ts strict about manifest.version equal to the tag version.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The release-plugin workflow succeeds on a tag whose versions.json lacks the entry, publishes main.js and manifest.json, and records the entry on main with a chore commit.
- [x] #2 The sync-plugin-compatibility job is removed or made idempotent with a documented retry. No workflow step depends on a release PR branch that may already be merged.
- [x] #3 Tests cover the writer, the validator and the workflow expectations. docs/plugin-release.md describes the flow.
- [x] #4 bun run check green. No new dependency.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Goal
Make plugin releases independent of release PR compatibility-map races.

## Owner decisions
Use option A from OAB-48. No Plannotator gates, live calls, releases, tags, Worker edits, or new dependencies. Keep exact tag-to-manifest validation. Use the workflow token for the post-publication chore commit. If main rejects the push, preserve the entry through a chore PR. Do not change git identity in this session.

## Implementation
- [ ] Add regression tests in the three named test files. Prove missing tag entries work after the writer, strict tag validation stays intact, and workflow order preserves tag metadata.
- [ ] Run the focused tests and record the expected failures before production edits.
- [ ] Write the tag compatibility entry before validation in release.yml. Build and publish only checked assets. Record the published tag entry on fresh main without replacing its manifest or losing earlier entries. Handle duplicate runs and rejected pushes safely.
- [ ] Remove sync-plugin-compatibility from release-please.yml and grant the reusable workflow the needed PR permission.
- [ ] Update release.ts and release-versions.ts only where the contract needs it. Update docs/plugin-release.md with ordering, retries, and fallback limits.
- [ ] Run focused tests, docs checks, and bun run check. Complete independent task and branch reviews. Correct each actionable finding.
- [ ] Rebase on origin/main. Close OAB-48 with local evidence and live-test limits. Push and open one PR against main. Remove the worktree and report the URL.

## Review focus
Missing tag map entry, exact tag mismatch, conflicting historical entry, newer main manifest, concurrent main changes, retry after publication, and token or branch-policy rejection.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
RED: focused plugin tests observed 1 failure (23 passed). Tooling tests observed 2 failures (6 passed).
GREEN: focused plugin tests passed (25); tooling tests passed (8). `bun run docs:check` passed. `bun run check` passed lint, docs, typecheck, 2,282 tests, one skipped test, and builds.
Local Git workflow test confirmed that the tag manifest updates fresh main, preserves newer main metadata, and supports an idempotent rerun. No live release, tag, deployment, vault, or service access.

Round 1 fixes: the publish job now installs the pinned mise toolchain. Retry publication checks existing assets byte for byte, skips exact matches, uploads missing assets, and rejects mismatches. Fake-GH shell tests cover matches, mismatch, and partial upload. A local bare Git test blocks main pushes and confirms the chore branch and PR command.
Focused GREEN: plugin release tests passed (28); tooling release test passed (8). `bun run docs:check` passed. `bun run check` passed all checks, 2,285 tests, one skipped test, and builds. No live calls.

Final branch review F1 fix: when no open PR exists, the workflow validates a remote fallback branch before reuse. It requires the expected single chore commit, only the compatibility-map path, and the exact map derived from current main. Conflicting branches stop without changes.
Test `reuses a matching fallback branch after PR failure and refuses unrelated changes` reproduced non-fast-forward on RED, then passed on GREEN. Fake GitHub and local bare Git confirm retry creates the missing PR with the same branch hash and rejects unrelated edits. No live calls.

F1 validation also confirms full Git history is available before the workflow checks ancestry. Final focused runs passed: plugin release tests 28, tooling release test 8. `bun run docs:check` passed. `bun run check` passed with private TMPDIR: lint, docs, typecheck, 2,290 tests, one skipped test, and builds. No live calls.

Final review: reviewed da71681..6b28890. Bun setup and asset retry findings closed. Fix c6cce4b adds fallback branch reuse after a failed PR request. Scoped review found a remaining blocker: if main adds another compatibility entry before retry, the expected map uses current main and rejects the valid older fallback branch. The merge-base file diff itself excludes later main changes. No unsafe overwrite occurs, but recovery stops. A further correction must validate the fallback commit against its own parent and check current-main compatibility separately. Add a local regression with failed PR creation, then a new main map entry, then retry. Owner brief directs a draft PR for real blockers. AC1 remains unchecked. No more implementation in this session after the final review fix wave.
Validation: bun run check passed after rebase with private TMPDIR. Final worker check at c6cce4b passed 2290 tests with one skip, lint, docs, typecheck, and builds. One earlier shared-TMPDIR check failed in unchanged Worker deploy-preflight.bun.ts because a concurrent temporary directory disappeared. No Worker edits, dependencies, live service calls, tags, releases, or deployments.

Final blocker fix: the workflow now compares the fallback map with its own parent plus the tag entry. It separately checks that current main accepts the tag entry without conflict. Later main entries no longer reject a valid fallback branch. Conflicting main maps and unrelated fallback branch changes still stop without branch edits.
RED: `bun run --filter '@obsidian-ai-bridge/plugin' test -- test/release.test.ts` observed 1 failing regression test and 23 passed tests. GREEN: plugin release tests passed (28), tooling release test passed (8), and `bun run docs:check` passed. The test `reuses a fallback branch after main moves and refuses unrelated changes` checks the failed PR retry, later main entry, unchanged fallback hash, conflict refusal, and unrelated branch refusal.
`bun run check` passed with private TMPDIR. Lint, docs, typecheck, builds, and 2,290 tests passed. One test was skipped. No live calls.
<!-- SECTION:NOTES:END -->
