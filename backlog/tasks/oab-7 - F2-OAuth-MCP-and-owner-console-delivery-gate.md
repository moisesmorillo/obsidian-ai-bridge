---
id: OAB-7
title: F2 OAuth MCP and owner console delivery gate
status: Done
assignee:
  - '@pi'
created_date: 2026-10-12 15:13
updated_date: '2026-10-28T17:25:00Z'
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
- [x] #1 F1 is complete before F2 starts.
- [x] #2 §14 F2 exit checks and account decision are evidenced.
- [x] #3 Service deployment/resource operations have separate explicit owner authorization.
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

Gate review after OAB-7.8 owner evidence on 2026-10-28. AC #1: OAB-6 is Done with the owner-approved server-only F1 exit and completed review/CI evidence. AC #3: OAB-7.7 records separate owner authority for the original deployment and resource boundary.

The owner also authorized the 16:18Z scope-fix deployment of PR #24 f84a225, Worker version 0527d86b-0edd-4b56-915f-aa652a38bc5f. This closure gives no new deployment or resource authority. AC #4 remains complete through OAB-7.1.

Section 14 F2 exit evidence now includes successful real Inspector, Claude Code, and ChatGPT web connections with synthetic read/write checks. OAB-7.8 records exact supplied UTC times and results. Developer mode and custom apps work in the owner account.

The same connector works on iPhone. The owner chose the custom ChatGPT app for iPhone. Real revocation proved the next DO request returned 401 revoked before provider cleanup at 15:12:42Z.

The owner Access login passed at 15:03Z.

AC #2 stays unchecked and OAB-7 stays In Progress. Spec section 14 includes AC-08 without a server-only exception for F2. The DO denial portion has evidence.

Plugin revoked status, stopped publishing and applying, and preservation of local files and queues do not. ChatGPT iPhone reads do not prove those Obsidian plugin effects. OAB-7.8 closes its client/account scope, not the complete F2 gate.

No specification change or waiver belongs to this task. OAB-8 and later phases stay unstarted. S1 privacy and S2 console visibility remain open as Deferred OAB-26 and OAB-27, with their triggers.

No personal-vault access or cleanup occurred.

Exit decision 2026-10-28: decision-1 accepts the F2 exit on server and real-client evidence from OAB-7.8 (Access login, Inspector 2.12.0, Claude Code 2.1.311, ChatGPT web and iPhone, same-token revocation 401 revoked). The device part of AC-08 moves to OAB-8 as an F3 exit obligation and is not waived. Criterion 2 is checked with that boundary. Deployed revision for the evidence: Worker version 0527d86b (PR #24, f84a225). Open findings stay in Deferred OAB-26 and OAB-27.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
F2 delivered: real OAuth with Access, MCP server and tools, owner console with durable revocation, deployed service on obsidian-bridge.mmorillo.dev. All eight subtasks are Done. Exit evidence: three named clients plus curl completed real read and write checks, same-token revocation returned 401 revoked on the first request, the owner confirmed Developer mode and iPhone availability and chose the custom ChatGPT app on iPhone. Decision-1 carries the device part of AC-08 into OAB-8. Risks: OAB-26 identity disclosure in authorization codes and OAB-27 console revoked state remain Deferred. OAB-8 needs explicit owner authorization.
<!-- SECTION:FINAL_SUMMARY:END -->
