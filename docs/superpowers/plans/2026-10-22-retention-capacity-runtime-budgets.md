# OAB-6.8 Retention, Capacity, and Runtime Budgets Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` after owner approval. Complete each work unit with tests, checks, and a commit.

**Goal:** Enforce vault capacity and retention without lost history, unsafe replay, or false claims about platform capacity.

**Architecture:** The Vault Durable Object owns atomic capacity decisions and bounded retention transactions. Existing Worker response owners retain their lifecycle duties. Canonical protocol schemas expose capacity and attention state through the existing vault summary.

**Tech Stack:** Bun, TypeScript, Zod, Hono, Drizzle, SQLite Durable Objects, R2, and the pinned Cloudflare Vitest runtime.

**Spec:** `docs/spec.md`, sections 5.2, 6.4, 6.5, 11.1, 12, and 13.

**State:** Owner approved pn-71230a. The owner then approved logical history accounting and continuation with the same worker. No second plan review applies.

## Planning checklist

- [x] Synchronize main without discarding local changes.
- [x] Read the task, direct dependencies, measurement subtasks, and relevant source owners.
- [x] Check published platform limits and distinguish them from pinned-runtime evidence.
- [x] Prepare sequential work units and acceptance tests.
- [x] Receive owner plan approval before product edits.
- [ ] Execute the approved units with one writer at a time.
- [ ] Complete independent task review, whole-branch review, and human branch review.

## Repository and dependency state

- Main and origin/main match at `f30435f`, the merged PR #16 revision.
- The original checkout was clean. Synchronization used fetch and a fast-forward merge, without reset, clean, or stash.
- Branch: `feature/oab-6.8-runtime-budgets`.
- Worktree: `~/.worktrees/obsidian-ai-bridge/feature/oab-6.8-runtime-budgets`.
- OAB-6.8 is In Progress and assigned to `@pi`. Its acceptance criteria remain unchecked.
- Direct dependencies OAB-6.6 and OAB-6.7 are Done. Their transitive prerequisites are also complete.
- OAB-6.8.1 is Done. It supplies SQL dispatch, bind count, encoded record, and database growth observations.
- OAB-6.8.1 observed at most 13 bindings and a largest encoded file record of 1,003,440 bytes in its workloads.
- Those observations do not prove new retention queries, mixed workloads, native memory use, or deployed capacity.
- OAB-6.8.2 remains Deferred. It needs separate authorization for a real deployment and native retention measurements.
- OAB-6.9 remains downstream. This task does not close F1 or qualify plugin behavior.

## Existing behavior

The schema already contains `export_pins`, lifetime current rows, and the `live_file_count` counter. Mutation owners update that counter transactionally.

The common mutation coordinator owns policy checks, receipt replay, ticket consumption, publication, and receipt storage. Capacity checks belong inside this transaction.

Admission already limits each client to 16 live rows across grants and states. It also bounds retained admissions per vault to 1,024 rows.

Four body slots and four read slots apply separately across one Worker isolate. They do not prove a combined runtime memory bound.

Feed reads calculate age eligibility from retained change rows. Physical deletion must not remove evidence that an older cursor is invalid.

No production retention alarm, capacity refusal, or capacity summary exists. No implementation edit is needed merely to preserve the completed dependencies.

## Proposed approach and approval scope

Use the existing native authority and response owners. Add a focused SQLite capacity owner and a bounded retention owner.

A Worker-only capacity check cannot serialize competing commits. Per-isolate client counters cannot enforce the distributed client limit.

A new coordinator service or full-vault cache adds an authority and duplicates existing duties. Neither belongs in this task.

The proposal uses these policy interpretations. Approval covers them unless the owner changes them during review:

1. GB means decimal bytes. Thresholds are 1,000,000,000, 1,500,000,000, 2,000,000,000, and 4,000,000,000 bytes.
2. The file limit counts live files, not permanent tombstones. Admission can reach exactly 10,000, but never 10,001.
3. At 10,000 live files, new non-delete content mutations fail with `507 capacity_exceeded`, as AC-43 states.
4. At the database cap, non-delete content mutations fail. Deletes and read admission remain recovery operations, not content admission.
5. Receipt replay remains available at capacity after current authorization checks. Replay creates no revision and is not a new content mutation.
6. Alerts use the existing authorized vault summary. This task does not build a plugin panel or an owner console.
7. Export pins remain authoritative even without an active export implementation. Retention never releases pins or deletes R2 objects.
8. Native deployed memory remains unproven under OAB-6.8.2. Local executable bounds must state that limit.

