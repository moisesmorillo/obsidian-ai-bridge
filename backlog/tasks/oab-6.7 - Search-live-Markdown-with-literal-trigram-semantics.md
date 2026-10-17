---
id: OAB-6.7
title: Search live Markdown with literal trigram semantics
status: To Do
assignee: []
created_date: '2026-10-15 00:38'
updated_date: '2026-10-15 00:40'
labels:
  - F1
dependencies:
  - OAB-6.4
  - OAB-6.5
documentation:
  - docs/spec.md
parent_task_id: OAB-6
type: feature
ordinal: 30000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Section10 requires literal case/diacritic-insensitive substring search, not a query language or semantic search. Mutations must never leave stale FTS results, and callers must see coverage for files that cannot be indexed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The real DO FTS5 search passes every AC-15 example, including punctuation, internal quotes, literal AND and cafe matching café.
- [ ] #2 Unicode query length 3–200 and result limits 1–50/default 20 are validated; ranking/snippets follow section 10 without interpreting user operators.
- [ ] #3 Only live inline Markdown is indexed; canvas, blobs, oversized Markdown and tombstones remain excluded with accurate coverage counts.
- [ ] #4 Mutation rollback, rename/delete/recreate and concurrent reads cannot expose an index inconsistent with authoritative state.
<!-- AC:END -->
