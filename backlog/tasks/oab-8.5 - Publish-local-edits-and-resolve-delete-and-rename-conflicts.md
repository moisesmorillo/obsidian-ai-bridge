---
id: OAB-8.5
title: Publish local edits and resolve delete and rename conflicts
status: To Do
assignee: []
created_date: '2026-10-28T19:31:00Z'
labels: []
dependencies:
  - OAB-8.4
documentation:
  - docs/spec.md
parent_task_id: OAB-8
ordinal: 43000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Connect vault events and startup hash scans to conditional publication and rename application. One focused PR. Preserve the journal send barrier and use the same application engine. Device proof remains in OAB-8.8.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Automated AC-03, AC-04, AC-05, and AC-06 cover offline edits and confirmed remote precedence. AC-24 fetches destination bytes by destination revision.
- [ ] #2 AC-30 retains sent keys and bytes after a lost response. Later edits receive separate keys and the correct next precondition. Receipt sequence never advances the feed cursor.
- [ ] #3 AC-33 resolves rename sides separately. Newer source revisions survive replay. Deletes and renames come only from live vault events. Missing startup files restore from the server.
- [ ] #4 Publication handles 412, path collisions, size limits, expired operations, and bounded retry with Retry-After. Local link rewrites publish as ordinary puts.
<!-- AC:END -->
