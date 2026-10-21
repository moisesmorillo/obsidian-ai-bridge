# Bounded Authoritative Reads Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` after owner approval. Complete each work unit and its independent review before the next unit.

**Goal:** Complete OAB-6.6 with authorized, bounded reads for vault metadata, manifest, changes, content, and history.

**Architecture:** SQLite remains the sole authority. Collection reads use ordered keyset queries and bounded internal batches. The Worker produces bounded JSON chunks and retains admission ownership until response production and operation cleanup settle.

**Tech Stack:** TypeScript, Zod, Hono, Drizzle, SQLite Durable Objects, native Workers streams, R2, Bun, and Vitest.

**Spec:** `docs/spec.md`, sections 5.1, 5.4, 6.1–6.5, 7.3, 9.3–9.5, and 12. Server evidence covers AC-12, AC-21, AC-25, and AC-40.

## Approval and base

- Planning only. Do not write functional code before the owner approves this plan in Plannotator.
- Base: `origin/main`, commit `4a470970bd24f02c9b68168c95937de9934207ce`, which includes PR #13.
- Worktree: `~/.worktrees/obsidian-ai-bridge/feature/oab-6.6`, branch `feature/oab-6.6`.
- Keep the original checkout unchanged. Use this worktree for all product commands.
- OAB-6.4 and OAB-6.5 are complete. Their dependency graph permits OAB-6.6 to start.
- Frozen dependency installation completed. The baseline `bun run check` runs separately.
- The owner corrected the history decision: use `{epoch, entries, next_page}`, not an array with pagination headers.

## Global constraints

- Complete only OAB-6.6. Do not implement search, plugin synchronization, backup, or the OAB-6.8 runtime envelope.
- Preserve exact CAS, lifetime revisions, immutable receipts, and two visible versions after collisions.
- Absence never authorizes deletion. Manifest pages always include tombstones.
- Use canonical ETags, not bare revisions, in new read results and history entries.
- Keep protocol Zod schemas canonical in `packages/protocol`. Infer TypeScript contract types from them.
- Keep application code independent of Cloudflare SDKs. Keep composition code limited to dependency wiring.
- Keep production identity denial until the separate authentication task supplies an adapter.
- Do not add dependencies, deploy, access the personal vault, or change Cloudflare resources or Git identity.
- Use English repository text, useful TSDoc, Biome formatting, and workspace import aliases.
- Keep the existing mutation-slot behavior and its regression tests unchanged.
- Do not reopen authority streams or OAB-6.5 R1. Native retention remains intentionally deferred to OAB-6.8.2.
- The owner-defined 32 MiB boundary covers active application-owned data only. Do not claim a native heap bound.
- Physical retention, capacity-pressure pruning, global concurrency qualification, and native measurements remain in OAB-6.8.

## Read contracts

### Existing endpoints only

- `GET /v1/vault` returns `{epoch, head_seq, counts, limits}`.
- `GET /v1/manifest?page=...` returns `{epoch, head_seq, entries, next_page}`.
- `GET /v1/changes?epoch=E&since=S&limit=N` returns `{epoch, head_seq, entries}`.
- `GET /v1/history/*path?page=...` returns `{epoch, entries, next_page}`.
- Preserve `GET /v1/files/*path` and its existing current, exact-revision, text-range, and blob-range forms.
- Update the endpoint documentation with the approved history envelope and canonical ETag fields.
- Do not add endpoints, alternate plugins, or public testing routes.

### Canonical metadata

- Manifest entries contain `path, etag, seq, hash, size, kind, deleted, large`.
- History entries contain `etag, hash, size, deleted, origin, at`. They contain no content or bare `rev`.
- Feed entries contain immutable `seq, op, path, etag, hash, origin, at`.
- Rename entries also contain `from_path` and `from_etag`, which identify the source tombstone.
- Derive feed fields only from the retained `changes` row and the current matching epoch.
- Never join feed entries to current files or retained revisions to reconstruct historical metadata.
- Reuse canonical content and blob schemas. Add shared metadata declarations only where actual schemas use them.
- `large` is true only for live Markdown or Canvas blobs above 1,000,000 bytes.
- Tombstones have an empty hash, zero size, and `large: false`.
- Vault counts distinguish live files and tombstones. Compute aggregate counts without returning file rows.
- Vault limits report existing contract values, not claims that deferred capacity enforcement already exists.

