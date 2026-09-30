# M7.4 Complete Sync Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the private protocol-major-one `SyncStore` over the isolated M7.3 R2 primitives, with crash-safe publication, fair feed and bounded resumable inventory, without activating synchronization.

**Architecture:** `packages/core` keeps the existing nine-method port and mutation policy; `packages/protocol` keeps canonical keys, identifiers, sequence and cursor formats. Private `apps/worker/src/infrastructure/sync/` modules own strict persisted journal/feed records, one-key conditional access, multi-step mutation orchestration, read-only feed paging and inventory state machines. Only the private composition implements `SyncStore`; no Worker route, MCP capability, plugin setting or production bootstrap imports it. Deliver one branch/PR with sequential behavior-bearing commits and fresh independent review gates. The owner expressly accepts exceeding the normal production-file/line limits for this M7.4 PR; this is not an exception for unrelated work.

**Tech Stack:** Strict TypeScript, existing Zod 4, Cloudflare R2 binding, Vitest and isolated local workerd; `mise` tasks. No new infrastructure or dependencies.

**Spec:** `docs/milestones/m7-versioned-sync-protocol-and-r2-store.md` (M7.4), with M7.1–M7.3 already merged; ADR 0016 remains a proposal for later product activation.

## Global Constraints

- Work on a feature branch/worktree from `main` after PR #95 (`2a885a5`); do not mutate/deploy real R2, vaults or production services. Synthetic marker fixtures only; never provide production provisioning.
- Preserve existing M1–M6 v2 prefixes, API, MCP, designated writer and M5 support claim; no sync route or plugin/OAuth composition. Never treat v2 data as a sync revision or read it through the new store.
- Validate untrusted vault/path/revision/operation/cursor at the adapter entry; strict private schema/key linkage; no R2 ETags or R2 cursors across the core port. No native R2 DELETE except scoped expired inventory scratch cleanup after explicit proof; never delete heads, versions, content, recovery or feed.
- Exact parent/create-only or original observed-ETag CAS; never refresh lane/current-head preconditions and retry. Journal-only transitions may use an exact fresh read of their own operation-bound monotonic journal phase for the journal CAS; a journal cannot embed its own future ETag. After a lost 429/timeout floor, an exact recovery observation establishes a conservative observation-time + 1,100-ms lower bound before any new attempt; divergent/unavailable evidence remains unknown. Use the existing one-key cooldown/read-back and persist retry floors where possible across isolates. No in-request sleep, local-lock correctness, implicit abort on timeout or successful publication before readable committed feed evidence.
- Markdown ≤1 MiB, canonical NotePath ≤720 UTF-8 bytes, 64 SHA-256-selected lanes, 20-digit non-zero sequences, ≤100 changes/page, 30-day cursor expiry (without purging events). Inventory: 24-hour scratch expiry, 10,000 heads, 20,001 list pages/chunks, at most two persisted attempts per step, at most one LIST(limit 1) and one head GET per attempt; 40,002 LIST and 20,000 head GET maximum; 400 R2 internal-service subrequests per invocation including read-backs, and CPU preflight before reserving a data-read attempt. Read spec for every aggregate byte, chunk, cursor, and evidence ceiling.
- Treat failed/missing/corrupt/ambiguous evidence conservatively: no complete snapshot, absent path inference, silent conflict resolution or current-head overwrite. New code has useful TSDoc, strongly typed results, alias imports, focused tests outside `src/`, no weak casts/console/deprecated APIs. `mise run check` and semantic review are required, not sufficient for a deployed Workers Free claim.
- One PR is approved despite AGENTS.md thresholds and the review-budget skill's 400-line default; record actual additions/deletions and exception in PR. Commit separately by tested semantic unit, maintain a task-by-task review ledger and provide a navigable PR description. No deploy, merge, release or real-vault qualification without separate owner permission.

## Review Focus

