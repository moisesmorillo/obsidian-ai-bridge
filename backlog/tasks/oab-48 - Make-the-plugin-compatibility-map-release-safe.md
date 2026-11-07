---
id: OAB-48
title: Make the plugin compatibility map release-safe
status: To Do
assignee: []
created_date: '2026-11-07T21:33:00Z'
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
- [ ] #2 The sync-plugin-compatibility job is removed or made idempotent with a documented retry. No workflow step depends on a release PR branch that may already be merged.
- [ ] #3 Tests cover the writer, the validator and the workflow expectations. docs/plugin-release.md describes the flow.
- [ ] #4 bun run check green. No new dependency.
<!-- AC:END -->
