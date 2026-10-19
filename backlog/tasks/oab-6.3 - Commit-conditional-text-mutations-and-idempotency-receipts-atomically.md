---
id: OAB-6.3
title: Commit conditional text mutations and idempotency receipts atomically
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-15 00:38'
updated_date: '2026-10-19 00:26'
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

Owner-approved workflow update: implementers now own task edits, debugging, RED/GREEN cycles, tests, and validation. The parent retains coordination, Backlog, commits, review, acceptance, and publication. This update replaces earlier parent-only validation instructions.
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

Task 1 review repair passed parent validation with 488 tests. The strict file failure boundary rejects unknown admission fields and preserves canonical admission checks. Nine regression cases protect nested failure boundaries, metadata rules, and existing admission parsing.

The parent kept the qualified RED tests unchanged. This repair failed the documentation gate once before a comment change. Fresh checks passed all compiler groups, documentation, Biome, builds, doctor, and diff validation.

Wrangler used dry-run only. Independent corrective review remains pending. All four acceptance criteria remain unchecked.

The parent accepted Task 1 after independent corrective review at 22d3df312691dbcbd74f08fade3ed92e4f41f1ff.

Task 2 implementation passed native tests and bun run check. The full suite passed 515 tests: 52 tooling, 227 protocol, 234 Worker, and 2 plugin tests. Lint, documentation, all workspace typechecks, and dry-run builds passed.

The parent verified saved output without repeating completed checks. The focused mutation and admission suites passed 58 tests. The source manifest retains 139 inputs, including the deleted schema tombstone.

The coordinator no longer changes fingerprint mismatch classification based on unrelated active admissions. The new R1 regression first failed with invalid_ticket and then passed with idempotency_mismatch.

The unrelated retry case retains its fixture and exact ownership snapshots. Its corrected expectation now matches the fingerprint contract. The separate claim-ID mismatch case still returns invalid_ticket.

Earlier import-order, collision-expectation, and focused-suite failures remain recorded. Independent Task 2 review and acceptance remain pending. All four acceptance criteria remain unchecked.

The owner approved autonomous whole-task subagent execution. AGENTS.md now records implementer-owned edits, debugging, tests, and validation. The parent retains coordination, review, acceptance, and publication.
<!-- SECTION:NOTES:END -->