1. Lost journal-create response with absent read-back: return unknown with cooldown; only identical request/ID may retry create-only, never claim no operation (Task 2).
2. A changed current head after lane reservation: publish verified abort at reserved sequence without overwriting the competitor; if ambiguous, retain blocker (Tasks 2–3).
3. An expired cursor whose lane is already at high water: it is **not** expired; first unconsumed old event **is** expired; hot lane cannot starve later lanes (Task 4).
4. Interrupted inventory after chunk create but before manifest CAS: validate persisted exact chunk and resume its stored cursor without repeating LIST/head GET (Task 6).
5. A complete manifest with unreleased/ambiguous active slot, or a partial evidence chain: never return a usable complete handle or absence evidence (Tasks 7–8).

---

## File map and ownership

| Unit | Production files (create unless marked modify) | Tests | Responsibility |
| --- | --- | --- | --- |
| Private journal/feed contracts | `apps/worker/src/infrastructure/sync/sync-publication.types.ts`, `sync-publication.schemas.ts`, `sync-publication.codec.ts` (modify `sync-r2-key.ts` only if closed keys require it) | `apps/worker/tests/unit/infrastructure/sync-publication-codec.test.ts` | Strict record/key/request provenance and bounded raw bodies; no policy or R2 calls |
| Durable single-key publication | `apps/worker/src/infrastructure/sync/sync-r2-publication.ts` | `apps/worker/tests/unit/infrastructure/sync-r2-publication.test.ts`, `apps/worker/tests/runtime/sync-r2-primitives.test.ts` | Marker-gated journal, lane head, event create/CAS/read-back via existing object store |
| Mutation state machine | `apps/worker/src/infrastructure/sync/sync-r2-mutation.ts`, `sync-r2-mutation.types.ts` | `apps/worker/tests/unit/infrastructure/sync-r2-mutation.test.ts`, `apps/worker/tests/runtime/sync-r2-publication.test.ts` | Full nine-method port's `mutate`/`resumeOperation` and current/version/recovery delegation; own durable step authority |
| Feed reader | `apps/worker/src/infrastructure/sync/sync-r2-feed.ts` | `apps/worker/tests/unit/infrastructure/sync-r2-feed.test.ts` | Snapshot high-water, fair bounded paging, cursor validation/expiry |
| Inventory execution | `apps/worker/src/infrastructure/sync/sync-r2-inventory-runner.ts`, `sync-r2-inventory-budget.ts`, `sync-r2-inventory-replay.ts` | `apps/worker/tests/unit/infrastructure/sync-r2-inventory-runner.test.ts`, `sync-r2-inventory-replay.test.ts`, `apps/worker/tests/runtime/sync-r2-inventory.test.ts` | Start/slot/vector, bounded LIST, durable attempt/chunk replay, terminal vector and release |
| Evidence and cleanup | `apps/worker/src/infrastructure/sync/sync-r2-inventory-pages.ts`, `sync-r2-inventory-cleanup.ts` | `apps/worker/tests/unit/infrastructure/sync-r2-inventory-pages.test.ts`, `sync-r2-inventory-cleanup.test.ts` | Contiguous root/count paging, eligible scratch reaping only |
| Private composition | `apps/worker/src/infrastructure/sync/sync-r2-store.ts` | `apps/worker/tests/integration/sync-r2-store.test.ts`, `apps/worker/tests/runtime/sync-r2-store.test.ts` | Implement `SyncStore`; no import by `app.ts`, `index.ts`, HTTP, MCP or plugin |

Reuse M7.3 `sync-r2-object.ts`, `sync-r2-records.ts`, `sync-r2-inventory.ts`, `sync-record.*`, existing `r2.types.ts`, and M7.1 codec/keys. Modify these only for a proved invariant/contract gap, with focused regression tests. If actual R2 LIST or scoped scratch cleanup needs a narrower capability, add it in `apps/worker/src/infrastructure/sync/sync-r2-inventory-list.ts` or cleanup module, and use only validated inventory/heads prefixes. Tests may share deterministic synthetic fixtures outside production. Doc owners: milestone spec, `docs/architecture.md`, `docs/current-state.md`, `docs/roadmap.md`, and an M7 evidence report under `docs/qualification/`; `docs/api.md` only if current API changes (not intended). **This file map is an estimate, not a promise of final size; stop on a material new architectural decision rather than hiding it in an extra module.**

