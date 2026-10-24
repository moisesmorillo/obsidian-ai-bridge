---
id: OAB-7.1
title: Reduce F1 extension-case integration test work
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-24T00:05:00Z'
updated_date: '2026-10-24T14:20:00Z'
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
Pending human review: docs/superpowers/plans/2026-10-24-f2-test-cleanup.md. Capture focused baseline counts and timing. Add bounded-matrix assertions first and verify RED against existing exhaustive Worker matrices. Replace only Worker matrices with md/MD/mD/Md and canvas/CANVAS/cAnVaS/CaNvAs. Preserve protocol exhaustive classifier coverage unchanged. Actual HTTP matrix is in http/search.test.ts. Inspect http/files.test.ts and preserve its existing checks. Verify GREEN, lower case/workload counts and focused runtime, docs:check, full check, independent task and branch reviews, then human branch review before publication. No product, auth, spec, dependency, deployment, personal-vault, or later phase changes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner approved plan pn-e4a1f7 and explicitly requested execution. One worker owns RED/GREEN, timings, formatting, full check, and implementation commit. One independent reviewer follows. Parent owns whole-branch review, human branch review, publication, and final closure. Only OAB-7.1 may execute.
<!-- SECTION:NOTES:END -->