### Page bounds and ordering

- Manifest public pages contain at most 256 entries, below the specification ceiling of 20,000.
- History public pages contain at most 256 entries.
- Feed `limit` defaults to 1,000. Accept canonical integers from 1 through 1,000 only.
- Internal collection queries select at most 64 metadata rows, plus at most one lookahead row.
- Select named metadata columns. Never select content in manifest, feed, or history queries.
- Manifest ordering uses SQLite binary path order and a strict `path > after_path` condition.
- History ordering uses ascending path revision and a strict `rev > after_rev` condition.
- Feed ordering uses ascending sequence and a strict `seq > since` condition.
- Use a bounded lookahead to decide continuation. Do not count or materialize a complete collection.
- Reject duplicate, unknown, malformed, negative, unsafe, and excessive query values before native data demand.
- Keep text offsets and lengths in UTF-16 code units. Keep blob selections in bytes.
- Preserve whole-blob streaming. An explicit blob range never exceeds 1,000,000 bytes.
- Bound text selection against the existing 1,000,000-byte inline content ceiling. Do not assemble an escaped full-body JSON string.

### Continuation tokens and recovery

- Define strict, versioned token payloads in `packages/protocol`, with bounded base64url encoding.
- Tokens carry their collection kind, epoch, captured head sequence, and last emitted identity.
- History tokens also bind the exact path and the first page's upper ETag.
- Use an encoded token ceiling of 4,096 bytes. Reject oversized tokens before decoding or JSON parsing.
- Tokens are seek hints, not authorization. Validate them and authorize every request independently.
- Reject a token from another collection or history path with `400 invalid_request`.
- An old epoch returns `409 epoch_mismatch` with the current epoch.
- An unavailable feed position returns `410 cursor_expired`. The client restarts reconciliation from a fresh manifest.
- Expire manifest continuation when its captured head can no longer resume the retained feed safely.
- History continuation remains bounded by its original upper ETag. Later revisions enter a fresh traversal.
- Missing exact revisions return `410 revision_pruned`, never newer content under the requested identity.
- The caller explicitly requests current content after `revision_pruned`. The server does not silently substitute it.

## Concurrency and retention semantics

1. Capture the manifest epoch and head sequence with the first authorized metadata batch.
2. Carry that same observation through the response and its continuation token.
3. Do not claim a manifest snapshot. Later batches may contain rows with `seq > head_seq`.
4. Keep every tombstone. A new path behind the traversal position remains discoverable through the feed after the captured head.
5. Clip one feed response to its first authorized `head_seq`. Later writes enter the next feed request.
6. Read retained feed entries directly. Updates, deletes, recreations, renames, and revision pruning cannot change emitted entries.
7. Determine the resumable feed floor from the retained sequence boundary and the 30-day availability cutoff.
8. A cursor immediately before the oldest available entry is valid. An earlier cursor is expired.
9. An empty fresh vault accepts `since=0`. A vault with a nonzero head and no retained entries rejects positions below that head.
10. Reject future cursors above the observed head with `400 invalid_request`.
11. Use sequence boundaries, not an assumption that write timestamps always increase.
12. Test exact cutoff behavior and clock rollback. Do not delete feed, history, receipts, or tombstones in this task.
13. Test physical pruning through real SQLite fixtures. Production pruning jobs remain in OAB-6.8.
14. Retained and export-pinned revisions remain readable while their rows exist. Age alone does not authorize a reader to remove them.

## Admission, production, and cancellation

- Use the existing durable read operation, scope policy, ticket deadlines, and finish semantics. Do not create a second admission ledger.
- A public read owns one durable admission through its started work and response production.
- Recheck context, grant revocation, epoch, and active admission before each internal batch.
- Bind path reads to their canonical path. Bind vault-wide reads to the existing zero-path read descriptor.
- Reuse the existing admission API and transaction helpers. Add a read-specific application coordinator, not a mutation imitation.
- Add four isolate-local read slots without a waiting queue. Keep them separate from the four existing mutation slots.
- Excess reads return `429 admission_limited` and `Retry-After: 1` before collection or storage demand.
- The durable ledger still supplies its existing per-client and vault admission limits across operations.
- Serialize only one bounded batch at a time. Produce encoded chunks no larger than 65,536 bytes under downstream demand.
- Use the existing owned response-lifetime behavior where its contract applies. Share neutral stream mechanics without changing mutation semantics.
- Read current or exact content authority before R2 access. Keep its selected ETag for the complete response.
- Abort stops new batch and storage demand. Await started RPC, stream reads, and cancellation cleanup before slot reuse.
- Known completion settles admission. An uncertain authority result retains the original durable deadline.
- Expiry or cancellation never releases a local slot while started work remains unresolved.
- Before headers, return canonical errors. After headers, a failed batch errors the stream. Never return a valid-looking partial page.
- Do not claim client receipt or native release from producer EOF.