### Task 1: Closed journal/feed records and exact immutable bytes

**Files:** Create `sync-publication.types.ts`, `sync-publication.schemas.ts`, `sync-publication.codec.ts` and `sync-publication-codec.test.ts` as mapped above; extend `sync-record.*` only where a strict shared codec is needed.

**Interfaces:** Export `SyncJournalRecord` (`pending | committed | aborted` with one immutable normalized request and recorded exact external-step precondition/retry evidence; never an impossible self-ETag witness), `SyncLaneHeadRecord` (committed sequence/time plus optional single pending operation/next sequence), `SyncFeedEventRecord` (`changed | aborted`, exact vault/lane/sequence/operation/time) and `decodeSyncPublication(kind, key, bytes, vaultId): Promise<SyncPublicationRecord>` / `encodeSyncPublication(record): Promise<Uint8Array>`. Choose a bounded persisted representation for exact mutation payload (≤1 MiB) and original CAS ETag without returning either through core. Contract must support resuming from **only** journal and exact R2 observations after isolate loss; do not add unknown authority-bearing fields without updating the spec/ADR and seeking approval.

- [ ] **Step 1:** Write failing codec tests for strict major/vault/key/revision/request equality, malformed extras, body hash/byte size, pending reservation, 20-digit sequence overflow, monotonic commit timestamp, exact idempotent bytes and changed/aborted event unions.
- [ ] **Step 2:** Run `mise run test -- apps/worker/tests/unit/infrastructure/sync-publication-codec.test.ts`; expect behavioral failure before code.
- [ ] **Step 3:** Implement those exact exported contracts and codec; document the durable original-ETag/cooldown representation in TSDoc. Assert no journal/event/list/head key can name v2 prefixes.
- [ ] **Step 4:** Run focused tests and `mise run typecheck`; expect pass. Commit tests+code: `feat(worker): define durable sync publication records`.

### Task 2: Marker-gated journal/lane/event persistence

**Files:** Create `sync-r2-publication.ts`, `sync-r2-publication.test.ts`; extend the M7.3 workerd test.

**Interfaces:** `syncR2Publication(objects: SyncR2ObjectStore): SyncR2Publication` with `readJournal`, `createJournal`, `replaceJournal`, `readLaneHead`, `createLaneHead`, `replaceLaneHead`, `readEvent`, `createEvent`; reads return `SyncRecordRead<T>`, writes return `SyncR2WriteResult` with caller-carried `SyncR2RetryContext`. Key arguments are typed vault+operation or vault+lane+sequence, never free-form strings. `readEvent` absence is not proof of committed sequence; lane-head validation owns that.

- [ ] **Step 1:** Test create-only journal/event replay, exact-byte read-back, exact ETag single-winner reservation, refusal without refreshed CAS, 1,100-ms repeated journal/head writes, timeout/429 retry floor and wrong/missing marker. Workerd tests prove real local R2 predicates and v2 sentinels unchanged (not production throttling).
- [ ] **Step 2:** Run focused `mise run test -- apps/worker/tests/unit/infrastructure/sync-r2-publication.test.ts` and `mise run worker:storage-test`; expect new assertions to fail before code.
- [ ] **Step 3:** Implement only one-key methods by composing Task 1 with existing M7.3 object store and marker gate. Never interpret an unavailable read-back as absence.
- [ ] **Step 4:** Run focused tests, workerd and typecheck; commit tests+code: `feat(worker): persist conditional sync journals and feed records`.

### Task 3: Recoverable mutation publication and exact reads

**Files:** Create `sync-r2-mutation.ts`, `sync-r2-mutation.types.ts`, tests mapped above; extend runtime publication test.

