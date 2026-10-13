---
id: OAB-6
title: F1 Worker delivery gate
status: To Do
assignee: []
created_date: '2026-10-12 15:13'
updated_date: '2026-10-12 15:36'
labels: []
dependencies:
  - OAB-2
  - OAB-3
  - OAB-4
  - OAB-5
documentation:
  - docs/spec.md
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Track the F1 Worker phase in docs/spec.md §14. This is intent-only: research and decompose when selected; no implementation plan is authorized now. Exit only when AC-01, 03–06 (server side), 11, 12, 14–18, 21, 22, 25–29, 34, 38, 40, 43 pass as specified. Any Cloudflare deployment or resource mutation needs separate explicit owner authorization; dependency completion grants no authorization.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 F1 entry gates OAB-2, OAB-3, OAB-4, and OAB-5 are satisfied before work starts.
- [ ] #2 Every §14 F1 exit acceptance case passes with evidence.
- [ ] #3 Any Cloudflare resource/deployment action has separate explicit authorization.
<!-- AC:END -->
