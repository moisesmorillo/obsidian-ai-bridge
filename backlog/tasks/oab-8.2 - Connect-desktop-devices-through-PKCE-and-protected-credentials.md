---
id: OAB-8.2
title: Connect desktop devices through PKCE and protected credentials
status: To Do
assignee: []
created_date: '2026-10-28T19:31:00Z'
labels: []
dependencies:
  - OAB-8.1
documentation:
  - docs/spec.md
parent_task_id: OAB-8
ordinal: 40000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Give each test vault its own enrolled device identity without placing credentials in synced settings. One focused PR. Use requestUrl and the existing deployed OAuth service. Owner-interactive acceptance remains in OAB-8.8.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Connect uses browser PKCE, validates callback state, exchanges the code, and handles cancelled or failed consent safely.
- [ ] #2 Tokens use secretStorage when available. The localStorage fallback has a visible unencrypted-storage warning. No token, code, or verifier reaches logs or data.json.
- [ ] #3 Refresh rotation and failed refresh stop unauthorized work. Reconnect does not discard journal entries or local files. Automated lifecycle and transport tests pass.
<!-- AC:END -->