**Interfaces:** `syncR2Mutation(records: SyncR2Records, publication: SyncR2Publication, clock: SyncServerClock): Pick<SyncStore, "mutate" | "resumeOperation" | "readCurrent" | "readVersion" | "readRecovery">`; `SyncServerClock` supplies epoch milliseconds, never grant/authorization. The state machine retains full request identity in the journal and exact observed ETags/bytes/retry floors for external pending steps; journal-only CAS derives its ETag from a fresh exact read of its own typed monotonic phase after resolving uncertainty. Use `evaluateSyncMutation` from core for parent/target policy; do not duplicate it inside the adapter.

- [ ] **Prerequisite reviewed unit 3A:** Before Task 3 implementation, correct the Task 1/2 private persisted journal and facade contract against the accepted unallocated→allocated same-lane race in the M7 spec (see the paragraph beginning “The initial `unallocated` pending journal”). Test-first, introduce a strict pending discriminant: unallocated has request/lane/exact persisted lane observation and no sequence or publication authority; allocated alone holds exact won sequence/predecessor and step evidence. Initial missing lane head must be initialized/read back as zero head and its ETag journaled before reservation. Preserve original lane CAS condition on unknown effects; definite loser can CAS-update only its own still-unallocated observation after verified release, while same-ID callers may adopt only a matching own pending marker. Change `sameJournalIdentity` to permit just the monotonic unallocated→allocated transition and evidenced unallocated re-observation, never allocation rewrite or journal rewind. Include first-use absent lane, different-ID and same-ID races, crash after reservation before journal transition, uncertain journal/lane writes, and cooldown rejection tests. Commit the contract correction with tests, run focused checks/`mise run check`, and obtain fresh task review before starting the rest of Task 3. Do not report Task 3 completed merely because this prerequisite passes.
- [ ] **Step 1:** Write failing tests for create/update/tombstone (preserve parent recovery before tombstone), same-op exact replay, changed request `operation_id_reused`, two-writer stale parent, destination-first synthetic rename using two independent operations, exact archived parent, injected crash **between every** journal/reservation/immutable/head/event/journal-commit/lane-head-commit boundary and 429/timeout on each mutable key. Assert only a readable committed feed event+head+committed journal can return `committed`; ambiguous head or lane stays blocked.
- [ ] **Step 2:** Run `mise run test -- apps/worker/tests/unit/infrastructure/sync-r2-mutation.test.ts`; expect failure. Run workerd baseline separately.
- [ ] **Step 3:** Implement one bounded step progression per resume invocation. Journal first; reserve lane with original ETag; immutable bytes before conditional head; verified feed event; committed journal; lane commit last. If head provably unchanged/stale before effect, publish `aborted` at reserved sequence before releasing; if evidence ambiguous, leave pending with typed `effect_unknown`. Persist cooldown/original ETag before a retryable write, not only in process memory. Do not wait in request or retry with a newer ETag. A journal-create timeout with absent read-back stays unknown until identical original mutation is resubmitted after cooldown.
- [ ] **Step 4:** Run focused unit+workerd tests and typecheck; commit tests+code: `feat(worker): publish resumable sync mutations`.

### Task 4: Fair metadata-only feed reader

**Files:** Create `sync-r2-feed.ts`, `sync-r2-feed.test.ts`.

**Interfaces:** `syncR2Feed(publication: SyncR2Publication, clock: SyncServerClock): Pick<SyncStore, "readChanges">`; use existing protocol `decodeSyncCursor`/`encodeSyncCursor`, 64-lane vector, lane head and immutable event codec. No note body read, R2 cursor or ETag in result.

- [ ] **Step 1:** Test 64 captured high-water reads, nextLane rotation, at most one next event per eligible lane per round, hot lane vs later lane, ≤100 output/≤6,400 visits, >2^53 sequence correctness, invalid/future/foreign cursor refusal, 30-day age of **first unconsumed** event, empty page at high water, missing/malformed committed event `storage_unavailable` or unknown (never empty success).
- [ ] **Step 2:** Run `mise run test -- apps/worker/tests/unit/infrastructure/sync-r2-feed.test.ts`; expect failure.
- [ ] **Step 3:** Implement bounded reader and typed cursor errors; capture a fixed committed vector once per call and retain input pointer for empty pages.
- [ ] **Step 4:** Run focused tests/typecheck; commit tests+code: `feat(worker): page committed sync changes fairly`.

