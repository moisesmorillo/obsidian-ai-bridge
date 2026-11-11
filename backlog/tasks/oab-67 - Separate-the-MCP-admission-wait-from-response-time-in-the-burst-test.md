---
id: OAB-67
title: Separate the MCP admission wait from response time in the burst test
status: Done
assignee: []
created_date: '2026-11-11T15:48:00Z'
updated_date: '2026-11-11T15:49:00Z'
labels: []
dependencies: []
priority: low
type: bug
ordinal: 109000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
CI run 43050594663 (PR #179, plugin-only change) failed in apps/worker/test/mcp-burst.test.ts: elapsed 2055 ms and 2006 ms against a 2000 ms bound. The spec bounds only the MCP admission wait (MCP_ADMISSION_WAIT_MS = 2000). The test measured the whole request: the wait, plus the operation work, plus CI timer jitter. Main Check failed 5 of the last 30 runs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The burst test bounds request time by MCP_ADMISSION_WAIT_MS plus a named, documented response margin
- [x] #2 All other burst assertions stay unchanged
- [x] #3 bun run check passes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
No RED test: a CI timing flake does not reproduce locally. Exception recorded per AGENTS.md. Evidence: run 43050594663 measured 2055 ms and 2006 ms against 2000 ms. The spec (docs/spec.md, MCP admission) bounds only the admission wait at 2,000 ms. The test now allows MCP_ADMISSION_WAIT_MS plus RESPONSE_MARGIN_MS (1,000 ms) for work, response, and CI timer jitter. Local check green (worker 883/138/162). Inline review: no findings.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Bounded burst request time by the admission wait plus a named response margin.
<!-- SECTION:FINAL_SUMMARY:END -->
