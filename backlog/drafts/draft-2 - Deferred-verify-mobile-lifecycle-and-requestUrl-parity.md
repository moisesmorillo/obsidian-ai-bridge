---
id: DRAFT-2
title: 'Deferred: verify mobile lifecycle and requestUrl parity'
status: Draft
assignee: []
created_date: '2026-11-05T23:21:00Z'
labels:
  - F5
  - Deferred
dependencies: []
parent_task_id: OAB-11
type: task
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Trigger: F4 closes, the owner approves F5 copy-vault work, and enrollment works on test devices. Suspension, network return, and native HTTP behavior lack device evidence. Scope excludes Cloudflare changes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 iPhone and iPad resume one serialized loop without concurrent cycles or lost queued operations.
- [ ] #2 Suspension stops scheduled work. Resume immediately recovers pending applies and immutable sent operations.
- [ ] #3 Native requestUrl preserves exact UTF-8 and binary bytes, conditional headers, ETag, Retry-After, and safe 401, 412, and 429 handling.
- [ ] #4 Interrupted uploads, low storage, and 25,000,000-byte transfers fail safely or recover with visible state.
- [ ] #5 Android observations remain separate from the Apple F5 gate.
<!-- AC:END -->