### Task 5: Inventory start, budget and exact scan admission

**Files:** Create `sync-r2-inventory-budget.ts`, `sync-r2-inventory-runner.ts`, `sync-r2-inventory-runner.test.ts`; extend existing scratch module only for typed data access. Defer page iteration to Task 6.

**Interfaces:** `SyncInventoryInvocationBudget.reserve(requiredCalls: number, requiredCpuAllowance: number): boolean` accounts every R2 GET/LIST/conditional write/read-back, hard cap 400; concrete CPU preflight uses an injected conservative request budget and returns progress before data-read reservation (not a claim of measured Free CPU). `syncR2InventoryRunner(scratch: SyncR2InventoryScratch, publication: SyncR2Publication, listing: SyncR2InventoryListing, budget: SyncInventoryInvocationBudget, clock: SyncServerClock): Pick<SyncStore, "startInventory" | "continueInventory">`; Task 6 fills one-page steps. `SyncR2InventoryListing.listHeads(prefix, cursor, limit: 1)` and `readHead(key, maxBytes: 2048)` accept only validated isolated heads keys and preserve `truncated` and opaque R2 cursor privately.

- [ ] **Step 1:** Test create exact `starting` manifest once, one active slot per vault, competing scan identity cannot adopt, 24-hour expiry with manifest proof, 64 start-vector pending refusal, unreadable manifest/slot retains scan identity, manifest/slot same-key cooldown defers without sleeping or spending attempt, every call budgeted including read-back; do not claim scan completion here.
- [ ] **Step 2:** Run focused unit test; expect failure.
- [ ] **Step 3:** Implement bounded start/claim/vector phases and one-step dispatcher, no LIST until durable scanning phase and budget reservation. Record exactly where invocation budget is injected into all storage capabilities; if M7.3 methods cannot report per-call count, add narrow counted wrappers instead of assuming one call per facade method.
- [ ] **Step 4:** Run focused tests and typecheck; commit tests+code: `feat(worker): admit bounded resumable inventories`.

### Task 6: Exactly one page and durable replay per inventory step

**Files:** Create `sync-r2-inventory-replay.ts`, `sync-r2-inventory-replay.test.ts`; extend runner tests and local workerd inventory test.

**Interfaces:** `runSyncInventoryStep(manifest: SyncRecordObservation<SyncInventoryManifest>, scratch: SyncR2InventoryScratch, listing: SyncR2InventoryListing, budget: SyncInventoryInvocationBudget, clock: SyncServerClock): Promise<SyncInventoryResult>`; implementation-private result may retain a typed terminal-listing phase. Task 5 calls it only after validated slot/phase/budget; it never returns `complete` before Task 7 finalization.

- [ ] **Step 1:** Test LIST limit=1, short/empty truncated pages, advancing opaque cursor, strict global key order, canonical path key/body linkage, bounded head GET, validated transcript and 12-KiB chunk, manifest cursor/root advance only after verified create-only chunk. Persist attempts 1/2 **before** LIST/GET; after interruption probe deterministic chunk first and replay from saved cursor only when exact absence proven; after second attempt require exact chunk-key absence before `inventory_limit_exceeded`. Inject failure at every read/chunk/CAS boundary, 429/unavailable/unknown; never count preflight as an attempt or expose partial result.
- [ ] **Step 2:** Run focused replay and runtime tests; expect failure.
- [ ] **Step 3:** Implement complete chunk validation including previous hash, canonical serialized bytes, input/output cursor digests, strict transcript, summary and byte/count ceilings; use private recovery cursor, not R2 metadata. Enforce 20,001 chunks, 10,000 unique heads, 40,002 LIST and 20,000 head GET calls, 20/40 MiB bodies and 192 MiB evidence. A present mismatched chunk is terminal incomplete, not replay authority.
- [ ] **Step 4:** Run replay+runner+workerd tests/typecheck; commit tests+code: `feat(worker): replay bounded sync inventory pages`.

