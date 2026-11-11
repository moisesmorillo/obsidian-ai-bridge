---
id: OAB-64
title: Stop the protocol runtime-isolation test timeout in CI
status: Done
assignee: []
created_date: '2026-11-11T11:33:00Z'
updated_date: '2026-11-11T11:35:00Z'
labels: []
dependencies: []
priority: low
type: bug
ordinal: 107000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Release run 43012203948 failed: test/runtime-isolation.test.ts 'allows Node globals in tooling and detects a leaky runtime config' runs two tsc compilations and exceeded the vitest 5 s default on ubuntu-latest. Same pattern as the large-payload CI timeouts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Both runtime-isolation tests declare a timeout that fits two tsc runs on CI
- [x] #2 Assertions and fixtures stay unchanged
- [x] #3 bun run check passes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
No RED test: a CI runner timeout cannot be reproduced locally. Exception recorded per AGENTS.md. Evidence: release run 43012203948 failed at 5074 ms; local check green (protocol 343, plugin 909+1 skipped, worker 883/138/162, tooling 107). Review: inline, no findings. spawnSync blocks the event loop, so Vitest only measures elapsed time; the budget does not interrupt tsc.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Gave both runtime-isolation tests a 60 s per-test budget for real tsc runs.
<!-- SECTION:FINAL_SUMMARY:END -->
