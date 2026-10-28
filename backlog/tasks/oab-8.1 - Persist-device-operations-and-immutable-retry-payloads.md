---
id: OAB-8.1
title: Persist device operations and immutable retry payloads
status: Done
assignee:
  - '@pi'
created_date: '2026-10-28T19:31:00Z'
updated_date: '2026-10-28T20:50:00Z'
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
- [x] #1 Device-local state uses one validated localStorage document with write read-back checks. Missing state creates a device identity. Invalid or failed storage preserves prior state and blocks operation release.
- [x] #2 Before an operation becomes sent, its payload exists at .ai-bridge/pending/<key> and passes SHA-256 verification. Restart returns the same key, bytes, path, and precondition.
- [x] #3 A newer edit replaces only a queued operation with a fresh UUIDv7 key. An edit behind a sent operation stays separate and cannot become sendable before its predecessor resolves.
- [x] #4 Tests cover corrupt state, write failure, payload failure, restart, and concurrent queue requests. Plugin load performs no network or note mutation. bun run check passes.
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

MAJOR review finding closure: fixed queued-operation ordering in DeviceJournal.prepareSend. It now rejects a candidate when any earlier unresolved operation conflicts by canonical pathKey identity across source and rename destination paths. This blocks queued rename A-to-B before queued edits to B, earlier source and destination operations before a later rename, and case variants that share pathKey. Sent operation metadata and exact paths remain unchanged. Queue coalescing now replaces only the latest safe same-type queued operation. It retains an older queued operation when a later unresolved operation depends on it, so replacing that operation cannot move dependent work ahead. RED: bun run --cwd apps/plugin test -- test/device-journal.test.ts failed 5 new assertions (queued rename destination, case identity, reverse source overlap, reverse destination overlap, and coalescing order). After the first correction, the case-alias test exposed that same-path puts correctly coalesced, so I changed that fixture to use a case-variant path overlapping a queued rename source. GREEN: focused suite passed 25/25. bun run docs:check passed. bun run check first found Biome import and formatting issues, which I fixed. The next full bun run check passed: 201 Biome files, all four workspace typechecks, 1,247 tests across 77 files (tooling 56, protocol 289, plugin 34, Worker 868), all builds. Finding is fixed at source and regression tests, not deferred.

MINOR review finding closure: corrected packages/protocol/test/device-state.test.ts so duplicate-key validation uses a version-1 state. The test now also proves that the matching single-operation state is valid. Unsupported-version rejection stays in its own assertion. Negative control: temporarily removed the DeviceStateSchema unique-key refinement, then ran bun run --cwd packages/protocol test -- test/device-state.test.ts. It failed at the duplicate-key assertion with expected false and received true, while the other six tests passed. Restored the schema source and reran the focused protocol test successfully: 7/7. The restored schema has no diff. bun run docs:check passed. The first full check found one formatting issue in the test. Biome fixed it. The final bun run check passed with all 1,247 tests across 77 files, all workspace typechecks, and all builds. No product behavior changed.

Independent task review found the overlapping-operation send barrier gap. Correction 7d2975d passed scoped review with APPROVE. Final whole-branch review examined all 21 changed files against main a4ec7ff at 7d2975d. It found no blocking implementation issue and one MINOR duplicate-key test masking issue. Correction 1c2a527 uses version 1 and a positive single-operation assertion. Scoped re-review confirms fixed with no production or schema change. Structural candidates: DeviceJournal owns transitions and the ordering matrix; adapter owns persistence mechanics; protocol owns persisted validation and path identity; main owns lifecycle fencing. Documentation scope includes all changed semantic declarations, tests, plan, and task decomposition. Full checks passed with 1247 tests across 77 files. Limits: no real Obsidian crash, two-vault, OAuth, revoked-device, or ChatGPT proof. Those remain in later OAB-8 tasks. Human branch review is next.

Owner approved the complete branch diff in Plannotator pn-7478de with no changes requested. Acceptance evidence: AC1 uses schema corruption, missing state, dropped writes, throwing storage, and read-back tests. AC2 uses payload integrity and restart retry tests. AC3 uses UUIDv7 replacement, immutable sent bytes, predecessor ordering, rename overlap, and canonical path tests. AC4 uses storage, concurrency, and lifecycle tests plus the final full check: 1247 tests across 77 files, all typechecks and builds. Main a4ec7ff is an ancestor of this branch. No deployment or resource change occurred.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added the durable desktop device journal, verified localStorage persistence, immutable payload files, serialized queue transitions, and lifecycle fencing. Added canonical protocol schemas and failure/restart regressions. Full checks passed with 1247 tests. Independent task and whole-branch reviews passed after corrections. Owner approved the branch diff. Full device synchronization and F3 proof remain in OAB-8.2 through OAB-8.8.
<!-- SECTION:FINAL_SUMMARY:END -->
