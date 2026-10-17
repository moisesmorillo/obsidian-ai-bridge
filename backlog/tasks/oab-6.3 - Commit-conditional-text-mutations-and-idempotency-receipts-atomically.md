---
id: OAB-6.3
title: Commit conditional text mutations and idempotency receipts atomically
status: To Do
assignee: []
created_date: '2026-10-15 00:38'
updated_date: '2026-10-15 00:40'
labels:
  - F1
dependencies:
  - OAB-6.2
documentation:
  - docs/spec.md
parent_task_id: OAB-6
type: feature
ordinal: 26000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Sections5 and6 require revision-safe publication and deterministic retries after lost responses. Content, history, feed, FTS, counters and receipts must share one authoritative commit so stale requests cannot partially overwrite the vault.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Text PUT, DELETE and exact reads enforce observed epochs and ETags, tombstones, case-insensitive path identity and monotonic revisions across delete/recreate.
- [ ] #2 Lost-response retries, same-key different-payload, in-flight duplicates, client-scoped keys and UUIDv7 age/skew limits satisfy AC-01/17/27/38 without duplicate revisions or content leakage.
- [ ] #3 A failed mutation leaves files, revisions, changes, FTS, counters and receipts unchanged; append/rename/restore can reuse the same atomic guarantees without duplicating policy.
- [ ] #4 Real Worker/DO integration tests cover the actual HTTP boundary with a test-only identity fixture while the default production composition continues to fail closed.
<!-- AC:END -->
