---
id: OAB-8.8
title: Prove the desktop gate with two vaults and real ChatGPT
status: To Do
assignee: []
created_date: '2026-10-28T19:31:00Z'
labels: []
dependencies:
  - OAB-8.7
references:
  - backlog/decisions/decision-1
documentation:
  - docs/spec.md
parent_task_id: OAB-8
ordinal: 46000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Close F3 only with Obsidian device evidence from the two authorized copies and the deployed service. One focused PR for acceptance tests and necessary bounded fixes. Run all owner-interactive checks here, including consent, revocation, and real ChatGPT. Preserve oab-7.8/ evidence. Never access iCloud or change Cloudflare resources.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Two Mac test vaults driven by Obsidian pass AC-02, 03, 04, 05, 06, 10, 13, 20, 24, 30, 31, 32, 33, and 39. Automated tests alone do not close the device gate.
- [ ] #2 Real ChatGPT passes the complete AC-09 loop, including automatic note arrival, subsequent reads, offline conflict, and interrupted append retry with one entry.
- [ ] #3 The device part of AC-08 shows revoked and retains files and queued work. Desktop credential storage behavior and the local fallback warning are verified.
- [ ] #4 Task notes record safe vault origins, actual commands and device results, reviewed revisions, and test limits. F3 closes only after independent review, human branch review, and passing checks.
<!-- AC:END -->
