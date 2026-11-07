---
id: OAB-18
title: Packed baseline export
status: Done
assignee:
  - '@pi'
created_date: 2026-10-12 15:14
updated_date: '2026-11-07T06:06:00Z'
labels:
  - deferred
  - trigger-based
dependencies: []
documentation:
  - docs/spec.md
ordinal: 18000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner order activates packed snapshots after the owner left iCloud. Save a restorable current-file snapshot in the existing R2 bucket. No Cloudflare resource change.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Stream a ZIP with bounded memory and no whole-vault byte buffer.
- [x] #2 Define the manifest and owner operation shapes in packages/protocol.
- [x] #3 Enforce owner-only access, browser CSRF checks, and Access-protected downloads.
- [x] #4 Make each epoch and UTC timestamp export idempotent.
- [x] #5 Test text and blob files, R2 failures, and snapshot listing.
- [x] #6 List snapshot time and size in the console and document a new-vault restore procedure.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Packed baseline export Implementation Plan
Goal: Save current live file bytes and a canonical manifest in the existing bucket.
Architecture: Capture epoch, head_seq, and live metadata in one transaction. Pin immutable revisions before external I/O. Stream manifest.json and files/<path> through a store-only ZIP writer into backups/<epoch>/<utc-timestamp>.zip. Persist status and final size. Release pins only after source reads settle. Keep incomplete exports unavailable for download.
Spec: docs/spec.md sections 11, 12, and 16, plus the W7 owner brief.
Global constraints: No live vault access, no deployment, and no Cloudflare resource change. Preserve exact revision checks and every visible collision. Keep protocol schemas canonical. Append shared-file additions. No snapshot deletion.
Owner decisions: The owner activates OAB-18 after iCloud cutover. Use the existing bucket. Use timestamp keys for idempotency. Prefer a store-only ZIP writer under 200 lines without a new dependency. Exports contain current live files only, not retained history. Restore stays a documented procedure, not code.
Review focus: Mutation during export, pruning of pinned data, failed or interrupted R2 writes, duplicate timestamp requests, unsafe archive paths, and aggregate runtime limits.
- [ ] Write failing tests for mixed text/blob archives, immutable cut consistency, streaming demand, owner access, listing, and R2 failures.
- [ ] Run the focused tests and record the expected failure.
- [ ] Add canonical export schemas and SQLite export state with a compatible migration.
- [ ] Add the application export workflow and R2 archive stream. Use immutable revision reads and pins.
- [ ] Append Vault RPC methods, owner routes, console controls, and composition wiring.
- [ ] Test timestamp replay, protected download, errors, concurrent mutations, and bounded demand.
- [ ] Document REST operations and the new-vault restore procedure. Update section 16 and conflicting no-export statements narrowly.
- [ ] Run focused tests, bun run docs:check, bun run check, and Worker preflight. Commit.
- [ ] Complete task review and whole-branch review before publication.

Design correction after local R2 probe: Use resumable multipart ZIP output instead of an unknown-length R2 put. Start the export with a short owner operation and return persisted progress. Continue through the existing Vault alarm without displacing retention. Bound each invocation by output bytes and source reads. Use fixed-length multipart parts of 5 MiB, except the final part. Persist upload id, accepted parts, source cursor, byte offset, CRC state, and any bounded unfinished part. Resume after interruption without duplicate ZIP bytes. Use immutable ranged blob reads and bounded inline revision reads. Keep buffered bytes at a constant bound independent of vault size. The product limit is 2 GB and 10,000 live files, so ZIP32 is enough when exact encoded overhead also passes ZIP32 checks. Return a typed failure before output if archive limits cannot hold. No arbitrary file-count reduction. Validate the batch policy locally, including small-file and large-blob cases. Do not claim verified production CPU timing or account tier. Record those evidence limits rather than treat missing production measurements as a blocker.

