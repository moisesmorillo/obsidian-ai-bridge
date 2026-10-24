---
id: OAB-7
title: F2 OAuth MCP and owner console delivery gate
status: In Progress
assignee:
  - '@pi'
created_date: 2026-10-12 15:13
updated_date: '2026-10-24T14:34:00Z'
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
- [x] #4 Cleanup from F1 review: the extension-case tests in apps/worker/test/blob-put.test.ts, apps/worker/test/vault-search.test.ts and apps/worker/test/http/files.test.ts use at most four representative forms per extension for real HTTP writes and SQLite runs. The full ASCII case combination stays only in packages/protocol/test/files.test.ts as a unit test of classifyFilePath. Test count and runtime go down. Coverage of the case rule stays.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Research and decomposition only. Main matches merged PR #20 at 3534d79. Use isolated branch chore/oab-7-f2-planning. Ordered tasks: OAB-7.1 criterion 4 test cleanup, OAB-7.2 real OAuth and verified Access, OAB-7.3 owner clients and durable revocation, OAB-7.4 MCP discovery and reads, OAB-7.5 conditional MCP mutations, OAB-7.6 local integration, OAB-7.7 authorized deployment, OAB-7.8 authorized real-client checks and owner account decision. Each task depends on the previous task. Only OAB-7.1 receives a plan now. Review docs/superpowers/plans/2026-10-24-f2-test-cleanup.md before implementation. The last two tasks need explicit owner authorization and stay last. Preserve F1 server-only acceptance, default-deny until real OAuth replaces it, all AC-08 obligations, and later phase gates. No OAB-8 or later task starts.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reconciled after merged F0: this is a committed section14 phase entry/exit gate, not a trigger-based deferred feature or an implementation task. Its original acceptance cases and dependency edges are unchanged. Dependency readiness only permits selection for research and decomposition; it does not authorize implementation, deployment or personal-vault access.

Owner selected F2 research and decomposition after merged PR #20. Plan only the criterion 4 cleanup first. Implementation waits for plan review. No deployment, Cloudflare resource action, personal-vault access, or later phase work is authorized.

Owner approved OAB-7.1 plan pn-e4a1f7 and explicitly requested implementation, one worker, one reviewer, human branch review, and a PR. Worker commit 9f2ef63 completes the local cleanup. Future tasks remain To Do. No OAuth, MCP, plugin, deployed, or device behavior is qualified by this change.

OAB-7.1 completes cleanup criterion 4 in PR #21 after independent, session-model, and human reviews plus actual remote CI. The actual exhaustive HTTP matrix was in http/search.test.ts. http/files.test.ts remains unchanged and passes. OAB-7 stays In Progress. OAB-7.2 through OAB-7.8 remain To Do. Deployment and real-client tasks still need explicit owner authorization. F1 server-only acceptance, default-deny production identity, and all later evidence boundaries remain unchanged.
<!-- SECTION:NOTES:END -->
