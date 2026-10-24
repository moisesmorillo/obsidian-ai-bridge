---
id: OAB-7.1
title: Reduce F1 extension-case integration test work
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-24T00:05:00Z'
updated_date: '2026-10-24T14:30:00Z'
labels:
  - F2
  - tests
dependencies:
  - OAB-6
documentation:
  - docs/spec.md
parent_task_id: OAB-7
type: chore
ordinal: 7100
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
OAB-7 criterion 4 addresses repeated exhaustive extension matrices after F1. The actual HTTP matrix is in http/search.test.ts. Inspect the named http/files.test.ts without inventing missing work. Preserve exhaustive classification only in the protocol unit test.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Worker extension matrices use at most four forms per extension. HTTP writes and SQLite lifecycle runs use representative forms only.
- [ ] #2 The full ASCII case matrix remains in packages/protocol/test/files.test.ts for classifyFilePath. Threshold, range, FTS, near-match, and lifecycle assertions remain.
- [ ] #3 Parameterized test count and measured focused runtime decrease against the same baseline commands. Record workload counts and timings in task notes.
- [ ] #4 bun run check passes. Production authentication stays default-deny. No product behavior, dependency, deployment, or plugin acceptance changes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Owner approved docs/superpowers/plans/2026-10-24-f2-test-cleanup.md in pn-e4a1f7. The worker completed baseline timing, bounded-work RED, representative-case GREEN, formatting, docs:check, full check, and implementation commit 9f2ef63. The independent task reviewer approved spec compliance and quality. Parent owns whole-branch review, human branch review, PR, remote CI, and closure. Preserve the approved scope and all safety boundaries.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner approved plan pn-e4a1f7 and explicitly requested execution. One worker owns RED/GREEN, timings, formatting, full check, and implementation commit. One independent reviewer follows. Parent owns whole-branch review, human branch review, publication, and final closure. Only OAB-7.1 may execute.

Implemented and committed as 9f2ef635d80bb092ce9952162db3d3bf4ac2693a. Changed only apps/worker/test/blob-put.test.ts, apps/worker/test/vault-search.test.ts, and apps/worker/test/http/search.test.ts. Policy cases fell 136 to 16. HTTP writes fell 137 to 17. SQLite indexing forms and lifecycle forms fell 68 to eight. Focused test counts: worker unit 178 to 58, HTTP 43 to 43, protocol 120 to 120. Three-run median durations: worker unit 3.27s to 1.83s, HTTP 12.46s to 11.47s, protocol 127ms to 125ms. RED bounds failed at 136 versus 16 and 68 versus eight before writes. The saved RED results show exit 1. An initial shell guard used an incorrect HTTP count of 72 and exited 1. A later shell check verified the captured actual counts and exited 0. All GREEN focused runs, docs:check, WRANGLER_SEND_METRICS=false bun run check, and git diff --check passed. No production, protocol, dependency, timeout, or configuration changes. Full commands, per-run times, validation, and review limits are in .superpowers/sdd/2026-10-24-f2-test-cleanup/task-1-report.md. Independent review and task closure remain with the parent.

Durable command and timing record: from apps/worker, bun x vitest run --config vitest.config.ts test/blob-put.test.ts test/vault-search.test.ts passed three baseline runs at 3.47s, 3.27s, 3.26s and three final runs at 1.83s each. Median fell 3.27s to 1.83s, with 178 tests before and 58 after. From apps/worker, bun x vitest run --config vitest.http.config.ts test/http/search.test.ts test/http/files.test.ts passed baseline runs at 12.45s, 12.46s, 12.72s and final runs at 11.44s, 11.47s, 11.55s. Median fell 12.46s to 11.47s, with 43 tests in each run. From packages/protocol, bun x vitest run --config vitest.config.ts test/files.test.ts passed baseline runs at 127ms, 124ms, 127ms and final runs at 125ms, 126ms, 124ms, with 120 tests in each run. All 18 focused runs exited zero. The full check passed 1092 tests: tooling 52, plugin 2, protocol 277, Worker 761. Lint, documentation, types, schema drift, and local builds passed. The Worker build used dry-run only.

Independent task review bd0154eb approved spec compliance and quality at 9f2ef635d80bb092ce9952162db3d3bf4ac2693a against 2d2fc40. No actionable finding remains. Documentation scope: changed test descriptions and removed case generators. No new semantic declaration needs TSDoc. Structural scope: the three test modules keep their test responsibilities and do not own production policy. Reviewer inspected the complete task diff and worker evidence without rerunning tests. No remote CI or human branch approval is claimed yet.
<!-- SECTION:NOTES:END -->
