---
id: OAB-6.3
title: Commit conditional text mutations and idempotency receipts atomically
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-15 00:38'
updated_date: '2026-10-19 04:07'
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

Task 4 amendment: add a read-only authoritative getCurrentEpoch capability for missing or malformed observed epoch failures. Keep canonical schemas in protocol. Reuse current revocation and operation-scope policy. The query creates no admission or content effects. Normal valid requests keep their existing path.
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

Task 2 passed independent review and parent acceptance at b954fa9bd8b6c14d1c0fd49fff2bb553808df86b.

Task 3 adds conditional inline publication and exact current or historical reads. The parent reviewed all four changed files.

The focused native suite passed 15 tests. The full check passed 530 tests: 52 tooling, 227 protocol, 249 Worker, and 2 plugin tests.

Lint, documentation, four typechecks, and three builds passed. Wrangler used dry-run only. The parent inspected saved output without another test run.

Native tests cover safe numeric boundaries and exact UPDATE and DELETE rollback snapshots. Later receipt and counter failures also restore FTS state.

The observed database grew from 151552 to 2150400 bytes with a 1000000-byte Canvas payload. The receipt body used 190 bytes.

Statement counts remain unmeasured. The editor probe returned four inconclusive results and no confirmed clean files.

Initial failures do not prove functional RED. They include fixture errors and helper exceptions. The parent preserves this process gap without a retroactive TDD claim.

Task 3 independent review and acceptance remain pending. Task 4 remains pending. All four acceptance criteria remain unchecked.

Independent Task 3 review found no critical or important implementation issues. It found a minor gap in required evidence.

Deferred task OAB-6.8.1 tracks SQL statement counts and complete row sizes under OAB-6.8. Its trigger precedes aggregate platform qualification or publication budget changes.

Task 3 did not establish functional RED. The owner-supplied session project instructions allow retaining an implementation that arrives green. The branch AGENTS.md does not contain that exception. The parent retains the working implementation and records the process gap here. Current behavioral tests and passing checks remain the validation evidence, not proof of earlier RED.

The parent confirmed that all four named review JSON files exist in the linked worktree. Corrective review will receive absolute paths. Editor cleanliness remains inconclusive.

Task 3 corrective review and acceptance remain pending. Task 4 and all acceptance criteria remain pending.

Task 4 exposed a real interface gap: mutation descriptor validation rejects missing epochs before authority, but epoch_mismatch needs current_epoch. The parent approved a narrow epoch query through Vault and the application gateway. It checks current revocation and intended operation scope before returning metadata. It never replaces the publication epoch guard. Extra scope is limited to canonical protocol contracts, existing admission policy seams, composition, Task 4 code, and covering tests. No guessed epoch, content probe, dependency, deployment, or broader protocol change is approved.

Task 4 adds Worker-to-DO text routes with production identity denial. A narrow epoch query supplies authoritative missing-observation failures without mutation effects. Parent review R1-R4 corrections cover actual actor eviction, cancellation, deterministic body readiness, public canonical failure encoding, and unexpected RPC errors. Repair RED reached the expected 500 assertion and received 400 after a committed response loss. Final check passed 548 tests: 251 native Worker, 14 HTTP, 229 protocol, 52 tooling, and 2 plugin. Documentation checks and dry-run builds passed. Worker dry-run upload is 752.53 KiB, or 126.41 KiB gzip. Production source and bundle scans exclude test identity markers. No parent test rerun. Four active editor probes are inconclusive, with zero confirmed clean files. Streaming and response-loss evidence uses the pinned local Workers runtime, not deployed Cloudflare. Independent task review and whole-branch reviews remain open.

Independent Task 4 review approved with one readiness finding. R1-R3 are fixed. R4 remained open because default stream prefetch could signal readiness before reader demand. The repair sets highWaterMark to zero and adds a direct read-demand regression. Repair RED reached the no-reader assertion and received true instead of false. The final HTTP suite passed 15 tests. The full check passed 549 tests: 251 native Worker, 15 HTTP, 229 protocol, 52 tooling, and 2 plugin. The worker summary said 548, but its suite counts sum to 549. Parent verified the saved output and did not rerun tests. The repair changes one test file and its helper comment. One active editor probe remains inconclusive, with zero confirmed clean files. Scoped independent review remains open.

Final whole-branch code review requests changes for WB-R1. Hono routing-path decoding preserves percent and reserved escapes, so the adapter can send a different filename to native authority. Design review approves the bounded slice with its stated follow-ups. Prior findings remain closed or explicitly deferred. The parent assigned a two-file transport and HTTP regression repair. It must decode the original URL path exactly once, then use canonical path normalization. Publication, human branch review, and task closure remain blocked until the final reviewer confirms the correction.

WB-R1 repair decodes the original URL pathname exactly once and then uses public canonical path normalization. A real SELF request reached product RED: HTTP 201 returned notes/100%25.md instead of notes/100%.md. The final regression checks exact returned, native, current, historical, updated, and deleted identities. It keeps literal percent-looking and space names distinct. Encoded dot segments and malformed paths return invalid_path without file or revision effects. Fixture ordering and cross-case spelling assertion failures remain test setup history. The final full check passed 550 tests: 251 native Worker, 16 HTTP, 229 protocol, 52 tooling, and 2 plugin. Documentation, type, lint, and dry-run builds passed. Worker dry-run upload is 752.93 KiB, or 126.52 KiB gzip. Parent inspected source and saved evidence without repeating tests. Two editor probes remain inconclusive. The final Sol reviewer must confirm closure before human review or publication.
<!-- SECTION:NOTES:END -->
