---
id: OAB-7.1
title: Reduce F1 extension-case integration test work
status: Done
assignee:
  - '@pi'
created_date: '2026-10-24T00:05:00Z'
updated_date: '2026-10-24T14:34:00Z'
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
- [x] #1 Worker extension matrices use at most four forms per extension. HTTP writes and SQLite lifecycle runs use representative forms only.
- [x] #2 The full ASCII case matrix remains in packages/protocol/test/files.test.ts for classifyFilePath. Threshold, range, FTS, near-match, and lifecycle assertions remain.
- [x] #3 Parameterized test count and measured focused runtime decrease against the same baseline commands. Record workload counts and timings in task notes.
- [x] #4 bun run check passes. Production authentication stays default-deny. No product behavior, dependency, deployment, or plugin acceptance changes.
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

Session-model whole-branch review: APPROVE at 99dd487674f7cb55a0498c04c64d1eec0bee0cc1 against main 3534d79, including all 13 changed files and task evidence. No actionable findings. The three test modules stay cohesive. Their test matrices do not own production rules or state transitions. No new contracts or named semantic declarations enter TypeScript. Documentation review covered the approved cleanup plan, F2 decomposition, task criteria, test descriptions, authorization labels, and evidence notes. The actual HTTP matrix path is correct and the named file-route tests stay unchanged. The parent inspected raw worker session results for RED, focused timings, 1092 passing full-check tests, and dry-run build completion. Active LSP checks returned no findings but could not confirm clean files, so compiler evidence comes from the full check. No production, protocol, dependency, timeout, or configuration change exists. No new design, platform capability, or runtime resource budget enters this test-only branch. Remote CI and human branch approval remain pending. Scope excludes deployed, real-client, plugin, and device qualification.

Owner approved the complete branch review pn-8df521 at 71ad4085ba4c9e5649e1b6db5b89cc3c7319a531 with no requested changes. The only later edit records this approval. Publish the requested PR and verify actual remote CI before closure.

Remote evidence: PR https://github.com/moisesmorillo/obsidian-ai-bridge/pull/21. Push run https://github.com/moisesmorillo/obsidian-ai-bridge/actions/runs/40102916636 and pull-request run https://github.com/moisesmorillo/obsidian-ai-bridge/actions/runs/40102921347 both completed successfully at exact head d793b062657e7469c375781716e113876161f7e3. The final closure edit changes only Backlog status and notes. No test or source change follows the approved and tested implementation.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Complete the approved test-only cleanup in PR #21. Policy cases fell 136 to 16, HTTP matrix writes fell 137 to 17, and SQLite forms per transition fell 68 to eight. Exhaustive protocol classification and all selected behavior assertions remain. Focused medians fell 3.27s to 1.83s for Worker tests and 12.46s to 11.47s for HTTP tests. The full check passed 1092 tests plus lint, documentation, types, schema drift, and local builds. Independent and session-model reviews approved the change. Owner approved pn-8df521. Push CI 40102916636 and PR CI 40102921347 passed at d793b062657e7469c375781716e113876161f7e3. No production behavior, deployment, dependency, or later phase changed. OAB-7 stays open.
<!-- SECTION:FINAL_SUMMARY:END -->
