---
id: OAB-8.4
title: Reconcile enrollment and resume the ordered change feed
status: To Do
assignee: []
created_date: '2026-10-28T19:31:00Z'
labels: []
dependencies:
  - OAB-8.3
documentation:
  - docs/spec.md
parent_task_id: OAB-8
ordinal: 42000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Compose remote apply with resumable initial enrollment, manifest reads, and feed replay. One focused PR. Real-device proof remains in OAB-8.8.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Empty, populated, and mixed vault enrollment follows section 7.2. Automated AC-20 covers equal, local-only, remote-only, and different files.
- [ ] #2 Pinned revision reads, pruned revision fallback, and manifest/feed overlap preserve exact bytes. Feed replay never applies an obsolete revision.
- [ ] #3 AC-13 epoch recovery discards stale cursors and expected writes, rewrites bases by hash, and moves old-epoch operations to attention without loss. Cursor expiry triggers full reconciliation.
<!-- AC:END -->
