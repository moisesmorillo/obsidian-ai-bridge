---
id: OAB-8.10
title: Measure journal persistence cost for 1,000,001-byte payloads
status: Done
assignee:
  - '@pi'
created_date: '2026-11-02T21:59:00Z'
updated_date: '2026-11-05T03:06:00Z'
labels: []
dependencies: []
parent_task_id: OAB-8
type: task
ordinal: 53000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Hosted CI timed out on oversized Markdown publication and apply cases that persist a 1,000,001-byte payload. The plugin test timeout now allows 30,000 ms. Measure journal persistence cost during OAB-8.8 qualification so the team can judge this cost against observed device and test needs. Trigger: start this task when OAB-8.8 qualification begins.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Measure repeated journal write/enqueue, reopen or recovery, and payload-read operations for a 1,000,001-byte payload. Record runtime and environment, operation boundaries, repetition count, median and p95 elapsed time, and persisted-byte volume.
- [x] #2 Record an explicit owner decision that the measured journal cost is acceptable or unacceptable for OAB-8.8. Cite the measurements and decision rationale. If the cost is unacceptable, define a separately approved follow-up rather than changing journal behavior in this measurement task.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Follow approved plan pn-fcb085 Task 7 after OAB-40. Measure deterministic 1,000,001-byte journal enqueue/write/readback, reopen/recovery, and payload hash-verified reads with representative serialized storage. Use warm-up plus at least 20 measured repetitions and report median, nearest-rank p95, environment, operation boundaries and byte volume. Measure affected publication/apply cases. Record evidence and limits in task notes. Keep 30,000 ms timeout only with supporting measurements. Present explicit cost decision at final branch review. No journal behavior change.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Measurement run on 2026-11-05. Harness test: apps/plugin/test/device-journal.measurement.test.ts. No product source changes. The new test passed on its first run, so there is no observed RED phase. The measurement test adds checks for exact operation/read/write counts and persisted byte boundaries. This is a test-only exception: the requested behavior is an observation of existing DeviceJournal behavior, not a product feature. The isolated measurements were GREEN.

Commands and results: `bun run --cwd apps/plugin test -- test/device-journal.measurement.test.ts` passed (1 pass, 1 gated skip). `OAB_JOURNAL_MEASURE=1 bun run --cwd apps/plugin test -- test/device-journal.measurement.test.ts --silent=false --reporter=verbose` passed (2 tests) and printed timing output. `bun run docs:check` first failed on missing TSDoc for declarations in the new test. TSDoc was added and `bun run docs:check` passed. First `bun run check` failed lint due three no-non-null-assertion warnings and import order. The assertions now guard empty timing results and Biome ordered imports. Next `bunx biome check --write apps/plugin/test/device-journal.measurement.test.ts && bun run check` passed. `bun run format --write ...` was not a valid script and exited 1; `bunx biome format --write ...` was also invalid for this CLI. Correct formatting ran with `bunx biome check --write ...`.

Isolated timing results (median and nearest-rank p95, ms): 1 warm-up then 20 measured repetitions. DeviceJournal.enqueue plus payload write, mandatory storage readback and SHA-256 verification: 1.5345 / 2.1316. DeviceJournal.open with serialized state validation, verified state write and pending-op recovery: 0.0497 / 0.0678. DeviceJournal.readPayload with hash verification: 0.8719 / 1.4096. Runtime Bun 1.4.3, Node-compatible process.version v24.21.0, macOS Darwin 27.0.0 arm64, Apple M4 Pro. The deterministic payload is 1,000,001 bytes of 0x61. Storage uses JSON.stringify/parse for state and defensive in-memory Uint8Array copies for payloads.

Counter definition: persistedStateBytes sums UTF-8 JSON byteLength for every writeState call. Persisted payload bytes sum payload byteLength on each writePayload. In 20 measured runs this totals 25,240 serialized state bytes over 60 state writes, and 20,000,020 payload bytes over 20 payload writes. State counts include each run’s initial open, enqueue commit and reopen verification write. Payload count excludes reads. Values are write-volume totals, not peak storage. The contract test verifies one enqueue produces 2 state writes, 1 payload write, 2 enqueue payload reads including journal verification, then a further payload read; it asserts exact payload byte volume and nonzero state bytes.

Affected case timing: five filtered invocations each; test durations are Vitest durations, wall values include Bun/Vitest startup. Publication selector `test/publication.test.ts -t 'replaces queued inline-to-blob payload with exact current bytes'`: test duration 1781, 1835, 1855, 1916, 1925 ms. Process wall time 2137, 2175, 2190, 2286, 2609 ms. Each run passed one test with 61 skipped. Apply selector in `test/text-apply.test.ts` matched these five named cases: `preserves invalid UTF-8 bytes when oversized Markdown changes to inline text` (through feed, manifest-kind, current); `uses pinned text kind when an oversized Markdown file shrinks`; `hydrates an absent oversized Markdown rename target from its pinned blob`. Across repetitions the per-test durations in that order were: (29,22,20,16,929), (32,22,20,14,920), (30,30,22,18,926), (30,23,20,24,926), (30,22,20,15,1080) ms. Whole filtered process duration: 1.15, 1.13, 1.15, 1.15, 1.31 s. Wall duration: 1387, 1343, 1363, 1366, 1530 ms. Each invocation passed 5 matching tests and skipped 87.