## Review focus

- A rename inserts a destination before the manifest traversal position. Feed recovery must still expose both exact identities.
- Revision pruning removes rename destination content. The immutable feed entry must survive and exact reads must return `revision_pruned`.
- A timestamp moves backwards across the retention cutoff. The feed must not silently skip an unavailable sequence.
- A slow reader cancels during an unresolved batch or R2 read. Capacity must stay charged until started work settles.
- A continuation crosses epoch replacement, revocation, or path substitution. The server must reject it without leaking content.

## Work unit 1: Canonical read contracts

**Owner:** One implementer, `openai/gpt-6-luna:high`. No concurrent writer.

**Files:**
- Create `packages/protocol/src/schemas/reads.ts`, `types/reads.ts`, and `codecs/reads.ts`.
- Create `packages/protocol/test/reads.test.ts`.
- Change protocol history schemas, inferred types, failure schemas/codecs, exports, and their focused tests.
- Change `docs/spec.md` only for implemented read shapes, bounded paging, and the owner-approved history envelope.

**Interfaces:**
- Export inferred vault, manifest, changes, history-page, token, internal-batch, and read-result types.
- Export token encode/decode functions that use canonical Zod payloads and reject oversized input first.
- Add `cursor_expired` to the existing canonical failure contract and encoder.
- Preserve mutation command, receipt, restore-source, and admission shapes.

- [ ] Write failing tests for exact metadata shapes, ETags, tombstones, rename source ETags, ordering, and page limits.
- [ ] Test token kind/path binding, bounded decoding, unsafe numbers, wrong epochs, and forbidden bare revision fields.
- [ ] Run the focused tests. Preserve genuine RED output and its observed exit code without marking an expected failure as infrastructure failure.
- [ ] Implement canonical schemas, inferred types, codecs, and the documentation amendment.
- [ ] Adapt existing history consumers to the approved envelope without adding unbounded compatibility code.
- [ ] Run focused protocol tests, `bun run docs:check`, and `bun run check`.
- [ ] Commit with a Conventional Commit message. Report commands, RED/GREEN evidence, commit, and remaining limits.
- [ ] Get one independent review before work unit 2.

## Work unit 2: Native authoritative read engine

**Owner:** One implementer, `openai/gpt-6-luna:high`. Use the accepted protocol commit.

**Files:**
- Create `apps/worker/src/application/reads.ts` and `infrastructure/sqlite/reads.ts`.
- Change `infrastructure/durable-object/vault.ts`, existing history/text stores, and only the admission helpers needed for read ownership.
- Create `apps/worker/test/vault-reads.test.ts` and focused read-admission fixtures/tests.
- Change existing native history tests for the approved page result.

**Interfaces:**
- `ReadVaultGateway` composes existing authorization/finish operations with bounded native read methods.
- `Vault.readVault`, `Vault.readManifest`, and `Vault.readChanges` expose the corresponding canonical results.
- Extend `Vault.readHistory` with canonical bounded paging and admission ownership.
- Each collection method accepts validated context, active read ownership, and its canonical bounded request.
- Return at most one internal batch. The Worker, not a retained SQL cursor, requests the next batch.
- Keep existing content methods compatible until transport integration adopts read ownership.

