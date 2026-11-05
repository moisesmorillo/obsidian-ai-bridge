---
id: DRAFT-1
title: 'Deferred: verify mobile enrollment and credential storage'
status: Draft
assignee: []
created_date: '2026-11-05T23:20:00Z'
updated_date: '2026-11-05T23:23:00Z'
labels:
  - F5
  - Deferred
dependencies: []
parent_task_id: OAB-11
type: task
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Trigger: F4 closes and the owner approves the F5 copy-vault scope with an isolated service authority. Mobile browser return and credential persistence lack device evidence. Scope covers iPhone, iPad, and an Android compatibility probe. No mobile support claim follows from API types alone.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Native browser consent returns through the registered URI on iPhone and iPad without direct callback injection.
- [ ] #2 State mismatch, replay, expiry, wrong-vault return, and process loss reject safely and allow a fresh connection.
- [ ] #3 Per-platform records show app and OS versions, capability presence, write verification, restart persistence, and the fallback warning without secret values.
- [ ] #4 Android availability and persistence results remain distinct from the Apple F5 exit evidence.
- [ ] #5 Device labels remain distinct after settings sync without copying journal IDs or credentials between devices.
<!-- AC:END -->