Resume plan after parent ruling: complete a durable export state machine. A start request transactionally creates the manifest, export row, and revision pins. One short alarm step reads a fixed maximum of 1 MiB of file bytes and at most 16 source ranges or revisions, builds ZIP32 output, and appends it to a persisted multipart remainder. A completed 5 MiB part is uploaded with FixedLengthStream. Persist the upload id, completed part receipts, ZIP entry cursor, CRC32 state, output offset, and bounded remainder after every step. Complete the final short part only at ZIP EOF. Before every step, validate ZIP32 name, size, count, offset, and central-directory overhead bounds against the 2 GB and 10,000-file product limits. Mark an export downloadable only after R2 multipart completion. On failure, record a typed failed state, abort a known incomplete upload, keep downloads unavailable, then release pins after all source work settles. Retention and export share alarm scheduling. Each alarm runs one retention batch and one bounded export batch, then schedules the earlier required continuation or nightly deadline. A mutex fences in-process overlap. Persisted state and exact compare-and-set progress checks fence retries and restart. Local byte/read limits are conservative policy values, not production CPU measurements. Scope extension: add the true shared behavior owner `vault.ts` alarm scheduling and any schema model, generated schema, migration, unit/native test, and transport-composition files needed for the durable export. Append additions only to shared-file lists.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reconciled after merged F0: this section16 feature has no committed delivery phase. Preserve the exact trigger and seam in the description; no trigger is evidenced and no future acceptance case is completed by this classification. The seam is a preservation obligation, not proof of an implemented feature. Reopen for research and reviewed planning only when the documented trigger is evidenced; no fake blocking dependency is added.

The under-an-hour statement is the specification baseline-export assumption, not a measured result from the current inert foundation. The ordinary exporter belongs to F3b (OAB9); packed archives remain deferred under the original size/wait trigger.

Owner order activated this task after iCloud cutover. No dependency is planned: the export uses a store-only ZIP encoder and the existing R2 bucket. Scope remains PR A only.

BLOCKED: Local Workerd feasibility tests show R2Bucket.put rejects an unknown-length ReadableStream with "Provided readable stream must have a known length". A fixed-length multipart part succeeds. A safe snapshot implementation therefore needs bounded multipart chunking and cancellation/abort cleanup. The approved plan does not define a total archive or per-invocation CPU-work ceiling. The vault permits 10,000 live files and the R2 bucket stores existing blobs. No test or runtime measurement proves that one archive pass stays within the Worker CPU budget. I did not add production code or publish incomplete protocol contracts. Partial diff: adds apps/worker/test/r2-stream-put.test.ts to preserve the verified R2 multipart feasibility check. A bounded/resumable execution policy is needed before implementation can promise no aggregate runtime-limit overrun.

Validation: the direct unknown-length put probe failed in Workerd as expected. The 5 MiB fixed-length multipart probe passed. Focused multipart test passed (1/1); full bun run docs:check passed; bun run check passed (lint, docs, all workspace typechecks, tests, and dry-run builds); Worker preflight passed. No production behavior owner outside the brief was changed. The remaining design blocker is a resumable, bounded CPU-work contract for arbitrary-size archives; no arbitrary archive cap or unsupported one-shot upload was introduced.

Parent ruling: The unknown-length R2 rejection changes the upload mechanism, not the approved deliverable. Use durable multipart batches and alarm continuation. Scope extends to alarm scheduling and any real behavior owner needed for resumable export. No live probes or resource changes. The existing 2 GB current-file capacity bounds archive bytes. Local tests must prove batch byte/read ceilings and resumable output. Production CPU timing stays an evidence limit, not a new owner gate.

Implementation update (2026-11-07): Resumable ZIP32 output, schema-8 persistence, immutable revision pins, bounded R2 multipart upload, alarm continuation, Access-protected owner actions, and local restore guidance are implemented. `bun run check` passed: lint, documentation, typechecks, all workspace tests, and dry-run builds. Production CPU duration and account-tier measurements remain unverified evidence limits. Keep OAB-18 In Progress for parent review.

Round-1 review correction (2026-11-07):
- RED: `cd apps/worker && bunx vitest run --config vitest.f2.config.ts test/f2/packed-export-schema-upgrade.test.ts -t "retries a failed pinned range"` failed because the transient stream error marked the export terminal. `nextActive()` returned no active row instead of `uploading`.
- GREEN: The focused regression passed after `SqlitePackedExportStore` classified `reader.read()` rejection as retryable storage failure and the application preserved that typed failure. The test confirms the same ZIP cursor and pending bytes, identical source range, retained revision pin during retry, and pin release after completion. Missing and short immutable sources remain terminal.
- Added `fflate@0.8.2` as a worker development dependency because the completed-archive test needs an independent ZIP reader. It extracts a mixed text/blob archive, checks the canonical manifest and payload bytes, and checks CRC values, data descriptors, and central-directory offsets. The dependency is not in runtime dependencies.
- Added owner export routes and behavior to `docs/api/f2.md`.