Timeout recommendation: change plugin test timeout from 30,000 to 10,000 ms. The slowest selected test took 1,925 ms in repeated publication runs; slowest apply test took 1,080 ms. The slowest full filtered process took 2,609 ms, which includes process startup and is not the timeout boundary. Ten seconds leaves over five times the slowest observed test duration. No flaky performance threshold was added. This is local synthetic evidence only, not evidence of native Obsidian storage or hosted CI speed. The prior hosted timeout report remains a limit; no hosted CI rerun was available. The 10,000 ms value is a conservative local-data-backed recommendation, not a guarantee for CI.

Limits and native differences: the storage helper models JSON state serialization and byte-array payload copies. It does not model app.saveLocalStorage, filesystem durability, iCloud, device flash, Obsidian scheduling, native vault operations, or mobile hardware. Publication/apply fixtures use the existing memory vault/storage test doubles. No live vault or service was used. Timing output is opt-in and skipped in normal test runs.

Cost recommendation: keep acceptance criterion 2 OPEN for the final human branch review. Local synthetic journal costs are low (under 2.2 ms p95 per isolated boundary), and affected selected cases complete below 2 seconds each locally. This evidence supports asking the owner to accept the measured local synthetic cost, but does not establish native or hosted cost. Do not record an owner acceptance before that review. No behavior follow-up is defined because the acceptability decision remains with the owner. OAB-8.10 remains In Progress. Test suite and docs checks passed. Full check summary: lint, docs:check, all workspace typechecks, tests, and builds passed. Tests: tooling 56, protocol 305, plugin 508 with 1 gated skip, Worker 882 across three discovered test groups.

Self-review: reviewed the new test, config diff, nearby journal implementation and selected existing oversized tests. The harness uses real DeviceJournal.enqueue/open/readPayload and serializes state through JSON storage operations. Its measurements stay behind OAB_JOURNAL_MEASURE=1, so normal test runs skip timing output. Counter assertions verify payload write/read count, state write count and payload bytes. No product journal or Worker behavior changed. No self-review findings. `bun run check` passed after the final source change. Criterion 1 is supported by measurement and remains unchecked in Backlog pending the final task review; criterion 2 remains OPEN because only the owner can make the cost decision. Commit: 23b3fd64f4b6ceb3954c4ced93acaca6e3a8654d (`test(plugin): measure oversized journal persistence costs`). Only the test and Vitest timeout config are in the commit. Task notes/status and the pre-existing plan file remain uncommitted by scope. Final `git status --short` shows only the task-record notes change and pre-existing untracked plan. No staged files remain.

Task review d1ef0fc2 approved measurement source 23b3fd64f4b6ceb3954c4ced93acaca6e3a8654d with no actionable implementation defect. Review checked timing boundaries, sample statistics, serialized write counters, opt-in output and semantic documentation. Native Obsidian and hosted CI performance remain unmeasured. The 10,000 ms timeout follows repeated selected local case timings, not a CI guarantee. Criterion 2 stays open for the explicit cost decision during final human branch review.

Final owner cost decision through supervisor delegation: accept the measured local synthetic cost for OAB-8.8 with the stated evidence limits. Supporting results are the recorded 20-sample median/p95 journal boundaries and five-run oversized case timings. Retain the existing 30,000 ms plugin test timeout. The supervisor reports hosted ubuntu-latest cases ran three to five times slower than local, and the 1 MB journal tests timed out there once. This supersedes the earlier 10,000 ms recommendation, which relied on local measurements only. Native Obsidian storage and current hosted CI performance remain explicit evidence limits. No current native or hosted measurement ran. No journal behavior follow-up is needed under this accepted bounded decision. Criterion 2 now records explicit acceptance, not inferred review approval.

Final branch closure: whole-branch review 1bacac3f covered the complete branch against current main. Corrective review 88a7015d approved 0dced7590c6484ed1ed28edac87ea78f85906fee and closed R1, R2 and R3. R1 separates epoch mismatch from cursor expiry. R2 covers repeated-plan restart fallback to blob, inline text and tombstone. R3 enforces the UTF-8 recovery-name budget. Reviewers assessed state-policy ownership, contracts, changed named declarations and semantic documentation. Autosquash and current-main integration preserved task source. Human review pn-09d26f approved 3364af028bd726dfdcf5b17aca816455ec21c39d with no annotations. The supervisor separately accepted measured local cost and retained 30,000 ms. Fresh parent docs:check and bun run check passed on that source: 1,776 tests passed, one opt-in measurement skipped. Lint, type checks and builds passed. Active LSP probes found no errors in the principal changed source files. No native desktop or current hosted performance proof ran. Only task closure records change after human approval.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Measured real journal boundaries through synthetic serialized storage. The supervisor accepted the local costs with native and hosted limits. Retained 30,000 ms timeout. Independent task, whole-branch, corrective, and human reviews passed. Final checks passed 1,776 tests with one opt-in skip. No live vault or service action ran.
<!-- SECTION:FINAL_SUMMARY:END -->
