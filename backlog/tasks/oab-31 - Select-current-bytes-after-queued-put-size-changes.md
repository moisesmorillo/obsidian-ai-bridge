---
id: OAB-31
title: Select current bytes after queued put size changes
status: Deferred
assignee: []
created_date: '2026-11-02T16:17:00Z'
labels: []
dependencies: []
references:
  - apps/plugin/src/sync/publication.ts
type: bug
ordinal: 50000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner branch review pn-86bc2b accepts this bounded deferral. refreshQueuedPut selects its reader from saved payload size, not current file size. A queued wait can cross the inline/blob boundary. Current local bytes remain intact, but the next payload can use the wrong reader. Trigger: OAB-8.8 qualification or evidence of a size transition while a put waits queued.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Tests cover both inline-to-blob and blob-to-inline changes during a queued wait, including invalid UTF-8, BOMs, and line endings.
- [ ] #2 Reader selection follows current file admission. The queued successor preserves exact current bytes or stops with attention before sending.
- [ ] #3 Sent keys, payload bytes, headers, and revision preconditions remain immutable. Files above 25 MB cause attention without a full body read.
<!-- AC:END -->