### Task 7: Final vector, slot release and evidence paging

**Files:** Create `sync-r2-inventory-pages.ts`, `sync-r2-inventory-pages.test.ts`; extend runner and runtime tests.

**Interfaces:** `syncR2InventoryPages(scratch: SyncR2InventoryScratch, budget: SyncInventoryInvocationBudget): Pick<SyncStore, "readInventoryPage">`; runner's finalizer captures all 64 lane committed sequences/pending markers, CAS persists complete manifest only when equal to start, CAS releases **only own** active slot, then returns `SyncCompleteInventory`. Evidence cursor binds vault+scan+vector+root+chunk offset+prior hash, never raw R2 cursor.

- [ ] **Step 1:** Test changed vector or pending lane fails without complete handle; completion/slot release throttled, interrupted or ambiguous remains progress/unknown until exact evidence; complete manifest with wrong active ID cannot release. Test ≤16 chunks and ≤16 summaries per page, empty continuation means progress, invalid/missing/altered chunk or cursor fails, final only after count/root match. At maxima assert 184,328,448 evidence bytes <192 MiB and ≤1,251 successful evidence responses; all invocations ≤400 calls.
- [ ] **Step 2:** Run focused pages+runner tests; expect failure.
- [ ] **Step 3:** Implement final-vector equality, persisted completion and exact slot release; read all evidence pages only from complete manifest with validated contiguous hashes/offsets. A slot read-back uncertainty must not surface complete authority.
- [ ] **Step 4:** Run focused and workerd tests/typecheck; commit tests+code: `feat(worker): verify complete sync inventory evidence`.

### Task 8: Prefix-limited expired scratch cleanup and private port composition

**Files:** Create `sync-r2-inventory-cleanup.ts`, `sync-r2-inventory-cleanup.test.ts`, `sync-r2-store.ts`, integration/runtime tests mapped above.

**Interfaces:** `createSyncR2Store(bucket: R2ConditionalBucketPort, clock: SyncServerClock): SyncStore` composes Tasks 2–7 and M7.3; cleanup is a private capped pass `reapExpiredSyncInventoryScratch(vaultId: SyncVaultIdDto, budget: SyncInventoryInvocationBudget): Promise<SyncInventoryCleanupResult>`, never a `SyncStore` method or public route. If existing delete-free port intentionally prevents scratch deletion, introduce a scoped cleanup-only inventory capability with exact validated keys, strict expiry proof and own tests; do not add generic delete to mutation-capable ports.

- [ ] **Step 1:** Write failing conformance tests covering all nine methods, same-vault isolation, v2 byte-for-byte sentinels, closed errors, resume across fresh store instances, no Worker app import, cross-namespace list refusal. Cleanup tests: at most 400 calls incl read-backs, only expired inventory manifest/chunks and proved-owned active slot, no head/feed/version/recovery delete; uncertain expiry/slot remains intact.
- [ ] **Step 2:** Run focused conformance/cleanup and `mise run worker:storage-test`; expect new behavioral failures.
- [ ] **Step 3:** Compose the nine-method store privately; implement minimal scoped scratch reaper. No route, marker provisioning, OAuth grant, scheduled job or plugin wiring. Use same typed budget/cooldown authority as Tasks 5–7.
- [ ] **Step 4:** Run focused tests, workerd and typecheck; commit tests+code: `feat(worker): compose private sync store and scoped scratch cleanup`.

### Task 9: End-to-end failure matrix, measurement and evidence

**Files:** Expand `apps/worker/tests/runtime/sync-r2-store.test.ts`, `sync-r2-inventory.test.ts`; update M7 spec and docs/evidence paths mapped above. Do not write a qualification claim without measured evidence.

