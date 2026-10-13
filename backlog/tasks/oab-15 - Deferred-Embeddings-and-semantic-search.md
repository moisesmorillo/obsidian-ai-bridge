---
id: OAB-15
title: 'Deferred: Embeddings and semantic search'
status: Deferred
assignee: []
created_date: '2026-10-12 15:14'
updated_date: '2026-10-13 10:04'
labels:
  - deferred
  - trigger-based
dependencies: []
documentation:
  - docs/spec.md
ordinal: 15000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Deferred per docs/spec.md §16 because FTS covers the current vault. Seam: search_notes returns rev and snippets; second backend plugs behind it. Reopen when agents miss notes by synonym in real use.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Task remains deferred until real-use synonym misses; when triggered, evaluate and test the §16 seam.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reconciled after merged F0: this section16 feature has no committed delivery phase. Preserve the exact trigger and seam in the description; no trigger is evidenced and no future acceptance case is completed by this classification. The seam is a preservation obligation, not proof of an implemented feature. Reopen for research and reviewed planning only when the documented trigger is evidenced; no fake blocking dependency is added.

FTS is the planned F1 search baseline, not implemented behavior in F0. Implementing ordinary FTS does not activate the semantic-search trigger or commit embeddings to F1.
<!-- SECTION:NOTES:END -->