## Global constraints

- Preserve exact revision preconditions, lifetime revision identity, permanent tombstones, and atomic FTS publication.
- Keep Zod protocol shapes canonical. Derive public TypeScript types from those schemas.
- Text limit: 1,000,000 bytes. Blob limit: 25,000,000 bytes. Range limit: 1,000,000 bytes.
- Preserve manifest pages of at most 256 rows, feed pages of at most 1,000 entries, and search results of at most 50.
- Keep feed and receipts for 30 days. Preserve the UUIDv7 acceptance window of 25 days plus 5 minutes.
- Keep ordinary history for 30 days. Pressure pruning never crosses the 7-day floor or removes an export pin.
- Raise visible history-reduced attention when pressure pruning removes otherwise retained revisions.
- Use `sql.databaseSize` for the 2 GB total cap, including admission storage.
- Use logical payload-byte counters for `revisions`, `receipts`, and `changes`, not FTS or physical table pages.
- Maintain category counters and their sum in `meta` within the same publication or pruning transaction.
- Encode each complete row as a JSON array in SQLite column order. Count UTF-8 bytes of the JSON text. Preserve null values. Exclude SQLite allocation overhead, indexes, FTS, and external R2 object bytes.
- Do not add dependencies, deploy, change Cloudflare resources, or touch the personal vault.
- Keep application code independent of Cloudflare SDKs. Composition only wires owners.
- Use the Backlog CLI for task changes. Do not create progress or review-record documents.
- Document named semantic declarations with useful TSDoc. Keep comments true to callers and failure behavior.
- Preserve the frozen schema compatibility policy. The owner approved schema version 4 for required logical history counters. Reject versions 1 through 3 without writes, migration, repair, zero backfill, or epoch replacement.

## Evidence and feasibility gates

Cloudflare documentation checked on 2026-10-22 lists 100 bound parameters, 100 columns, and a 2 MB string, BLOB, or row limit.

It lists 128 MB per Worker isolate and six simultaneous outgoing connections per request. Neither limit is a per-file allowance.

Sources:
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/

Published limits can differ from the pinned runtime. Use native tests before code depends on an API or storage observation.

Native tests confirm transaction-visible `sql.databaseSize`, rollback, and free-page reuse. The pinned runtime rejects `dbstat` with `no such table: dbstat: SQLITE_ERROR`.

The owner resolved this blocker with a specification decision. Exact native table attribution no longer gates implementation.

Keep the 2 GB physical cap. Use transactional logical payload-byte counters for history pressure across `revisions`, `receipts`, and `changes`.

Do not start a platform investigation task, change dependencies, or claim that logical counters measure physical table storage.

Check free-page reuse separately from physical shrink. Deleting history does not itself prove that allocated database bytes decrease.

Do not allocate a 2 GB fixture to test policy boundaries. Use real native page growth with injected lower test thresholds.

Keep production defaults fixed at the specified thresholds. Test thresholds are internal construction inputs, never request parameters.

A storage compatibility change needs a named version boundary and an approved specification amendment. No existing store can receive a silent repair.

## Review focus

1. Two authorized commits compete for the last file or database allowance. Only the admissible commit succeeds.
2. Pressure coincides with a young revision or export pin. Neither protected revision disappears.
3. Physical feed pruning removes every expired row. An old cursor still returns `410 cursor_expired`, including after restart.
4. Receipt pruning and a fast UUIDv7 clock meet an exact cutoff. A removed receipt cannot make an old UUIDv7 operation new again.
5. Mixed reads, uploads, slow consumers, and cancellation share one isolate. Started work retains its charge until settlement.

## Work unit 1: Atomic capacity and observable state

