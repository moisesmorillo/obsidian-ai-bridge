---
id: OAB-8
title: F3 Desktop plugin delivery gate
status: In Progress
assignee:
  - '@pi'
created_date: 2026-10-12 15:13
updated_date: '2026-10-29T03:33:00Z'
labels:
  - phase-gate
  - F3
dependencies:
  - OAB-7
documentation:
  - docs/spec.md
type: task
ordinal: 8000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Track F3 against docs/spec.md §14. Intent-only; research/decompose when selected; no implementation plan authorized now. Exit: two test vaults on Mac pass AC-02, 03–06, 09, 10, 13, 20, 24, 30–33, 39; AC-09 runs against real ChatGPT. Vault access is not authorized by task dependencies.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 F2 is complete before F3 starts.
- [ ] #2 Every §14 F3 exit case is evidenced using the specified test context.
- [ ] #3 The device part of AC-08 from decision-1 passes: revoked status stops effects and retains local files and queued work.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Ordered focused PRs: OAB-8.1 device journal, OAB-8.2 enrollment credentials, OAB-8.3 text apply and conflict recovery, OAB-8.4 reconciliation and feed, OAB-8.5 publishing and rename, OAB-8.6 blobs, OAB-8.7 loop and status, OAB-8.8 two-vault and real ChatGPT exit proof. Only OAB-8.1 receives an implementation plan in this session.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reconciled after merged F0: this is a committed section14 phase entry/exit gate, not a trigger-based deferred feature or an implementation task. Its original acceptance cases and dependency edges are unchanged. Dependency readiness only permits selection for research and decomposition; it does not authorize implementation, deployment or personal-vault access.

Owner authorized F3 on 2026-10-28. decision-1 adds the device part of AC-08: revoked status, local files retained, queued work retained. Authorized test vault 1 is ~/vaults/obsidian-ai-bridge-dev. Test vault 2 is ~/vaults/obsidian-ai-bridge-dev-2, copied from test vault 1 on 2026-10-28 with 84 files, including .obsidian. Neither copy came from a read of iCloud in this task. Only these two vaults and the deployed service are authorized. Preserve all oab-7.8/ service evidence. No Cloudflare resource changes.

Standing authorizations for F3 (owner, 2026-10-28). The plugin code under test and its tests may use the deployed service at https://obsidian-bridge.mmorillo.dev with the two test vaults ~/vaults/obsidian-ai-bridge-dev and ~/vaults/obsidian-ai-bridge-dev-2. Write only under these two vaults and only through the plugin code. Never touch the owner's iCloud vault. Device names for live evidence: "oab-<subtask> dev-1" and "oab-<subtask> dev-2". Record only client ids, times and results. Never print tokens or cookies. Never write them to tracked files. A merge to main that touches apps/worker, packages, bun.lock, package.json, mise.toml or deploy.yml deploys the Worker through GitHub Actions. Cloudflare resources belong to OpenTofu in cloudflare-infra. Inside Orca, the built-in browser keeps the owner's Access session and automates the consent page: load the harness-browser skill. Owner-manual steps: the Access PIN login and anything in the ChatGPT account. Session kickoff after AGENTS.md Session start: "Pick the next ready OAB-8 subtask and do it."
<!-- SECTION:NOTES:END -->
