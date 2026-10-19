---
id: OAB-6.8.1
title: Measure native text publication SQL and complete row budgets
status: Deferred
assignee: []
created_date: '2026-10-19 02:25'
labels:
  - F1
dependencies:
  - OAB-6.3
documentation:
  - docs/spec.md
parent_task_id: OAB-6.8
type: task
ordinal: 34000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Trigger: before OAB-6.8 reports aggregate platform budgets or before publication changes SQL statement or row budgets.

OAB-6.3 measured native database growth and content size, but it did not measure SQL statement counts or complete row sizes. Independent Task 3 review found this bounded evidence gap. Existing publication and rollback tests remain valid, but they do not prove these storage budgets.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Native publication workloads report observed SQL execution counts and maximum bind-parameter counts for create, update, DELETE, replay, and rejection.
- [ ] #2 Tests measure complete file, revision, and receipt row sizes for 1,000,000-byte Markdown and Canvas content with worst-case bounded metadata.
- [ ] #3 Evidence separates content bytes, encoded row sizes, database growth, and whole-runtime memory without claiming unmeasured platform headroom.
- [ ] #4 All observations use the real pinned runtime without SDK shims or unchecked casts.
<!-- AC:END -->