**Files:**
- Create `apps/worker/src/infrastructure/sqlite/capacity.ts`.
- Change `apps/worker/src/infrastructure/sqlite/mutations.ts`, `text-files.ts`, `history.ts`, and `reads.ts`.
- Change `apps/worker/src/infrastructure/durable-object/vault.ts` only for wiring.
- Change `packages/protocol/src/schemas/files.ts`, `schemas/reads.ts`, derived types, and public exports.
- Test `apps/worker/test/vault-capacity.test.ts`, `test/http/capacity.test.ts`, and `packages/protocol/test/reads.test.ts`.
- Extend `apps/worker/test/vault-publication-budgets.test.ts` for changed publication queries.

**Interfaces:**
- Keep existing public mutation RPC signatures and result shapes, except the canonical new capacity failure variant.
- Add `capacity_exceeded` to the canonical failure union with HTTP status 507.
- Add `capacity` to `VaultReadResultSchema`: `database_bytes`, `database_limit_bytes`, `live_file_limit`, `history_pressure_bytes`, and `referenced_blob_bytes`.
- Add `attention` as a strict array of codes: `storage_high`, `capacity_exceeded`, `history_reduced`, and `blob_storage_high`.
- `referenced_blob_bytes` counts known unique referenced hashes. It does not claim to measure all R2 objects or unreferenced uploads.
- `SqliteCapacityPolicy` receives storage and fixed production defaults through construction. Its transaction hooks check admission and final publication.
- `assertCanPublish(tx, operation)` checks current limits after authorization and receipt replay, before new publication.
- `assertPublishedSize(tx, operation)` checks native database allocation after publication and receipt insertion, before transaction commit.
- Both hooks throw `FileOperationDenied` for known capacity refusals. The outer transaction must roll back all publication effects.
- Add deterministic UTF-8 logical payload encoding for complete revision, receipt, and change row payloads.
- Track `revisions`, `receipts`, `changes`, and total logical bytes in `meta`. Update them with publication, including receipt insertion.
- Keep logical accounting separate from `sql.databaseSize`. Do not count FTS, indexes, allocator overhead, or external blob bytes as logical payload.
- Use schema version 4 for the five required history metadata keys. Fresh v4 stores start at zero. Existing v3 and older stores fail closed without backfill or repair.
- Count revision fields in `path`, `rev`, `hash`, `size`, `kind`, `content`, `blob_hash`, `deleted`, `origin`, `at` order. Count receipt fields in `client_id`, `key`, `fingerprint`, `status`, `body`, `at` order. Count change fields in `seq`, `op`, `path`, `rev`, `hash`, `from_path`, `from_rev`, `origin`, `at` order.

- [x] Test native transaction-visible allocation, rollback, free-page reuse, and missing `dbstat`.
- [ ] Preserve the two passing native capability tests. No further exact-attribution gate applies.
- [ ] Write failing counter tests for Unicode payloads, null content, blob-reference rows, receipt replay, and rollback.
- [ ] Verify counter deltas for create, update, DELETE, append, rename, restore, and keyed receipts within publication transactions.
- [ ] Write failing tests at 9,999, 10,000, and competing admissions for the final live-file slot.
- [ ] Write failing tests for create, update, blob publication, append, rename, restore, delete, and replay at capacity.
- [ ] Use native growth with small test thresholds to reject a commit that crosses its database budget.
- [ ] Assert rollback of files, revisions, FTS, feed, counters, receipt, and ticket effects after the final size check fails.
- [ ] Assert authorization and stale-precondition failures retain their existing precedence and disclose no unauthorized content.
- [ ] Add summary schema and HTTP tests for exact alert thresholds and recovery reads at the product cap.
- [ ] Implement the capacity owner inside the existing transaction. Do not place the deciding check before an asynchronous storage wait.
- [ ] Keep read reservations, cleanup, and delete revision writes available at the product cap. Test these exceptions without claiming physical storage is unlimited.
- [ ] Run focused native, protocol, and HTTP tests. Run `bun run docs:check` and `bun run check`.
- [ ] Commit as `feat(worker): enforce atomic vault capacity limits`.

## Work unit 2: Bounded durable retention

**Files:**
- Create `apps/worker/src/infrastructure/sqlite/retention.ts`.
- Change `apps/worker/src/infrastructure/sqlite/reads.ts`, `capacity.ts`, and the Vault composition and alarm handler.
- Change `schema-model.ts`, generated schema tooling, fixtures, and `docs/spec.md` only if the approved storage contract needs a version boundary.
- Test `apps/worker/test/vault-retention.test.ts`, `vault-reads.test.ts`, and `test/http/read-recovery.test.ts`.

