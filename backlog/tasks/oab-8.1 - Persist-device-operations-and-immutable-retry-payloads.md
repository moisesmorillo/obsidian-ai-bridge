---
id: OAB-8.1
title: Persist device operations and immutable retry payloads
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-28T19:31:00Z'
updated_date: '2026-10-28T20:14:00Z'
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

Integration evidence: implementation commit a126bbaa1d8f9911e775308337303098e91236ec was merged with main at a4ec7ffe030e5a4d367820eacdada24a8f894b7e using a normal merge, with no force push. Integrated HEAD is recorded in the recovery report. Post-merge bun run check passed: Biome checked 201 files; docs:check passed; all four workspace typechecks passed; 77 test files passed with 1,241 tests total (tooling 56, protocol 289, plugin 28, Worker 868); protocol, plugin, and Worker builds passed. Worker tests printed their expected injected network/SQLite failure diagnostics but exited 0. The Worker build used Wrangler dry-run only. No resources were deployed or changed.

Correction: the integrated HEAD is eb345883b196458e1bf8f9d8335c8202a353ad01, a merge commit with implementation parent a126bbaa1d8f9911e775308337303098e91236ec and main parent a4ec7ffe030e5a4d367820eacdada24a8f894b7e. The required post-integration bun run check completed at this HEAD and passed.

Manual implementation review at integrated commit eb345883b196458e1bf8f9d8335c8202a353ad01: inspected DeviceJournal, ObsidianDeviceStorage, canonical device-state schemas, plugin lifecycle, tests, and public protocol exports. The journal owns transitions, ordering, retries, immutable copies, and confirmed-state publication. The schema owns persisted shape validation; the host adapter owns localStorage and confined payload mechanics; main owns lifecycle fencing. No network or note mutation exists. No implementation blocker remained. TSDoc coverage was checked for changed semantic declarations, and docs:check passed. Review limits: no real Obsidian crash or two-vault test; the approved OAB-8.1 scope uses automated storage and lifecycle tests. Parent review and branch review remain pending.
<!-- SECTION:NOTES:END -->
