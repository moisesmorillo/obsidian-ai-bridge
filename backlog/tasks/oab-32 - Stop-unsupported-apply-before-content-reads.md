---
id: OAB-32
title: Stop unsupported apply before content reads
status: Deferred
assignee: []
created_date: '2026-11-02T16:17:00Z'
labels: []
dependencies: []
references:
  - apps/plugin/src/sync/text-apply.ts
type: bug
ordinal: 51000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner branch review pn-86bc2b defers the unsupported-admission read gap in applyCurrent and applyPathChange. An unsupported path can reach vault.read before admission stops the content read. This bounded deferral does not authorize an unguarded overwrite. Local bytes must remain intact. Trigger: OAB-8.8 qualification.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Tests cover applyCurrent and feed apply for files above 25 MB. Neither route reads the complete text or binary body.
- [ ] #2 Unsupported local content stays unchanged. The apply retains safe pending state or attention without advancing an unconfirmed base.
- [ ] #3 Supported inline and blob applies retain exact-byte preservation, revision guards, and current scope boundaries.
<!-- AC:END -->