**Interfaces:**
- `SqliteRetentionStore.runBatch(now: number)` returns `{ more: boolean, historyReduced: boolean }` for one synchronous transaction.
- Each batch deletes at most 64 selected identities from one retention category. Use composite-key selection without exceeding 100 bindings.
- Categories are expired changes, expired receipts, ordinary expired revisions, and pressure-eligible revisions.
- Native metadata stores durable category progress, the removed feed prefix boundary, and sticky history-reduced attention.
- Use the existing `meta` table for compatible added state. Validate it without silently repairing malformed storage.
- Effective feed eligibility is the maximum of the persisted pruned boundary and the existing time-derived boundary.
- Persist progress, deletion, and logical payload counter decrements atomically. Repeated delivery must not skip data or lower the feed boundary.
- Pressure uses the sum of logical `revisions`, `receipts`, and `changes` payload bytes. FTS and physical table pages do not enter that sum.

- [ ] Write failing exact-cutoff tests for 30-day feed, receipt, and ordinary history retention.
- [ ] Test receipt retention against UUIDv7 keys at minus 25 days, plus 5 minutes, and after receipt expiry.
- [ ] Test opaque-key behavior separately. Do not claim UUIDv7 age protection for opaque keys.
- [ ] Write failing pressure tests above the 1 GB history-group threshold, with a reduced internal test threshold.
- [ ] Verify oldest-first pruning beyond 7 days, retained exact-floor rows, pins at every age, and visible history-reduced state.
- [ ] Verify protected history can prevent relief. Refuse new content rather than remove protected rows.
- [ ] Verify tombstones, current content, path revision counters, head sequence, and immutable feed identities survive pruning.
- [ ] Verify an empty physical feed still rejects expired cursors after restart. Test rename source and destination identities.
- [ ] Verify revision pruning removes only that revision's metadata and payload reference. Never delete immutable R2 objects.
- [ ] Implement batches and a resumable nightly alarm. Schedule the next batch separately from the next nightly cycle.
- [ ] Preserve pending maintenance after interruption. Test repeated delivery, native faults, and constructor restart.
- [ ] Keep alarm scheduling behind the native owner. Reserve a clear composition seam for future export alarms without building exports.
- [ ] Rerun query and record budgets for cleanup and the changed summary paths.
- [ ] Run focused retention and recovery tests, `bun run docs:check`, and `bun run check`.
- [ ] Commit as `feat(worker): prune retained data with durable safety bounds`.

## Work unit 3: Distributed admission and aggregate runtime checks

**Files:**
- Extend `apps/worker/test/vault-admission-global-limit.test.ts`, `vault-read-interleavings.test.ts`, and `aggregate-body-work.test.ts`.
- Create `apps/worker/test/aggregate-runtime-budget.test.ts` and `test/http/runtime-limits.test.ts`.
- Extend `test/fixtures/publication-budgets.ts` only for reusable measurement duties.
- Change `application/body-budget.ts`, `read-budget.ts`, native admission, or existing response owners only when a failing regression proves a gap.
- Keep native deployed measurements in OAB-6.8.2, not in a new test service or plugin.

**Interfaces:**
- Keep one durable admission authority per vault. Reuse current grants, ticket deadlines, uncertain states, and positive retry delays.
- Keep four body slots and four read slots unless measured combined application ownership proves they need a smaller shared allowance.
- Any changed allowance needs an explicit specification update within approved scope. Do not silently change the public concurrency contract.
- Measurement fixtures observe application SQL, complete encoded records, started RPC/storage work, and application-owned buffers separately.
- Do not label logger dispatch counts as internal FTS work or total platform subrequests.

