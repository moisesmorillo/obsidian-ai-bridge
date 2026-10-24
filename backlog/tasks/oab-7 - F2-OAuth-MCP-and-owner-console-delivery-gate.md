---
id: OAB-7
title: F2 OAuth MCP and owner console delivery gate
status: To Do
assignee: []
created_date: 2026-10-12 15:13
updated_date: '2026-10-24T00:01:00Z'
labels:
  - phase-gate
  - F2
dependencies:
  - OAB-6
documentation:
  - docs/spec.md
type: task
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Track F2 against docs/spec.md §14. Intent-only; research/decompose when selected, with no implementation plan authorized now. Entry is F1. Exit: MCP Inspector, Claude Code, ChatGPT web connect; read/write work; AC-08; owner verifies Developer mode and iPhone availability in their ChatGPT account and records outcome/decides mobile strategy. Real-client checks require a deployed authorized service; deployment/resource changes need separate explicit owner authorization.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 F1 is complete before F2 starts.
- [ ] #2 §14 F2 exit checks and account decision are evidenced.
- [ ] #3 Service deployment/resource operations have separate explicit owner authorization.
- [ ] #4 Cleanup from F1 review: the extension-case tests in apps/worker/test/blob-put.test.ts, apps/worker/test/vault-search.test.ts and apps/worker/test/http/files.test.ts use at most four representative forms per extension for real HTTP writes and SQLite runs. The full ASCII case combination stays only in packages/protocol/test/files.test.ts as a unit test of classifyFilePath. Test count and runtime go down. Coverage of the case rule stays.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reconciled after merged F0: this is a committed section14 phase entry/exit gate, not a trigger-based deferred feature or an implementation task. Its original acceptance cases and dependency edges are unchanged. Dependency readiness only permits selection for research and decomposition; it does not authorize implementation, deployment or personal-vault access.
<!-- SECTION:NOTES:END -->
