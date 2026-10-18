---
id: OAB-6.3
title: Commit conditional text mutations and idempotency receipts atomically
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-15 00:38'
updated_date: '2026-10-18 19:59'
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

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Approved by the owner through Plannotator pn-37ad1c. Plan: docs/superpowers/plans/2026-10-18-f1-conditional-text-commits.md.
1. Add canonical file contracts and pure key/payload policies.
2. Add separate durable claims and a shared atomic mutation coordinator.
3. Implement conditional inline PUT, DELETE, and exact reads through the real Vault.
4. Add real Worker-to-DO HTTP tests with a test-only identity entry and production default denial.
Owner approved breaking storage changes without legacy migration. Fresh schema v3 rejects unsupported stores without repair or reset. Historical reads need X-Vault-Epoch. User selected subagents. Parent owns validation, Backlog, commits, and publication. No new dependencies or deployment. Human plan approval is complete. Frozen baseline passed all 369 tests before Task 1.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Human plan approval: pn-37ad1c. Frozen install passed. Canonical check passed 369 tests: tooling 52, protocol 123, Worker 192, plugin 2. Biome checked 70 files. All compiler groups, documentation checks, builds, Backlog doctor, and diff checks passed. All 121 tracked baseline inputs stayed unchanged. No product implementation started.

Task 1 adds canonical file contracts, exact key bounds, UUIDv7 timing, and original-byte text payloads.

PUT and DELETE reuse admission refinements. Full text preserves BOM and exact UTF-8 bytes. Read ranges use UTF-16 offsets and allow split surrogate pairs.

Parent validation passed 479 tests: tooling 52, protocol 218, Worker 207, and plugin 2. Types, documentation, Biome, builds, Backlog doctor, and diff checks passed. Wrangler used dry-run only.

Task 1 still needs independent review. Tasks 2 through 4 and all four acceptance criteria remain pending.

The LSP probe confirmed no clean files. All 16 outcomes were inconclusive.

Earlier failed quality gates and observers remain in private execution evidence.
<!-- SECTION:NOTES:END -->
