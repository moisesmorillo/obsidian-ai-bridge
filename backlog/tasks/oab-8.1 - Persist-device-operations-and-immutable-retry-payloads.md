---
id: OAB-8.1
title: Persist device operations and immutable retry payloads
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-28T19:31:00Z'
updated_date: '2026-10-28T20:09:00Z'
labels: []
dependencies:
  - OAB-7
documentation:
  - docs/spec.md
parent_task_id: OAB-8
ordinal: 39000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A desktop restart must not change an operation that might reach the server. Deliver the device-local journal and durable payload storage before any network publisher exists. This is one focused PR. Covers the durable foundation of section 7.1 and AC-30, not the full F3 device gate.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Device-local state uses one validated localStorage document with write read-back checks. Missing state creates a device identity. Invalid or failed storage preserves prior state and blocks operation release.
- [ ] #2 Before an operation becomes sent, its payload exists at .ai-bridge/pending/<key> and passes SHA-256 verification. Restart returns the same key, bytes, path, and precondition.
- [ ] #3 A newer edit replaces only a queued operation with a fresh UUIDv7 key. An edit behind a sent operation stays separate and cannot become sendable before its predecessor resolves.
- [ ] #4 Tests cover corrupt state, write failure, payload failure, restart, and concurrent queue requests. Plugin load performs no network or note mutation. bun run check passes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implement docs/superpowers/plans/2026-10-28-device-journal.md after owner approval. Use one implementer subagent for RED/GREEN, host integration, bun run check, and commit. Review once per task, then review the whole branch and open the human branch review before the PR. Stop after this PR.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Recovery: the prior worker session ended when the owner closed the Orca tab. Its earlier RED output is unavailable, so no earlier RED evidence is claimed. I preserved the recovered implementation, tests, all eight OAB-8.2 through OAB-8.8 subtask files, and the OAB-8 parent update. I added focused regressions and observed these RED results against the recovered implementation: plugin device-journal tests failed 3 assertions for mutable inputs, attention-blocked retry, and rename-destination ordering; lifecycle tests failed the stale open-after-unload assertion; protocol schema tests failed the same-source-and-destination rename assertion; journal tests failed for sending a persisted resolved operation. An initial lifecycle run timed out because its deferred localStorage test double blocked read-back. I corrected the test double, reran, and observed the intended lifecycle failure. GREEN: plugin tests 28 passed; protocol tests 289 passed; documentation check passed. Before final integration, bun run check passed with 201 Biome files, all workspace typechecks, 56 tooling tests, 289 protocol tests, 27 plugin tests, 868 Worker tests, and all builds. It ran before the final resolved-operation guard and needs to run again after integration.
<!-- SECTION:NOTES:END -->