- [ ] Write failing real SQLite DO tests for vault counts, empty state, mixed text/blob/tombstone manifest pages, and page traversal.
- [ ] Test 1,000-entry feed limits, 256-entry public-page traversal, 64-row batches, and content-free SQL projections.
- [ ] Test epoch mismatch, expired and future cursors, exact retention boundaries, empty pruned feeds, and clock rollback.
- [ ] Test PUT, delete/recreate, append, restore, and rename between manifest batches and public pages.
- [ ] Assert that retained feed metadata remains identical after later edits and revision pruning.
- [ ] Test pruned exact revisions, current fallback as a separate request, and surviving pinned revision reads.
- [ ] Test revoked and write-only identities before data demand, plus revocation and ticket expiry between batches.
- [ ] Run the new tests and record genuine RED before implementation.
- [ ] Implement metadata-only keyset queries and native read policy in bounded transactions.
- [ ] Use no new persistent schema, migration, retention job, or content-publication behavior.
- [ ] Run native read/history/content regressions, `bun run docs:check`, and `bun run check`.
- [ ] Commit and report evidence. Get one independent review before work unit 3.

## Work unit 3: Bounded Worker transport and acceptance tests

**Owner:** One implementer, `openai/gpt-6-luna:high`. Use the accepted native engine commit.

**Files:**
- Create `apps/worker/src/transport/reads.ts` and bounded read-response production code beside it.
- Change `transport/worker.ts`, `transport/history.ts`, `transport/files.ts`, and blob read ownership where needed.
- Change `src/index.ts` and `test/fixtures/http-worker.ts` for composition only.
- Create `apps/worker/test/http/reads.test.ts` and read-response lifecycle tests.
- Update existing HTTP history/content tests and gateway fixtures.

**Interfaces:**
- Register only the existing vault, manifest, changes, history, and content routes.
- `ReadVaultGateway` owns transport-neutral read dependencies. Composition supplies native RPC adapters.
- JSON success bodies follow the protocol schemas. Content responses preserve canonical ETag headers.
- The read coordinator owns local slots, durable admission, batch demand, and final settlement.

- [ ] Write failing real `SELF.fetch` tests for all read routes, strict query parsing, authorization, and canonical errors.
- [ ] Test successive public pages, stable captured heads, concurrent publication, and content selection under later writes.
- [ ] Exercise server portions of AC-12, AC-21, AC-25, and AC-40 with real Worker/DO calls.
- [ ] Assert tombstone recovery, newer manifest rows, older feed identities, and rename source ETags below later source revisions.
- [ ] State in test names and task notes that plugin apply, no-op, trash, and conflict-copy assertions remain unimplemented here.
- [ ] Test text UTF-16 boundaries, surrogate pairs, escaped control characters, and current/exact revision ETags.
- [ ] Preserve blob whole-object streaming and the existing single-range 1,000,000-byte limit tests.
- [ ] Test unread and slow responses, EOF, final-chunk boundaries, cancellation, RPC failure, storage failure, and cleanup rejection.
- [ ] Use explicit demand barriers for interleavings. Do not use timers as proof of settlement order.
- [ ] Assert a maximum 65,536-byte encoded chunk and no next-batch demand before consumption permits it.
- [ ] Assert local slots and durable ownership remain charged until started work and response cleanup settle.
- [ ] Run focused HTTP/lifecycle tests, mutation lifetime regressions, `bun run docs:check`, and `bun run check`.
- [ ] Commit and report actual results. Get one independent task review.

## Review, closure, and publication

- Load `code-review` and its TypeScript profile before each independent review.
- Review the complete branch with `openai/gpt-6.1-sol:medium` after task reviews and corrections.
- Record reviewed revisions, documentation scope, structural candidates, validation, limits, and evidence-based finding closure in task notes.
- Do not commit review-record or evidence documents. Tests, task notes, and the PR carry the record.
- Read `backlog instructions task-finalization` before acceptance checks or terminal status changes.
- Match each real OAB-6.6 criterion to passing native tests. Do not claim plugin qualification or a deployed runtime measurement.
- Open one human branch review in Plannotator against `origin/main`. Address every annotation before the PR.
- Use `finishing-a-development-branch` after tests and reviews pass. Push and create an English Conventional Commit-style PR.
- Do not merge. Remove the worktree only after safe publication and clean-state checks.
- Stop after OAB-6.6. Do not start another task.

## Acceptance mapping

- Criterion 1: work unit 1 contracts, work unit 2 native policy/metadata, and work unit 3 routes and content ETags.
- Criterion 2: work unit 2 recovery boundaries and immutable feed tests, plus work unit 3 concurrent HTTP scenarios.
- Criterion 3: work units 2–3 page, batch, range, chunk, admission, and cancellation assertions.
- Criterion 4: work unit 3 real server acceptance cases, with explicit plugin limits.