The mixed-content archive test was green on its first run because the completed archive already passed independent extraction and structure checks. This test adds evidence without a production ZIP-writer change. Focused F2 validation passed: 5 tests. `bun run docs:check` passed.

Post-rebase validation (2026-11-07): Rebased on `origin/main` without conflicts. Focused tests passed after rebase: 3 unit test files with 5 tests, plus the F2 packed-export file with 5 tests. Worker typecheck passed. Full `bun run check` passed: lint, docs:check, typechecks, tests, and dry-run builds. Test totals: 2,206 passed and 1 skipped across 121 files. Worker preflight passed with exit code 0 using `bun run --filter @obsidian-ai-bridge/worker preflight`. The first full check found a TypeScript stream-result type mismatch. Inferred the exact reader result type and reran the full check successfully.

Round-2 review correction (2026-11-07):
- F1: Replaced inline manifest and multipart remainder values with bounded chunk rows. Each chunk stores at most 1,000,000 payload bytes. The store checks encoded keys, scalar fields, and conservative row overhead against the 2,000,000-byte row limit. Native tests cover a completed archive above 5 MiB, chunk row bounds, and a 10,000-file manifest with 512-byte paths.
- F2: File, pin, and chunk inserts use separate batch sizes derived from the 100-parameter limit. Native tests capture 17 and 35 files and compare every captured path and revision with its pin. The original tests failed at the old insert with “too many SQL variables”.
- F3: Capture selects current-file metadata with a LEFT JOIN to retained revisions. When a current text revision is absent, the capture transaction copies the exact current payload into source chunks. Tests prune ordinary and pressure history, capture, mutate the live row, then read the original bytes. Both tests failed before the fallback capture was added.
- F4: Revision metadata queries select a content-presence expression instead of the full revision payload. The query-projection test checks the selected fields, and the range test reads only 64 bytes. No separate pre-fix RED run was recorded for F4.
- Lost completion: Added a service test where R2 creates the object and loses the completion reply. The next batch finds the exact object key and size, marks completion, and does not submit completion twice.
- The F1 and F4 regressions landed after their implementation changes were in progress. No pre-fix RED run was recorded for those cases. Their tests remain and pass.
- Focused validation passed: packed-export native tests (12/12), export service/store tests (3/3), schema upgrade tests (7/7), and Worker typecheck. Documentation now records chunk bounds, parameter-safe writes, retention fallback bytes, and projection behavior. OAB-18 remains In Progress for parent review.

Final round-2 validation (2026-11-07): `bun run docs:check` passed. Worker preflight passed with exit code 0. `bun run check` passed after clearing the new chunk table in test vault setup and updating the generated-DDL count. Results: 2,214 tests passed and 1 skipped across tooling, protocol, plugin, and Worker tests. The check also passed lint, documentation, all workspace typechecks, and dry-run builds. Worktree diff check passed. No live service or vault was used.

Review closure: task review at 65203af approved transient-source retry and independent ZIP extraction fixes. Whole-branch review at 65203af found SQLite row limits, SQL binding limits, pruned current revisions, and unbounded metadata projections. Scoped correction review at dab7a53 approved all four with native regression evidence. The lost-completion recovery test also passes. Full check: 2214 tests pass, one skipped. Worker preflight passes. Production CPU duration and account tier remain unverified. No live service access, deployment, or Cloudflare resource change occurred.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added resumable owner-only packed snapshots in the existing R2 bucket. Canonical manifests capture exact live revisions and bytes. Bounded multipart batches, chunked SQLite state, protected downloads, timestamp replay, and retention-safe source capture preserve the snapshot. Native tests cover mixed archives, retries, platform bounds, pruning, and completion recovery. Task and whole-branch review findings are closed. Restore guidance covers a new local vault, not service import.
<!-- SECTION:FINAL_SUMMARY:END -->