- [ ] **Step 1:** Run synthetic 10,000-head and worst-case short/empty-page inventory profiles across resumptions; measure total elapsed, CPU and memory in local workerd, per-invocation subrequests for start/step/finalize/page/cleanup/recovery, 20,001-page worst-case and two-attempt ceilings. Use a deterministic fast contract test for aggregate maxima if the full-scale runtime profile is too costly for every `mise run check`, but retain an explicit reproducible focused qualification task; do not label arithmetic as a runtime run.
- [ ] **Step 2:** Run `mise install`, `mise run install`, `mise run check`. Record exact source/workerd/artifact counts and coverage; maintain ≥configured thresholds. Re-run after every review correction. Check TSDoc usefulness, cross-boundary typing, stale CAS, immutable evidence, uncertain-write floors, no unbounded loops, no v2 route/plugin change and no secret/content logging. Independent fresh-context whole-branch semantic/security review must have no unexplained findings; corrective findings are tested and re-reviewed.
- [ ] **Step 3:** The spec requires a separately authorized **isolated Workers Free** run showing every inventory invocation profile ≤10 ms CPU. Ask owner for that authorization before any remote run; if not granted, do **not** mark M7 COMPLETE, do not claim CPU compliance or move the roadmap to a later NEXT milestone. Record M7.4 local implementation evidence and outstanding exit gate honestly; if a profile exceeds 10 ms, reduce per-invocation work and recalculate bounds before completion.
- [ ] **Step 4:** Synchronize milestone evidence, architecture, current-state, roadmap and qualification report with actual results/limits. Only mark M7 COMPLETE after every acceptance criterion including authorized Free CPU qualification, canonical checks and review passes; never activate sync or infer cutover. Commit docs with corresponding verified behavior; suggested PR title `feat(worker): complete isolated M7 sync store` (or narrower if Free CPU gate remains open).

## Execution and review handoff

- Before dispatch, user reviews this written plan. Follow `superpowers:using-git-worktrees` and `superpowers:subagent-driven-development`. Parent on current `openai-codex/gpt-6-sol` medium owns arbitration, dependency interfaces, integration, validation, evidence and PR creation; task implementers each receive one bounded file seam on an isolated lane/worktree, with sequential integration and one active writer per tree. Fresh reviewers inspect each tested work-unit diff against its predecessor; one independent whole-branch reviewer inspects the accumulated diff. Parent resolves findings without allowing overlapping writers or nested agents.
- Operator clarified the worker route: **`openai-codex/gpt-6-luna` with Pi thinking `max`** (`xmax` is not a supported Pi level; `max` is). Pin this exact route for implementation and fresh reviewers. If the route or authentication is unavailable, pause; do not substitute another provider/model/thinking level.
- User approved **one PR irrespective of size** for this feature, not automatic publishing/merge/deploy. Preserve readable work-unit commits, tests with behavior, explicit size-exception rationale, focused test evidence and rollback boundary for each unit. Avoid concurrent mutation of journal/feed/inventory shared files; independent read-only review may run in parallel. Run full canonical gates and semantic review before drafting/pushing a PR; do not claim remote CPU evidence from local workerd.

## Self-review and risk gates

The accepted spec's M7.4 journal, committed feed, 30-day cursor, stable-vector inventory, bounded replay, evidence paging, cleanup, 10,000-head ceiling, rename safety, isolated namespace and Free CPU gate map to Tasks 1–9. **Planning risk:** the M7.3 private manifest has only `starting | scanning | complete | failed`; task implementation must prove exact resumability of finalization/slot release without inventing incompatible persisted authority. Similarly, R2 `uploaded`/exact ETag and cross-isolate retry floors must be reconstructible from recorded evidence. If either requires a changed authority-bearing schema/ADR or additional infrastructure, stop, present the counterexample and seek a design decision before implementing. All new behavior remains private even if the runtime qualification gate has to be deferred; a locally passing test suite is not M7 completion.