- [ ] Write failing or characterization tests for 16 durable client admissions across grants and independent Worker routers.
- [ ] Admit competing requests through the same real DO, not a shared local counter. Verify request 17 returns 429 and positive `Retry-After`.
- [ ] Test mixed read/write admissions, exact expiry, uncertainty, duplicate-key ownership, and safe refusal during unresolved work.
- [ ] Exercise four maximum inline mutations concurrently with four content, metadata, or search responses across vault hosts.
- [ ] Exercise concurrent maximum blob streams with slow reads, unread responses, abort, cleanup failure, and delayed RPC results.
- [ ] Assert no future demand after abort and no early slot reuse before started work and cleanup settle.
- [ ] Derive a simultaneous application-memory budget from owned allocations and retained values, including UTF-16 and encoded response fragments.
- [ ] State each observed bound separately from native buffers, RPC retention, FTS working memory, and total process memory.
- [ ] Check every changed SQL path stays within 100 parameters and complete rows stay below 2 MB in real workloads.
- [ ] Count RPC and R2 operations for the worst bounded page and upload paths. Check sequential demand and at most six pending connection starts per request.
- [ ] Use the smaller verified pinned-runtime subrequest allowance. Do not assume a newer published Paid allowance changes the pinned runtime.
- [ ] Retain permanently blocked-work tests as safe-refusal checks. Do not call unresolved work successful recovery.
- [ ] Add AC-43 HTTP tests for content refusal, replay, read availability, delete availability, and summary attention at capacity.
- [ ] Run focused native and HTTP checks, `bun run docs:check`, and `bun run check`.
- [ ] Commit as `test(worker): verify aggregate runtime and admission limits`.

## Commands and evidence

Run from the isolated worktree. Use background execution for long commands and retain exit-code summaries.

- Baseline and final gate: `bun install --frozen-lockfile && bun run check`.
- Native focus: `cd apps/worker && bunx --no-install vitest run --config vitest.config.ts test/vault-capacity.test.ts test/vault-retention.test.ts test/aggregate-runtime-budget.test.ts`.
- HTTP focus: `cd apps/worker && bunx --no-install vitest run --config vitest.http.config.ts test/http/capacity.test.ts test/http/runtime-limits.test.ts`.
- Protocol focus: `cd packages/protocol && bun run test -- reads.test.ts`.
- Documentation correction: `bun run docs:check`.

For each new behavior, first run its test before implementation. An expected RED command must record its observed nonzero exit and return zero itself.

Record RED/GREEN evidence in task notes. Do not invent a failing result when a characterization test starts green.

## Acceptance mapping and limits

- AC 1: Work unit 1 and the final HTTP matrix prove atomic admission and recovery operations at the declared cap.
- AC 2: Work unit 2 proves retention, receipt safety, export pins, durable feed recovery, and lifetime identity.
- AC 3: Work unit 3 proves distributed durable admission and canonical retry headers.
- AC 4: Units 1 and 3 provide executable SQL, row, application-memory, operation-count, and lifecycle bounds.
- Native deployed retention remains intentionally deferred to OAB-6.8.2. Do not report deployed memory capacity as proven.
- R2 reference accounting cannot prove total bucket bytes. Total R2 alerts need an authorized inventory source in a later console or storage task.
- No plugin panel, export execution, blob garbage collection, OAuth, MCP, personal-vault access, or deployment belongs here.

## Execution and review gates

Use one implementer per sequential work unit. Each implementer owns its full RED/GREEN cycle, formatting, full check, and commit.

Use one independent reviewer after each unit. The parent reviews the complete branch with the code-review skill and TypeScript profile.

Record reviewed revisions, documentation scope, structural candidates, verification, limits, and explicit closure for each finding in task notes.

If a finding needs unavailable deployed evidence, cite the existing owner deferral and retain OAB-6.8.2 with its trigger. Do not claim that evidence exists.

After complete checks and review, open one human branch review against main. Address every annotation before publication.

Only then close OAB-6.8 through the Backlog finalization guide and prepare the pull request. Do not merge locally.

## Plan self-review

The plan maps all four criteria to native or HTTP tests. It keeps deployed measurements outside the local evidence boundary.

Capacity uses the common publication transaction, not transport authority. Retention keeps permanent rows and a durable feed boundary.

The native gate found missing `dbstat`. The owner approved logical history accounting and kept `sql.databaseSize` for the total cap.

The owner directs continuation with the same worker and no second plan review. Ask again only for a failed `bun run check` or another specification change.

No platform investigation task applies. Deployment remains unauthorized. Preserve the native capability tests and the original blocker evidence.
